import { checkConnection, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import {
  gridLayoutAutoFlowCode, gridLayoutInspectCode, gridLayoutPlaceCode,
  gridLayoutReorderCode, gridLayoutSetCode,
} from '../lib/grid-layout-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const layout = program.command('layout').description('Manage native Auto Layout features');
const grid = layout.command('grid').description('Manage Auto Layout Grid containers (not Layout Guides)');

grid.command('inspect <nodeId>').action(async (nodeId) => { try { print(await run(gridLayoutInspectCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
grid.command('set <nodeId>')
  .option('--rows <count>').option('--columns <count>').option('--row-gap <pixels>').option('--column-gap <pixels>')
  .option('--row-sizes <json>', 'Track array, e.g. [{"type":"FIXED","value":100}]')
  .option('--column-sizes <json>', 'Track array, e.g. [{"type":"FLEX","value":1}]')
  .action(async (nodeId, options) => {
    try { print(await run(gridLayoutSetCode({ nodeId, rows: options.rows, columns: options.columns, rowGap: options.rowGap, columnGap: options.columnGap, rowSizes: options.rowSizes, columnSizes: options.columnSizes }))); }
    catch (error) { handleEvalError(error); }
  });
grid.command('place <gridId> <childId>')
  .requiredOption('--row <index>').requiredOption('--column <index>')
  .option('--row-span <count>').option('--column-span <count>')
  .option('--horizontal-align <value>', 'auto, min, center, or max')
  .option('--vertical-align <value>', 'auto, min, center, or max')
  .action(async (gridId, childId, options) => {
    try {
      print(await run(gridLayoutPlaceCode({
        gridId, childId, row: options.row, column: options.column,
        rowSpan: options.rowSpan, columnSpan: options.columnSpan,
        horizontalAlign: options.horizontalAlign, verticalAlign: options.verticalAlign,
      })));
    } catch (error) { handleEvalError(error); }
  });
grid.command('auto-flow <nodeId>')
  .requiredOption('--auto-tracks <mode>', 'none or rows').requiredOption('--positioning <mode>', 'manual or row_auto_flow')
  .action(async (nodeId, options) => { try { print(await run(gridLayoutAutoFlowCode({ nodeId, autoTracks: options.autoTracks, positioning: options.positioning }))); } catch (error) { handleEvalError(error); } });
grid.command('reorder-rows <nodeId>').requiredOption('--from <indices>').requiredOption('--to <index>').action(async (nodeId, options) => {
  try { print(await run(gridLayoutReorderCode({ nodeId, axis: 'rows', from: options.from, insertionIndex: options.to }))); } catch (error) { handleEvalError(error); }
});
grid.command('reorder-columns <nodeId>').requiredOption('--from <indices>').requiredOption('--to <index>').action(async (nodeId, options) => {
  try { print(await run(gridLayoutReorderCode({ nodeId, axis: 'columns', from: options.from, insertionIndex: options.to }))); } catch (error) { handleEvalError(error); }
});
