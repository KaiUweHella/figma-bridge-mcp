import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeShaderMutationPlan,
  shaderMutationArgvFromRequest,
} from '../application/shader-mutation-command.js';
import {
  executeShaderReadPlan,
  shaderReadArgvFromRequest,
} from '../application/shader-read-command.js';
import {
  daemonExec, handleEvalError, program,
} from '../lib/cli-core.js';
import { parseShaderProperties } from '../lib/shader-management.js';

const shader = program.command('shader').description('Discover, import, and apply native Figma shaders');

async function runShaderRead(request) {
  try {
    const plan = planFigmaCommand(shaderReadArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeShaderReadPlan(plan, {
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

shader.command('list')
  .allowExcessArguments(false)
  .action(async () => runShaderRead({ action: 'list' }));
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
