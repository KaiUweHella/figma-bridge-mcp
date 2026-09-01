// Commands: motion — author Figma Motion animations (Config 2026 Beta Plugin API).
// Additive: registers the `motion` namespace only. Pure logic lives in
// ../lib/motion-core.js; legacy mutations turn normalized specs into Plugin API
// calls via fastEval, while reads delegate to their Command Application. Every
// operation guards on the metronome_plugin_api feature flag.
//
// Two hard-won gotchas baked in (Figma Desktop 126.6.12):
//   1. object-assignment `node.manualKeyframeTracks = {...}` is a SILENT NO-OP;
//      only applyManualKeyframeTrack / removeManualKeyframeTrack persist.
//   2. the daemon's top-level-return auto-wrap is flaky on if-statement returns,
//      so every eval body is wrapped in an explicit async IIFE (evalBody()).
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeMotionAddPlan,
  motionAddPlanningArgvFromRequest,
} from '../application/motion-add-command.js';
import {
  executeMotionClearPlan,
  motionClearPlanningArgvFromRequest,
} from '../application/motion-clear-command.js';
import {
  executeMotionReadPlan,
  motionReadPlanningArgvFromRequest,
} from '../application/motion-read-command.js';
import {
  executeMotionStylePlan,
  motionStylePlanningArgvFromRequest,
} from '../application/motion-style-command.js';
import {
  executeMotionTimelinePlan,
  motionTimelinePlanningArgvFromRequest,
} from '../application/motion-timeline-command.js';
import {
  progress, program, checkConnection, daemonExec, fastEval, handleEvalError, spinnerSucceed,
} from '../lib/cli-core.js';
import { parseBoundedJson, workspaceIO } from '../lib/workspace-io.js';
import {
  normalizeSpec,
  presetTracks,
  expandStagger,
  PRESETS,
} from '../lib/motion-core.js';

const motion = program
  .command('motion')
  .description('Figma Motion: keyframes, presets, styles, timelines (Config 2026 Beta)');

// --- shared plugin-side helpers, embedded into every eval ------------------

// Beta guard + node resolution with top-level-frame descent.
const PLUGIN_PRELUDE = `
function motionGuard() {
  if (typeof figma.motion !== 'object' || !figma.motion) return { error: 'MOTION_DISABLED' };
  return null;
}
async function resolveTarget(id) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) return { error: 'NOT_FOUND', id };
  const topLevel = n.parent && n.parent.type === 'PAGE';
  const containerish = ['FRAME','COMPONENT','COMPONENT_SET','GROUP','SECTION','INSTANCE'].includes(n.type);
  if (topLevel && containerish) {
    const kids = n.children || [];
    if (kids.length === 1) return { node: kids[0], descended: true, fromId: id, fromName: n.name };
    if (kids.length === 0) return { error: 'TOPLEVEL_EMPTY', id, name: n.name };
    return { error: 'TOPLEVEL_MULTI', id, name: n.name, children: kids.map(k => ({ id: k.id, name: k.name })) };
  }
  return { node: n, descended: false };
}
`;

// Wrap prelude + a guarded body in an async IIFE so the daemon never has to
// guess whether to wrap top-level returns.
function evalBody(body) {
  return `(async () => {
${PLUGIN_PRELUDE}
const guard = motionGuard();
if (guard) return guard;
${body}
})()`;
}

function printGuardError(res) {
  if (res && res.error === 'MOTION_DISABLED') {
    console.log(chalk.red('\n✗ Motion API not enabled for your Figma account.'));
    console.log(chalk.gray('  Figma Motion (Config 2026) is rolling out behind a Beta flag.'));
    console.log(chalk.gray('  Update Figma Desktop and check figma.com for Motion access, then retry.\n'));
    return true;
  }
  return false;
}

function printTargetError(res, id) {
  if (!res || !res.error) return false;
  if (printGuardError(res)) return true;
  if (res.error === 'NOT_FOUND') {
    console.log(chalk.red(`\n✗ Node "${id}" not found.\n`));
    return true;
  }
  if (res.error === 'TOPLEVEL_EMPTY') {
    console.log(chalk.red(`\n✗ "${res.name}" is a top-level frame with no children.`));
    console.log(chalk.gray("  Motion can only animate a frame's children, not the frame itself.\n"));
    return true;
  }
  if (res.error === 'TOPLEVEL_MULTI') {
    console.log(chalk.red(`\n✗ "${res.name}" is a top-level frame — motion can't target it directly.`));
    console.log(chalk.gray('  Pick one of its children by id:'));
    for (const c of res.children) console.log(chalk.gray(`    ${c.id}  ${c.name}`));
    console.log('');
    return true;
  }
  return false;
}

