// Commands: node-ops (extracted from index.js)
import chalk from 'chalk';
import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
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
  .command('move <nodeId> <x> <y>')
  .description('Move a node to an absolute canvas position (top-left corner). Sections move with their children.')
  .option('-p, --page <nameOrId>', 'Reparent onto this page (top level) before positioning')
  .action(async (nodeId, x, y, options) => {
    await checkConnection();
    const targetX = Number(x);
    const targetY = Number(y);
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
      console.log(chalk.red('✗ x and y must be numbers'));
      return;
    }
    const code = `(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(normalizeNodeId(nodeId).id)});
      if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      if (!('x' in node)) throw new Error('Node has no position: ' + node.type);
      const pageQuery = ${JSON.stringify(options.page || null)};
      if (pageQuery) {
        const pages = figma.root.children;
        let target = pages.find(p => p.id === pageQuery) || pages.find(p => p.name === pageQuery);
        if (!target) {
          const matches = pages.filter(p => p.name.toLowerCase().includes(pageQuery.toLowerCase()));
          if (matches.length === 1) target = matches[0];
          else if (matches.length > 1) throw new Error('Ambiguous page name "' + pageQuery + '": ' + matches.map(p => p.name).join(', '));
        }
        if (!target) throw new Error('Page not found: ' + pageQuery);
        await target.loadAsync();
        target.appendChild(node);
        // Top level of a page: x/y ARE absolute, set directly.
        node.x = ${targetX};
        node.y = ${targetY};
        return { id: node.id, name: node.name, x: node.x, y: node.y, page: target.name };
      }
      // node.x/y are parent-relative; translate the absolute target into the
      // parent's coordinate space so the command means the same thing at any
      // nesting depth.
      const b = node.absoluteBoundingBox;
      if (b) {
        node.x = node.x + (${targetX} - b.x);
        node.y = node.y + (${targetY} - b.y);
      } else {
        node.x = ${targetX};
        node.y = ${targetY};
      }
      return { id: node.id, name: node.name, x: node.x, y: node.y };
    })()`;
    try {
      const r = await fastEval(code);
      console.log(chalk.green('✓'), `Moved "${r.name}" (${r.id})`);
    } catch (e) {
      console.log(chalk.red('✗ Move failed: ' + e.message));
    }
  });

node
  .command('resize <nodeId> <width> <height>')
  .description('Resize a node (keeps position). Per dimension: a number, "keep" (unchanged), "fill" or "hug" (auto-layout sizing).')
  .action(async (nodeId, width, height) => {
    await checkConnection();
    const KEYWORDS = ['keep', 'fill', 'hug'];
    const parseDim = (v) => KEYWORDS.includes(v) ? v : Number(v);
    const w = parseDim(width);
    const h = parseDim(height);
    if ((typeof w === 'number' && !Number.isFinite(w)) || (typeof h === 'number' && !Number.isFinite(h))) {
      console.log(chalk.red('✗ width/height must be numbers (or "keep" / "fill" / "hug")'));
      return;
    }
    // fill/hug set layoutSizing (needs an auto-layout parent / children);
    // numbers resize to FIXED. Mixed forms are fine ("fill" + number).
    const dimCode = (dim, prop, sizeProp) => {
      if (dim === 'keep') return '';
      if (dim === 'fill' || dim === 'hug') {
        return `node.${sizeProp} = '${dim.toUpperCase()}';`;
      }
      return `node.${sizeProp} = 'FIXED'; ${prop === 'width' ? `node.resize(${dim}, node.height);` : `node.resize(node.width, ${dim});`}`;
    };
    const code = `(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(normalizeNodeId(nodeId).id)});
      if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      if (typeof node.resize !== 'function') throw new Error('Node cannot be resized: ' + node.type);
      try { ${dimCode(w, 'width', 'layoutSizingHorizontal')} } catch (e) { throw new Error('width: ' + e.message); }
      try { ${dimCode(h, 'height', 'layoutSizingVertical')} } catch (e) { throw new Error('height: ' + e.message); }
      return { id: node.id, name: node.name, width: node.width, height: node.height,
        sizingH: node.layoutSizingHorizontal, sizingV: node.layoutSizingVertical };
    })()`;
    try {
      const r = await fastEval(code);
      console.log(chalk.green('✓'), `Resized "${r.name}" to ${r.width}×${r.height}`);
    } catch (e) {
      console.log(chalk.red('✗ Resize failed: ' + e.message));
    }
  });

node
  .command('rename <nodeId> <name>')
  .description('Rename a node')
  .action(async (nodeId, name) => {
    await checkConnection();
    const code = `(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(normalizeNodeId(nodeId).id)});
      if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      const oldName = node.name;
      node.name = ${JSON.stringify(String(name))};
      return { id: node.id, oldName, name: node.name };
    })()`;
    try {
      const r = await fastEval(code);
      console.log(chalk.green('✓'), `Renamed "${r.oldName}" → "${r.name}"`);
    } catch (e) {
      console.log(chalk.red('✗ Rename failed: ' + e.message));
    }
  });

