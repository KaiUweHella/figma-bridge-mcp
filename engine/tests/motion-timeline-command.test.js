import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMotionTimeline,
  executeMotionTimelinePlan,
  motionTimelineCode,
  motionTimelinePlanRoute,
} from '../src/application/motion-timeline-command.js';
import {
  acceptsMotionTimelineArgv,
  motionTimelineArgvFromRequest,
  motionTimelinePlanningArgvFromRequest,
  parseMotionTimelineRequest,
} from '../src/application/motion-timeline-request.js';

function runtime({
  editorType = 'figma', motion = true, duration = 0.6, noTimeline = false,
  noEffectFirst = false, wrongFirst = false, throwAfterMutation = false,
  rollbackNoEffect = false, children = null,
} = {}) {
  const page = { id: '0:1', type: 'PAGE', name: 'Motion Lab', children: [] };
  const parent = { id: '0:2', type: 'FRAME', name: 'Inner', parent: page, children: [] };
  let timelines = noTimeline ? [] : [{ id: 'timeline:1', duration }];
  let calls = 0;
  const node = {
    id: '1:2', type: 'RECTANGLE', name: 'Animated Card', parent,
    get timelines() { return timelines.map((timeline) => ({ ...timeline })); },
    setTimelineDuration(id, value) {
      calls += 1;
      const index = timelines.findIndex((timeline) => timeline.id === id);
      if (index < 0) throw new Error('unknown timeline');
      if (calls === 1 && noEffectFirst) return;
      if (calls > 1 && rollbackNoEffect) return;
      timelines[index] = { ...timelines[index], duration: calls === 1 && wrongFirst ? value + 0.25 : value };
      if (calls === 1 && throwAfterMutation) throw new Error('injected acknowledgement');
    },
  };
  parent.children.push(node);
  page.children.push(parent);
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
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
  };
  return { figma, node, target, calls: () => calls, timelines: () => timelines.map((item) => ({ ...item })) };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Motion Timeline closes optional duration, URL identity, and excess input', () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  assert.deepEqual(parseMotionTimelineRequest(['motion', 'timeline', url]), { nodeId: '1:2', duration: null });
  assert.deepEqual(parseMotionTimelineRequest(['motion', 'timeline', '-d1.25', url]), { nodeId: '1:2', duration: 1.25 });
  assert.deepEqual(motionTimelineArgvFromRequest({ nodeId: '1:2', duration: 2 }),
    ['motion', 'timeline', '--duration', '2', '--', '1:2']);
  assert.deepEqual(motionTimelinePlanningArgvFromRequest({ nodeId: url }),
    ['motion', 'timeline', '--', url]);
  for (const argv of [
    ['motion', 'timeline'],
    ['motion', 'timeline', '1:2', '2:3'],
    ['motion', 'timeline', '--duration', '0', '1:2'],
    ['motion', 'timeline', '--duration=NaN', '1:2'],
    ['motion', 'timeline', '-d', '1', '--duration', '2', '1:2'],
    ['motion', 'timeline', '--future', '1:2'],
  ]) assert.equal(acceptsMotionTimelineArgv(argv), false, argv.join(' '));
});

test('Motion Timeline reads a complete bounded native list without mutation', async () => {
  const live = runtime();
  const result = await executeMotionTimeline({ nodeId: live.node.id }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'read');
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.data.timelines, [{ id: 'timeline:1', duration: 0.6 }]);
  assert.equal(result.stdout, 'Timeline: 0.6s');
  assert.equal(live.calls(), 0);

  const empty = runtime({ noTimeline: true });
  const emptyResult = await executeMotionTimeline({ nodeId: empty.node.id }, { evaluate: evaluate(empty.figma) });
  assert.deepEqual(emptyResult.result.data.timelines, []);
  assert.equal(emptyResult.stdout, 'Timeline: none');
});

test('Motion Timeline sets and freshly verifies the exact first timeline duration', async () => {
  const live = runtime();
  const result = await executeMotionTimeline({ nodeId: live.node.id, duration: 1.2 }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'updated');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.attempted, 1);
  assert.equal(result.result.data.previousDuration, 0.6);
  assert.equal(result.result.data.timelines[0].duration, 1.2);
  assert.equal(result.stdout, 'Timeline set to 1.2s');
  assert.equal(live.calls(), 1);

  const same = runtime({ duration: 1.2 });
  const noOp = await executeMotionTimeline({ nodeId: same.node.id, duration: 1.2 }, { evaluate: evaluate(same.figma) });
  assert.equal(noOp.result.outcome, 'no-op');
  assert.equal(noOp.result.attempted, 0);
  assert.equal(same.calls(), 0);
});

test('a thrown timeline acknowledgement succeeds only after exact readback', async () => {
  const live = runtime({ throwAfterMutation: true });
  const result = await executeMotionTimeline({ nodeId: live.node.id, duration: 1.4 }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh readback proved/);
  assert.equal(live.timelines()[0].duration, 1.4);
});

