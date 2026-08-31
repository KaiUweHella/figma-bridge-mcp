// Commands: node-ops (extracted from index.js)
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import {
  program,
  checkConnection,
  daemonExec,
  daemonTypedRead,
  fastEval
} from '../lib/cli-core.js';
import { normalizeNodeId } from '../lib/node-id.js';
import { generateFillCode, isVarRef, varLoadingCode, varResolverCode } from '../lib/eval-snippets.js';
import { readImageBase64 } from '../lib/image-file.js';
import {
  executeNodeCssPlan,
  nodeCssPlanningArgvFromRequest,
} from '../application/node-css-command.js';
import {
  executeNodeBindingsPlan,
  nodeBindingsPlanningArgvFromRequest,
} from '../application/node-bindings-command.js';
import {
  executeNodeTextPlan,
  formatNodeTextResult,
  nodeTextPlanningArgvFromRequest,
  nodeTextResultRows,
} from '../application/node-text-command.js';
import {
  executeNodeMovePlan,
  formatNodeMoveResult,
  nodeMoveRequestFromArgv,
} from '../application/node-move-command.js';
import {
  executeNodeDuplicatePlan,
  nodeDuplicatePlanningArgvFromRequest,
} from '../application/node-duplicate-command.js';
import {
  executeNodeRenamePlan,
  nodeRenamePlanningArgvFromRequest,
} from '../application/node-rename-command.js';
import {
  executeNodeResizePlan,
  nodeResizePlanningArgvFromRequest,
} from '../application/node-resize-command.js';
import {
  executeNodeReparentPlan,
  nodeReparentPlanningArgvFromRequest,
} from '../application/node-reparent-command.js';
import {
  executeNodeGroupPlan,
  nodeGroupPlanningArgvFromRequest,
} from '../application/node-group-command.js';
import {
  executeNodeDeletePlan,
  formatNodeDeleteResult,
  nodeDeletePlanningArgvFromRequest,
} from '../application/node-delete-command.js';
import {
  executeNodeToComponentPlan,
  nodeToComponentPlanningArgvFromRequest,
} from '../application/node-to-component-command.js';
import { finiteNodeCoordinate } from '../application/node-coordinate.js';
import {
  executeNodeTreePlan,
  nodeTreePlanningArgvFromRequest,
} from '../application/node-tree-command.js';

// ============ NODE OPERATIONS ============

const node = program
  .command('node')
  .description('Node operations (tree, bindings, to-component)');

