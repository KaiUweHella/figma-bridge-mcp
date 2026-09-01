import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMotionStyle,
  executeMotionStylePlan,
  motionStyleCode,
  motionStylePlanRoute,
} from '../src/application/motion-style-command.js';
import {
  acceptsMotionStyleArgv,
  motionStyleArgvFromRequest,
  motionStylePlanningArgvFromRequest,
  parseMotionStyleRequest,
} from '../src/application/motion-style-request.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const CATALOG = [
  { styleId: 'style:contains', name: 'motion.preset_name.opacity-in' },
  { styleId: 'style:exact', name: 'opacity' },
  { styleId: 'style:position', name: 'motion.preset_name.position' },
];

function runtime({
  editorType = 'figma', motion = true, catalog = CATALOG, applied = [],
  timelineDuration = 0.6, noTimeline = false, applyNoEffect = false,
  throwAfterApply = false, timelineNoEffect = false, throwAfterTimeline = false,
  removeNoEffect = false, rollbackTimelineNoEffect = false, children = null,
  failGetCalls = [],
} = {}) {
  const page = { id: '0:1', type: 'PAGE', name: 'Motion Lab', children: [] };
  const parent = { id: '0:2', type: 'FRAME', name: 'Inner', parent: page, children: [] };
  let styles = copy(applied);
  let timelines = noTimeline ? [] : [{ id: 'timeline:1', duration: timelineDuration }];
  let applyCalls = 0;
  let timelineCalls = 0;
  let getCalls = 0;
  const removals = [];
  const node = {
    id: '1:2', type: 'RECTANGLE', name: 'Animated Card', parent,
    get animationStyles() { return copy(styles); },
    get timelines() { return copy(timelines); },
    applyAnimationStyle(styleId, config) {
      applyCalls += 1;
      const id = `applied:${applyCalls}`;
      if (!applyNoEffect) {
        const definition = catalog.find((style) => style.styleId === styleId);
        styles.push({ id, styleId, name: definition.name, ...copy(config) });
      }
      if (throwAfterApply) throw new Error('injected apply acknowledgement');
      return id;
    },
    removeAnimationStyle(id) {
      removals.push(id);
      if (!removeNoEffect) styles = styles.filter((style) => style.id !== id);
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
    ...(motion ? { motion: { figmaAnimationStyles: () => copy(catalog) } } : {}),
    async getNodeByIdAsync(id) {
      getCalls += 1;
      if (failGetCalls.includes(getCalls)) throw new Error('injected fresh read failure');
      return registry.get(id) || null;
    },
  };
  return {
    figma, node, target, removals,
    styles: () => copy(styles), timelines: () => copy(timelines),
    applyCalls: () => applyCalls, timelineCalls: () => timelineCalls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Motion Style closes defaults, numeric options, timing, URL identity, and excess input', () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  assert.deepEqual(parseMotionStyleRequest(['motion', 'style', url, 'opacity']), {
    nodeId: '1:2', name: 'opacity', duration: 0.5, offset: 0, timing: null,
  });
  assert.deepEqual(parseMotionStyleRequest([
    'motion', 'style', '-d1.25', '--at=.2', '-tout', url, 'position',
  ]), { nodeId: '1:2', name: 'position', duration: 1.25, offset: 0.2, timing: 'out' });
  assert.deepEqual(motionStyleArgvFromRequest({
    nodeId: '1:2', name: 'position', duration: 1.25, offset: 0.2, timing: 'in',
  }), ['motion', 'style', '--dur', '1.25', '--at', '0.2', '--timing', 'in', '--', '1:2', 'position']);
  assert.deepEqual(motionStylePlanningArgvFromRequest({ nodeId: url, name: '--help' }),
    ['motion', 'style', '--', url, '--help']);
  for (const argv of [
    ['motion', 'style'],
    ['motion', 'style', '1:2'],
    ['motion', 'style', '1:2', 'opacity', 'extra'],
    ['motion', 'style', '--dur', '0', '1:2', 'opacity'],
    ['motion', 'style', '--at=-1', '1:2', 'opacity'],
    ['motion', 'style', '--timing', 'sideways', '1:2', 'opacity'],
    ['motion', 'style', '-d1', '--dur', '2', '1:2', 'opacity'],
    ['motion', 'style', '--future', 'private-value', '1:2', 'opacity'],
  ]) assert.equal(acceptsMotionStyleArgv(argv), false, argv.join(' '));
});

