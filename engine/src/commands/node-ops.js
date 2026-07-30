// Commands: node-ops (extracted from index.js)
import chalk from 'chalk';
import {
  program,
  checkConnection,
  fastEval
} from '../lib/cli-core.js';
import { normalizeNodeId } from '../lib/node-id.js';

// ============ NODE OPERATIONS ============

const node = program
  .command('node')
  .description('Node operations (tree, bindings, to-component)');

node
  .command('tree [nodeId]')
  .description('Show node tree structure')
  .option('-d, --depth <n>', 'Max depth', '3')
  .option('--ids', 'Append each node\'s id ([12:34]) — for follow-up inspect/spec/screenshot calls')
  .action(async (nodeId, options) => {
    await checkConnection();

    // Plugin bridge is the only execution path in the Safe-Mode build.
    {
      if (nodeId) {
        const norm = normalizeNodeId(nodeId);
        if (norm.warning) console.error(chalk.yellow('⚠ ' + norm.warning));
        nodeId = norm.id;
      }
      const maxDepth = parseInt(options.depth) || 3;
      const withIds = options.ids === true;
      const code = `(async () => {
        const maxDepth = ${maxDepth};
        const WITH_IDS = ${withIds};
        const targetId = ${nodeId ? JSON.stringify(nodeId) : 'null'};
        const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
        if (!root) return 'Node not found: ' + targetId + ' in the currently open file "' + figma.root.name + '" — Safe Mode only reaches the file open in Figma Desktop.';
        // Dynamic-page requirement: pages (and the document root, id 0:0)
        // must be loaded before touching .children — otherwise Figma throws
        // an internal "call loadAsync" error that used to leak to the user.
        if (root.type === 'DOCUMENT') await figma.loadAllPagesAsync();
        else if (typeof root.loadAsync === 'function') await root.loadAsync();

        const lines = [];
        let truncated = 0;
        async function printNode(node, indent = 0, depth = 0) {
          if (depth > maxDepth) return;
          const prefix = '  '.repeat(indent);
          const size = node.width && node.height ? \` (\${Math.round(node.width)}x\${Math.round(node.height)})\` : '';
          let label = node.type + ': ' + node.name + size;
          if (WITH_IDS) label += ' [' + node.id + ']';
          // TEXT: show the REAL characters — layer names inside instances are
          // the master's names and routinely lie about the actual content.
          if (node.type === 'TEXT') {
            const chars = node.characters || '';
            label += ' "' + (chars.length > 60 ? chars.slice(0, 60) + '…' : chars) + '"';
          }
          // INSTANCE: resolve the main component — an icon renamed "leaf" may
          // actually instantiate "calendar". Truth beats layer names.
          if (node.type === 'INSTANCE') {
            try {
              const main = await node.getMainComponentAsync();
              if (main && main.name !== node.name) label += ' → ' + main.name;
            } catch (e) {}
          }
          lines.push(prefix + label);
          if ('children' in node && node.children.length > 0) {
            if (depth < maxDepth) {
              for (const c of node.children) await printNode(c, indent + 1, depth + 1);
            } else {
              // Children exist below the depth cut — say so instead of
              // silently rendering a leaf (a truncated tree that LOOKS
              // complete sends readers down wrong paths).
              lines.push(prefix + '  … +' + node.children.length + ' child(ren) below depth ' + maxDepth);
              truncated += node.children.length;
            }
          }
        }
        await printNode(root);
        if (truncated > 0) {
          lines.push('(' + truncated + ' node(s) hidden by depth limit — re-run with -d <n>)');
        }
        return lines.join('\\n');
      })()`;

      try {
        const result = await fastEval(code);
        console.log(result);
      } catch (e) {
        console.log(chalk.red('✗ Tree failed: ' + e.message));
      }
    }
  });

node
  .command('bindings [nodeId]')
  .description('Show variable bindings for node')
  .action(async (nodeId) => {
    await checkConnection();

    // Plugin bridge is the only execution path in the Safe-Mode build.
    {
      const code = `(async () => {
        const targetId = ${nodeId ? JSON.stringify(nodeId) : 'null'};
        const nodes = targetId
          ? [await figma.getNodeByIdAsync(targetId)]
          : figma.currentPage.selection;

        if (!nodes.length) return 'No node selected';

        const results = [];
        for (const node of nodes) {
          if (!node) continue;
          const bindings = {};
          if (node.boundVariables) {
            for (const [prop, binding] of Object.entries(node.boundVariables)) {
              const b = Array.isArray(binding) ? binding[0] : binding;
              if (b && b.id) {
                const variable = await figma.variables.getVariableByIdAsync(b.id);
                bindings[prop] = variable ? variable.name : b.id;
              }
            }
          }
          results.push({ id: node.id, name: node.name, bindings });
        }
        return results;
      })()`;

      try {
        const result = await fastEval(code);
        if (typeof result === 'string') {
          console.log(result);
        } else {
          result.forEach(r => {
            console.log(chalk.cyan(`\n${r.name} (${r.id}):`));
            if (Object.keys(r.bindings).length === 0) {
              console.log(chalk.gray('  No variable bindings'));
            } else {
              Object.entries(r.bindings).forEach(([prop, varName]) => {
                console.log(`  ${prop}: ${chalk.green(varName)}`);
              });
            }
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Bindings failed: ' + e.message));
      }
    }
  });

node
  .command('to-component <nodeIds...>')
  .description('Convert frames to components')
  .action(async (nodeIds) => {
    await checkConnection();

    // Plugin bridge is the only execution path in the Safe-Mode build.
    const code = `(async () => {
      const ids = ${JSON.stringify(nodeIds)};
      const results = [];
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (node && (node.type === 'FRAME' || node.type === 'GROUP')) {
          const comp = figma.createComponentFromNode(node);
          results.push({ id: comp.id, name: comp.name });
        }
      }
      return results;
    })()`;
    try {
      const result = await fastEval(code);
      if (result && result.length > 0) {
        result.forEach(r => console.log(chalk.green(`✓ Converted: ${r.id} (${r.name})`)));
      }
    } catch (e) {
      console.log(chalk.red('✗ Convert failed: ' + e.message));
    }
  });

node
  .command('delete <nodeIds...>')
  .description('Delete nodes by ID')
  .action(async (nodeIds) => {
    await checkConnection();

    // Plugin bridge is the only execution path in the Safe-Mode build.
    const code = `(async () => {
      const ids = ${JSON.stringify(nodeIds)};
      let deleted = 0;
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (node) { node.remove(); deleted++; }
      }
      return deleted;
    })()`;
    try {
      const result = await fastEval(code);
      console.log(chalk.green(`✓ Deleted ${result} node(s)`));
    } catch (e) {
      console.log(chalk.red('✗ Delete failed: ' + e.message));
    }
  });

