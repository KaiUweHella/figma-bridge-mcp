import { checkConnection, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import { slotCreateCode, slotEditCode, slotInspectCode, slotResetCode, slotValidateCode } from '../lib/slot-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const slot = program.command('slot').description('Create, configure, validate, and reset native component slots');

slot.command('inspect <nodeId>').action(async (nodeId) => { try { print(await run(slotInspectCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
slot.command('create <componentId> <name>')
  .option('--settings <json>', 'SlotSettings JSON').option('--preferred <json>', 'Preferred component keys JSON').option('--description <text>')
  .action(async (componentId, name, options) => { try { print(await run(slotCreateCode({ componentId, name, settings: options.settings, preferredValues: options.preferred, description: options.description }))); } catch (error) { handleEvalError(error); } });
slot.command('edit <componentId> <propertyName>')
  .option('--name <name>').option('--settings <json>', 'SlotSettings JSON').option('--preferred <json>', 'Preferred component keys JSON').option('--description <text>')
  .action(async (componentId, propertyName, options) => { try { print(await run(slotEditCode({ componentId, propertyName, name: options.name, settings: options.settings, preferredValues: options.preferred, description: options.description }))); } catch (error) { handleEvalError(error); } });
slot.command('validate [nodeId]').action(async (nodeId) => { try { print(await run(slotValidateCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
slot.command('reset <nodeId>').action(async (nodeId) => { try { print(await run(slotResetCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