// Apply a normalized spec ({ duration, byNode }). byNode maps requested id ->
// { FIELD:{keyframes}, fills:{i:{keyframes}} }. Returns per-node results.
async function runApply(normalized) {
  const payload = JSON.stringify({ duration: normalized.duration, byNode: normalized.byNode });
  const body = `
const spec = ${payload};
const results = [];
for (const [reqId, tracks] of Object.entries(spec.byNode)) {
  const r = await resolveTarget(reqId);
  if (r.error) { results.push({ reqId, error: r.error, children: r.children, name: r.name }); continue; }
  const node = r.node;
  const applied = [];
  for (const [field, data] of Object.entries(tracks)) {
    if (field === 'fills' || field === 'strokes') {
      const paints = field === 'fills' ? node.fills : node.strokes;
      for (const [idx, track] of Object.entries(data)) {
        const p = Array.isArray(paints) ? paints[Number(idx)] : null;
        if (!p || p.type !== 'SOLID') { applied.push(field + '[' + idx + ']:SKIPPED_NO_SOLID'); continue; }
        node.applyManualKeyframeTrack({ type: 'INDEXED_ITEM', collection: field, index: Number(idx) }, track);
        applied.push(field + '[' + idx + ']');
      }
    } else {
      node.applyManualKeyframeTrack({ type: 'PROPERTY', name: field }, data);
      applied.push(field);
    }
  }
  const tl = (node.timelines || [])[0];
  if (tl && tl.duration < spec.duration) node.setTimelineDuration(tl.id, spec.duration);
  results.push({
    reqId, nodeId: node.id, nodeName: node.name,
    descended: r.descended || false, fromName: r.fromName, applied,
  });
}
return { duration: spec.duration, results };
`;
  return await fastEval(evalBody(body));
}

function reportApply(res, spinner) {
  if (printGuardError(res)) { spinner.fail('Motion not available'); return false; }
  const ok = res.results.filter((r) => !r.error);
  const bad = res.results.filter((r) => r.error);
  if (ok.length === 0) {
    spinner.fail('No tracks applied');
    for (const b of bad) printTargetError(b, b.reqId);
    return false;
  }
  spinnerSucceed(spinner, `Animated ${ok.length} node${ok.length > 1 ? 's' : ''} · timeline ${res.duration}s`);
  for (const r of ok) {
    const via = r.descended ? chalk.gray(` (via "${r.fromName}")`) : '';
    console.log(chalk.gray(`  ${r.nodeId}  ${r.nodeName}${via} → ${r.applied.join(', ')}`));
  }
  for (const b of bad) printTargetError(b, b.reqId);
  return true;
}

function specFromPreset(id, name, opts) {
  const tracks = presetTracks(name, opts).map((t) => ({ node: id, field: t.field, keys: t.keys }));
  return normalizeSpec({ tracks });
}

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
  .action(async (spec) => {
    await checkConnection();
    const spinner = progress('Applying animation spec...').start();
    try {
      const trimmed = spec.trim();
      const text = trimmed.startsWith('{')
        ? trimmed
        : workspaceIO().readText(spec, { role: 'motion-file' });
      const obj = parseBoundedJson(text, { role: 'motion-file', limits: workspaceIO().limits });
      const normalized = normalizeSpec(obj);
      const res = await runApply(normalized);
      reportApply(res, spinner);
    } catch (e) {
      spinner.fail(e.message);
      process.exitCode = 1;
    }
  });

// ============ motion preset <id> <name> ============
motion
  .command('preset <id> <name>')
  .description(`Apply a preset: ${Object.keys(PRESETS).join(', ')}`)
  .option('-d, --dur <s>', 'duration seconds', '0.5')
  .option('--at <s>', 'start offset seconds', '0')
  .option('-e, --ease <ease>', 'easing', 'ease-out')
  .action(async (id, name, options) => {
    await checkConnection();
    const spinner = progress(`Applying "${name}"...`).start();
    try {
      const normalized = specFromPreset(id, name, {
        dur: parseFloat(options.dur),
        at: parseFloat(options.at),
        ease: options.ease,
      });
      const res = await runApply(normalized);
      reportApply(res, spinner);
    } catch (e) {
      spinner.fail(e.message);
      process.exitCode = 1;
    }
  });

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
  .action(async (ids, options) => {
    await checkConnection();
    const list = ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return console.log(chalk.red('✗ no node ids given'));
    if (!options.preset && !options.field) return console.log(chalk.red('✗ need --preset or --field'));
    const spinner = progress(`Staggering ${list.length} nodes...`).start();
    try {
      const opts = options.preset
        ? { preset: options.preset, dur: parseFloat(options.dur), ease: options.ease }
        : {
            field: options.field,
            from: parseFloat(options.from),
            to: parseFloat(options.to),
            dur: parseFloat(options.dur),
            ease: options.ease,
          };
      const specObj = expandStagger(list, opts, parseFloat(options.step));
      const normalized = normalizeSpec(specObj);
      const res = await runApply(normalized);
      reportApply(res, spinner);
    } catch (e) {
      spinner.fail(e.message);
      process.exitCode = 1;
    }
  });

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
