// Commands: node-ops (extracted from index.js)
import chalk from 'chalk';
import {
  program,
  checkConnection,
  fastEval
} from '../lib/cli-core.js';
import { normalizeNodeId } from '../lib/node-id.js';
import { generateFillCode, isVarRef, pageLookupCode, varLoadingCode, varResolverCode } from '../lib/eval-snippets.js';
import { readImageBase64 } from '../lib/image-file.js';

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
      ${options.page ? `{
        ${pageLookupCode(options.page)}
        await target.loadAsync();
        target.appendChild(node);
        // Top level of a page: x/y ARE absolute, set directly.
        node.x = ${targetX};
        node.y = ${targetY};
        return { id: node.id, name: node.name, x: node.x, y: node.y, page: target.name };
      }` : ''}
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
    if (!isVarRef(value) && !/^#?[0-9a-fA-F]{6}$/.test(value)) {
      console.log(chalk.red('✗ color must be #RRGGBB or var:<name>'));
      return;
    }
    // Shared fill semantics: hex parsed CLI-side, var: bound via the same
    // vars/boundFill preamble every other set-style command emits.
    let fill;
    try {
      fill = generateFillCode(value, 'node');
    } catch (e) {
      console.log(chalk.red('✗ ' + e.message));
      return;
    }
    const code = `(async () => {
      const node = await figma.getNodeByIdAsync(${JSON.stringify(normalizeNodeId(nodeId).id)});
      if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
      if (!('fills' in node)) throw new Error('Node has no fills: ' + node.type);
      ${fill.usesVars ? `${varLoadingCode()}
      if (!vars[${JSON.stringify(value.slice(4))}]) throw new Error('Color variable not found: ' + ${JSON.stringify(value.slice(4))});` : ''}
      ${fill.code}
      return { id: node.id, name: node.name, fill: ${JSON.stringify(value)} };
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
    const { b64, error } = readImageBase64(file);
    if (error) return;
    const mode = String(options.scale || 'FILL').toUpperCase();
    const finalMode = ['FILL', 'FIT', 'CROP', 'TILE'].includes(mode) ? mode : 'FILL';
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


// ============ BIND (variable → property, by node id) ============
//
// The write counterpart to `node bindings`. Rebuilt from the deleted `bind`
// command group, which read figma.currentPage.selection — a selection no MCP
// caller can set, which is why nothing could ever call it.
//
// Two things it does that the original did not: it refuses an ambiguous
// variable name instead of taking the first match, and it checks the
// variable's type against the property before binding (a COLOR on
// cornerRadius used to fail inside the plugin with an opaque message).

// property → how it binds. PAINT properties go through
// setBoundVariableForPaint; SCALAR ones through node.setBoundVariable.
const BIND_PROPS = {
  fill:            { kind: 'paint',  field: 'fills',   type: 'COLOR' },
  stroke:          { kind: 'paint',  field: 'strokes', type: 'COLOR' },
  radius:          { kind: 'scalar', field: 'cornerRadius', type: 'FLOAT' },
  gap:             { kind: 'scalar', field: 'itemSpacing', type: 'FLOAT' },
  opacity:         { kind: 'scalar', field: 'opacity', type: 'FLOAT' },
  'stroke-width':  { kind: 'scalar', field: 'strokeWeight', type: 'FLOAT' },
  width:           { kind: 'scalar', field: 'width', type: 'FLOAT' },
  height:          { kind: 'scalar', field: 'height', type: 'FLOAT' },
  padding:         { kind: 'scalar', field: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'], type: 'FLOAT' },
  'padding-top':   { kind: 'scalar', field: 'paddingTop', type: 'FLOAT' },
  'padding-right': { kind: 'scalar', field: 'paddingRight', type: 'FLOAT' },
  'padding-bottom':{ kind: 'scalar', field: 'paddingBottom', type: 'FLOAT' },
  'padding-left':  { kind: 'scalar', field: 'paddingLeft', type: 'FLOAT' },
};

/**
 * Normalize one binding request. Pure — exported for tests.
 * Returns { nodeId, property, varName, collection } or throws with the
 * reason a caller can act on.
 */
export function parseBindRequest(entry) {
  const nodeId = entry.node ?? entry.nodeId ?? entry.id;
  const property = entry.property ?? entry.prop;
  const varName = entry.variable ?? entry.var ?? entry.varName;
  if (!nodeId) throw new Error('missing node id');
  if (!property) throw new Error('missing property');
  if (!varName) throw new Error('missing variable name');
  if (!(property in BIND_PROPS)) {
    throw new Error(`unknown property "${property}". Known: ${Object.keys(BIND_PROPS).join(', ')}`);
  }
  const norm = normalizeNodeId(String(nodeId));
  return {
    nodeId: norm.id,
    property,
    varName: String(varName),
    collection: entry.collection ?? null,
  };
}

/** Build the eval for a batch of already-parsed requests. Exported for tests. */
export function bindCode(requests) {
  return `(async () => {
${varResolverCode()}
const requests = ${JSON.stringify(requests)};
const props = ${JSON.stringify(BIND_PROPS)};
const done = [];
const failed = [];

for (const req of requests) {
  const node = await figma.getNodeByIdAsync(req.nodeId);
  if (!node) { failed.push({ ...req, reason: 'node not found' }); continue; }

  const res = __resolveVar(req.varName, req.collection);
  if (res.badCollection) {
    failed.push({ ...req, reason: 'no collection matching "' + res.badCollection + '" (have: ' + res.collections.join(', ') + ')' });
    continue;
  }
  if (!res.variable) {
    if (res.matches.length === 0) {
      failed.push({ ...req, reason: 'no variable named "' + req.varName + '"' });
    } else {
      const where = res.matches.map(m => m.name + ' in ' + m.collection).join(', ');
      failed.push({ ...req, reason: res.matches.length + ' variables match — narrow with --collection: ' + where });
    }
    continue;
  }
  const v = res.variable;
  const spec = props[req.property];
  if (v.resolvedType !== spec.type) {
    failed.push({ ...req, reason: req.property + ' needs a ' + spec.type + ' variable, "' + v.name + '" is ' + v.resolvedType });
    continue;
  }

  try {
    if (spec.kind === 'paint') {
      if (!(spec.field in node)) { failed.push({ ...req, reason: node.type + ' has no ' + spec.field }); continue; }
      const paints = node[spec.field];
      // strokes are often empty: a bind implies "make it visible", so seed a
      // black solid rather than silently doing nothing.
      const base = (Array.isArray(paints) && paints.length)
        ? paints[0]
        : { type: 'SOLID', color: { r: 0, g: 0, b: 0 } };
      node[spec.field] = [figma.variables.setBoundVariableForPaint(base, 'color', v)];
    } else {
      const fields = Array.isArray(spec.field) ? spec.field : [spec.field];
      const usable = fields.filter(f => f in node);
      if (usable.length === 0) { failed.push({ ...req, reason: node.type + ' has no ' + fields.join('/') }); continue; }
      for (const f of usable) node.setBoundVariable(f, v);
    }
    done.push({ nodeId: req.nodeId, name: node.name, property: req.property, variable: v.name, collection: __colName(v) });
  } catch (e) {
    failed.push({ ...req, reason: e.message });
  }
}
return { done, failed };
})()`;
}

node
  .command('bind [nodeId] [property] [varName]')
  .description(`Bind a variable to a node property, by id. Properties: ${Object.keys(BIND_PROPS).join(', ')}. The read counterpart is \`node bindings\`.`)
  .option('-c, --collection <name>', 'Which collection the variable comes from (required when the name is not unique)')
  .option('--batch <json>', 'Bind many at once: [{"node":"1:2","property":"fill","variable":"brand","collection":"TARGET_COLLECTION"}, …]')
  .action(async (nodeId, property, varName, options) => {
    await checkConnection();

    let entries;
    if (options.batch) {
      try {
        entries = JSON.parse(options.batch);
      } catch (e) {
        console.error(chalk.red('✗'), `--batch is not valid JSON: ${e.message}`);
        process.exit(1);
      }
      if (!Array.isArray(entries) || entries.length === 0) {
        console.error(chalk.red('✗'), '--batch expects a non-empty JSON array');
        process.exit(1);
      }
    } else {
      entries = [{ node: nodeId, property, variable: varName }];
    }

    let requests;
    try {
      requests = entries.map((e, i) => {
        const merged = options.collection && !e.collection ? { ...e, collection: options.collection } : e;
        try {
          return parseBindRequest(merged);
        } catch (err) {
          throw new Error(`entry ${i}: ${err.message}`);
        }
      });
    } catch (e) {
      console.error(chalk.red('✗'), e.message);
      process.exit(1);
    }

    try {
      const r = await fastEval(bindCode(requests));
      for (const d of r.done) {
        console.log(chalk.green('✓') + ` ${d.name} (${d.nodeId}) ${d.property} → ${d.variable}` + chalk.gray(`  [${d.collection}]`));
      }
      for (const f of r.failed) {
        console.error(chalk.red('✗') + ` ${f.nodeId} ${f.property}: ${f.reason}`);
      }
      if (r.failed.length) process.exit(1);
      if (r.done.length === 0) console.log(chalk.gray('Nothing bound.'));
    } catch (e) {
      console.error(chalk.red('✗ Bind failed: ' + e.message));
      process.exit(1);
    }
  });