node
  .command('tree [nodeId]')
  .description('Show node tree structure')
  .option('-d, --depth <n>', 'Max depth', '3')
  .option('--ids', 'Append each node\'s id ([12:34]) — for follow-up inspect/spec/screenshot calls')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const plan = planFigmaCommand(nodeTreePlanningArgvFromRequest({
        nodeId: nodeId || null,
        depth: options.depth,
        withIds: options.ids === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeTreePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Tree failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

node
  .command('bindings [nodeId]')
  .description('Show variable bindings for node')
  .option('--json', 'Output bounded direct Node Binding Facts as JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const plan = planFigmaCommand(nodeBindingsPlanningArgvFromRequest({
        nodeId: nodeId || null,
        json: options.json === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeBindingsPlan(plan, {
            typedRead: (operation, request, fallbackCode) => daemonTypedRead(
              operation, request, fallbackCode,
              fileKey ? { fileKey } : {}, Math.max(1, deadline - Date.now()),
            ),
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Bindings failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

node
  .command('css <nodeId>')
  .description("Read the node's native Figma Inspect CSS via getCSSAsync() (not token CSS)")
  .option('--json', 'Output node metadata and CSS as JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const plan = planFigmaCommand(nodeCssPlanningArgvFromRequest({
        nodeId,
        json: options.json === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeCssPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Native CSS failed: ' + error.message));
      process.exitCode = 1;
    }
  });

node
  .command('to-component <nodeIds...>')
  .description('Convert frames to components')
  .allowExcessArguments(false)
  .action(async (nodeIds) => {
    try {
      const plan = planFigmaCommand(nodeToComponentPlanningArgvFromRequest({ nodeIds }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeToComponentPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Convert failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

function normalizedNodeIds(values) {
  return values.map((value) => normalizeNodeId(String(value)).id);
}

function structuralParentOptions(command) {
  return command
    .option('--parent <nodeId>', 'Use this parent instead of the first node\'s current parent')
    .option('--index <n>', 'Insert at this child index')
    .option('--name <name>', 'Name the resulting node')
    .option('--json', 'Output as JSON');
}

function structuralRequest(nodeIds, options, minimum = 1) {
  const ids = normalizedNodeIds(nodeIds);
  if (ids.length < minimum) throw new Error(`Provide at least ${minimum} node id${minimum === 1 ? '' : 's'}`);
  if (new Set(ids).size !== ids.length) throw new Error('Node ids must be unique');
  const parentId = options.parent ? normalizeNodeId(String(options.parent)).id : null;
  const index = options.index === undefined ? null : Number(options.index);
  if (index !== null && (!Number.isInteger(index) || index < 0)) {
    throw new Error('--index must be a non-negative integer');
  }
  return { ids, parentId, index };
}

function structuralPrelude({ ids, parentId, index }) {
  return `const ids = ${JSON.stringify(ids)};
const nodes = [];
for (const id of ids) {
  const candidate = await figma.getNodeByIdAsync(id);
  if (!candidate || candidate.type === 'DOCUMENT' || candidate.type === 'PAGE') throw new Error('Canvas node not found: ' + id);
  nodes.push(candidate);
}
let parent = ${parentId ? `await figma.getNodeByIdAsync(${JSON.stringify(parentId)})` : 'nodes[0].parent'};
if (!parent || typeof parent.appendChild !== 'function') throw new Error('Target parent cannot contain children');
${parentId ? '' : `if (nodes.some(candidate => !candidate.parent || candidate.parent.id !== parent.id)) throw new Error('Nodes must share one parent unless --parent is provided');`}
${index === null ? 'const insertionIndex = undefined;' : `if (${index} > parent.children.length) throw new Error('Index out of range: ' + ${index}); const insertionIndex = ${index};`}`;
}

structuralParentOptions(node
  .command('group <nodeIds...>')
  .description('Group two or more explicit node IDs'))
  .action(async (nodeIds, options) => {
    try {
      const plan = planFigmaCommand(nodeGroupPlanningArgvFromRequest({
        nodeIds, parentId: options.parent || null,
        index: options.index === undefined ? null : options.index,
        name: options.name === undefined ? null : options.name,
        json: options.json === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeGroupPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Group failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

node
  .command('ungroup <nodeId>')
  .description('Ungroup an explicit group or transform group')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    try {
      const id = normalizeNodeId(String(nodeId)).id;
      await checkConnection();
      const result = await fastEval(`(async () => {
const target = await figma.getNodeByIdAsync(${JSON.stringify(id)});
if (!target || !['GROUP', 'TRANSFORM_GROUP'].includes(target.type)) throw new Error('Expected GROUP or TRANSFORM_GROUP: ' + ${JSON.stringify(id)});
const parentId = target.parent ? target.parent.id : null;
const children = figma.ungroup(target);
return { parentId, children: children.map(child => ({ id: child.id, name: child.name, type: child.type })) };
})()`);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(chalk.green('✓'), `Ungrouped ${result.children.length} nodes into ${result.parentId}`);
    } catch (error) { handleEvalError(error); }
  });

structuralParentOptions(node
  .command('boolean <operation> <nodeIds...>')
  .description('Combine explicit nodes with union, subtract, intersect, or exclude'))
  .action(async (operation, nodeIds, options) => {
    try {
      const method = String(operation).toLowerCase();
      if (!['union', 'subtract', 'intersect', 'exclude'].includes(method)) {
        throw new Error('Operation must be union, subtract, intersect, or exclude');
      }
      const request = structuralRequest(nodeIds, options, 2);
      await checkConnection();
      const result = await fastEval(`(async () => {
${structuralPrelude(request)}
const result = figma[${JSON.stringify(method)}](nodes, parent, insertionIndex);
${options.name ? `result.name = ${JSON.stringify(options.name)};` : ''}
return { id: result.id, name: result.name, type: result.type, operation: result.booleanOperation, parentId: result.parent ? result.parent.id : null };
})()`);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(chalk.green('✓'), `${result.operation} created as "${result.name}" (${result.id})`);
    } catch (error) { handleEvalError(error); }
  });

structuralParentOptions(node
  .command('flatten <nodeIds...>')
  .description('Flatten one or more explicit nodes into one vector'))
  .action(async (nodeIds, options) => {
    try {
      const request = structuralRequest(nodeIds, options, 1);
      await checkConnection();
      const result = await fastEval(`(async () => {
${structuralPrelude(request)}
const result = figma.flatten(nodes, parent, insertionIndex);
${options.name ? `result.name = ${JSON.stringify(options.name)};` : ''}
return { id: result.id, name: result.name, type: result.type, parentId: result.parent ? result.parent.id : null };
})()`);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else console.log(chalk.green('✓'), `Flattened to "${result.name}" (${result.id})`);
    } catch (error) { handleEvalError(error); }
  });

node
  .command('duplicate <nodeId>')
  .description('Duplicate any cloneable canvas node (including frames and sections)')
  .option('--parent <nodeId>', 'Place the copy inside this parent instead of beside the source')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .option('--name <name>', 'Rename the copy')
  .option('--offset-x <n>', 'Horizontal offset from the source', '40')
  .option('--offset-y <n>', 'Vertical offset from the source', '40')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const plan = planFigmaCommand(nodeDuplicatePlanningArgvFromRequest({
        nodeId,
        parentId: options.parent || null,
        index: options.index,
        name: options.name,
        offsetX: options.offsetX,
        offsetY: options.offsetY,
        json: options.json === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeDuplicatePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Duplicate failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

node
  .command('reparent <nodeId> <parentId>')
  .description('Move a canvas node into another page, frame, section, component, or group')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .option('--no-preserve-position', 'Use the node\'s existing local x/y instead of preserving its canvas position')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, parentId, options) => {
    try {
      const plan = planFigmaCommand(nodeReparentPlanningArgvFromRequest({
        nodeId, parentId,
        index: options.index === undefined ? null : options.index,
        preservePosition: options.preservePosition !== false,
        json: options.json === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeReparentPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Reparent failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

async function runNodeMoveCommand(argv) {
  nodeMoveRequestFromArgv(argv);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      const result = await executeNodeMovePlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
      return { stdout: formatNodeMoveResult(result), stderr: '', code: 0 };
    });
}

node
  .command('move [args...]')
  .usage('<nodeId> <x> <y> [--page <nameOrId>]')
  .description('Move a node to an absolute canvas position (top-left corner). Sections move with their children.')
  // Commander normally consumes signed numbers as options. Retain every raw
  // token and let the closed request Interface distinguish them fail-closed.
  .allowUnknownOption(true)
  .addHelpText('after', '\nAdditional accepted syntax:\n  -p, --page <nameOrId>  Reparent onto this page before positioning')
  .action(async (args) => {
    try {
      const result = await runNodeMoveCommand(['node', 'move', ...args]);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Move failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

node
  .command('resize <nodeId> <width> <height>')
  .description('Resize a node (keeps position). Per dimension: a number, "keep" (unchanged), "fill" or "hug" (auto-layout sizing).')
  .allowExcessArguments(false)
  .action(async (nodeId, width, height) => {
    try {
      const plan = planFigmaCommand(nodeResizePlanningArgvFromRequest({ nodeId, width, height }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeResizePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Resize failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

node
  .command('rename <nodeId> <name>')
  .description('Rename a node')
  .allowExcessArguments(false)
  .action(async (nodeId, name) => {
    try {
      const plan = planFigmaCommand(nodeRenamePlanningArgvFromRequest({ nodeId, name }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeRenamePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Rename failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

function renderNodeTextRows(rows) {
  for (const row of rows) {
    const marker = row.markerTone === 'success' ? chalk.green(row.marker) : row.marker;
    console.log(marker, row.text);
  }
}

async function runNodeTextCommand(request) {
  const plan = planFigmaCommand(nodeTextPlanningArgvFromRequest(request), {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  let domainResult = null;
  await runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      domainResult = await executeNodeTextPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
      return { stdout: formatNodeTextResult(domainResult), stderr: '', code: 0 };
    });
  return domainResult;
}

node
  .command('set-text <nodeId> <text>')
  .description('Replace the characters of a TEXT node (loads its fonts first; works on instance sub-texts too)')
  .allowExcessArguments(false)
  .action(async (nodeId, text) => {
    try {
      const result = await runNodeTextCommand({ nodeId, text });
      renderNodeTextRows(nodeTextResultRows(result));
    } catch (error) {
      console.error(chalk.red('✗'), error?.message || String(error));
      process.exitCode = 1;
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
      process.exitCode = 1;
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
      process.exitCode = 1;
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
      process.exitCode = 1;
    }
  });

node
  .command('delete <nodeIds...>')
  .description('Delete nodes by ID')
  .action(async (nodeIds) => {
    try {
      const plan = planFigmaCommand(nodeDeletePlanningArgvFromRequest({ nodeIds }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          const domainResult = await executeNodeDeletePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
          return { stdout: formatNodeDeleteResult(domainResult), stderr: '', code: 0 };
        });
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Delete failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
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
  .option('--batch <json>', 'Temporarily disabled until bounded typed batch mutation is available')
  .action(async (nodeId, property, varName, options) => {
    if (options.batch) {
      console.error(chalk.red('✗ node bind --batch is temporarily disabled.'));
      console.error(chalk.gray('  Run one explicit node bind command per node.'));
      process.exitCode = 1;
      return;
    }
    await checkConnection();

    const entries = [{ node: nodeId, property, variable: varName }];

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

const SET_ENUMS = Object.freeze({
  blendMode: ['PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'],
  strokeAlign: ['CENTER', 'INSIDE', 'OUTSIDE'],
  strokeCap: ['NONE', 'ROUND', 'SQUARE', 'ARROW_LINES', 'ARROW_EQUILATERAL', 'DIAMOND_FILLED', 'TRIANGLE_FILLED', 'CIRCLE_FILLED'],
  strokeJoin: ['MITER', 'BEVEL', 'ROUND'],
  maskType: ['ALPHA', 'VECTOR', 'LUMINANCE'],
  layoutMode: ['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID'],
  layoutWrap: ['NO_WRAP', 'WRAP'],
  primaryAxisAlign: ['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN'],
  counterAxisAlign: ['MIN', 'MAX', 'CENTER', 'BASELINE'],
  layoutSizingHorizontal: ['FIXED', 'HUG', 'FILL'],
  layoutSizingVertical: ['FIXED', 'HUG', 'FILL'],
  layoutAlign: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT'],
  layoutPositioning: ['AUTO', 'ABSOLUTE'],
  constraintsHorizontal: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'],
  constraintsVertical: ['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE'],
});

const SET_PROPS = Object.freeze({
  fill: 'paint', stroke: 'paint', effects: 'json-array',
  strokeWidth: 'number', strokeTopWidth: 'number', strokeRightWidth: 'number',
  strokeBottomWidth: 'number', strokeLeftWidth: 'number', strokeMiterLimit: 'number',
  strokeAlign: 'enum', strokeCap: 'enum', strokeJoin: 'enum', dashPattern: 'number-list',
  radius: 'number', radii: 'radii', cornerSmoothing: 'number',
  opacity: 'number', blendMode: 'enum', visible: 'boolean', locked: 'boolean',
  isMask: 'boolean', maskType: 'enum', clip: 'boolean', constrainProportions: 'boolean',
  x: 'number', y: 'number', width: 'number', height: 'number', rotation: 'number',
  minWidth: 'nullable-number', maxWidth: 'nullable-number', minHeight: 'nullable-number', maxHeight: 'nullable-number',
  name: 'string',
  constraintsHorizontal: 'enum', constraintsVertical: 'enum',
  layoutMode: 'enum', layoutWrap: 'enum', primaryAxisAlign: 'enum', counterAxisAlign: 'enum',
  layoutSizingHorizontal: 'enum', layoutSizingVertical: 'enum', layoutAlign: 'enum',
  layoutPositioning: 'enum', layoutGrow: 'number', itemSpacing: 'number', counterAxisSpacing: 'nullable-number',
  padding: 'number', paddingTop: 'number', paddingRight: 'number', paddingBottom: 'number', paddingLeft: 'number',
  pointCount: 'number', innerRadius: 'number', sectionContentsHidden: 'boolean',
});

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
    rotate: 'rotation', clipsContent: 'clip',
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
      let n;
      try {
        n = key === 'x' || key === 'y'
          ? finiteNodeCoordinate(value, key)
          : Number(value);
      } catch (error) {
        throw new Error(error.message);
      }
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${JSON.stringify(value)}`);
      props[key] = n;
    } else if (want === 'nullable-number') {
      if (value === null || /^(none|null)$/i.test(String(value))) props[key] = null;
      else {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`${key} must be a number or null, got ${JSON.stringify(value)}`);
        props[key] = n;
      }
    } else if (want === 'boolean') {
      if (value === true || value === false) props[key] = value;
      else if (/^(true|false)$/i.test(String(value))) props[key] = String(value).toLowerCase() === 'true';
      else throw new Error(`${key} must be true or false`);
    } else if (want === 'enum') {
      let normalized = String(value).trim().toUpperCase().replace(/[ -]+/g, '_');
      if (key === 'layoutMode' && normalized === 'ROW') normalized = 'HORIZONTAL';
      if (key === 'layoutMode' && ['COL', 'COLUMN'].includes(normalized)) normalized = 'VERTICAL';
      if (!SET_ENUMS[key].includes(normalized)) throw new Error(`${key} must be one of: ${SET_ENUMS[key].join(', ')}`);
      props[key] = normalized;
    } else if (want === 'number-list' || want === 'radii') {
      const values = Array.isArray(value) ? value : String(value).split(',');
      const numbers = values.map((item) => Number(item));
      if (numbers.some((number) => !Number.isFinite(number) || number < 0)) throw new Error(`${key} must contain non-negative numbers`);
      if (want === 'radii' && numbers.length !== 4) throw new Error('radii must contain four values: top-left, top-right, bottom-right, bottom-left');
      props[key] = numbers;
    } else if (want === 'json-array') {
      let parsed = value;
      if (typeof value === 'string') {
        try { parsed = JSON.parse(value); }
        catch (error) { throw new Error(`${key} must be valid JSON: ${error.message}`); }
      }
      if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error(`${key} must be a JSON array of Figma effect objects`);
      }
      props[key] = parsed;
    } else {
      props[key] = String(value);
    }
  }
  if (Object.keys(props).length === 0) throw new Error('no properties to set');
  // width and height must move together: resize() takes both.
  if (('width' in props) !== ('height' in props)) {
    throw new Error('width and height must be set together (Figma resizes in one call)');
  }
  if ('opacity' in props && (props.opacity < 0 || props.opacity > 1)) throw new Error('opacity must be between 0 and 1');
  if ('cornerSmoothing' in props && (props.cornerSmoothing < 0 || props.cornerSmoothing > 1)) throw new Error('cornerSmoothing must be between 0 and 1');
  if ('innerRadius' in props && (props.innerRadius < 0 || props.innerRadius > 1)) throw new Error('innerRadius must be between 0 and 1');
  if ('pointCount' in props && (!Number.isInteger(props.pointCount) || props.pointCount < 3)) throw new Error('pointCount must be an integer of at least 3');
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
    ['strokeWidth', 'strokeWeight'], ['strokeTopWidth', 'strokeTopWeight'],
    ['strokeRightWidth', 'strokeRightWeight'], ['strokeBottomWidth', 'strokeBottomWeight'],
    ['strokeLeftWidth', 'strokeLeftWeight'], ['strokeMiterLimit', 'strokeMiterLimit'],
    ['strokeAlign', 'strokeAlign'], ['strokeCap', 'strokeCap'], ['strokeJoin', 'strokeJoin'],
    ['radius', 'cornerRadius'], ['cornerSmoothing', 'cornerSmoothing'],
    ['opacity', 'opacity'], ['blendMode', 'blendMode'], ['visible', 'visible'], ['locked', 'locked'],
    ['isMask', 'isMask'], ['maskType', 'maskType'], ['clip', 'clipsContent'],
    ['constrainProportions', 'constrainProportions'],
    ['x', 'x'], ['y', 'y'], ['rotation', 'rotation'], ['name', 'name'],
    ['minWidth', 'minWidth'], ['maxWidth', 'maxWidth'], ['minHeight', 'minHeight'], ['maxHeight', 'maxHeight'],
    ['layoutMode', 'layoutMode'], ['layoutWrap', 'layoutWrap'],
    ['primaryAxisAlign', 'primaryAxisAlignItems'], ['counterAxisAlign', 'counterAxisAlignItems'],
    ['layoutSizingHorizontal', 'layoutSizingHorizontal'], ['layoutSizingVertical', 'layoutSizingVertical'],
    ['layoutAlign', 'layoutAlign'], ['layoutPositioning', 'layoutPositioning'], ['layoutGrow', 'layoutGrow'],
    ['itemSpacing', 'itemSpacing'], ['counterAxisSpacing', 'counterAxisSpacing'],
    ['paddingTop', 'paddingTop'], ['paddingRight', 'paddingRight'], ['paddingBottom', 'paddingBottom'], ['paddingLeft', 'paddingLeft'],
    ['pointCount', 'pointCount'], ['innerRadius', 'innerRadius'], ['sectionContentsHidden', 'sectionContentsHidden'],
  ];
  for (const [key, field] of scalars) {
    if (!(key in p)) continue;
    if (!(field in node)) { skipped.push(key + ' (' + node.type + ' has no ' + field + ')'); continue; }
    try { node[field] = p[key]; applied.push(key); }
    catch (e) { failed.push({ nodeId: req.nodeId, reason: key + ': ' + e.message }); }
  }

  if ('padding' in p) {
    const fields = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
    if (fields.some(field => !(field in node))) skipped.push('padding (' + node.type + ' has no Auto Layout padding)');
    else {
      try { for (const field of fields) node[field] = p.padding; applied.push('padding'); }
      catch (e) { failed.push({ nodeId: req.nodeId, reason: 'padding: ' + e.message }); }
    }
  }

  if ('radii' in p) {
    const fields = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
    if (fields.some(field => !(field in node))) skipped.push('radii (' + node.type + ' has no individual corners)');
    else {
      try { fields.forEach((field, index) => { node[field] = p.radii[index]; }); applied.push('radii'); }
      catch (e) { failed.push({ nodeId: req.nodeId, reason: 'radii: ' + e.message }); }
    }
  }

  if ('dashPattern' in p) {
    if (!('dashPattern' in node)) skipped.push('dashPattern (' + node.type + ' has no strokes)');
    else {
      try { node.dashPattern = p.dashPattern; applied.push('dashPattern'); }
      catch (e) { failed.push({ nodeId: req.nodeId, reason: 'dashPattern: ' + e.message }); }
    }
  }

  if ('effects' in p) {
    if (!('effects' in node)) skipped.push('effects (' + node.type + ' has no effects)');
    else {
      try { node.effects = p.effects; applied.push('effects'); }
      catch (e) { failed.push({ nodeId: req.nodeId, reason: 'effects: ' + e.message }); }
    }
  }

  if ('constraintsHorizontal' in p || 'constraintsVertical' in p) {
    if (!('constraints' in node)) skipped.push('constraints (' + node.type + ' has no constraints)');
    else {
      try {
        node.constraints = {
          horizontal: p.constraintsHorizontal || node.constraints.horizontal,
          vertical: p.constraintsVertical || node.constraints.vertical,
        };
        applied.push('constraints');
      } catch (e) { failed.push({ nodeId: req.nodeId, reason: 'constraints: ' + e.message }); }
    }
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
  .option('--effects <json>', 'Figma Effect[] JSON')
  .option('--stroke-width <n>', 'Stroke weight')
  .option('--stroke-top-width <n>', 'Top stroke weight')
  .option('--stroke-right-width <n>', 'Right stroke weight')
  .option('--stroke-bottom-width <n>', 'Bottom stroke weight')
  .option('--stroke-left-width <n>', 'Left stroke weight')
  .option('--stroke-miter-limit <n>', 'Miter limit')
  .option('--stroke-align <value>', 'center, inside, or outside')
  .option('--stroke-cap <value>', 'none, round, square, or an arrow/shape cap')
  .option('--stroke-join <value>', 'miter, bevel, or round')
  .option('--dash-pattern <values>', 'Comma-separated dash and gap lengths')
  .option('--radius <n>', 'Corner radius')
  .option('--radii <values>', 'Four corners: top-left,top-right,bottom-right,bottom-left')
  .option('--corner-smoothing <n>', 'Corner smoothing, 0–1')
  .option('--opacity <n>', 'Opacity, 0–1')
  .option('--blend-mode <value>', 'Figma blend mode')
  .option('--locked <bool>', 'true / false')
  .option('--clip <bool>', 'Clip frame contents')
  .option('--is-mask <bool>', 'Use this node as a mask')
  .option('--mask-type <value>', 'alpha, vector, or luminance')
  .option('--constrain-proportions <bool>', 'Lock or unlock aspect ratio')
  .option('--x <n>', 'X position')
  .option('--y <n>', 'Y position')
  .option('--rotation <n>', 'Rotation in degrees')
  .option('--width <n>', 'Width (needs --height)')
  .option('--height <n>', 'Height (needs --width)')
  .option('--min-width <n>', 'Minimum width, or null')
  .option('--max-width <n>', 'Maximum width, or null')
  .option('--min-height <n>', 'Minimum height, or null')
  .option('--max-height <n>', 'Maximum height, or null')
  .option('--name <name>', 'Rename the layer')
  .option('--visible <bool>', 'true / false')
  .option('--constraints-horizontal <value>', 'min, center, max, stretch, or scale')
  .option('--constraints-vertical <value>', 'min, center, max, stretch, or scale')
  .option('--layout-mode <value>', 'none, horizontal/row, vertical/column, or grid')
  .option('--layout-wrap <value>', 'no-wrap or wrap')
  .option('--primary-axis-align <value>', 'min, max, center, or space-between')
  .option('--counter-axis-align <value>', 'min, max, center, or baseline')
  .option('--layout-sizing-horizontal <value>', 'fixed, hug, or fill')
  .option('--layout-sizing-vertical <value>', 'fixed, hug, or fill')
  .option('--layout-align <value>', 'min, center, max, stretch, or inherit')
  .option('--layout-positioning <value>', 'auto or absolute')
  .option('--layout-grow <n>', 'Auto Layout grow value')
  .option('--item-spacing <n>', 'Auto Layout item spacing')
  .option('--counter-axis-spacing <n>', 'Wrapped-row spacing, or null')
  .option('--padding <n>', 'Set all four Auto Layout paddings')
  .option('--padding-top <n>', 'Top padding')
  .option('--padding-right <n>', 'Right padding')
  .option('--padding-bottom <n>', 'Bottom padding')
  .option('--padding-left <n>', 'Left padding')
  .option('--point-count <n>', 'Polygon sides or star points')
  .option('--inner-radius <n>', 'Star inner radius, 0–1')
  .option('--section-contents-hidden <bool>', 'Hide or reveal section contents')
  .option('-c, --collection <name>', 'Which collection var:<name> resolves in')
  .option('--batch <json>', 'Temporarily disabled until bounded typed batch mutation is available')
  .action(async (nodeId, options) => {
    if (options.batch) {
      console.error(chalk.red('✗ node set --batch is temporarily disabled.'));
      console.error(chalk.gray('  Run one explicit node set command per node.'));
      process.exitCode = 1;
      return;
    }
    await checkConnection();

    if (!nodeId) {
      console.error(chalk.red('✗'), 'Name one explicit node id.');
      process.exitCode = 1;
      return;
    }
    const single = { node: nodeId };
    for (const key of Object.keys(SET_PROPS)) {
      if (options[key] !== undefined) single[key] = options[key];
    }
    const entries = [single];

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
