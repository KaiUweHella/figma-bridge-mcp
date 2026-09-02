// Command: slides — a bounded first vertical slice for Figma Slides.
//
// This is explicitly beta. It covers deck structure and native slide
// properties, not interactive elements or a second content renderer.
import chalk from 'chalk';
import {
  program,
  daemonExec,
} from '../lib/cli-core.js';
import * as snippets from '../lib/slides-snippets.js';
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
import {
  executeSlidesDeletePlan,
  slidesDeletePlanningArgvFromRequest,
} from '../application/slides-delete-command.js';
import { executeSlidesLintPlan } from '../application/slides-lint-command.js';
import { executeSlidesBatchPlan } from '../application/slides-batch-command.js';
import { slidesBatchPlanningArgvFromRequest } from '../application/slides-batch-request.js';
import { slidesLintPlanningArgvFromRequest } from '../application/slides-lint-request.js';
import {
  executeSlidesManifestPlan,
  slidesManifestPlanningArgvFromRequest,
} from '../application/slides-manifest-command.js';

const slides = program
  .command('slides')
  .description('Figma Slides beta: inspect, lint, manifest, create, duplicate, move, transition, skip, delete');

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
  .allowExcessArguments(false)
  .action(async (slide) => {
    try {
      const plan = planFigmaCommand(slidesDeletePlanningArgvFromRequest({ reference: slide }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeSlidesDeletePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Slides delete failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// Deck-wide reads. Both are safe reads: they walk the canvas grid and touch
// nothing, so neither takes a slide reference nor a write confirmation.
slides
  .command('lint')
  .description('Report structural findings across the whole deck')
  .option('--kinds <list>', 'Comma-separated finding kinds: duplicate-name, skipped-placement, missing-transition, empty-slide')
  .option('--limit <n>', 'Maximum findings printed per kind (default 20)')
  .option('--fail-on-issues', 'Exit non-zero when the deck has findings')
  .allowExcessArguments(false)
  .action(async (options) => {
    try {
      const plan = planFigmaCommand(slidesLintPlanningArgvFromRequest({
        kinds: options.kinds ? String(options.kinds).split(',').map((part) => part.trim()).filter(Boolean) : undefined,
        limit: options.limit === undefined ? undefined : Number(options.limit),
        failOnIssues: options.failOnIssues === true,
      }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeSlidesLintPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      if (result.code) process.exitCode = result.code;
    } catch (error) {
      console.error(chalk.red('✗ Slides lint failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

slides
  .command('manifest')
  .description('Export a compact deck manifest for review and version control')
  .allowExcessArguments(false)
  .action(async () => {
    try {
      const plan = planFigmaCommand(slidesManifestPlanningArgvFromRequest(), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeSlidesManifestPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('✗ Slides manifest failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// Batch is a plan by default. --apply is the deliberate second step, and the
// Capability Catalog gates it accordingly: without it the command is a read.
slides
  .command('batch <json>')
  .description('Plan create/duplicate/move operations over the deck; --apply performs them')
  .option('--apply', 'Perform the planned operations instead of only reporting them')
  .allowExcessArguments(false)
  .action(async (json, options) => {
    try {
      const argv = ['slides', 'batch', json, ...(options.apply ? ['--apply'] : [])];
      const plan = planFigmaCommand(slidesBatchPlanningArgvFromRequest({ argv }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeSlidesBatchPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
    } catch (error) {
      console.error(chalk.red('\u2717 Slides batch failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });
