import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMotionAdd,
  executeMotionAddPlan,
  motionAddCode,
  motionAddPlanRoute,
} from '../src/application/motion-add-command.js';
import {
  acceptsMotionAddArgv,
  motionAddArgvFromRequest,
  motionAddPlanningArgvFromRequest,
  parseMotionAddRequest,
} from '../src/application/motion-add-request.js';

const copy = (value) => JSON.parse(JSON.stringify(value));

function runtime({
  editorType = 'figma', motion = true, manual = {}, timelineDuration = 0.2, noTimeline = false,
  fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], applyNoEffect = false,
  throwAfterApply = false, timelineNoEffect = false, throwAfterTimeline = false,
  removeNoEffect = false, rollbackApplyNoEffect = false, rollbackTimelineNoEffect = false,
  failGetCalls = [], children = null,
} = {}) {
  const page = { id: '0:1', type: 'PAGE', name: 'Motion Lab', children: [] };
  const parent = { id: '0:2', type: 'FRAME', name: 'Inner', parent: page, children: [] };
  let tracks = copy(manual);
  let timelines = noTimeline ? [] : [{ id: 'timeline:1', duration: timelineDuration }];
  let applyCalls = 0;
  let timelineCalls = 0;
  let removeCalls = 0;
  let getCalls = 0;
  const setTrack = (field, track) => {
    if (field.type === 'PROPERTY') tracks[field.name] = copy(track);
    else {
      tracks[field.collection] ||= {};
      tracks[field.collection][String(field.index)] = copy(track);
    }
  };
  const removeTrack = (field) => {
    if (field.type === 'PROPERTY') delete tracks[field.name];
    else if (tracks[field.collection]) {
      delete tracks[field.collection][String(field.index)];
      if (Object.keys(tracks[field.collection]).length === 0) delete tracks[field.collection];
    }
  };
  const node = {
    id: '1:2', type: 'RECTANGLE', name: 'Animated Card', parent, fills,
    get manualKeyframeTracks() { return copy(tracks); },
    get timelines() { return copy(timelines); },
    applyManualKeyframeTrack(field, track) {
      applyCalls += 1;
      const noEffect = applyCalls === 1 ? applyNoEffect : rollbackApplyNoEffect;
      if (!noEffect) setTrack(field, track);
      if (applyCalls === 1 && throwAfterApply) throw new Error('injected apply acknowledgement');
    },
    removeManualKeyframeTrack(field) {
      removeCalls += 1;
      if (!removeNoEffect) removeTrack(field);
    },
    setTimelineDuration(id, duration) {
      timelineCalls += 1;
      const index = timelines.findIndex((timeline) => timeline.id === id);
      if (index < 0) throw new Error('unknown timeline');
      const noEffect = timelineCalls === 1 ? timelineNoEffect : rollbackTimelineNoEffect;
      if (!noEffect) timelines[index] = { ...timelines[index], duration };
      if (timelineCalls === 1 && throwAfterTimeline) throw new Error('injected timeline acknowledgement');
    },
  };
  parent.children.push(node); page.children.push(parent);
  const registry = new Map([[page.id, page], [parent.id, parent], [node.id, node]]);
  let target = node;
  if (children !== null) {
    target = { id: '1:1', type: 'FRAME', name: 'Top Level', parent: page, children };
    page.children.push(target); registry.set(target.id, target);
    for (const child of children) { child.parent = target; registry.set(child.id, child); }
  }
  const figma = {
    editorType,
    ...(motion ? { motion: {} } : {}),
    async getNodeByIdAsync(id) {
      getCalls += 1;
      if (failGetCalls.includes(getCalls)) throw new Error('injected fresh read failure');
      return registry.get(id) || null;
    },
  };
  return {
    figma, node, target,
    tracks: () => copy(tracks), timelines: () => copy(timelines),
    applyCalls: () => applyCalls, timelineCalls: () => timelineCalls, removeCalls: () => removeCalls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Motion Add closes key and from/to modes, aliases, URL identity, and invalid input', () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  assert.deepEqual(parseMotionAddRequest([
    'motion', 'add', '-ftranslateY', '--from', '-24', '--to=0', '--', url,
  ]), {
    nodeId: '1:2', field: 'TRANSLATION_Y', mode: 'from-to', keys: null,
    from: -24, to: 0, duration: 0.5, offset: 0, easing: 'ease-out',
  });
  assert.deepEqual(parseMotionAddRequest([
    'motion', 'add', '-f', 'opacity', '-k0:0, 0.4:1:ease-out', '1:2',
  ]), {
    nodeId: '1:2', field: 'OPACITY', mode: 'keys', keys: '0:0, 0.4:1:ease-out',
    from: null, to: null, duration: 0.4, offset: 0, easing: null,
  });
  assert.deepEqual(motionAddArgvFromRequest({
    nodeId: '1:2', field: 'translateY', from: -24, to: 0, duration: 1, offset: 0.2,
    easing: 'gentle',
  }), [
    'motion', 'add', '--field', 'TRANSLATION_Y', '--from', '-24', '--to', '0',
    '--dur', '1', '--at', '0.2', '--ease', 'gentle', '--', '1:2',
  ]);
  assert.deepEqual(motionAddPlanningArgvFromRequest({
    nodeId: url, field: 'opacity', keys: '0:0,1:1',
  }).slice(-2), ['--', url]);
  for (const argv of [
    ['motion', 'add', '1:2'],
    ['motion', 'add', '--field', 'opacity', '1:2'],
    ['motion', 'add', '--field', 'opacity', '--keys', 'bad', '1:2'],
    ['motion', 'add', '--field', 'opacity', '--keys', '0:0', '--dur', '1', '1:2'],
    ['motion', 'add', '--field', 'opacity', '--keys', '0:0', '--from', '0', '1:2'],
    ['motion', 'add', '--field', 'opacity', '--from', 'NaN', '--to', '1', '1:2'],
    ['motion', 'add', '--field', 'fill:256', '--from', '#fff', '--to', '#000', '1:2'],
    ['motion', 'add', '--future', 'private', '--field', 'opacity', '--keys', '0:0', '1:2'],
    ['motion', 'add', '--field', 'opacity', '--keys', '0:0', '1:2', 'extra'],
  ]) assert.equal(acceptsMotionAddArgv(argv), false, argv.join(' '));
});

