import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executePrototypeInspectionPlan,
  prototypeInspectionPlanningArgvFromRequest,
} from '../application/prototype-inspection-command.js';
import {
  executePrototypeMutationPlan,
} from '../application/prototype-mutation-command.js';
import {
  daemonExec, handleEvalError, program,
} from '../lib/cli-core.js';

const prototype = program.command('prototype').description('Inspect and manage native Figma prototype reactions');

async function runPrototypeMutation(argv) {
  try {
    const plan = planFigmaCommand(argv, {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executePrototypeMutationPlan(plan, {
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

prototype.command('inspect <nodeId>')
  .allowExcessArguments(false)
  .action(async (nodeId) => {
    try {
      const plan = planFigmaCommand(prototypeInspectionPlanningArgvFromRequest({ nodeId }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executePrototypeInspectionPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(result.stderr);
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

prototype.command('add <nodeId>')
  .option('--trigger <trigger>', 'click, hover, press, drag, media_end, or after:<seconds>', 'click')
  .option('--navigate-to <frameId>', 'Create a NAVIGATE node action')
  .option('--actions <json>', 'Complete Action[] JSON (supports multiple, variable, and conditional actions)')
  .option('--transition <json>', 'Transition JSON for --navigate-to')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runPrototypeMutation([
    'prototype', 'add', nodeId, '--trigger', options.trigger,
    ...(options.navigateTo === undefined ? [] : ['--navigate-to', options.navigateTo]),
    ...(options.actions === undefined ? [] : ['--actions', options.actions]),
    ...(options.transition === undefined ? [] : ['--transition', options.transition]),
  ]));

prototype.command('set <nodeId>')
  .requiredOption('--json <json>', 'Complete Reaction[] JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runPrototypeMutation([
    'prototype', 'set', nodeId, '--json', options.json,
  ]));

prototype.command('clear <nodeId>')
  .allowExcessArguments(false)
  .action(async (nodeId) => runPrototypeMutation(['prototype', 'clear', nodeId]));
