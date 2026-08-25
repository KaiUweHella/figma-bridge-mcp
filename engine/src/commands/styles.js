import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  checkConnection, daemonExec, fastEval, handleEvalError, program,
} from '../lib/cli-core.js';
import {
  executeStyleFactsPlan,
  styleFactsPlanningArgvFromRequest,
} from '../application/style-facts-command.js';
import {
  executeStyleCatalogPlan,
  styleCatalogPlanningArgvFromRequest,
} from '../application/style-catalog-command.js';
import {
  executeStyleConsumerPlan,
  styleConsumerPlanningArgvFromRequest,
} from '../application/style-consumer-command.js';
import {
  executeStylePublishStatusPlan,
  stylePublishStatusPlanningArgvFromRequest,
} from '../application/style-publish-status-command.js';
import {
  parseStyleProperties, parseStyleType, styleApplyCode,
  styleBindVariableCode,
  styleCreateCode, styleDeleteCode,
  styleUpdateCode,
} from '../lib/style-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const styles = program.command('style').description('Manage local paint, text, effect, and grid styles');

styles.command('list')
  .option('-t, --type <type>', 'PAINT, TEXT, EFFECT, or GRID')
  .option('--limit <count>', 'Maximum styles returned in this page')
  .option('--cursor <cursor>', 'Continue from a prior Style Catalog page')
  .allowExcessArguments(false)
  .action(async (options) => {
    try {
      const plan = planFigmaCommand(styleCatalogPlanningArgvFromRequest({
        type: options.type || null,
        limit: options.limit || null,
        cursor: options.cursor || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleCatalogPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Style Catalog failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });
styles.command('show <style>')
  .option('-t, --type <type>', 'Narrow name resolution to PAINT, TEXT, EFFECT, or GRID')
  .allowExcessArguments(false)
  .action(async (style, options) => {
    try {
      const plan = planFigmaCommand(styleFactsPlanningArgvFromRequest({
        style,
        type: options.type || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleFactsPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Style Facts failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });
styles.command('create <type> <name>')
  .option('-d, --description <text>').option('-p, --properties <json>', 'Type-specific properties as JSON')
  .action(async (type, name, options) => {
    try {
      const normalized = parseStyleType(type);
      const result = await run(styleCreateCode({ type: normalized, name, description: options.description, properties: parseStyleProperties(options.properties, normalized) }));
      console.log(chalk.green('✓'), `Created ${normalized} style ${result.name}.`); print(result);
    } catch (error) { handleEvalError(error); }
  });
styles.command('update <style>')
  .option('-t, --type <type>', 'Required when using --properties')
  .option('-n, --name <name>').option('-d, --description <text>').option('-p, --properties <json>')
  .action(async (style, options) => {
    try {
      if (options.name === undefined && options.description === undefined && options.properties === undefined) throw new Error('Provide --name, --description, or --properties');
      if (options.properties !== undefined && !options.type) throw new Error('--type is required with --properties');
      const type = options.type ? parseStyleType(options.type) : undefined;
      const properties = options.properties === undefined ? undefined : parseStyleProperties(options.properties, type);
      print(await run(styleUpdateCode({ style, type, name: options.name, description: options.description, properties })));
    } catch (error) { handleEvalError(error); }
  });
styles.command('apply <style> <nodeIds>')
  .requiredOption('-f, --field <field>', 'fill, stroke, text, effect, or grid')
  .action(async (style, nodeIds, options) => {
    try { print(await run(styleApplyCode({ style, nodeIds, field: options.field }))); } catch (error) { handleEvalError(error); }
  });
styles.command('consumers <style>')
  .option('-t, --type <type>', 'Narrow style resolution to PAINT, TEXT, EFFECT, or GRID')
  .option('--limit <count>', 'Maximum consumers returned in this page')
  .option('--cursor <cursor>', 'Continue from a prior Style Consumer page')
  .allowExcessArguments(false)
  .action(async (style, options) => {
    try {
      const plan = planFigmaCommand(styleConsumerPlanningArgvFromRequest({
        style,
        type: options.type || null,
        limit: options.limit || null,
        cursor: options.cursor || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStyleConsumerPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Style Consumer failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });
styles.command('publish-status <style>')
  .option('-t, --type <type>', 'Narrow style resolution to PAINT, TEXT, EFFECT, or GRID')
  .allowExcessArguments(false)
  .action(async (style, options) => {
    try {
      const plan = planFigmaCommand(stylePublishStatusPlanningArgvFromRequest({
        style,
        type: options.type || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeStylePublishStatusPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Style Publish Status failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });
styles.command('delete <style>').action(async (style) => {
  try { const result = await run(styleDeleteCode({ style })); console.log(chalk.green('✓'), `Deleted ${result.type} style ${result.name}.`); } catch (error) { handleEvalError(error); }
});
styles.command('bind-font <style> <field>')
  .requiredOption('--variable <variable>', 'Local variable ID or name')
  .action(async (style, field, options) => {
    try { print(await run(styleBindVariableCode({ style, field, variable: options.variable }))); } catch (error) { handleEvalError(error); }
  });
styles.command('unbind-font <style> <field>').action(async (style, field) => {
  try { print(await run(styleBindVariableCode({ style, field, variable: null }))); } catch (error) { handleEvalError(error); }
});
