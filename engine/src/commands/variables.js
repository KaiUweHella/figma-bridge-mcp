// Commands: variables (extracted from index.js)
import chalk from 'chalk';
import { join } from 'path';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeVariableDiscoveryPlan,
  variableDiscoveryPlanningArgvFromRequest,
} from '../application/variable-discovery-command.js';
import {
  executeVariableFactsPlan,
  variableFactsArgvFromRequest,
} from '../application/variable-facts-command.js';
import {
  executeVariableCreatePlan,
  variableCreatePlanningArgvFromRequest,
} from '../application/variable-create-command.js';
import {
  executeVariableCreateBatchPlan,
  variableCreateBatchPlanningArgvFromRequest,
} from '../application/variable-create-batch-command.js';
import {
  executeVariableVisualizationPlan,
  variableVisualizationPlanningArgvFromRequest,
} from '../application/variable-visualization-command.js';
import {
  executeVariableSetValuePlan,
  variableSetValuePlanningArgvFromRequest,
} from '../application/variable-set-value-command.js';
import {
  executeVariableSetValueBatchPlan,
  variableSetValueBatchPlanningArgvFromRequest,
} from '../application/variable-set-value-batch-command.js';
import {
  executeVariableCodeSyntaxPlan,
  variableCodeSyntaxPlanningArgvFromRequest,
} from '../application/variable-code-syntax-command.js';
import {
  executeVariableUpdatePlan,
  variableUpdatePlanningArgvFromRequest,
} from '../application/variable-update-command.js';
import {
  executeVariableUpdateBatchPlan,
  variableUpdateBatchPlanningArgvFromRequest,
} from '../application/variable-update-batch-command.js';
import {
  executeVariableResolutionPlan,
  variableResolutionPlanningArgvFromRequest,
} from '../application/variable-resolution-command.js';
import {
  executeTokenPublishStatusPlan,
  tokenPublishStatusPlanningArgvFromRequest,
} from '../application/token-publish-status-command.js';
import {
  executeVariableDeletePlan,
  variableDeletePlanningArgvFromRequest,
} from '../application/variable-delete-command.js';
import {
  progress,
  program,
  checkConnection,
  daemonExec,
  fastEval,
  handleEvalError,
  hexToRgb,
  spinnerSucceed
} from '../lib/cli-core.js';
// ============ VARIABLES ============

const variables = program
  .command('variables')
  .alias('var')
  .description('Manage design tokens/variables');