test('timeline mismatch distinguishes unchanged, rollback, and residue', async () => {
  const unchanged = runtime({ noEffectFirst: true });
  await assert.rejects(() => executeMotionTimeline({ nodeId: unchanged.node.id, duration: 1.4 }, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged');
  assert.equal(unchanged.calls(), 1);

  const rollback = runtime({ wrongFirst: true });
  await assert.rejects(() => executeMotionTimeline({ nodeId: rollback.node.id, duration: 1.4 }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.equal(rollback.timelines()[0].duration, 0.6);

  const residue = runtime({ wrongFirst: true, rollbackNoEffect: true });
  await assert.rejects(() => executeMotionTimeline({ nodeId: residue.node.id, duration: 1.4 }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
  assert.equal(residue.timelines()[0].duration, 1.65);
});

test('Motion Timeline refuses unavailable targets and missing writable timelines before mutation', async () => {
  const empty = runtime({ noTimeline: true });
  await assert.rejects(() => executeMotionTimeline({ nodeId: empty.node.id, duration: 1 }, {
    evaluate: evaluate(empty.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && /no timeline/.test(error.message));
  assert.equal(empty.calls(), 0);

  const disabled = runtime({ motion: false });
  await assert.rejects(() => executeMotionTimeline({ nodeId: disabled.node.id }, {
    evaluate: evaluate(disabled.figma),
  }), /not enabled/);
  const wrong = runtime({ editorType: 'figjam' });
  await assert.rejects(() => executeMotionTimeline({ nodeId: wrong.node.id, duration: 1 }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && /requires Figma Design/.test(error.message));
});

test('top-level Motion Timeline resolution descends one child and retains ambiguity', async () => {
  const child = runtime().node;
  child.id = '2:1';
  const one = runtime({ children: [child] });
  const result = await executeMotionTimeline({ nodeId: one.target.id }, { evaluate: evaluate(one.figma) });
  assert.equal(result.result.data.nodeId, '2:1');
  assert.equal(result.result.data.descended, true);

  const second = runtime().node; second.id = '2:2'; second.name = 'Second';
  const many = runtime({ children: [child, second] });
  await assert.rejects(() => executeMotionTimeline({ nodeId: many.target.id }, {
    evaluate: evaluate(many.figma),
  }), (error) => /choose one child by id/.test(error.message) && error.message.includes('2:2'));
});

test('Motion Timeline owns conditional read/write policy across CLI and MCP', async () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  const readCli = planFigmaCommand(['motion', 'timeline', url], { adapter: 'cli' });
  const readMcp = planFigmaCommand(['motion', 'timeline', '--', url], { adapter: 'mcp' });
  assert.equal(readCli.allowed, true);
  assert.deepEqual(readCli.argv, readMcp.argv);
  assert.deepEqual(readCli.effects, readMcp.effects);
  assert.equal(readCli.target.fileKey, 'FILEA');
  assert.equal(readCli.effects.figma, 'read');
  assert.equal(readCli.confirmation, 'none');
  assert.equal(readCli.execution.retry, 'safe-read');

  const writeCli = planFigmaCommand(['motion', 'timeline', url, '--duration', '1.2'], { adapter: 'cli' });
  const writeMcp = planFigmaCommand(['motion', 'timeline', '-d1.2', '--', url], { adapter: 'mcp' });
  assert.equal(writeCli.allowed, true);
  assert.deepEqual(writeCli.argv, writeMcp.argv);
  assert.deepEqual(writeCli.effects, writeMcp.effects);
  assert.equal(writeCli.effects.figma, 'write');
  assert.equal(writeCli.confirmation, 'configured');
  assert.equal(writeCli.execution.retry, 'never');
  assert.equal(motionTimelinePlanRoute(writeCli), 'command-application');
  const live = runtime();
  assert.equal((await executeMotionTimelinePlan(writeCli, {
    evaluate: evaluate(live.figma),
  })).result.outcome, 'verified');
  assert.throws(() => motionTimelinePlanRoute({ ...writeCli }), /requires a Command Plan/);
});

test('malformed and forged Plugin results cannot become Motion Timeline facts', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'read' })]) {
    await assert.rejects(() => executeMotionTimeline({ nodeId: '1:2' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(motionTimelineCode({ nodeId: live.node.id }));
  const forged = JSON.parse(serialized);
  forged.data.requestedNodeId = '9:9';
  await assert.rejects(() => executeMotionTimeline({ nodeId: live.node.id }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Motion Timeline generated Plugin code parses without a private timer', () => {
  const code = motionTimelineCode({ nodeId: '1:2', duration: 1.2 });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /setTimelineDuration/);
  assert.match(code, /Restored Motion Timeline/);
});
