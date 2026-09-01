import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMotionApplyPlan,
  executePreparedMotionApply,
  motionApplyCode,
  motionApplyPlanRoute,
  prepareMotionApplyPlan,
} from '../src/application/motion-apply-command.js';
import {
  acceptsMotionApplyArgv,
  motionApplyArgvFromRequest,
  motionApplyPlanningArgvFromRequest,
  parseMotionApplyRequest,
} from '../src/application/motion-apply-request.js';
import { parseMotionApplySource } from '../src/application/motion-apply-source.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

const copy = (value) => JSON.parse(JSON.stringify(value));

const SPEC = Object.freeze({
  duration: 1.5,
  tracks: [
    { node: '1:2', field: 'opacity', keys: [{ t: 0, v: 0 }, { t: 1, v: 1, ease: 'ease-out' }] },
    { node: '1:3', field: 'fill', keys: [{ t: 0, v: '#ff0000' }, { t: 1, v: '#00ff0080' }] },
  ],
});

function runtime({ throwAfterApplyCall = 0 } = {}) {
  const page = { id: '0:1', type: 'PAGE', name: 'Motion Lab', children: [] };
  const registry = new Map();
  const states = new Map();
  let applyCalls = 0;
  for (const [index, id] of ['1:2', '1:3'].entries()) {
    const parent = { id: `0:${index + 2}`, type: 'FRAME', name: `Inner ${index + 1}`, parent: page, children: [] };
    const state = { tracks: {}, timelines: [{ id: `timeline:${index + 1}`, duration: 0.25 }] };
    const node = {
      id, type: 'RECTANGLE', name: `Card ${index + 1}`, parent,
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
      strokes: [],
      get manualKeyframeTracks() { return copy(state.tracks); },
      get timelines() { return copy(state.timelines); },
      applyManualKeyframeTrack(field, binding) {
        applyCalls += 1;
        if (field.type === 'PROPERTY') state.tracks[field.name] = copy(binding);
        else { state.tracks[field.collection] ||= {}; state.tracks[field.collection][field.index] = copy(binding); }
        if (applyCalls === throwAfterApplyCall) throw new Error('injected apply acknowledgement');
      },
      removeManualKeyframeTrack(field) {
        if (field.type === 'PROPERTY') delete state.tracks[field.name];
        else if (state.tracks[field.collection]) {
          delete state.tracks[field.collection][field.index];
          if (!Object.keys(state.tracks[field.collection]).length) delete state.tracks[field.collection];
        }
      },
      setTimelineDuration(timelineId, duration) {
        const timeline = state.timelines.find((entry) => entry.id === timelineId);
        if (!timeline) throw new Error('unknown timeline');
        timeline.duration = duration;
      },
    };
    parent.children.push(node); page.children.push(parent);
    registry.set(id, node); states.set(id, state);
  }
  return {
    figma: {
      editorType: 'figma', motion: {},
      async getNodeByIdAsync(id) { return registry.get(id) || null; },
    },
    state: (id) => copy(states.get(id)),
    applyCalls: () => applyCalls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

function workspaceFixture(source = SPEC) {
  const root = mkdtempSync(join(tmpdir(), 'motion-apply-'));
  const file = join(root, 'motion.json');
  writeFileSync(file, JSON.stringify(source));
  let reads = 0;
  const io = createWorkspaceIO({ root, testHooks: { beforeReadOpen: () => { reads += 1; } } });
  return { root, file, io, reads: () => reads };
}

test('Motion Apply closes inline JSON, file paths, terminators, and excess input', () => {
  const pretty = JSON.stringify(SPEC, null, 2);
  const canonical = JSON.stringify(SPEC);
  assert.deepEqual(parseMotionApplyRequest(['motion', 'apply', pretty]), {
    sourceKind: 'inline', source: canonical,
  });
  assert.deepEqual(parseMotionApplyRequest(['motion', 'apply', '--', '-motion.json']), {
    sourceKind: 'file', source: '-motion.json',
  });
  assert.deepEqual(motionApplyArgvFromRequest({ source: pretty }), [
    'motion', 'apply', '--', canonical,
  ]);
  assert.deepEqual(motionApplyPlanningArgvFromRequest({ sourceKind: 'file', source: 'motion.json' }), [
    'motion', 'apply', '--', 'motion.json',
  ]);
  for (const argv of [
    ['motion', 'apply'],
    ['motion', 'apply', '   '],
    ['motion', 'apply', '--future', 'private-value'],
    ['motion', 'apply', 'motion.json', 'private-value'],
    ['motion', 'apply', '{"tracks":[]}'],
    ['motion', 'apply', '{"tracks":[{"node":"1:2","field":"opacity","keys":[{"t":0,"v":0}],"private":"value"}]}'],
  ]) assert.equal(acceptsMotionApplyArgv(argv), false, argv.join(' '));
});

test('Motion Apply source validation is exact, bounded, and rejects secret target derivation', () => {
  const parsed = parseMotionApplySource(JSON.stringify(SPEC));
  assert.equal(parsed.prepared.action, 'apply');
  assert.equal(parsed.prepared.duration, 1.5);
  assert.deepEqual(parsed.prepared.nodes.map(({ requestedId }) => requestedId), ['1:2', '1:3']);
  assert.deepEqual(parsed.prepared.nodes[1].tracks[0].field,
    { type: 'INDEXED_ITEM', collection: 'fills', index: 0 });
  for (const value of [
    { tracks: [] },
    { tracks: [{ node: 'https://www.figma.com/design/SECRET/X?node-id=1-2', field: 'opacity', keys: [{ t: 0, v: 0 }] }] },
    { tracks: [{ node: '1:2', field: 'private-field', keys: [{ t: 0, v: 0 }] }] },
    { tracks: [{ node: '1:2', field: 'fill:256', keys: [{ t: 0, v: '#fff' }] }] },
    { tracks: [{ node: '1:2', field: 'opacity', keys: [{ t: -1, v: 0 }] }] },
    { tracks: [{ node: '1:2', field: 'opacity', keys: [{ t: 0, v: 0, ease: 'private-ease' }] }] },
    { tracks: [
      { node: '1:2', field: 'opacity', keys: [{ t: 0, v: 0 }] },
      { node: '1:2', field: 'OPACITY', keys: [{ t: 1, v: 1 }] },
    ] },
  ]) assert.throws(() => parseMotionApplySource(JSON.stringify(value)), /Invalid Motion Apply source/);
  assert.throws(() => parseMotionApplySource(JSON.stringify(SPEC), {
    limits: { jsonBytes: 1, nestingDepth: 64, collectionEntries: 100_000 },
  }), /exceeds 1 bytes/);
  for (const secret of ['private-field-value', 'private-easing-value']) {
    const source = secret.includes('field')
      ? { tracks: [{ node: '1:2', field: secret, keys: [{ t: 0, v: 0 }] }] }
      : { tracks: [{ node: '1:2', field: 'opacity', keys: [{ t: 0, v: 0, ease: secret }] }] };
    assert.throws(() => parseMotionApplySource(JSON.stringify(source)), (error) => !error.message.includes(secret));
  }
});

test('Motion Apply prepares an authorized file exactly once before dispatch', () => {
  const fixture = workspaceFixture();
  const plan = planFigmaCommand(['motion', 'apply', 'motion.json'], {
    adapter: 'mcp', workspaceDir: fixture.root, workspaceIO: fixture.io, fileKey: 'FILEA',
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.argv.at(-1), fixture.file);
  assert.equal(plan.effects.workspace, 'read');
  assert.equal(fixture.reads(), 0);
  const prepared = prepareMotionApplyPlan(plan, { workspaceIO: fixture.io });
  assert.equal(fixture.reads(), 1);
  assert.equal(prepared.request.source, fixture.file);
  assert.equal(prepared.tracks.nodes.length, 2);
  assert.throws(() => { prepared.tracks.nodes[0].requestedId = '9:9'; }, TypeError);
  assert.throws(() => motionApplyPlanRoute({ ...plan }), /requires a Command Plan/);
  assert.throws(() => prepareMotionApplyPlan(plan), /authorized WorkspaceIO/);
});

test('Motion Apply applies one inline multi-node spec through the shared transaction', async () => {
  const plan = planFigmaCommand(['motion', 'apply', JSON.stringify(SPEC)], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  const live = runtime();
  const result = await executeMotionApplyPlan(plan, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.trackCount, 2);
  assert.equal(result.result.nodes.length, 2);
  assert.equal(live.state('1:2').tracks.OPACITY.keyframes[1].easing.type, 'EASE_OUT');
  assert.deepEqual(live.state('1:3').tracks.fills[0].keyframes[1].value.value,
    { r: 0, g: 1, b: 0, a: 128 / 255 });
  assert.equal(live.state('1:2').timelines[0].duration, 1.5);
  assert.equal(live.state('1:3').timelines[0].duration, 1.5);
  assert.match(result.stdout, /Animated 2 nodes · 2 tracks · timeline 1.5s/);
});

test('Motion Apply file and inline Plans have the same canonical execution semantics', async () => {
  const fixture = workspaceFixture();
  const filePlan = planFigmaCommand(['motion', 'apply', 'motion.json'], {
    adapter: 'cli', workspaceDir: fixture.root, workspaceIO: fixture.io, fileKey: 'FILEA',
  });
  const inlinePlan = planFigmaCommand(['motion', 'apply', JSON.stringify(SPEC, null, 2)], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(motionApplyPlanRoute(filePlan), 'command-application');
  assert.equal(motionApplyPlanRoute(inlinePlan), 'command-application');
  assert.equal(filePlan.execution.retry, 'never');
  assert.equal(inlinePlan.execution.retry, 'never');
  const fileLive = runtime();
  const inlineLive = runtime();
  const fileResult = await executeMotionApplyPlan(filePlan, {
    workspaceIO: fixture.io, evaluate: evaluate(fileLive.figma),
  });
  const inlineResult = await executeMotionApplyPlan(inlinePlan, { evaluate: evaluate(inlineLive.figma) });
  assert.deepEqual(fileResult.result, inlineResult.result);
  assert.deepEqual(fileLive.state('1:2'), inlineLive.state('1:2'));
  assert.deepEqual(fileLive.state('1:3'), inlineLive.state('1:3'));
  assert.equal(readFileSync(fixture.file, 'utf8'), JSON.stringify(SPEC));
});

test('invalid file contents fail before evaluation and prepared inputs cannot be forged', async () => {
  const fixture = workspaceFixture({ tracks: [] });
  const plan = planFigmaCommand(['motion', 'apply', fixture.file], {
    adapter: 'mcp', workspaceDir: fixture.root, workspaceIO: fixture.io, fileKey: 'FILEA',
  });
  let evaluations = 0;
  assert.throws(() => executeMotionApplyPlan(plan, {
    workspaceIO: fixture.io, evaluate: async () => { evaluations += 1; return '{}'; },
  }), /Invalid Motion Apply source/);
  assert.equal(evaluations, 0);
  assert.throws(() => motionApplyCode({ tracks: parseMotionApplySource(JSON.stringify(SPEC)).prepared }),
    /authentic prepared input/);
  await assert.rejects(() => executePreparedMotionApply({}, { evaluate: async () => '{}' }),
    /authentic prepared input/);
});

test('malformed and forged Plugin results cannot become successful Motion Applies', async () => {
  const plan = planFigmaCommand(['motion', 'apply', JSON.stringify(SPEC)], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  const prepared = prepareMotionApplyPlan(plan);
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(() => executePreparedMotionApply(prepared, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(motionApplyCode(prepared));
  const forged = JSON.parse(serialized);
  forged.trackCount += 1;
  await assert.rejects(() => executePreparedMotionApply(prepared, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Motion Apply generated code parses and owns one rollback-capable transaction', () => {
  const plan = planFigmaCommand(['motion', 'apply', JSON.stringify(SPEC)], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  const code = motionApplyCode(prepareMotionApplyPlan(plan));
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /requestedTrackCount/);
  assert.match(code, /rollbackNodes/);
});

test('Source MCP delegates Motion Apply preparation and dispatch to the same Application', () => {
  const server = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf('const motionApplyRoute = motionApplyPlanRoute(plan);');
  const end = server.indexOf('const motionAddRoute = motionAddPlanRoute(plan);', start);
  const route = server.slice(start, end);
  assert.ok(start >= 0 && end > start, 'Motion Apply MCP route exists');
  assert.match(route, /prepareMotionApplyPlan\(plan, \{ workspaceIO: WORKSPACE_IO \}\)/);
  assert.match(route, /compatibilityFallback: false/);
  assert.match(route, /executePreparedMotionApply\(prepared/);
  assert.ok(route.indexOf('prepareMotionApplyPlan') < route.indexOf('ensurePluginReadiness'));
});
