import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeShaderMutationPlan,
  shaderMutationArgvFromRequest,
} from '../application/shader-mutation-command.js';
import {
  checkConnection, daemonExec, fastEval, handleEvalError, program,
} from '../lib/cli-core.js';
import { parseShaderProperties, shaderListCode } from '../lib/shader-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const shader = program.command('shader').description('Discover, import, and apply native Figma shaders');

async function runShaderMutation(request) {
  try {
    const plan = planFigmaCommand(shaderMutationArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeShaderMutationPlan(plan, {
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

shader.command('list').action(async () => { try { print(await run(shaderListCode())); } catch (error) { handleEvalError(error); } });
shader.command('import <shaderId>')
  .allowExcessArguments(false)
  .action(async (shaderId) => runShaderMutation({ action: 'import', shaderId }));
shader.command('apply <nodeId> <shaderId>')
  .requiredOption('--field <field>', 'fill, stroke, or effect')
  .option('--properties <json>', 'Property values keyed by shader property-definition ID')
  .option('--replace', 'Replace existing paints/effects instead of appending')
  .allowExcessArguments(false)
  .action(async (nodeId, shaderId, options) => {
    await runShaderMutation({
      action: 'apply', nodeId, shaderId, field: options.field,
      properties: parseShaderProperties(options.properties), replace: options.replace,
    });
  });
