import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMotionClear,
  executeMotionClearPlan,
  motionClearCode,
  motionClearPlanRoute,
} from '../src/application/motion-clear-command.js';
import {
  acceptsMotionClearArgv,
  motionClearArgvFromRequest,
  motionClearPlanningArgvFromRequest,
  parseMotionClearRequest,
} from '../src/application/motion-clear-request.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const track = (id, from = 0, to = 1) => ({
  id,
  baseValue: { type: 'FLOAT', value: from },
  keyframes: [
    { id: `${id}:1`, timelinePosition: 0, easing: { type: 'LINEAR' }, value: { type: 'FLOAT', value: from } },
    { id: `${id}:2`, timelinePosition: 0.5, easing: { type: 'EASE_OUT' }, value: { type: 'FLOAT', value: to } },
  ],
});

function runtime({
  editorType = 'figma', motion = true,
  manual = { OPACITY: track('track:opacity'), fills: { 0: track('track:fill') } },
  styles = [], noEffectRemoveAt = null, throwAfterRemoveAt = null,
  rollbackNoEffect = false, children = null,
} = {}) {
  const page = { id: '0:1', type: 'PAGE', name: 'Motion Lab', children: [] };
  const parent = { id: '0:2', type: 'FRAME', name: 'Inner', parent: page, children: [] };
  let manualState = copy(manual);
  let styleState = copy(styles);
  const removals = [];
  const restores = [];
  let removeCount = 0;
  const node = {
    id: '1:2', type: 'RECTANGLE', name: 'Animated Card', parent,
    get manualKeyframeTracks() { return copy(manualState); },
    get animationStyles() { return copy(styleState); },
    removeManualKeyframeTrack(field) {
      removeCount += 1; removals.push(copy(field));
      if (removeCount !== noEffectRemoveAt) {
        if (field.type === 'PROPERTY') delete manualState[field.name];
        else {
          const item = manualState[field.collection]?.[field.index];
          if (field.propertyId !== undefined) {
            if (item?.properties) delete item.properties[field.propertyId];
            if (item?.properties && Object.keys(item.properties).length === 0) delete item.properties;
            if (item && Object.keys(item).length === 0) delete manualState[field.collection][field.index];
          } else if (field.field !== undefined) {
            if (item) delete item[field.field];
            if (item && Object.keys(item).length === 0) delete manualState[field.collection][field.index];
          } else delete manualState[field.collection]?.[field.index];
          if (manualState[field.collection]
            && Object.keys(manualState[field.collection]).length === 0) delete manualState[field.collection];
        }
      }
      if (removeCount === throwAfterRemoveAt) throw new Error('injected clear acknowledgement');
    },
    applyManualKeyframeTrack(field, value) {
      restores.push(copy(field));
      if (rollbackNoEffect) return;
      if (field.type === 'PROPERTY') manualState[field.name] = copy(value);
      else {
        manualState[field.collection] ||= {};
        if (field.propertyId !== undefined) {
          manualState[field.collection][field.index] ||= {};
          manualState[field.collection][field.index].properties ||= {};
          manualState[field.collection][field.index].properties[field.propertyId] = copy(value);
        } else if (field.field !== undefined) {
          manualState[field.collection][field.index] ||= {};
          manualState[field.collection][field.index][field.field] = copy(value);
        } else manualState[field.collection][field.index] = copy(value);
      }
    },
    removeAnimationStyle(id) {
      removeCount += 1; removals.push(id);
      if (removeCount !== noEffectRemoveAt) styleState = styleState.filter((style) => style.id !== id);
      if (removeCount === throwAfterRemoveAt) throw new Error('injected style acknowledgement');
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
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
  };
  return {
    figma, node, target, removals, restores,
    manual: () => copy(manualState), styles: () => copy(styleState),
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Motion Clear closes modes, aliases, URL identity, and excess input', () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  assert.deepEqual(parseMotionClearRequest(['motion', 'clear', url]), {
    nodeId: '1:2', mode: 'tracks', field: null,
  });
  assert.deepEqual(parseMotionClearRequest(['motion', 'clear', '-fopacity', url]), {
    nodeId: '1:2', mode: 'field', field: 'OPACITY',
  });
  assert.deepEqual(parseMotionClearRequest(['motion', 'clear', '--field=fill:2', url]), {
    nodeId: '1:2', mode: 'field', field: 'fills:2',
  });
  assert.deepEqual(parseMotionClearRequest(['motion', 'clear', '--field', 'opacity', '--styles', url]), {
    nodeId: '1:2', mode: 'styles', field: null,
  });
  assert.deepEqual(motionClearArgvFromRequest({ nodeId: '1:2', mode: 'field', field: 'opacity' }),
    ['motion', 'clear', '--field', 'OPACITY', '--', '1:2']);
  assert.deepEqual(motionClearPlanningArgvFromRequest({ nodeId: url, mode: 'styles', field: null }),
    ['motion', 'clear', '--styles', '--', url]);
  for (const argv of [
    ['motion', 'clear'],
    ['motion', 'clear', '1:2', '2:3'],
    ['motion', 'clear', '--field', 'wobble', '1:2'],
    ['motion', 'clear', '--field', 'opacity', '-f', 'scale', '1:2'],
    ['motion', 'clear', '--styles', '--styles', '1:2'],
    ['motion', 'clear', '--future', '1:2'],
  ]) assert.equal(acceptsMotionClearArgv(argv), false, argv.join(' '));
});

