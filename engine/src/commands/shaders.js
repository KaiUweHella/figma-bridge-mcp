import { checkConnection, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import { shaderApplyCode, shaderImportCode, shaderListCode } from '../lib/shader-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const shader = program.command('shader').description('Discover, import, and apply native Figma shaders');

shader.command('list').action(async () => { try { print(await run(shaderListCode())); } catch (error) { handleEvalError(error); } });
shader.command('import <shaderId>').action(async (shaderId) => { try { print(await run(shaderImportCode({ shaderId }))); } catch (error) { handleEvalError(error); } });
shader.command('apply <nodeId> <shaderId>')
  .requiredOption('--field <field>', 'fill, stroke, or effect')
  .option('--properties <json>', 'Property values keyed by shader property-definition ID')
  .option('--replace', 'Replace existing paints/effects instead of appending')
  .action(async (nodeId, shaderId, options) => {
    try { print(await run(shaderApplyCode({ nodeId, shaderId, field: options.field, properties: options.properties, replace: options.replace }))); }
    catch (error) { handleEvalError(error); }
  });
