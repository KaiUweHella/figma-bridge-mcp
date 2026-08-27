// Command: font — truthful range inspection plus metadata-only variable axes.
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  program,
  checkConnection,
  daemonExec,
  fastEval,
  handleEvalError,
} from '../lib/cli-core.js';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  fontAxesCode,
  forgetAxesCode,
  parseAxisSpec,
  parseOptionalIndex,
  rememberAxesCode,
} from '../lib/font-introspection.js';
import {
  executeFontInspectionPlan,
  fontInspectionPlanningArgvFromRequest,
} from '../application/font-inspection-command.js';
import {
  executeFontVariableBindingPlan,
  fontVariableBindingPlanningArgvFromRequest,
} from '../application/font-variable-binding-command.js';

const font = program
  .command('font')
  .description('Inspect typography, bind variables, and preserve variable-font axis intent as metadata');

const rangeOptions = (command) => command
  .option('--start <index>', 'Start character index (inclusive)')
  .option('--end <index>', 'End character index (exclusive)');

const parsedRange = (options) => ({
  start: parseOptionalIndex(options.start, '--start'),
  end: parseOptionalIndex(options.end, '--end'),
});

const print = (value) => console.log(JSON.stringify(value, null, 2));

rangeOptions(font
  .command('bind <nodeId> <field> <variable>')
  .description('Bind a STRING/FLOAT variable to a typography field on a TEXT node or character range'))
  .option('-c, --collection <name>', 'Narrow an ambiguous local variable name to one collection')
  .allowExcessArguments(false)
  .action(async (nodeId, field, variable, options) => {
    try {
      const range = parsedRange(options);
      await runFontVariableBinding({ action: 'bind', nodeId, field, variable,
        collection: options.collection || null, ...range });
    } catch (error) {
      console.error(chalk.red('✗ Font binding failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

rangeOptions(font
  .command('unbind <nodeId> <field>')
  .description('Remove a typography-variable binding from a TEXT node or character range'))
  .allowExcessArguments(false)
  .action(async (nodeId, field, options) => {
    try {
      const range = parsedRange(options);
      await runFontVariableBinding({ action: 'unbind', nodeId, field, ...range });
    } catch (error) {
      console.error(chalk.red('✗ Font unbinding failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

async function runFontVariableBinding(request) {
  const plan = planFigmaCommand(fontVariableBindingPlanningArgvFromRequest(request), {
    adapter: 'cli', fileKey: program.opts().figmaFile || null,
  });
  const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeFontVariableBindingPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code, ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
  if (result.stderr) console.error(chalk.yellow(result.stderr));
  console.log(result.stdout);
}

rangeOptions(font
  .command('inspect <nodeId>')
  .description('Read Figma-reported range fonts, numeric weights, OpenType features and bindings'))
  .option('--all-open-type', 'Include false OpenType feature values as well as enabled tags')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const range = parsedRange(options);
      const plan = planFigmaCommand(fontInspectionPlanningArgvFromRequest({
        nodeId,
        ...range,
        allOpenType: options.allOpenType === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeFontInspectionPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Font inspection failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

font
  .command('axes <nodeId>')
  .description('Read metadata-only variable-font axis intent (does not describe Figma rendering)')
  .action(async (nodeId) => {
    try {
      const id = normalizeNodeId(nodeId).id;
      await checkConnection();
      print(await fastEval(fontAxesCode({ nodeId: id })));
    } catch (error) {
      handleEvalError(error);
    }
  });

rangeOptions(font
  .command('remember-axes <nodeId> <axes>')
  .description('Store range axis intent such as wght=357,wdth=82; does NOT change glyph rendering'))
  .action(async (nodeId, axesSpec, options) => {
    try {
      const id = normalizeNodeId(nodeId).id;
      const axes = parseAxisSpec(axesSpec);
      const range = parsedRange(options);
      await checkConnection();
      const result = await fastEval(rememberAxesCode({ nodeId: id, axes, ...range }));
      console.log(chalk.green('✓'), 'Variable-font axis intent stored as plugin metadata.');
      print(result);
    } catch (error) {
      handleEvalError(error);
    }
  });

rangeOptions(font
  .command('forget-axes <nodeId>')
  .description('Remove one exact range or all stored variable-font axis metadata'))
  .action(async (nodeId, options) => {
    try {
      const id = normalizeNodeId(nodeId).id;
      const range = parsedRange(options);
      await checkConnection();
      const result = await fastEval(forgetAxesCode({ nodeId: id, ...range }));
      console.log(chalk.green('✓'), 'Variable-font axis metadata removed.');
      print(result);
    } catch (error) {
      handleEvalError(error);
    }
  });
