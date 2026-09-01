import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMotionStagger,
  executeMotionStaggerPlan,
  motionStaggerCode,
  motionStaggerPlanRoute,
} from '../src/application/motion-stagger-command.js';
import {
  acceptsMotionStaggerArgv,
  motionStaggerArgvFromRequest,
  motionStaggerPlanningArgvFromRequest,
  parseMotionStaggerRequest,
} from '../src/application/motion-stagger-request.js';

const copy = (value) => JSON.parse(JSON.stringify(value));

function runtime({ ids = ['1:2', '1:3', '1:4'], missing = [], throwAfterApplyCall = 0 } = {}) {
  const page = { id: '0:1', type: 'PAGE', name: 'Motion Lab', children: [] };
  const registry = new Map();
  const states = new Map();
  let applyCalls = 0;
  let timelineCalls = 0;
  for (const [index, id] of ids.entries()) {
    const parent = { id: `0:${index + 2}`, type: 'FRAME', name: `Inner ${index + 1}`, parent: page, children: [] };
    const state = { tracks: {}, timelines: [{ id: `timeline:${index + 1}`, duration: 0.2 }] };
    const node = {
      id, type: 'RECTANGLE', name: `Card ${index + 1}`, parent,
      get manualKeyframeTracks() { return copy(state.tracks); },
      get timelines() { return copy(state.timelines); },
      applyManualKeyframeTrack(field, binding) {
        applyCalls += 1;
        if (field.type === 'PROPERTY') state.tracks[field.name] = copy(binding);
        else { state.tracks[field.collection] ||= {}; state.tracks[field.collection][field.index] = copy(binding); }
        if (applyCalls === throwAfterApplyCall) throw new Error('injected stagger acknowledgement');
      },
      removeManualKeyframeTrack(field) {
        if (field.type === 'PROPERTY') delete state.tracks[field.name];
        else if (state.tracks[field.collection]) {
          delete state.tracks[field.collection][field.index];
          if (!Object.keys(state.tracks[field.collection]).length) delete state.tracks[field.collection];
        }
      },
      setTimelineDuration(timelineId, duration) {
        timelineCalls += 1;
        const timeline = state.timelines.find((entry) => entry.id === timelineId);
        if (!timeline) throw new Error('unknown timeline');
        timeline.duration = duration;
      },
    };
    parent.children.push(node); page.children.push(parent);
    registry.set(id, node); states.set(id, state);
  }
  const figma = {
    editorType: 'figma', motion: {},
    async getNodeByIdAsync(id) { return missing.includes(id) ? null : registry.get(id) || null; },
  };
  return {
    figma,
    state: (id) => copy(states.get(id)),
    applyCalls: () => applyCalls,
    timelineCalls: () => timelineCalls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Motion Stagger closes preset and field modes, URLs, aliases, and invalid input', () => {
  const first = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  const second = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-3';
  assert.deepEqual(parseMotionStaggerRequest([
    'motion', 'stagger', '-pfade-up', '--step=.2', '-d1', '-egentle', '--', `${first},${second}`,
  ]), {
    nodeIds: ['1:2', '1:3'], mode: 'preset', preset: 'fade-up', field: null,
    from: null, to: null, step: 0.2, duration: 1, easing: 'gentle',
  });
  assert.deepEqual(parseMotionStaggerRequest([
    'motion', 'stagger', '--field', 'translateY', '--from', '-24', '--to=0', '1:2,1:3',
  ]), {
    nodeIds: ['1:2', '1:3'], mode: 'field', preset: null, field: 'TRANSLATION_Y',
    from: -24, to: 0, step: 0.1, duration: 0.5, easing: 'ease-out',
  });
  assert.deepEqual(motionStaggerArgvFromRequest({
    nodeIds: ['1:2', '1:3'], preset: 'pop', step: 0.2, duration: 1, easing: 'linear',
  }), ['motion', 'stagger', '--preset', 'pop', '--step', '0.2', '--dur', '1', '--ease', 'linear', '--', '1:2,1:3']);
  assert.equal(motionStaggerPlanningArgvFromRequest({
    nodeIds: [first, second], preset: 'fade-in',
  }).at(-1), `${first},${second}`);
  for (const argv of [
    ['motion', 'stagger'],
    ['motion', 'stagger', '1:2'],
    ['motion', 'stagger', '--preset', 'fade-in', '--field', 'opacity', '1:2'],
    ['motion', 'stagger', '--field', 'opacity', '--from', '0', '1:2'],
    ['motion', 'stagger', '--preset', 'private-value', '1:2'],
    ['motion', 'stagger', '--preset', 'fade-in', '--step', '-1', '1:2'],
    ['motion', 'stagger', '--preset', 'fade-in', '1:2,1:2'],
    ['motion', 'stagger', '--preset', 'fade-in', `${first},https://www.figma.com/design/FILEB/X?node-id=1-3`],
    ['motion', 'stagger', '--preset', 'fade-in', '--future', 'private-value', '1:2'],
  ]) assert.equal(acceptsMotionStaggerArgv(argv), false, argv.join(' '));
});