test('Motion Add applies and freshly verifies one property track plus its timeline', async () => {
  const live = runtime();
  const result = await executeMotionAdd({
    nodeId: live.node.id, field: 'translateY', from: -24, to: 0,
    duration: 0.8, offset: 0.4, easing: 'gentle',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.keyframeCount, 2);
  assert.equal(result.result.replaced, false);
  assert.deepEqual(live.tracks().TRANSLATION_Y, { keyframes: [
    { timelinePosition: 0.4, value: { type: 'FLOAT', value: -24 } },
    { timelinePosition: 1.2000000000000002, value: { type: 'FLOAT', value: 0 }, easing: { type: 'GENTLE' } },
  ] });
  assert.equal(live.timelines()[0].duration, 1.2000000000000002);
  assert.match(result.stdout, /Animated 1:2/);
});

test('Motion Add applies a bounded color key track only to an existing solid paint', async () => {
  const live = runtime({ noTimeline: true });
  const result = await executeMotionAdd({
    nodeId: live.node.id, field: 'fill', keys: '0:#ff0000, 1:#0000ff',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.timelineDuration, null);
  assert.equal(result.result.field, 'fills:0');
  assert.equal(live.tracks().fills[0].keyframes[1].value.value.b, 1);

  const missingPaint = runtime({ fills: [] });
  await assert.rejects(() => executeMotionAdd({
    nodeId: missingPaint.node.id, field: 'fill', keys: '0:#fff,1:#000',
  }, { evaluate: evaluate(missingPaint.figma) }), (error) => error.mutationOutcome === 'no-mutation'
    && /existing solid paint/.test(error.message));
  assert.equal(missingPaint.applyCalls(), 0);
});

test('Motion Add distinguishes an exact no-op from replacing an existing track', async () => {
  const existing = { keyframes: [
    { timelinePosition: 0, value: { type: 'FLOAT', value: 0 } },
    { timelinePosition: 0.5, value: { type: 'FLOAT', value: 1 } },
  ] };
  const noOp = runtime({ manual: { OPACITY: existing }, timelineDuration: 1 });
  const same = await executeMotionAdd({
    nodeId: noOp.node.id, field: 'opacity', keys: '0:0,0.5:1',
  }, { evaluate: evaluate(noOp.figma) });
  assert.equal(same.result.outcome, 'no-op');
  assert.equal(noOp.applyCalls(), 0);

  const replacement = runtime({ manual: { OPACITY: existing }, timelineDuration: 1 });
  const changed = await executeMotionAdd({
    nodeId: replacement.node.id, field: 'opacity', keys: '0:1,0.5:0',
  }, { evaluate: evaluate(replacement.figma) });
  assert.equal(changed.result.replaced, true);
  assert.equal(replacement.tracks().OPACITY.keyframes[0].value.value, 1);
});

test('native acknowledgement errors succeed only after complete Motion Add readback', async () => {
  const applyAck = runtime({ throwAfterApply: true, timelineDuration: 2 });
  const applied = await executeMotionAdd({
    nodeId: applyAck.node.id, field: 'opacity', keys: '0:0,1:1',
  }, { evaluate: evaluate(applyAck.figma) });
  assert.equal(applied.result.outcome, 'verified-after-error');
  assert.match(applied.stderr, /fresh readback proved/);

  const timelineAck = runtime({ throwAfterTimeline: true });
  const extended = await executeMotionAdd({
    nodeId: timelineAck.node.id, field: 'opacity', keys: '0:0,1:1',
  }, { evaluate: evaluate(timelineAck.figma) });
  assert.equal(extended.result.outcome, 'verified-after-error');
  assert.equal(timelineAck.timelines()[0].duration, 1);
});

test('Motion Add mismatch distinguishes unchanged, rollback, residue, and unavailable first readback', async () => {
  const unchanged = runtime({ applyNoEffect: true, timelineDuration: 2 });
  await assert.rejects(() => executeMotionAdd({
    nodeId: unchanged.node.id, field: 'opacity', keys: '0:0,1:1',
  }, { evaluate: evaluate(unchanged.figma) }), (error) => error.mutationOutcome === 'unchanged');

  const rollback = runtime({ timelineNoEffect: true });
  await assert.rejects(() => executeMotionAdd({
    nodeId: rollback.node.id, field: 'opacity', keys: '0:0,1:1',
  }, { evaluate: evaluate(rollback.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(rollback.tracks(), {});
  assert.deepEqual(rollback.timelines(), [{ id: 'timeline:1', duration: 0.2 }]);

  const residue = runtime({ timelineNoEffect: true, removeNoEffect: true });
  await assert.rejects(() => executeMotionAdd({
    nodeId: residue.node.id, field: 'opacity', keys: '0:0,1:1',
  }, { evaluate: evaluate(residue.figma) }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount === 1);

  const unavailable = runtime({ failGetCalls: [2] });
  await assert.rejects(() => executeMotionAdd({
    nodeId: unavailable.node.id, field: 'opacity', keys: '0:0,1:1',
  }, { evaluate: evaluate(unavailable.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(unavailable.tracks(), {});
  assert.deepEqual(unavailable.timelines(), [{ id: 'timeline:1', duration: 0.2 }]);
});

test('Motion Add refuses unavailable APIs and ambiguous top-level targets before mutation', async () => {
  const disabled = runtime({ motion: false });
  await assert.rejects(() => executeMotionAdd({
    nodeId: disabled.node.id, field: 'opacity', keys: '0:0,1:1',
  }, { evaluate: evaluate(disabled.figma) }), (error) => error.mutationOutcome === 'no-mutation'
    && /not enabled/.test(error.message));

  const first = runtime().node; first.id = '2:1';
  const second = runtime().node; second.id = '2:2';
  const many = runtime({ children: [first, second] });
  await assert.rejects(() => executeMotionAdd({
    nodeId: many.target.id, field: 'opacity', keys: '0:0,1:1',
  }, { evaluate: evaluate(many.figma) }), (error) => error.mutationOutcome === 'no-mutation'
    && /2:2/.test(error.message));
});

test('Motion Add owns one non-retrying write Plan across CLI and MCP', async () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  const cli = planFigmaCommand([
    'motion', 'add', url, '--field', 'translateY', '--from', '-24', '--to', '0',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'motion', 'add', '--from=-24', '--to=0', '-ftranslateY', '--', url,
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(motionAddPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeMotionAddPlan(cli, { evaluate: evaluate(live.figma) })).result.outcome,
    'verified');
  assert.throws(() => motionAddPlanRoute({ ...cli }), /requires a Command Plan/);
});

test('malformed and forged Plugin results cannot become successful Motion Adds', async () => {
  const request = { nodeId: '1:2', field: 'opacity', keys: '0:0,1:1' };
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(() => executeMotionAdd(request, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(motionAddCode(request));
  const forged = JSON.parse(serialized);
  forged.field = 'TRANSLATION_X';
  await assert.rejects(() => executeMotionAdd(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Motion Add generated Plugin code parses without a private timer', () => {
  const code = motionAddCode({ nodeId: '1:2', field: 'opacity', keys: '0:0,1:1' });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /applyManualKeyframeTrack/);
  assert.match(code, /removeManualKeyframeTrack/);
  assert.match(code, /setTimelineDuration/);
});
