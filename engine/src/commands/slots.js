import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeSlotConfigurationPlan,
  slotConfigurationArgvFromRequest,
} from '../application/slot-configuration-command.js';
import {
  executeSlotReadPlan,
  slotReadPlanningArgvFromRequest,
} from '../application/slot-read-command.js';
import { executeSlotResetPlan, slotResetArgvFromRequest } from '../application/slot-reset-command.js';
import {
  daemonExec, handleEvalError, program,
} from '../lib/cli-core.js';
import {
  parsePreferredValues, parseSlotSettings,
} from '../lib/slot-management.js';

const slot = program.command('slot').description('Create, configure, validate, and reset native component slots');

async function runSlotRead(request) {
  try {
    const plan = planFigmaCommand(slotReadPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeSlotReadPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

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

async function runSlotReset(request) {
  try {
    const plan = planFigmaCommand(slotResetArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeSlotResetPlan(plan, {
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

slot.command('inspect <nodeId>')
  .allowExcessArguments(false)
  .action(async (nodeId) => runSlotRead({ action: 'inspect', nodeId }));
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
slot.command('validate [nodeId]')
  .allowExcessArguments(false)
  .action(async (nodeId) => runSlotRead({ action: 'validate', nodeId }));
slot.command('reset <nodeId>')
  .allowExcessArguments(false)
  .action(async (nodeId) => runSlotReset({ nodeId }));
