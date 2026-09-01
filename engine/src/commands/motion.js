// Commands: motion — author Figma Motion animations (Config 2026 Beta Plugin API).
// Additive: registers the `motion` namespace only. Pure logic lives in
// ../lib/motion-core.js; every read and mutation delegates to a closed Command
// Application with bounded native facts and explicit verification semantics.
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executePreparedMotionApply,
  motionApplyPlanningArgvFromRequest,
  prepareMotionApplyPlan,
} from '../application/motion-apply-command.js';
import {
  executeMotionAddPlan,
  motionAddPlanningArgvFromRequest,
} from '../application/motion-add-command.js';
import {
  executeMotionClearPlan,
  motionClearPlanningArgvFromRequest,
} from '../application/motion-clear-command.js';
import {
  executeMotionPresetPlan,
  motionPresetPlanningArgvFromRequest,
} from '../application/motion-preset-command.js';
import {
  executeMotionReadPlan,
  motionReadPlanningArgvFromRequest,
} from '../application/motion-read-command.js';
import {
  executeMotionStylePlan,
  motionStylePlanningArgvFromRequest,
} from '../application/motion-style-command.js';
import {
  executeMotionStaggerPlan,
  motionStaggerPlanningArgvFromRequest,
} from '../application/motion-stagger-command.js';
import {
  executeMotionTimelinePlan,
  motionTimelinePlanningArgvFromRequest,
} from '../application/motion-timeline-command.js';
import {
  program, daemonExec, handleEvalError,
} from '../lib/cli-core.js';
import { workspaceIO } from '../lib/workspace-io.js';
import { PRESETS } from '../lib/motion-core.js';

const motion = program
  .command('motion')
  .description('Figma Motion: keyframes, presets, styles, timelines (Config 2026 Beta)');