// ============ SET (properties, by node id) ============
//
// Rebuilt from the deleted `set-batch`, which was registered top-level rather
// than under `variables` — so the allowlisted `var` alias never reached it and
// nothing could call it.
//
// The point of the batch form is one eval instead of N round-trips: renaming
// forty layers used to be forty daemon calls. `node rename`, `node move` and
// `node resize` still exist for the single-property case.
//
// Colours accept a hex OR `var:<name>`; a var: reference stays BOUND, so a
// later `tokens rebind` can still move it. Resolution goes through the same
// helper as `node bind`, which means an ambiguous name is reported instead of
// silently resolved to whichever collection came first.

const SET_PROPS = {
  fill:        'paint',
  stroke:      'paint',
  strokeWidth: 'number',
  radius:      'number',
  opacity:     'number',
  x:           'number',
  y:           'number',
  width:       'number',
  height:      'number',
  name:        'string',
  visible:     'boolean',
};

/**
 * Normalize one set request. Pure — exported for tests.
 * Tolerates the spellings an LLM reaches for: id/nodeId/node, w/h for
 * width/height, newName/label for name.
 */
export function parseSetRequest(entry) {
  const rawId = entry.node ?? entry.nodeId ?? entry.id;
  if (!rawId) throw new Error('missing node id');

  const alias = {
    w: 'width', h: 'height',
    newName: 'name', label: 'name',
    cornerRadius: 'radius', strokeWeight: 'strokeWidth',
  };
  const props = {};
  for (const [rawKey, value] of Object.entries(entry)) {
    if (['node', 'nodeId', 'id'].includes(rawKey)) continue;
    if (value === undefined) continue;
    const key = alias[rawKey] ?? rawKey;
    if (!(key in SET_PROPS)) {
      throw new Error(`unknown property "${rawKey}". Known: ${Object.keys(SET_PROPS).join(', ')}`);
    }
    const want = SET_PROPS[key];
    if (want === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${JSON.stringify(value)}`);
      props[key] = n;
    } else if (want === 'boolean') {
      props[key] = value === true || value === 'true';
    } else {
      props[key] = String(value);
    }
  }
  if (Object.keys(props).length === 0) throw new Error('no properties to set');
  // width and height must move together: resize() takes both.
  if (('width' in props) !== ('height' in props)) {
    throw new Error('width and height must be set together (Figma resizes in one call)');
  }
  return { nodeId: normalizeNodeId(String(rawId)).id, props };
}

/** Build the eval for a batch of already-parsed set requests. Exported for tests. */
export function setCode(requests, collection) {
  return `(async () => {
${varResolverCode()}
const requests = ${JSON.stringify(requests)};
const collection = ${JSON.stringify(collection ?? null)};

const hexToRgb = (hex) => {
  const m = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(String(hex));
  return m ? { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 } : null;
};

// hex → frozen paint; var:<name> → BOUND paint (survives a later rebind).
const toPaint = (input) => {
  if (typeof input === 'string' && input.startsWith('var:')) {
    const ref = input.slice(4);
    const res = __resolveVar(ref, collection);
    if (res.badCollection) return { _err: 'no collection matching "' + res.badCollection + '"' };
    if (!res.variable) {
      if (res.matches.length === 0) return { _err: 'no variable named "' + ref + '"' };
      return { _err: res.matches.length + ' variables match "' + ref + '" — narrow with --collection: '
                     + res.matches.map(m => m.name + ' in ' + m.collection).join(', ') };
    }
    if (res.variable.resolvedType !== 'COLOR') {
      return { _err: '"' + ref + '" is ' + res.variable.resolvedType + ', not a COLOR' };
    }
    return figma.variables.setBoundVariableForPaint(
      { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', res.variable);
  }
  const rgb = hexToRgb(input);
  return rgb ? { type: 'SOLID', color: rgb } : { _err: 'not a hex colour or var: reference: ' + input };
};

const done = [];
const failed = [];

for (const req of requests) {
  const node = await figma.getNodeByIdAsync(req.nodeId);
  if (!node) { failed.push({ nodeId: req.nodeId, reason: 'node not found' }); continue; }

  const applied = [];
  const skipped = [];
  const p = req.props;

  for (const key of ['fill', 'stroke']) {
    if (!(key in p)) continue;
    const field = key === 'fill' ? 'fills' : 'strokes';
    if (!(field in node)) { skipped.push(key + ' (' + node.type + ' has no ' + field + ')'); continue; }
    const paint = toPaint(p[key]);
    if (paint._err) { failed.push({ nodeId: req.nodeId, reason: key + ': ' + paint._err }); continue; }
    node[field] = [paint];
    applied.push(key);
  }

  const scalars = [
    ['strokeWidth', 'strokeWeight'], ['radius', 'cornerRadius'], ['opacity', 'opacity'],
    ['x', 'x'], ['y', 'y'], ['name', 'name'], ['visible', 'visible'],
  ];
  for (const [key, field] of scalars) {
    if (!(key in p)) continue;
    if (!(field in node)) { skipped.push(key + ' (' + node.type + ' has no ' + field + ')'); continue; }
    try { node[field] = p[key]; applied.push(key); }
    catch (e) { failed.push({ nodeId: req.nodeId, reason: key + ': ' + e.message }); }
  }

  if ('width' in p && 'height' in p) {
    if (!('resize' in node)) skipped.push('size (' + node.type + ' cannot resize)');
    else {
      try { node.resize(p.width, p.height); applied.push('size'); }
      catch (e) { failed.push({ nodeId: req.nodeId, reason: 'resize: ' + e.message }); }
    }
  }

  if (applied.length) done.push({ nodeId: req.nodeId, name: node.name, applied, skipped });
  else if (skipped.length) failed.push({ nodeId: req.nodeId, reason: 'nothing applied — ' + skipped.join(', ') });
}
return { done, failed };
})()`;
}

node
  .command('set [nodeId]')
  .description(`Set properties on a node, or on many at once with --batch. Properties: ${Object.keys(SET_PROPS).join(', ')}. Colours take a hex or var:<name> — a var: reference stays bound.`)
  .option('--fill <color>', 'Hex ("#ff0000") or var:<name>')
  .option('--stroke <color>', 'Hex or var:<name>')
  .option('--stroke-width <n>', 'Stroke weight')
  .option('--radius <n>', 'Corner radius')
  .option('--opacity <n>', 'Opacity, 0–1')
  .option('--x <n>', 'X position')
  .option('--y <n>', 'Y position')
  .option('--width <n>', 'Width (needs --height)')
  .option('--height <n>', 'Height (needs --width)')
  .option('--name <name>', 'Rename the layer')
  .option('--visible <bool>', 'true / false')
  .option('-c, --collection <name>', 'Which collection var:<name> resolves in')
  .option('--batch <json>', 'Many at once: [{"node":"1:2","name":"Card","fill":"var:sage/50"}, …]')
  .action(async (nodeId, options) => {
    await checkConnection();

    let entries;
    if (options.batch) {
      try {
        entries = JSON.parse(options.batch);
      } catch (e) {
        console.error(chalk.red('✗'), `--batch is not valid JSON: ${e.message}`);
        process.exit(1);
      }
      if (!Array.isArray(entries) || entries.length === 0) {
        console.error(chalk.red('✗'), '--batch expects a non-empty JSON array');
        process.exit(1);
      }
    } else {
      if (!nodeId) {
        console.error(chalk.red('✗'), 'Name a node id, or pass --batch.');
        process.exit(1);
      }
      const single = { node: nodeId };
      for (const [flag, key] of [['fill', 'fill'], ['stroke', 'stroke'], ['strokeWidth', 'strokeWidth'],
                                 ['radius', 'radius'], ['opacity', 'opacity'], ['x', 'x'], ['y', 'y'],
                                 ['width', 'width'], ['height', 'height'], ['name', 'name'],
                                 ['visible', 'visible']]) {
        if (options[flag] !== undefined) single[key] = options[flag];
      }
      entries = [single];
    }

    let requests;
    try {
      requests = entries.map((e, i) => {
        try { return parseSetRequest(e); }
        catch (err) { throw new Error(`entry ${i}: ${err.message}`); }
      });
    } catch (e) {
      console.error(chalk.red('✗'), e.message);
      process.exit(1);
    }

    try {
      const r = await fastEval(setCode(requests, options.collection));
      for (const d of r.done) {
        console.log(chalk.green('✓') + ` ${d.name} (${d.nodeId}): ${d.applied.join(', ')}`);
        for (const s of d.skipped) console.log(chalk.gray(`    skipped ${s}`));
      }
      for (const f of r.failed) {
        console.error(chalk.red('✗') + ` ${f.nodeId}: ${f.reason}`);
      }
      if (r.failed.length) process.exit(1);
      if (r.done.length === 0) console.log(chalk.gray('Nothing set.'));
    } catch (e) {
      console.error(chalk.red('✗ Set failed: ' + e.message));
      process.exit(1);
    }
  });
