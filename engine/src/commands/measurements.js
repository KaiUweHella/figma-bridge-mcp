import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeMeasurementMutationPlan,
  measurementMutationPlanningArgvFromRequest,
} from '../application/measurement-mutation-command.js';
import {
  executeMeasurementReadPlan,
  measurementReadPlanningArgvFromRequest,
} from '../application/measurement-read-command.js';
import {
  daemonExec, handleEvalError, program,
} from '../lib/cli-core.js';

const measure = program.command('measure').description('Inspect and manage Dev Mode measurements');

async function runMeasurementRead(request) {
  try {
    const plan = planFigmaCommand(measurementReadPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeMeasurementReadPlan(plan, {
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

async function runMeasurementMutation(request) {
  try {
    const plan = planFigmaCommand(measurementMutationPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeMeasurementMutationPlan(plan, {
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

measure.command('list [nodeId]')
  .allowExcessArguments(false)
  .action(async (nodeId) => runMeasurementRead({ nodeId }));
measure.command('add <from> <to>')
  .description('Add a measurement, e.g. 1:2:right 3:4:left')
  .option('--offset <pixels>', 'Outer fixed offset').option('--relative <ratio>', 'Inner relative offset, 0..1')
  .option('--text <text>', 'Free text label')
  .allowExcessArguments(false)
  .action(async (from, to, options) => runMeasurementMutation({
    action: 'add', from, to,
    offset: options.offset === undefined ? options.relative === undefined ? null
      : { type: 'INNER', relative: options.relative } : { type: 'OUTER', fixed: options.offset },
    text: options.text,
  }));
measure.command('edit <id>')
  .option('--offset <pixels>', 'Outer fixed offset').option('--relative <ratio>', 'Inner relative offset, 0..1')
  .option('--text <text>', 'Free text label; pass an empty string to clear')
  .allowExcessArguments(false)
  .action(async (id, options) => runMeasurementMutation({
    action: 'edit', id,
    offset: options.offset === undefined ? options.relative === undefined ? null
      : { type: 'INNER', relative: options.relative } : { type: 'OUTER', fixed: options.offset },
    text: options.text,
  }));
measure.command('delete <id>')
  .allowExcessArguments(false)
  .action(async (id) => runMeasurementMutation({ action: 'delete', id }));