node
  .command('set-text <nodeId> <text>')
  .description('Replace the characters of a TEXT node (loads its fonts first; works on instance sub-texts too)')
  .action(async (nodeId, text) => {
    await checkConnection();
    const code = `(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(normalizeNodeId(nodeId).id)});
      if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      if (node.type !== 'TEXT') throw new Error('Not a TEXT node: ' + node.type + ' — pass the text layer id (see node tree)');
      // Mixed-style text carries several fonts; every one must be loaded
      // before characters may be written.
      const fonts = node.characters.length > 0
        ? node.getRangeAllFontNames(0, node.characters.length)
        : [node.fontName];
      for (const f of fonts) await figma.loadFontAsync(f);
      const oldText = node.characters;
      node.characters = ${JSON.stringify(String(text))};
      return { id: node.id, oldText, text: node.characters };
    })()`;
    try {
      const r = await fastEval(code);
      console.log(chalk.green('✓'), `Text set on ${r.id}: "${r.oldText}" → "${r.text}"`);
    } catch (e) {
      console.log(chalk.red('✗ set-text failed: ' + e.message));
    }
  });

node
  .command('set-fill <nodeId> <color>')
  .description('Set a solid fill: hex ("#2F6B3F") or a variable ("var:color/green/600")')
  .action(async (nodeId, color) => {
    await checkConnection();
    const value = String(color).trim();
    const isVar = value.startsWith('var:');
    if (!isVar && !/^#?[0-9a-fA-F]{6}$/.test(value)) {
      console.log(chalk.red('✗ color must be #RRGGBB or var:<name>'));
      return;
    }
    const code = `(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(normalizeNodeId(nodeId).id)});
      if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      if (!('fills' in node)) throw new Error('Node has no fills: ' + node.type);
      ${isVar ? `
      const wanted = ${JSON.stringify(value.slice(4))};
      const vars = await figma.variables.getLocalVariablesAsync('COLOR');
      const v = vars.find(x => x.name === wanted) || vars.find(x => x.name.toLowerCase() === wanted.toLowerCase());
      if (!v) throw new Error('Color variable not found: ' + wanted);
      const paint = figma.variables.setBoundVariableForPaint(
        { type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', v);
      node.fills = [paint];
      return { id: node.id, name: node.name, fill: 'var:' + v.name };
      ` : `
      const hex = ${JSON.stringify(value.replace(/^#/, ''))};
      const rgb = {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
      };
      node.fills = [{ type: 'SOLID', color: rgb }];
      return { id: node.id, name: node.name, fill: '#' + hex };
      `}
    })()`;
    try {
      const r = await fastEval(code);
      console.log(chalk.green('✓'), `Fill set on "${r.name}": ${r.fill}`);
    } catch (e) {
      console.log(chalk.red('✗ set-fill failed: ' + e.message));
    }
  });

node
  .command('set-image <nodeId> <file>')
  .description('Set a local image file (png/jpg/gif/webp) as the fill of a node — turns render placeholders into real images')
  .option('--scale <mode>', 'Scale mode: FILL, FIT, CROP, TILE', 'FILL')
  .action(async (nodeId, file, options) => {
    await checkConnection();
    const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
    if (!existsSync(path)) {
      console.log(chalk.red(`✗ File not found: ${file}`));
      return;
    }
    const size = statSync(path).size;
    if (size > 8 * 1024 * 1024) {
      console.log(chalk.red(`✗ ${file} is ${(size / 1048576).toFixed(1)} MB (> 8 MB) — downscale it first (Figma caps images at 4096px anyway).`));
      return;
    }
    const mode = String(options.scale || 'FILL').toUpperCase();
    const finalMode = ['FILL', 'FIT', 'CROP', 'TILE'].includes(mode) ? mode : 'FILL';
    const b64 = readFileSync(path).toString('base64');
    const code = `(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(normalizeNodeId(nodeId).id)});
      if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      if (!('fills' in node)) throw new Error('Node has no fills: ' + node.type);
      const img = figma.createImage(figma.base64Decode(${JSON.stringify(b64)}));
      node.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: ${JSON.stringify(finalMode)} }];
      // The placeholder annotation has served its purpose once a real image lands.
      try { node.annotations = []; } catch (e) {}
      return { id: node.id, name: node.name };
    })()`;
    try {
      const r = await fastEval(code);
      console.log(chalk.green('✓'), `Image set on "${r.name}" (${r.id}) from ${file}`);
    } catch (e) {
      console.log(chalk.red('✗ set-image failed: ' + e.message));
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

