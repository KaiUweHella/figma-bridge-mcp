// Commands: node-ops (extracted from index.js)
import chalk from 'chalk';
import { execSync } from 'child_process';
import { join } from 'path';
import {
  program,
  DAEMON_PORT,
  checkConnection,
  fastEval,
  getDaemonToken,
  isInSafeMode,
  runFigmaUse
} from '../lib/cli-core.js';

// ============ NODE OPERATIONS (figma-use) ============

const node = program
  .command('node')
  .description('Node operations (tree, bindings, to-component)');

node
  .command('tree [nodeId]')
  .description('Show node tree structure')
  .option('-d, --depth <n>', 'Max depth', '3')
  .action(async (nodeId, options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const maxDepth = parseInt(options.depth) || 3;
      const code = `(async () => {
        const maxDepth = ${maxDepth};
        const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
        const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
        if (!root) return 'Node not found';

        const lines = [];
        function printNode(node, indent = 0, depth = 0) {
          if (depth > maxDepth) return;
          const prefix = '  '.repeat(indent);
          const size = node.width && node.height ? \` (\${Math.round(node.width)}x\${Math.round(node.height)})\` : '';
          lines.push(prefix + node.type + ': ' + node.name + size);
          if ('children' in node && depth < maxDepth) {
            node.children.forEach(c => printNode(c, indent + 1, depth + 1));
          }
        }
        printNode(root);
        return lines.join('\\n');
      })()`;

      try {
        const result = await fastEval(code);
        console.log(result);
      } catch (e) {
        console.log(chalk.red('✗ Tree failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use node tree';
      if (nodeId) cmd += ` "${nodeId}"`;
      cmd += ` --depth ${options.depth}`;
      runFigmaUse(cmd);
    }
  });

node
  .command('bindings [nodeId]')
  .description('Show variable bindings for node')
  .action(async (nodeId) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
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
                const variable = figma.variables.getVariableById(b.id);
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
    } else {
      let cmd = 'npx figma-use node bindings';
      if (nodeId) cmd += ` "${nodeId}"`;
      runFigmaUse(cmd);
    }
  });

node
  .command('to-component <nodeIds...>')
  .description('Convert frames to components')
  .action(async (nodeIds) => {
    await checkConnection();

    // Check if we're in Safe Mode (plugin only, no CDP)
    let useDaemon = false;
    try {
      const healthToken = getDaemonToken();
      const healthHeader = healthToken ? ` -H "X-Daemon-Token: ${healthToken}"` : '';
      const healthRes = execSync(`curl -s${healthHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
      const health = JSON.parse(healthRes);
      useDaemon = health.plugin && !health.cdp;
    } catch {}

    if (useDaemon) {
      // Safe Mode: use native Figma API
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
    } else {
      // Yolo Mode: use figma-use
      const cmd = `npx figma-use node to-component "${nodeIds.join(' ')}"`;
      runFigmaUse(cmd);
    }
  });

node
  .command('delete <nodeIds...>')
  .description('Delete nodes by ID')
  .action(async (nodeIds) => {
    await checkConnection();

    // Check if we're in Safe Mode
    let useDaemon = false;
    try {
      const healthToken = getDaemonToken();
      const healthHeader = healthToken ? ` -H "X-Daemon-Token: ${healthToken}"` : '';
      const healthRes = execSync(`curl -s${healthHeader} http://127.0.0.1:${DAEMON_PORT}/health`, { encoding: 'utf8', timeout: 2000 });
      const health = JSON.parse(healthRes);
      useDaemon = health.plugin && !health.cdp;
    } catch {}

    if (useDaemon) {
      // Safe Mode: use native Figma API
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
    } else {
      // Yolo Mode: use figma-use
      const cmd = `npx figma-use node delete "${nodeIds.join(' ')}"`;
      runFigmaUse(cmd);
    }
  });