test('Motion Clear removes every rollback-safe manual track and verifies empty state', async () => {
  const live = runtime();
  const result = await executeMotionClear({ nodeId: live.node.id, mode: 'tracks', field: null }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.cleared, 2);
  assert.deepEqual(live.manual(), {});
  assert.deepEqual(live.removals, [
    { type: 'PROPERTY', name: 'OPACITY' },
    { type: 'INDEXED_ITEM', collection: 'fills', index: 0 },
  ]);
  assert.equal(result.stdout, 'Cleared all tracks on Animated Card');
});

test('Motion Clear removes one canonical field and preserves sibling tracks', async () => {
  const live = runtime();
  const result = await executeMotionClear({ nodeId: live.node.id, mode: 'field', field: 'opacity' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.cleared, 1);
  assert.deepEqual(live.manual(), { fills: { 0: track('track:fill') } });

  const absent = runtime();
  const noOp = await executeMotionClear({ nodeId: absent.node.id, mode: 'field', field: 'scale' }, {
    evaluate: evaluate(absent.figma),
  });
  assert.equal(noOp.result.outcome, 'no-op');
  assert.equal(absent.removals.length, 0);
});

test('manual-track mismatch distinguishes unchanged, rollback, and residue', async () => {
  const unchanged = runtime({ noEffectRemoveAt: 1 });
  await assert.rejects(() => executeMotionClear({ nodeId: unchanged.node.id, mode: 'field', field: 'opacity' }, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged');

  const rollback = runtime({ noEffectRemoveAt: 2 });
  await assert.rejects(() => executeMotionClear({ nodeId: rollback.node.id, mode: 'tracks', field: null }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(rollback.manual(), { OPACITY: track('track:opacity'), fills: { 0: track('track:fill') } });
  assert.equal(rollback.restores.length, 2);

  const residue = runtime({ noEffectRemoveAt: 2, rollbackNoEffect: true });
  await assert.rejects(() => executeMotionClear({ nodeId: residue.node.id, mode: 'tracks', field: null }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
});

test('Style Clear verifies all removals but never fabricates identity-safe rollback', async () => {
  const styles = [
    { id: 'applied:1', styleId: 'style:1', name: 'Opacity', duration: 0.4 },
    { id: 'applied:2', styleId: 'style:2', name: 'Position', duration: 0.5 },
  ];
  const live = runtime({ styles, throwAfterRemoveAt: 2 });
  const result = await executeMotionClear({ nodeId: live.node.id, mode: 'styles', field: null }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.deepEqual(live.styles(), []);
  assert.match(result.stderr, /fresh readback proved/);

  const partial = runtime({ styles, noEffectRemoveAt: 2 });
  await assert.rejects(() => executeMotionClear({ nodeId: partial.node.id, mode: 'styles', field: null }, {
    evaluate: evaluate(partial.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.restored === 0
    && partial.styles().length === 1);
});

test('Motion Clear addresses official effect and component-property tracks exactly', async () => {
  const live = runtime({ manual: {
    effects: { 0: { RADIUS: track('effect:radius'), properties: { glass: track('effect:glass') } } },
    fills: { 0: { properties: { color: track('paint:color') } } },
  } });
  const result = await executeMotionClear({ nodeId: live.node.id, mode: 'tracks', field: null }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.cleared, 3);
  assert.deepEqual(live.manual(), {});
  assert.deepEqual(live.removals, [
    { type: 'INDEXED_ITEM', collection: 'effects', index: 0, field: 'RADIUS' },
    { type: 'INDEXED_ITEM', collection: 'effects', index: 0, propertyId: 'glass' },
    { type: 'INDEXED_ITEM', collection: 'fills', index: 0, propertyId: 'color' },
  ]);
});

test('Motion Clear refuses unavailable targets before mutation', async () => {
  const disabled = runtime({ motion: false });
  await assert.rejects(() => executeMotionClear({ nodeId: disabled.node.id, mode: 'tracks', field: null }, {
    evaluate: evaluate(disabled.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && /not enabled/.test(error.message));
});

test('top-level Motion Clear resolution descends one child and retains ambiguity', async () => {
  const child = runtime().node; child.id = '2:1';
  const one = runtime({ children: [child] });
  const result = await executeMotionClear({ nodeId: one.target.id, mode: 'tracks', field: null }, {
    evaluate: evaluate(one.figma),
  });
  assert.equal(result.result.node.id, '2:1');
  assert.equal(result.result.node.descended, true);

  const second = runtime().node; second.id = '2:2';
  const many = runtime({ children: [child, second] });
  await assert.rejects(() => executeMotionClear({ nodeId: many.target.id, mode: 'tracks', field: null }, {
    evaluate: evaluate(many.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && /ambiguous/.test(error.message));
});

test('Motion Clear owns one non-retrying write Plan across CLI and MCP', async () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  const cli = planFigmaCommand(['motion', 'clear', url, '--field', 'opacity'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['motion', 'clear', '-fOPACITY', '--', url], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(motionClearPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeMotionClearPlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.outcome, 'verified');
  assert.throws(() => motionClearPlanRoute({ ...cli }), /requires a Command Plan/);
});

test('malformed and forged Plugin results cannot become successful Motion Clears', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'cleared' })]) {
    await assert.rejects(() => executeMotionClear({ nodeId: '1:2', mode: 'tracks', field: null }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(motionClearCode({ nodeId: live.node.id, mode: 'tracks', field: null }));
  const forged = JSON.parse(serialized);
  forged.node.requestedId = '9:9';
  await assert.rejects(() => executeMotionClear({ nodeId: live.node.id, mode: 'tracks', field: null }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Motion Clear generated Plugin code parses without a private timer', () => {
  for (const request of [
    { nodeId: '1:2', mode: 'tracks', field: null },
    { nodeId: '1:2', mode: 'field', field: 'fill:2' },
    { nodeId: '1:2', mode: 'styles', field: null },
  ]) assert.doesNotThrow(() => new Function(`return ${motionClearCode(request)}`));
  const code = motionClearCode({ nodeId: '1:2', mode: 'tracks', field: null });
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /removeManualKeyframeTrack/);
  assert.match(code, /applyManualKeyframeTrack/);
});