async function runVariableDiscovery(action, pattern, options) {
  try {
    const plan = planFigmaCommand(variableDiscoveryPlanningArgvFromRequest({
      action,
      pattern,
      limit: options.limit || null,
      json: options.json === true,
    }), {
      adapter: 'cli',
      fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeVariableDiscoveryPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code,
            ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    handleEvalError(error);
    process.exitCode = 1;
  }
}

variables
  .command('list')
  .description('List all variables')
  .option('-l, --limit <count>', 'Maximum variables returned')
  .option('--json', 'Return bounded identity facts as JSON')
  .allowExcessArguments(false)
  .action(async (options) => runVariableDiscovery('list', null, options));

variables
  .command('create <name>')
  .description('Create a variable')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .requiredOption('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN, EASING, TIMING')
  .option('-v, --value <value>', 'Initial value; EASING accepts a name or MotionEasing JSON, TIMING uses seconds')
  .option('--allow-duplicate', 'Intentionally allow an exact duplicate name in the Collection')
  .allowExcessArguments(false)
  .action(async (name, options) => {
    try {
      const plan = planFigmaCommand(variableCreatePlanningArgvFromRequest({
        name,
        collection: options.collection,
        type: options.type,
        value: options.value,
        allowDuplicate: options.allowDuplicate === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableCreatePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('find <pattern>')
  .description('Find variables by name pattern')
  .option('-l, --limit <count>', 'Maximum variables returned')
  .option('--json', 'Return bounded identity facts as JSON')
  .allowExcessArguments(false)
  .action(async (pattern, options) => runVariableDiscovery('find', pattern, options));

variables.command('show <variable>')
  .option('-c, --collection <collection>')
  .allowExcessArguments(false)
  .action(async (variable, options) => {
    try {
      const plan = planFigmaCommand(variableFactsArgvFromRequest({
        variable,
        collection: options.collection || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableFactsPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('update <variable>')
  .option('-c, --collection <collection>').option('-n, --name <name>')
  .option('-d, --description <text>').option('--hidden <boolean>').option('--scopes <list>', 'Comma-separated Figma variable scopes')
  .allowExcessArguments(false)
  .action(async (variable, options) => {
    try {
      const plan = planFigmaCommand(variableUpdatePlanningArgvFromRequest({
        variable,
        collection: options.collection || null,
        name: options.name,
        description: options.description,
        hidden: options.hidden,
        scopes: options.scopes,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableUpdatePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('update-batch <json>')
  .description('Update metadata on multiple explicitly named local variables in one operation')
  .allowExcessArguments(false)
  .action(async (json) => {
    try {
      const plan = planFigmaCommand(variableUpdateBatchPlanningArgvFromRequest({
        items: JSON.parse(json),
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableUpdateBatchPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('set-value <variable> [value]')
  .requiredOption('-m, --mode <mode>', 'Mode ID or name').option('-c, --collection <collection>')
  .option('--alias <variable>', 'Set a variable alias instead of a literal value')
  .allowExcessArguments(false)
  .action(async (variable, value, options) => {
    try {
      const plan = planFigmaCommand(variableSetValuePlanningArgvFromRequest({
        variable,
        value,
        alias: options.alias || null,
        mode: options.mode,
        collection: options.collection || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableSetValuePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('set-value-batch <json>')
  .description('Set several explicit Variable/mode values with best-effort rollback')
  .allowExcessArguments(false)
  .action(async (json) => {
    try {
      const plan = planFigmaCommand(variableSetValueBatchPlanningArgvFromRequest({
        items: JSON.parse(json),
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableSetValueBatchPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('code-syntax <variable> <platform> [value]')
  .option('-c, --collection <collection>').option('--remove', 'Remove the platform definition')
  .allowExcessArguments(false)
  .action(async (variable, platform, value, options) => {
    try {
      const plan = planFigmaCommand(variableCodeSyntaxPlanningArgvFromRequest({
        variable,
        platform,
        value,
        collection: options.collection || null,
        remove: options.remove === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableCodeSyntaxPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('resolve <variable> <nodeId>')
  .option('-c, --collection <collection>')
  .allowExcessArguments(false)
  .action(async (variable, nodeId, options) => {
    try {
      const plan = planFigmaCommand(variableResolutionPlanningArgvFromRequest({
        variable,
        nodeId,
        collection: options.collection || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableResolutionPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('publish-status <variable>')
  .option('-c, --collection <collection>')
  .allowExcessArguments(false)
  .action(async (variable, options) => {
    try {
      const plan = planFigmaCommand(tokenPublishStatusPlanningArgvFromRequest({
        kind: 'variable', query: variable, collection: options.collection || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeTokenPublishStatusPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('visualize [collection]')
  .description('Create color swatches on canvas (grouped palette layout)')
  .option('-m, --mode <mode>', 'Mode ID or name; defaults to each Collection default mode')
  .allowExcessArguments(false)
  .action(async (collection, options) => {
    try {
      const plan = planFigmaCommand(variableVisualizationPlanningArgvFromRequest({
        collection: collection || null,
        mode: options.mode || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableVisualizationPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('create-batch <json>')
  .description('Create multiple variables at once (faster than individual calls)')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .option('-m, --mode <mode>', 'Mode ID or name; defaults to the Collection default mode')
  .option('--allow-duplicate', 'Allow exact duplicate names intentionally')
  .allowExcessArguments(false)
  .action(async (json, options) => {
    try {
      const items = JSON.parse(json);
      const plan = planFigmaCommand(variableCreateBatchPlanningArgvFromRequest({
        items,
        collection: options.collection,
        mode: options.mode || null,
        allowDuplicate: options.allowDuplicate === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableCreateBatchPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('delete <names...>')
  .description('Delete exact local Variables by id or name; use --collection to scope duplicate names')
  .option('-c, --collection <collection>', 'Scope exact names to one Collection id or name')
  .allowExcessArguments(false)
  .action(async (names, options) => {
    try {
      const plan = planFigmaCommand(variableDeletePlanningArgvFromRequest({
        names, collection: options.collection || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableDeletePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('delete-all')
  .description('Disabled unsafe legacy bulk deletion; use exact var delete or col delete')
  .option('-c, --collection <name>', 'Only delete variables in this collection')
  .action(async () => {
    console.error(chalk.red('✗ var delete-all is disabled.'));
    console.error(chalk.gray('  Use var delete <exact names...> or col delete <exact collection>.'));
    process.exitCode = 1;
  });

// (The batch operations `delete-batch`, `bind-batch`, `set-batch` and
// `rename-batch` were removed. All four were registered TOP-LEVEL rather
// than under `variables`, so the allowlisted `var` alias never reached
// them — nothing could ever call them. `node delete <ids...>` and
// `node rename` cover the two that had no other home; the binding ones
// are listed for a proper rebuild in docu/FUNDLISTE-toter-code.md.)
