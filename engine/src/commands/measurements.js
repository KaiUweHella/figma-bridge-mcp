import { checkConnection, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import {
  measurementAddCode, measurementDeleteCode, measurementEditCode, measurementListCode,
} from '../lib/measurement-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const measure = program.command('measure').description('Inspect and manage Dev Mode measurements');

measure.command('list [nodeId]').action(async (nodeId) => {
  try { print(await run(measurementListCode({ nodeId }))); } catch (error) { handleEvalError(error); }
});
measure.command('add <from> <to>')
  .description('Add a measurement, e.g. 1:2:right 3:4:left')
  .option('--offset <pixels>', 'Outer fixed offset').option('--relative <ratio>', 'Inner relative offset, 0..1')
  .option('--text <text>', 'Free text label')
  .action(async (from, to, options) => {
    try { print(await run(measurementAddCode({ from, to, offset: options.offset, relative: options.relative, text: options.text }))); }
    catch (error) { handleEvalError(error); }
  });
measure.command('edit <id>')
  .option('--offset <pixels>', 'Outer fixed offset').option('--relative <ratio>', 'Inner relative offset, 0..1')
  .option('--text <text>', 'Free text label; pass an empty string to clear')
  .action(async (id, options) => {
    try { print(await run(measurementEditCode({ id, offset: options.offset, relative: options.relative, text: options.text }))); }
    catch (error) { handleEvalError(error); }
  });
measure.command('delete <id>').action(async (id) => {
  try { print(await run(measurementDeleteCode({ id }))); } catch (error) { handleEvalError(error); }
});
