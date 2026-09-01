// Commands: node-ops (extracted from index.js)
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import {
  program,
  daemonExec,
  daemonTypedRead,
} from '../lib/cli-core.js';
import { workspaceIO } from '../lib/workspace-io.js';
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
  executeNodeUngroupPlan,
  nodeUngroupPlanningArgvFromRequest,
} from '../application/node-ungroup-command.js';
import {
  executeNodeBooleanPlan,
  nodeBooleanPlanningArgvFromRequest,
} from '../application/node-boolean-command.js';
import {
  executeNodeBindPlan,
  nodeBindPlanningArgvFromRequest,
} from '../application/node-bind-command.js';
import { NODE_BIND_PROPERTIES } from '../application/node-bind-request.js';
import {
  executeNodeSetFillPlan,
  nodeSetFillPlanningArgvFromRequest,
} from '../application/node-set-fill-command.js';
import {
  executePreparedNodeSetImage,
  nodeSetImagePlanningArgvFromRequest,
  prepareNodeSetImagePlan,
} from '../application/node-set-image-command.js';
import {
  executeNodeSetPlan,
  nodeSetPlanningArgvFromRequest,
} from '../application/node-set-command.js';
import { NODE_SET_PROPERTIES, parseSetRequest as parseNodeSetEntry } from '../application/node-set-request.js';
import { executeNodeFlattenPlan, nodeFlattenPlanningArgvFromRequest } from '../application/node-flatten-command.js';
import {
  executeNodeDeletePlan,
  formatNodeDeleteResult,
  nodeDeletePlanningArgvFromRequest,
} from '../application/node-delete-command.js';
import {
  executeNodeToComponentPlan,
  nodeToComponentPlanningArgvFromRequest,
} from '../application/node-to-component-command.js';
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

function structuralParentOptions(command) {
  return command
    .option('--parent <nodeId>', 'Use this parent instead of the first node\'s current parent')
    .option('--index <n>', 'Insert at this child index')
    .option('--name <name>', 'Name the resulting node')
    .option('--json', 'Output as JSON');
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
      const plan = planFigmaCommand(nodeUngroupPlanningArgvFromRequest({ nodeId, json: options.json === true }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false }, async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeNodeUngroupPlan(plan, { evaluate: (code) => daemonExec('eval', { code, ...(fileKey ? { fileKey } : {}) }, Math.max(1, deadline - Date.now())) });
      });
      console.log(result.stdout);
    } catch (error) { console.error(chalk.red('✗ Ungroup failed: ' + (error?.message || String(error)))); process.exitCode = 1; }
  });

structuralParentOptions(node
  .command('boolean <operation> <nodeIds...>')
  .description('Combine explicit nodes with union, subtract, intersect, or exclude'))
  .action(async (operation, nodeIds, options) => {
    try {
      const plan = planFigmaCommand(nodeBooleanPlanningArgvFromRequest({
        operation, nodeIds, parentId: options.parent || null, index: options.index ?? null,
        name: options.name ?? null, json: options.json === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeBooleanPlan(plan, { evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())) });
        });
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Boolean failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

structuralParentOptions(node
  .command('flatten <nodeIds...>')
  .description('Flatten one or more explicit nodes into one vector'))
  .action(async (nodeIds, options) => {
    try {
      const plan = planFigmaCommand(nodeFlattenPlanningArgvFromRequest({ nodeIds, parentId: options.parent || null, index: options.index ?? null, name: options.name ?? null, json: options.json === true }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false }, async ({ fileKey, deadline }) => { await ensurePluginReadiness({ deadline, maxWaitMs: 8000 }); return executeNodeFlattenPlan(plan, { evaluate: (code) => daemonExec('eval', { code, ...(fileKey ? { fileKey } : {}) }, Math.max(1, deadline - Date.now())) }); });
      console.log(result.stdout);
    } catch (error) { console.error(chalk.red('✗ Flatten failed: ' + (error?.message || String(error)))); process.exitCode = 1; }
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
  .allowExcessArguments(false)
  .action(async (nodeId, color) => {
    try {
      const plan = planFigmaCommand(nodeSetFillPlanningArgvFromRequest({ nodeId, color }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeSetFillPlan(plan, { evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())) });
        });
      console.log(chalk.green('✓'), result.stdout);
    } catch (error) {
      console.log(chalk.red('✗ set-fill failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

node
  .command('set-image <nodeId> <file>')
  .description('Set a local image file (png/jpg/gif/webp) as the fill of a node — turns render placeholders into real images')
  .option('--scale <mode>', 'Scale mode: FILL, FIT, CROP, TILE', 'FILL')
  .allowExcessArguments(false)
  .action(async (nodeId, file, options) => {
    try {
      const io = workspaceIO();
      const plan = planFigmaCommand(nodeSetImagePlanningArgvFromRequest({
        nodeId, file, scale: options.scale,
      }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
        workspaceDir: io.roots[0], workspaceIO: io,
      });
      const prepared = prepareNodeSetImagePlan(plan, { workspaceIO: io });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executePreparedNodeSetImage(prepared, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(chalk.green('✓'), result.stdout);
    } catch (error) {
      console.log(chalk.red('✗ set-image failed: ' + (error?.message || String(error))));
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


node
  .command('bind [nodeId] [property] [varName]')
  .description(`Bind a variable to a node property, by id. Properties: ${Object.keys(NODE_BIND_PROPERTIES).join(', ')}. The read counterpart is \`node bindings\`.`)
  .option('-c, --collection <name>', 'Which collection the variable comes from (required when the name is not unique)')
  .option('--batch <json>', 'Temporarily disabled until bounded typed batch mutation is available')
  .allowExcessArguments(false)
  .action(async (nodeId, property, varName, options) => {
    if (options.batch) {
      console.error(chalk.red('✗ node bind --batch is temporarily disabled.'));
      console.error(chalk.gray('  Run one explicit node bind command per node.'));
      process.exitCode = 1;
      return;
    }
    try {
      const plan = planFigmaCommand(nodeBindPlanningArgvFromRequest({
        nodeId, property, variable: varName, collection: options.collection || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeBindPlan(plan, { evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())) });
        });
      console.log(chalk.green('✓'), result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Bind failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// ============ SET (properties, by node id) ============
//
// The single-node surface delegates its complete typed request to one
// journaled Application. The legacy batch form remains gated separately.

node
  .command('set [nodeId]')
  .description(`Set properties on one node. Properties: ${Object.keys(NODE_SET_PROPERTIES).join(', ')}. Colours take a hex or var:<name> — a var: reference stays bound.`)
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
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    if (options.batch) {
      console.error(chalk.red('✗ node set --batch is temporarily disabled.'));
      console.error(chalk.gray('  Run one explicit node set command per node.'));
      process.exitCode = 1;
      return;
    }
    try {
      if (!nodeId) throw new Error('Name one explicit node id.');
      const single = { node: nodeId, collection: options.collection ?? null };
      for (const key of Object.keys(NODE_SET_PROPERTIES)) {
        if (options[key] !== undefined) single[key] = options[key];
      }
      const request = parseNodeSetEntry(single);
      const plan = planFigmaCommand(nodeSetPlanningArgvFromRequest(request), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeNodeSetPlan(plan, { evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())) });
        });
      console.log(chalk.green('✓'), result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Set failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });
