import { checkConnection, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import {
  prototypeAddCode, prototypeClearCode, prototypeInspectCode, prototypeSetCode,
} from '../lib/prototype-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const prototype = program.command('prototype').description('Inspect and manage native Figma prototype reactions');

prototype.command('inspect <nodeId>').action(async (nodeId) => {
  try { print(await run(prototypeInspectCode({ nodeId }))); } catch (error) { handleEvalError(error); }
});

prototype.command('add <nodeId>')
  .option('--trigger <trigger>', 'click, hover, press, drag, media_end, or after:<seconds>', 'click')
  .option('--navigate-to <frameId>', 'Create a NAVIGATE node action')
  .option('--actions <json>', 'Complete Action[] JSON (supports multiple, variable, and conditional actions)')
  .option('--transition <json>', 'Transition JSON for --navigate-to')
  .action(async (nodeId, options) => {
    try { print(await run(prototypeAddCode({ nodeId, trigger: options.trigger, navigateTo: options.navigateTo, actions: options.actions ?? null, transition: options.transition ?? null }))); }
    catch (error) { handleEvalError(error); }
  });

prototype.command('set <nodeId>')
  .requiredOption('--json <json>', 'Complete Reaction[] JSON')
  .action(async (nodeId, options) => {
    try { print(await run(prototypeSetCode({ nodeId, reactions: options.json }))); } catch (error) { handleEvalError(error); }
  });

prototype.command('clear <nodeId>').action(async (nodeId) => {
  try { print(await run(prototypeClearCode({ nodeId }))); } catch (error) { handleEvalError(error); }
});
