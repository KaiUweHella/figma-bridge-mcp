// Commands: motion — author Figma Motion animations (Config 2026 Beta Plugin API).
// Additive: registers the `motion` namespace only. Pure logic lives in
// ../lib/motion-core.js; this file turns normalized specs into Plugin API calls
// via fastEval. Every command guards on the metronome_plugin_api feature flag.
//
// Two hard-won gotchas baked in (Figma Desktop 126.6.12):
//   1. object-assignment `node.manualKeyframeTracks = {...}` is a SILENT NO-OP;
//      only applyManualKeyframeTrack / removeManualKeyframeTrack persist.
//   2. the daemon's top-level-return auto-wrap is flaky on if-statement returns,
//      so every eval body is wrapped in an explicit async IIFE (evalBody()).
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync } from 'fs';
import { program, checkConnection, fastEval } from '../lib/cli-core.js';
import {
  mapField,
  parseKeys,
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
  spinner.succeed(`Animated ${ok.length} node${ok.length > 1 ? 's' : ''} · timeline ${res.duration}s`);
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
  .action(async (id, options) => {
    await checkConnection();
    if (!options.field) return console.log(chalk.red('✗ --field is required (e.g. --field opacity)'));
    const spinner = ora('Applying keyframes...').start();
    try {
      const f = mapField(options.field);
      let normalized;

      if (options.keys) {
        const kfs = parseKeys(options.keys, f.valueType);
        const node = {};
        if (f.valueType === 'COLOR') node[f.name] = { [f.index]: { keyframes: kfs } };
        else node[f.name] = { keyframes: kfs };
        const maxT = Math.max(...kfs.map((k) => k.timelinePosition));
        normalized = { duration: maxT, maxT, byNode: { [id]: node } };
      } else if (options.from != null && options.to != null) {
        const dur = parseFloat(options.dur);
        const at = parseFloat(options.at);
        const from = f.valueType === 'COLOR' ? options.from : parseFloat(options.from);
        const to = f.valueType === 'COLOR' ? options.to : parseFloat(options.to);
        const keys = [
          { t: at, v: from },
          { t: at + dur, v: to, ease: options.ease },
        ];
        normalized = normalizeSpec({ tracks: [{ node: id, field: options.field, keys }] });
      } else {
        spinner.fail('Need --keys or both --from and --to');
        return;
      }

      const res = await runApply(normalized);
      reportApply(res, spinner);
    } catch (e) {
      spinner.fail(e.message);
    }
  });

// ============ motion apply <spec> ============
motion
  .command('apply <spec>')
  .description('Apply a full animation spec (JSON file path or inline JSON)')
  .action(async (spec) => {
    await checkConnection();
    const spinner = ora('Applying animation spec...').start();
    try {
      const trimmed = spec.trim();
      const obj = trimmed.startsWith('{') ? JSON.parse(trimmed) : JSON.parse(readFileSync(spec, 'utf8'));
      const normalized = normalizeSpec(obj);
      const res = await runApply(normalized);
      reportApply(res, spinner);
    } catch (e) {
      spinner.fail(e.message);
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
    const spinner = ora(`Applying "${name}"...`).start();
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
    const spinner = ora(`Staggering ${list.length} nodes...`).start();
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
    }
  });

// ============ motion styles ============
motion
  .command('styles')
  .description("List Figma's first-party animation styles")
  .action(async () => {
    await checkConnection();
    const spinner = ora('Reading animation styles...').start();
    try {
      const res = await fastEval(evalBody(
        `return figma.motion.figmaAnimationStyles().map(s => ({ styleId: s.styleId, name: s.name, description: s.description }));`
      ));
      if (printGuardError(res)) { spinner.fail('Motion not available'); return; }
      spinner.succeed(`${res.length} animation styles`);
      for (const s of res) {
        const short = String(s.name).replace(/^motion\.preset_name\./, '');
        console.log(chalk.gray(`  ${short.padEnd(12)} ${chalk.dim(s.name)}`));
      }
    } catch (e) {
      spinner.fail(e.message);
    }
  });

// ============ motion style <id> <name> ============
motion
  .command('style <id> <name>')
  .description('Apply a Figma animation style (match by name, e.g. opacity, position)')
  .option('-d, --dur <s>', 'duration seconds', '0.5')
  .option('--at <s>', 'timeline offset seconds', '0')
  .option('-t, --timing <timing>', 'in | out (style-dependent)')
  .action(async (id, name, options) => {
    await checkConnection();
    const spinner = ora(`Applying style "${name}"...`).start();
    try {
      const props = {};
      if (options.timing) props.timing = options.timing;
      const arg = JSON.stringify({ name, dur: parseFloat(options.dur), at: parseFloat(options.at), props });
      const body = `
const arg = ${arg};
const r = await resolveTarget(${JSON.stringify(id)});
if (r.error) return r;
const node = r.node;
const styles = figma.motion.figmaAnimationStyles();
const q = arg.name.toLowerCase();
const def = styles.find(s => s.name.toLowerCase() === q || s.name.toLowerCase().endsWith('.' + q) || s.name.toLowerCase().includes(q));
if (!def) return { error: 'STYLE_NOT_FOUND', available: styles.map(s => s.name) };
const applied = node.applyAnimationStyle(def.styleId, { duration: arg.dur, timelineOffset: arg.at, props: arg.props });
const end = arg.at + arg.dur;
const tl = (node.timelines || [])[0];
if (tl && tl.duration < end) node.setTimelineDuration(tl.id, end);
return { nodeId: node.id, nodeName: node.name, descended: r.descended || false, fromName: r.fromName, styleName: def.name, appliedStyleId: applied };
`;
      const res = await fastEval(evalBody(body));
      if (printTargetError(res, id)) { spinner.fail('Could not apply style'); return; }
      if (res.error === 'STYLE_NOT_FOUND') {
        spinner.fail(`No style matching "${name}"`);
        console.log(chalk.gray('  Available: ' + res.available.map((n) => n.replace(/^motion\.preset_name\./, '')).join(', ')));
        return;
      }
      const via = res.descended ? chalk.gray(` (via "${res.fromName}")`) : '';
      spinner.succeed(`Applied style "${res.styleName.replace(/^motion\.preset_name\./, '')}" to ${res.nodeName}${via}`);
    } catch (e) {
      spinner.fail(e.message);
    }
  });

// ============ motion timeline <id> ============
motion
  .command('timeline <id>')
  .description('Read or set the timeline duration of the frame containing a node')
  .option('-d, --duration <s>', 'set duration seconds')
  .action(async (id, options) => {
    await checkConnection();
    const spinner = ora('Reading timeline...').start();
    try {
      const setDur = options.duration != null ? parseFloat(options.duration) : null;
      const body = `
const r = await resolveTarget(${JSON.stringify(id)});
if (r.error) return r;
const node = r.node;
const tl = (node.timelines || [])[0] || null;
${setDur != null ? `if (tl) node.setTimelineDuration(tl.id, ${setDur});` : ''}
return { nodeId: node.id, timelines: node.timelines };
`;
      const res = await fastEval(evalBody(body));
      if (printTargetError(res, id)) { spinner.fail('No timeline'); return; }
      const tl = (res.timelines || [])[0];
      if (setDur != null) spinner.succeed(`Timeline set to ${tl ? tl.duration : setDur}s`);
      else spinner.succeed(`Timeline: ${tl ? tl.duration + 's' : 'none'}`);
    } catch (e) {
      spinner.fail(e.message);
    }
  });

// ============ motion inspect <id> ============
motion
  .command('inspect <id>')
  .description('Read back keyframe tracks, styles, and timeline for a node')
  .action(async (id) => {
    await checkConnection();
    const spinner = ora('Inspecting motion...').start();
    try {
      const body = `
const r = await resolveTarget(${JSON.stringify(id)});
if (r.error) return r;
const node = r.node;
return {
  nodeId: node.id, nodeName: node.name, descended: r.descended || false, fromName: r.fromName,
  timelines: node.timelines,
  manualKeyframeTracks: node.manualKeyframeTracks,
  animationStyles: node.animationStyles,
};
`;
      const res = await fastEval(evalBody(body));
      if (printTargetError(res, id)) { spinner.fail('Nothing to inspect'); return; }
      spinner.succeed(`Motion on ${res.nodeName}${res.descended ? chalk.gray(` (via "${res.fromName}")`) : ''}`);
      console.log(JSON.stringify({
        timelines: res.timelines,
        manualKeyframeTracks: res.manualKeyframeTracks,
        animationStyles: res.animationStyles,
      }, null, 2));
    } catch (e) {
      spinner.fail(e.message);
    }
  });

// ============ motion clear <id> ============
motion
  .command('clear <id>')
  .description('Remove motion: all tracks (default), one --field, or --styles')
  .option('-f, --field <field>', 'remove only this field track')
  .option('--styles', 'remove animation styles instead of keyframe tracks')
  .action(async (id, options) => {
    await checkConnection();
    const spinner = ora('Clearing motion...').start();
    try {
      const target = options.field ? mapField(options.field) : null;
      const arg = JSON.stringify({ field: target, styles: !!options.styles });
      const body = `
const arg = ${arg};
const r = await resolveTarget(${JSON.stringify(id)});
if (r.error) return r;
const node = r.node;
if (arg.styles) {
  for (const s of (node.animationStyles || [])) { if (s.id) node.removeAnimationStyle(s.id); }
} else if (arg.field) {
  if (arg.field.valueType === 'COLOR') node.removeManualKeyframeTrack({ type: 'INDEXED_ITEM', collection: arg.field.name, index: arg.field.index });
  else node.removeManualKeyframeTrack({ type: 'PROPERTY', name: arg.field.name });
} else {
  const mkt = node.manualKeyframeTracks || {};
  for (const key of Object.keys(mkt)) {
    if (key === 'fills' || key === 'strokes') {
      for (const idx of Object.keys(mkt[key])) node.removeManualKeyframeTrack({ type: 'INDEXED_ITEM', collection: key, index: Number(idx) });
    } else {
      node.removeManualKeyframeTrack({ type: 'PROPERTY', name: key });
    }
  }
}
return { nodeId: node.id, nodeName: node.name };
`;
      const res = await fastEval(evalBody(body));
      if (printTargetError(res, id)) { spinner.fail('Nothing to clear'); return; }
      const what = options.styles ? 'styles' : options.field ? `field ${options.field}` : 'all tracks';
      spinner.succeed(`Cleared ${what} on ${res.nodeName}`);
    } catch (e) {
      spinner.fail(e.message);
    }
  });