test('Motion Style preserves legacy first-match resolution and verifies style plus timeline', async () => {
  const live = runtime();
  const result = await executeMotionStyle({
    nodeId: live.node.id, name: 'opacity', duration: 0.8, offset: 0.4, timing: 'in',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.match, {
    styleId: 'style:contains', name: 'motion.preset_name.opacity-in', kind: 'contains',
  });
  assert.equal(result.result.appliedId, 'applied:1');
  assert.deepEqual(live.styles()[0], {
    id: 'applied:1', styleId: 'style:contains', name: 'motion.preset_name.opacity-in',
    duration: 0.8, timelineOffset: 0.4, props: { timing: 'in' },
  });
  assert.ok(Math.abs(live.timelines()[0].duration - 1.2) < Number.EPSILON * 2);
  assert.equal(result.stdout, 'Applied style "opacity-in" to Animated Card');
});

test('Motion Style leaves a sufficiently long timeline untouched', async () => {
  const live = runtime({ timelineDuration: 2 });
  const result = await executeMotionStyle({ nodeId: live.node.id, name: 'position' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.timelineDuration, 2);
  assert.equal(live.timelineCalls(), 0);
});

test('native acknowledgement errors succeed only after complete fresh readback', async () => {
  const applyAck = runtime({ throwAfterApply: true, timelineDuration: 2 });
  const applied = await executeMotionStyle({ nodeId: applyAck.node.id, name: 'position' }, {
    evaluate: evaluate(applyAck.figma),
  });
  assert.equal(applied.result.outcome, 'verified-after-error');
  assert.match(applied.stderr, /fresh readback proved/);

  const timelineAck = runtime({ throwAfterTimeline: true });
  const extended = await executeMotionStyle({
    nodeId: timelineAck.node.id, name: 'position', duration: 1, offset: 0,
  }, { evaluate: evaluate(timelineAck.figma) });
  assert.equal(extended.result.outcome, 'verified-after-error');
  assert.equal(timelineAck.timelines()[0].duration, 1);
});

test('Motion Style mismatch distinguishes unchanged, rollback, and residue', async () => {
  const unchanged = runtime({ applyNoEffect: true, timelineDuration: 2 });
  await assert.rejects(() => executeMotionStyle({ nodeId: unchanged.node.id, name: 'position' }, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged');

  const rollback = runtime({ timelineNoEffect: true });
  await assert.rejects(() => executeMotionStyle({
    nodeId: rollback.node.id, name: 'position', duration: 1,
  }, { evaluate: evaluate(rollback.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(rollback.styles(), []);
  assert.deepEqual(rollback.timelines(), [{ id: 'timeline:1', duration: 0.6 }]);

  const residue = runtime({ timelineNoEffect: true, removeNoEffect: true });
  await assert.rejects(() => executeMotionStyle({
    nodeId: residue.node.id, name: 'position', duration: 1,
  }, { evaluate: evaluate(residue.figma) }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount === 1);
  assert.equal(residue.styles().length, 1);

  const unavailableFreshRead = runtime({ timelineDuration: 0.2, failGetCalls: [2] });
  await assert.rejects(() => executeMotionStyle({
    nodeId: unavailableFreshRead.node.id, name: 'position', duration: 1,
  }, { evaluate: evaluate(unavailableFreshRead.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(unavailableFreshRead.styles(), []);
  assert.deepEqual(unavailableFreshRead.timelines(), [{ id: 'timeline:1', duration: 0.2 }]);
});

test('Motion Style refuses unavailable resources and ambiguous targets before mutation', async () => {
  const missing = runtime();
  await assert.rejects(() => executeMotionStyle({ nodeId: missing.node.id, name: 'wobble' }, {
    evaluate: evaluate(missing.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && /No Motion style matches/.test(error.message));
  assert.equal(missing.applyCalls(), 0);

  const disabled = runtime({ motion: false });
  await assert.rejects(() => executeMotionStyle({ nodeId: disabled.node.id, name: 'opacity' }, {
    evaluate: evaluate(disabled.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && /not enabled/.test(error.message));

  const first = runtime().node; first.id = '2:1';
  const second = runtime().node; second.id = '2:2';
  const many = runtime({ children: [first, second] });
  await assert.rejects(() => executeMotionStyle({ nodeId: many.target.id, name: 'opacity' }, {
    evaluate: evaluate(many.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && /2:2/.test(error.message));
});

test('Motion Style owns one non-retrying write Plan across CLI and MCP', async () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  const cli = planFigmaCommand([
    'motion', 'style', url, 'position', '--dur', '1', '--at', '.2', '--timing', 'out',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'motion', 'style', '-d1', '--at=.2', '-tout', '--', url, 'position',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(motionStylePlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeMotionStylePlan(cli, { evaluate: evaluate(live.figma) })).result.outcome,
    'verified');
  assert.throws(() => motionStylePlanRoute({ ...cli }), /requires a Command Plan/);
});

test('malformed and forged Plugin results cannot become successful Motion Styles', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(() => executeMotionStyle({ nodeId: '1:2', name: 'opacity' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const request = { nodeId: live.node.id, name: 'position' };
  const serialized = await evaluate(live.figma)(motionStyleCode(request));
  const forged = JSON.parse(serialized);
  forged.node.requestedId = '9:9';
  await assert.rejects(() => executeMotionStyle(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);

  const forgedMatch = JSON.parse(serialized);
  forgedMatch.match.kind = 'exact';
  await assert.rejects(() => executeMotionStyle(request, {
    evaluate: async () => JSON.stringify(forgedMatch),
  }), /invalid bounded result/);
});

test('Motion Style generated Plugin code parses without a private timer', () => {
  const code = motionStyleCode({ nodeId: '1:2', name: 'position', duration: 1, offset: 0.2 });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /applyAnimationStyle/);
  assert.match(code, /removeAnimationStyle/);
  assert.match(code, /setTimelineDuration/);
});
