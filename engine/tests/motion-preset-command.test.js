import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMotionPreset,
  executeMotionPresetPlan,
  motionPresetCode,
  motionPresetPlanRoute,
} from '../src/application/motion-preset-command.js';
import {
  acceptsMotionPresetArgv,
  motionPresetArgvFromRequest,
  motionPresetPlanningArgvFromRequest,
  parseMotionPresetRequest,
} from '../src/application/motion-preset-request.js';

const copy = (value) => JSON.parse(JSON.stringify(value));

function runtime({
  manual = {}, timelineDuration = 0.2, throwAfterApplyCall = 0,
  applyNoEffectCalls = [], removeNoEffect = false, rollbackApplyNoEffect = false,
} = {}) {
  const page = { id: '0:1', type: 'PAGE', name: 'Motion Lab', children: [] };
  const parent = { id: '0:2', type: 'FRAME', name: 'Inner', parent: page, children: [] };
  let tracks = copy(manual);
  let timelines = [{ id: 'timeline:1', duration: timelineDuration }];
  let applyCalls = 0;
  const node = {
    id: '1:2', type: 'RECTANGLE', name: 'Animated Card', parent,
    get manualKeyframeTracks() { return copy(tracks); },
    get timelines() { return copy(timelines); },
    applyManualKeyframeTrack(field, binding) {
      applyCalls += 1;
      const rollbackCall = throwAfterApplyCall > 0 && applyCalls > throwAfterApplyCall;
      if (!applyNoEffectCalls.includes(applyCalls) && !(rollbackCall && rollbackApplyNoEffect)) {
        if (field.type === 'PROPERTY') tracks[field.name] = copy(binding);
        else { tracks[field.collection] ||= {}; tracks[field.collection][field.index] = copy(binding); }
      }
      if (applyCalls === throwAfterApplyCall) throw new Error('injected preset acknowledgement');
    },
    removeManualKeyframeTrack(field) {
      if (removeNoEffect) return;
      if (field.type === 'PROPERTY') delete tracks[field.name];
      else if (tracks[field.collection]) {
        delete tracks[field.collection][field.index];
        if (!Object.keys(tracks[field.collection]).length) delete tracks[field.collection];
      }
    },
    setTimelineDuration(id, duration) {
      const index = timelines.findIndex((timeline) => timeline.id === id);
      if (index < 0) throw new Error('unknown timeline');
      timelines[index] = { ...timelines[index], duration };
    },
  };
  parent.children.push(node); page.children.push(parent);
  const figma = {
    editorType: 'figma', motion: {},
    async getNodeByIdAsync(id) { return id === node.id ? node : null; },
  };
  return { figma, node, tracks: () => copy(tracks), timelines: () => copy(timelines), applyCalls: () => applyCalls };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Motion Preset closes defaults, aliases, URL identity, and invalid input', () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  assert.deepEqual(parseMotionPresetRequest(['motion', 'preset', url, 'fade-up']), {
    nodeId: '1:2', preset: 'fade-up', duration: 0.5, offset: 0, easing: 'ease-out',
  });
  assert.deepEqual(parseMotionPresetRequest([
    'motion', 'preset', '-d1', '--at=.2', '-egentle', '--', '1:2', 'pop',
  ]), { nodeId: '1:2', preset: 'pop', duration: 1, offset: 0.2, easing: 'gentle' });
  assert.deepEqual(motionPresetArgvFromRequest({
    nodeId: '1:2', preset: 'spin', duration: 1, offset: 0.2, easing: 'linear',
  }), ['motion', 'preset', '--dur', '1', '--at', '0.2', '--ease', 'linear', '--', '1:2', 'spin']);
  assert.deepEqual(motionPresetPlanningArgvFromRequest({ nodeId: url, preset: 'fade-in' }).slice(-3),
    ['--', url, 'fade-in']);
  for (const argv of [
    ['motion', 'preset'],
    ['motion', 'preset', '1:2'],
    ['motion', 'preset', '1:2', 'explode'],
    ['motion', 'preset', '--dur', '0', '1:2', 'fade-in'],
    ['motion', 'preset', '--at', '-1', '1:2', 'fade-in'],
    ['motion', 'preset', '--ease', 'private-value', '1:2', 'fade-in'],
    ['motion', 'preset', '--future', 'private-value', '1:2', 'fade-in'],
    ['motion', 'preset', '1:2', 'fade-in', 'extra'],
  ]) assert.equal(acceptsMotionPresetArgv(argv), false, argv.join(' '));
});

test('Motion Preset applies every generated track and extends one timeline transactionally', async () => {
  const live = runtime();
  const result = await executeMotionPreset({
    nodeId: live.node.id, preset: 'fade-up', duration: 0.8, offset: 0.4, easing: 'gentle',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.trackCount, 2);
  assert.deepEqual(result.result.nodes[0].fields, ['OPACITY', 'TRANSLATION_Y']);
  assert.equal(live.tracks().OPACITY.keyframes[1].easing.type, 'GENTLE');
  assert.equal(live.tracks().TRANSLATION_Y.keyframes[0].value.value, 24);
  assert.equal(live.timelines()[0].duration, 1.2000000000000002);
  assert.match(result.stdout, /fade-up/);
});

test('Motion Preset accepts an acknowledgement error only after the complete state exists', async () => {
  const complete = runtime({ timelineDuration: 2, throwAfterApplyCall: 2 });
  const result = await executeMotionPreset({ nodeId: complete.node.id, preset: 'fade-up' }, {
    evaluate: evaluate(complete.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh readback proved/);

  const incomplete = runtime({ throwAfterApplyCall: 2 });
  await assert.rejects(() => executeMotionPreset({ nodeId: incomplete.node.id, preset: 'fade-up' }, {
    evaluate: evaluate(incomplete.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(incomplete.tracks(), {});
  assert.deepEqual(incomplete.timelines(), [{ id: 'timeline:1', duration: 0.2 }]);
});

test('Motion Preset reports bounded residue when reverse rollback cannot restore one track', async () => {
  const live = runtime({ throwAfterApplyCall: 2, removeNoEffect: true });
  await assert.rejects(() => executeMotionPreset({ nodeId: live.node.id, preset: 'fade-up' }, {
    evaluate: evaluate(live.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount === 1);
  assert.equal(Object.keys(live.tracks()).length, 2);
});

test('Motion Preset owns one non-retrying Plan across CLI and MCP', async () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  const cli = planFigmaCommand([
    'motion', 'preset', url, 'pop', '--dur', '1', '--at', '.2', '--ease', 'gentle',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'motion', 'preset', '-d1', '--at=.2', '-egentle', '--', url, 'pop',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(motionPresetPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeMotionPresetPlan(cli, { evaluate: evaluate(live.figma) })).result.outcome,
    'verified');
  assert.throws(() => motionPresetPlanRoute({ ...cli }), /requires a Command Plan/);
});

test('malformed and forged results cannot become successful Motion Presets', async () => {
  const request = { nodeId: '1:2', preset: 'fade-in' };
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(() => executeMotionPreset(request, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(motionPresetCode(request));
  const forged = JSON.parse(serialized);
  forged.trackCount += 1;
  await assert.rejects(() => executeMotionPreset(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Motion Preset generated code parses and uses the shared track transaction', () => {
  const code = motionPresetCode({ nodeId: '1:2', preset: 'fade-up' });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /applyManualKeyframeTrack/);
  assert.match(code, /removeManualKeyframeTrack/);
});