async function runMotionRead(request) {
  try {
    const plan = planFigmaCommand(motionReadPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeMotionReadPlan(plan, {
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

async function runMotionAdd(request) {
  try {
    const plan = planFigmaCommand(motionAddPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeMotionAddPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runMotionPreset(request) {
  try {
    const plan = planFigmaCommand(motionPresetPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeMotionPresetPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runMotionStagger(request) {
  try {
    const plan = planFigmaCommand(motionStaggerPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeMotionStaggerPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runMotionApply(request) {
  try {
    const plan = planFigmaCommand(motionApplyPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const prepared = prepareMotionApplyPlan(plan, { workspaceIO: workspaceIO() });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executePreparedMotionApply(prepared, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runMotionTimeline(request) {
  try {
    const plan = planFigmaCommand(motionTimelinePlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeMotionTimelinePlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runMotionClear(request) {
  try {
    const plan = planFigmaCommand(motionClearPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeMotionClearPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

async function runMotionStyle(request) {
  try {
    const plan = planFigmaCommand(motionStylePlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeMotionStylePlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

// ============ motion add ============
motion
  .command('add <id>')
  .description('Add a keyframe track: --field + (--keys OR --from/--to)')
  .option('-f, --field <field>', 'opacity, translateX/Y, scale, rotate, radius, fill…')
  .option('-k, --keys <keys>', 'multi-keyframe "t:v[:ease], …" e.g. "0:0, 0.4:1:ease-out"')
  .option('--from <v>', 'start value (with --to)')
  .option('--to <v>', 'end value (with --from)')
  .option('-d, --dur <s>', 'duration seconds (with --from/--to)', '0.5')
  .option('--at <s>', 'start offset seconds (with --from/--to)', '0')
  .option('-e, --ease <ease>', 'easing: ease-out, gentle, quick, spring, linear, hold', 'ease-out')
  .allowExcessArguments(false)
  .action(async (id, options) => runMotionAdd({
    nodeId: id,
    field: options.field,
    keys: options.keys ?? null,
    from: options.from ?? null,
    to: options.to ?? null,
    duration: options.keys == null ? options.dur : null,
    offset: options.keys == null ? options.at : null,
    easing: options.keys == null ? options.ease : null,
  }));

// ============ motion apply <spec> ============
motion
  .command('apply <spec>')
  .description('Apply a full animation spec (JSON file path or inline JSON)')
  .allowExcessArguments(false)
  .action(async (spec) => runMotionApply({ source: spec }));

// ============ motion preset <id> <name> ============
motion
  .command('preset <id> <name>')
  .description(`Apply a preset: ${Object.keys(PRESETS).join(', ')}`)
  .option('-d, --dur <s>', 'duration seconds', '0.5')
  .option('--at <s>', 'start offset seconds', '0')
  .option('-e, --ease <ease>', 'easing', 'ease-out')
  .allowExcessArguments(false)
  .action(async (id, name, options) => runMotionPreset({
    nodeId: id,
    preset: name,
    duration: options.dur,
    offset: options.at,
    easing: options.ease,
  }));

// ============ motion stagger <ids> ============
motion
  .command('stagger <ids>')
  .description('Choreograph the same animation across nodes, offset per node')
  .option('-p, --preset <name>', 'preset to stagger')
  .option('-f, --field <field>', 'field (instead of a preset)')
  .option('--from <v>', 'start value (with --field)')
  .option('--to <v>', 'end value (with --field)')
  .option('-s, --step <s>', 'per-node offset seconds', '0.1')
  .option('-d, --dur <s>', 'duration seconds', '0.5')
  .option('-e, --ease <ease>', 'easing', 'ease-out')
  .allowExcessArguments(false)
  .action(async (ids, options) => runMotionStagger({
    nodeIds: ids.split(',').map((value) => value.trim()).filter(Boolean),
    mode: options.preset ? 'preset' : 'field',
    preset: options.preset ?? null,
    field: options.field ?? null,
    from: options.from ?? null,
    to: options.to ?? null,
    step: options.step,
    duration: options.dur,
    easing: options.ease,
  }));

// ============ motion styles ============
motion
  .command('styles')
  .description("List Figma's first-party animation styles")
  .allowExcessArguments(false)
  .action(async () => runMotionRead({ action: 'styles' }));

// ============ motion style <id> <name> ============
motion
  .command('style <id> <name>')
  .description('Apply a Figma animation style (match by name, e.g. opacity, position)')
  .option('-d, --dur <s>', 'duration seconds', '0.5')
  .option('--at <s>', 'timeline offset seconds', '0')
  .option('-t, --timing <timing>', 'in | out (style-dependent)')
  .allowExcessArguments(false)
  .action(async (id, name, options) => runMotionStyle({
    nodeId: id,
    name,
    duration: options.dur,
    offset: options.at,
    timing: options.timing || null,
  }));

// ============ motion timeline <id> ============
motion
  .command('timeline <id>')
  .description('Read or set the timeline duration of the frame containing a node')
  .option('-d, --duration <s>', 'set duration seconds')
  .allowExcessArguments(false)
  .action(async (id, options) => runMotionTimeline({ nodeId: id, duration: options.duration }));

// ============ motion inspect <id> ============
motion
  .command('inspect <id>')
  .description('Read back keyframe tracks, styles, and timeline for a node')
  .allowExcessArguments(false)
  .action(async (id) => runMotionRead({ action: 'inspect', nodeId: id }));

// ============ motion clear <id> ============
motion
  .command('clear <id>')
  .description('Remove motion: all tracks (default), one --field, or --styles')
  .option('-f, --field <field>', 'remove only this field track')
  .option('--styles', 'remove animation styles instead of keyframe tracks')
  .allowExcessArguments(false)
  .action(async (id, options) => runMotionClear({
    nodeId: id,
    mode: options.styles ? 'styles' : options.field ? 'field' : 'tracks',
    field: options.styles ? null : options.field || null,
  }));