test('Motion Stagger applies a preset across every node with deterministic offsets', async () => {
  const live = runtime();
  const result = await executeMotionStagger({
    nodeIds: ['1:2', '1:3', '1:4'], preset: 'fade-up', step: 0.1,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.trackCount, 6);
  assert.equal(result.result.nodes.length, 3);
  assert.equal(live.state('1:2').tracks.OPACITY.keyframes[0].timelinePosition, 0);
  assert.equal(live.state('1:3').tracks.OPACITY.keyframes[0].timelinePosition, 0.1);
  assert.equal(live.state('1:4').tracks.OPACITY.keyframes[0].timelinePosition, 0.2);
  for (const id of ['1:2', '1:3', '1:4']) assert.equal(live.state(id).timelines[0].duration, 0.7);
  assert.match(result.stdout, /Staggered 3 nodes/);
});

test('Motion Stagger applies signed field values through the same transaction', async () => {
  const live = runtime({ ids: ['1:2', '1:3'] });
  const result = await executeMotionStagger({
    nodeIds: ['1:2', '1:3'], field: 'translateY', from: -24, to: 0,
    step: 0.2, duration: 0.4,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.trackCount, 2);
  assert.equal(live.state('1:2').tracks.TRANSLATION_Y.keyframes[0].value.value, -24);
  assert.equal(live.state('1:3').tracks.TRANSLATION_Y.keyframes[0].timelinePosition, 0.2);
});

test('Motion Stagger preflights every target before the first mutation', async () => {
  const live = runtime({ ids: ['1:2', '1:3'], missing: ['1:3'] });
  await assert.rejects(() => executeMotionStagger({
    nodeIds: ['1:2', '1:3'], preset: 'fade-in',
  }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(live.applyCalls(), 0);
  assert.deepEqual(live.state('1:2').tracks, {});
});

test('Motion Stagger rolls back prior nodes when a later node fails', async () => {
  const live = runtime({ ids: ['1:2', '1:3'], throwAfterApplyCall: 3 });
  await assert.rejects(() => executeMotionStagger({
    nodeIds: ['1:2', '1:3'], preset: 'fade-up',
  }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  for (const id of ['1:2', '1:3']) {
    assert.deepEqual(live.state(id).tracks, {});
    assert.equal(live.state(id).timelines[0].duration, 0.2);
  }
});

test('Motion Stagger owns one non-retrying multi-target Plan across CLI and MCP', async () => {
  const first = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  const second = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-3';
  const cli = planFigmaCommand([
    'motion', 'stagger', `${first},${second}`, '--preset', 'fade-in', '--step', '.2',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'motion', 'stagger', '-pfade-in', '--step=.2', '--', `${first},${second}`,
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(motionStaggerPlanRoute(cli), 'command-application');
  const live = runtime({ ids: ['1:2', '1:3'] });
  assert.equal((await executeMotionStaggerPlan(cli, { evaluate: evaluate(live.figma) })).result.outcome,
    'verified');
  assert.throws(() => motionStaggerPlanRoute({ ...cli }), /requires a Command Plan/);
});

test('malformed and forged results cannot become successful Motion Staggers', async () => {
  const request = { nodeIds: ['1:2', '1:3'], preset: 'fade-in' };
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(() => executeMotionStagger(request, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime({ ids: ['1:2', '1:3'] });
  const serialized = await evaluate(live.figma)(motionStaggerCode(request));
  const forged = JSON.parse(serialized);
  forged.nodes.reverse();
  await assert.rejects(() => executeMotionStagger(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Motion Stagger generated code parses and uses one shared transaction', () => {
  const code = motionStaggerCode({ nodeIds: ['1:2', '1:3'], preset: 'fade-up' });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /requestedTrackCount/);
  assert.match(code, /rollbackNodes/);
});
