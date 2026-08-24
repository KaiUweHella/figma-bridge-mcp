import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executePrototypeInspectionPlan,
  prototypeInspectionPlanningArgvFromRequest,
} from '../application/prototype-inspection-command.js';
import {
  checkConnection, daemonExec, fastEval, handleEvalError, program,
} from '../lib/cli-core.js';
import {
  prototypeAddCode, prototypeClearCode, prototypeSetCode,
} from '../lib/prototype-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const prototype = program.command('prototype').description('Inspect and manage native Figma prototype reactions');

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
