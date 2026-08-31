// Command: slides — a bounded first vertical slice for Figma Slides.
//
// This is explicitly beta. It covers deck structure and native slide
// properties, not interactive elements or a second content renderer.
import chalk from 'chalk';
import {
  program,
  checkConnection,
  daemonExec,
  fastEval,
  handleEvalError,
} from '../lib/cli-core.js';
import * as snippets from '../lib/slides-snippets.js';
import { unionReferenceExecutionValue } from '../application/union-reference.js';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import {
  executeSlidesInspectPlan,
  slidesInspectPlanningArgvFromRequest,
} from '../application/slides-inspect-command.js';
import {
  executeSlidesCreatePlan,
  slidesCreatePlanningArgvFromRequest,
} from '../application/slides-create-command.js';
import {
  executeSlidesDuplicatePlan,
  slidesDuplicatePlanningArgvFromRequest,
} from '../application/slides-duplicate-command.js';
import {
  executeSlidesMovePlan,
  slidesMovePlanningArgvFromRequest,
} from '../application/slides-move-command.js';
import {
  executeSlidesPropertyPlan,
  parseSlidesPropertyRequest,
  slidesPropertyPlanningArgvFromRequest,
} from '../application/slides-property-command.js';

const slides = program
  .command('slides')
  .description('Figma Slides beta: inspect, create, duplicate, move, transition, skip, delete');

async function run(code, onOk) {
  await checkConnection();
  let result;
  try {
    result = await fastEval(code);
  } catch (error) {
    handleEvalError(error);
    return;
  }
  if (result && result.error === 'WRONG_EDITOR') {
    console.error(chalk.red(`✗ This is a ${result.editor} file, not a Figma Slides deck.`));
    console.error(chalk.yellow('  Open a Slides file in Figma Desktop and relaunch the Figma Bridge plugin there.'));
    process.exit(1);
  }
  if (result && result.error) {
    console.error(chalk.red(`✗ ${result.error}`));
    process.exit(1);
  }
  onOk(result);
}

slides
  .command('inspect [slide]')
  .description('Read the slide grid, or one typed node:/name:/label: reference or compatible query')
  .allowExcessArguments(false)
  .action(async (slide) => {
    try {
      const plan = planFigmaCommand(slidesInspectPlanningArgvFromRequest({
        reference: slide || null,
      }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeSlidesInspectPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Slides inspect failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

slides
  .command('create [label]')
  .description('Create and focus a slide with a durable Bridge label, optionally at a grid coordinate')
  .option('--row <n>', 'Zero-based grid row')
  .option('--col <n>', 'Zero-based grid column (requires --row)')
  .allowExcessArguments(false)
  .action(async (label, options) => {
    try {
      const plan = planFigmaCommand(slidesCreatePlanningArgvFromRequest({
        label: label ?? null,
        row: options.row ?? null,
        col: options.col ?? null,
      }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeSlidesCreatePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Slides create failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

slides
  .command('duplicate <slide>')
  .description('Duplicate a slide and move the copy to the end or a grid coordinate')
  .option('--label <label>', 'Durable Bridge label for the copy')
  .option('--row <n>', 'Zero-based target row')
  .option('--col <n>', 'Zero-based target column (requires --row)')
  .allowExcessArguments(false)
  .action(async (slide, options) => {
    try {
      const plan = planFigmaCommand(slidesDuplicatePlanningArgvFromRequest({
        reference: slide,
        label: options.label ?? null,
        row: options.row ?? null,
        col: options.col ?? null,
      }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeSlidesDuplicatePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Slides duplicate failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

slides
  .command('move <slide> <row> <col>')
  .description('Move one slide to a zero-based grid coordinate')
  .allowExcessArguments(false)
  .action(async (slide, rowValue, colValue) => {
    try {
      const plan = planFigmaCommand(slidesMovePlanningArgvFromRequest({
        reference: slide, row: rowValue, col: colValue,
      }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeSlidesMovePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Slides move failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

slides
  .command('transition <slide> <style>')
  .description('Set a native slide transition')
  .option('--duration <seconds>', 'Duration in seconds', '0.3')
  .option('--curve <curve>', `One of: ${snippets.TRANSITION_CURVES.join(', ')}`, 'EASE_IN_AND_OUT')
  .option('--timing <timing>', `One of: ${snippets.TRANSITION_TIMINGS.join(', ')}`, 'ON_CLICK')
  .option('--delay <seconds>', 'Delay for AFTER_DELAY timing', '0')
  .allowExcessArguments(false)
  .action(async (slide, styleValue, options) => {
    try {
      const plan = planFigmaCommand(slidesPropertyPlanningArgvFromRequest({
        action: 'transition', reference: slide, style: styleValue,
        duration: options.duration, curve: options.curve,
        timing: options.timing, delay: options.delay,
      }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeSlidesPropertyPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Slides transition failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

slides
  .command('skip <slide> [state]')
  .description('Include or skip a slide in presentation playback (on/off; default on)')
  .allowExcessArguments(false)
  .action(async (slide, state = 'on') => {
    try {
      const request = parseSlidesPropertyRequest(['slides', 'skip', slide, state]);
      const plan = planFigmaCommand(slidesPropertyPlanningArgvFromRequest(request), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeSlidesPropertyPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Slides skip failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

slides
  .command('delete <slide>')
  .description('Delete exactly one slide resolved by typed node:/name:/label: reference or compatible query')
  .action(async (slide) => {
    const reference = unionReferenceExecutionValue(slide);
    await run(snippets.remove(reference), (result) => {
      const labelled = result.label ? ` [${result.label}]` : '';
      console.log(chalk.green('✓'), `Deleted slide ${result.id}${labelled} (Figma name: "${result.name}")`);
    });
  });
