import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeSlotConfigurationPlan,
  slotConfigurationArgvFromRequest,
} from '../application/slot-configuration-command.js';
import {
  checkConnection, daemonExec, fastEval, handleEvalError, program,
} from '../lib/cli-core.js';
import {
  parsePreferredValues, parseSlotSettings, slotInspectCode, slotResetCode, slotValidateCode,
} from '../lib/slot-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const slot = program.command('slot').description('Create, configure, validate, and reset native component slots');

async function runSlotConfiguration(request) {
  try {
    const plan = planFigmaCommand(slotConfigurationArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeSlotConfigurationPlan(plan, {
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

slot.command('inspect <nodeId>').action(async (nodeId) => { try { print(await run(slotInspectCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
slot.command('create <componentId> <name>')
  .option('--settings <json>', 'SlotSettings JSON').option('--preferred <json>', 'Preferred component keys JSON').option('--description <text>')
  .allowExcessArguments(false)
  .action(async (componentId, name, options) => runSlotConfiguration({
    action: 'create', componentId, name, settings: parseSlotSettings(options.settings),
    preferredValues: parsePreferredValues(options.preferred), description: options.description,
  }));
slot.command('edit <componentId> <propertyName>')
  .option('--name <name>').option('--settings <json>', 'SlotSettings JSON').option('--preferred <json>', 'Preferred component keys JSON').option('--description <text>')
  .allowExcessArguments(false)
  .action(async (componentId, propertyName, options) => runSlotConfiguration({
    action: 'edit', componentId, propertyName, name: options.name,
    settings: parseSlotSettings(options.settings),
    preferredValues: parsePreferredValues(options.preferred), description: options.description,
  }));
slot.command('validate [nodeId]').action(async (nodeId) => { try { print(await run(slotValidateCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
slot.command('reset <nodeId>').action(async (nodeId) => { try { print(await run(slotResetCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
