import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeGridAutoFlowPlan,
  gridAutoFlowArgvFromRequest,
} from '../application/grid-auto-flow-command.js';
import {
  executeGridPlacePlan,
  gridPlaceArgvFromRequest,
} from '../application/grid-place-command.js';
import {
  executeGridSetPlan,
  gridSetArgvFromRequest,
} from '../application/grid-set-command.js';
import {
  executeGridTrackReorderPlan,
  gridTrackReorderArgvFromRequest,
} from '../application/grid-track-reorder-command.js';
import { checkConnection, daemonExec, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import { gridLayoutInspectCode } from '../lib/grid-layout-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const layout = program.command('layout').description('Manage native Auto Layout features');
const grid = layout.command('grid').description('Manage Auto Layout Grid containers (not Layout Guides)');

async function runGridAutoFlow(request) {
  try {
    const plan = planFigmaCommand(gridAutoFlowArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeGridAutoFlowPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runGridPlace(request) {
  try {
    const plan = planFigmaCommand(gridPlaceArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeGridPlacePlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runGridTrackReorder(request) {
  try {
    const plan = planFigmaCommand(gridTrackReorderArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeGridTrackReorderPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runGridSet(request) {
  try {
    const plan = planFigmaCommand(gridSetArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeGridSetPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

grid.command('inspect <nodeId>').action(async (nodeId) => { try { print(await run(gridLayoutInspectCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
grid.command('set <nodeId>')
  .option('--rows <count>').option('--columns <count>').option('--row-gap <pixels>').option('--column-gap <pixels>')
  .option('--row-sizes <json>', 'Track array, e.g. [{"type":"FIXED","value":100}]')
  .option('--column-sizes <json>', 'Track array, e.g. [{"type":"FLEX","value":1}]')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runGridSet({
    nodeId, rows: options.rows, columns: options.columns,
    rowGap: options.rowGap, columnGap: options.columnGap,
    rowSizes: options.rowSizes, columnSizes: options.columnSizes,
  }));
grid.command('place <gridId> <childId>')
  .requiredOption('--row <index>').requiredOption('--column <index>')
  .option('--row-span <count>').option('--column-span <count>')
  .option('--horizontal-align <value>', 'auto, min, center, or max')
  .option('--vertical-align <value>', 'auto, min, center, or max')
  .allowExcessArguments(false)
  .action(async (gridId, childId, options) => runGridPlace({
    gridId, childId, row: options.row, column: options.column,
    rowSpan: options.rowSpan, columnSpan: options.columnSpan,
    horizontalAlign: options.horizontalAlign, verticalAlign: options.verticalAlign,
  }));
grid.command('auto-flow <nodeId>')
  .requiredOption('--auto-tracks <mode>', 'none or rows').requiredOption('--positioning <mode>', 'manual or row_auto_flow')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runGridAutoFlow({
    nodeId, autoTracks: options.autoTracks, positioning: options.positioning,
  }));
grid.command('reorder-rows <nodeId>')
  .requiredOption('--from <indices>').requiredOption('--to <index>')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runGridTrackReorder({
    axis: 'rows', nodeId, from: options.from, insertionIndex: options.to,
  }));
grid.command('reorder-columns <nodeId>')
  .requiredOption('--from <indices>').requiredOption('--to <index>')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runGridTrackReorder({
    axis: 'columns', nodeId, from: options.from, insertionIndex: options.to,
  }));
