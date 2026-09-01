import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMotionRead,
  executeMotionReadPlan,
  MAX_MOTION_STYLES,
  motionReadCode,
  motionReadPlanRoute,
} from '../src/application/motion-read-command.js';
import {
  acceptsMotionReadArgv,
  motionReadArgvFromRequest,
  motionReadPlanningArgvFromRequest,
  parseMotionReadRequest,
} from '../src/application/motion-read-request.js';

const STYLES = [
  { styleId: 'motion:1', name: 'motion.preset_name.opacity', description: 'Fade' },
  { styleId: 'motion:2', name: 'motion.preset_name.position' },
];
const MOTION = {
  timelines: [{ id: 'timeline:1', duration: 0.6 }],
  manualKeyframeTracks: {
    OPACITY: {
      baseValue: { type: 'FLOAT', value: 1 },
      keyframes: [{ timelinePosition: 0.6, value: { type: 'FLOAT', value: 0 } }],
    },
  },
  animationStyles: [{
    id: 'applied:1', styleId: 'motion:1', name: 'motion.preset_name.opacity',
    duration: 0.6, timelineOffset: 0,
  }],
};

function runtime({ editorType = 'figma', motion = true, nodes = [] } = {}) {
  const page = { id: '0:1', type: 'PAGE', name: 'Motion Lab', children: [] };
  const registry = new Map([[page.id, page]]);
  for (const node of nodes) {
    if (!node.parent) node.parent = page;
    if (node.parent === page && !page.children.includes(node)) page.children.push(node);
    registry.set(node.id, node);
    for (const child of node.children || []) registry.set(child.id, child);
  }
  return {
    editorType,
    ...(motion ? { motion: { figmaAnimationStyles: () => STYLES } } : {}),
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
  };
}

const scene = (overrides = {}) => ({
  id: '1:2', type: 'RECTANGLE', name: 'Animated Card',
  timelines: MOTION.timelines,
  manualKeyframeTracks: MOTION.manualKeyframeTracks,
  animationStyles: MOTION.animationStyles,
  ...overrides,
});
const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Motion Read closes styles, inspect, URL identity, and excess input', () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  assert.deepEqual(parseMotionReadRequest(['motion', 'styles']), { action: 'styles', nodeId: null });
  assert.deepEqual(parseMotionReadRequest(['motion', 'inspect', url]), { action: 'inspect', nodeId: '1:2' });
  assert.deepEqual(motionReadArgvFromRequest({ action: 'inspect', nodeId: '1:2' }),
    ['motion', 'inspect', '--', '1:2']);
  assert.deepEqual(motionReadPlanningArgvFromRequest({ action: 'inspect', nodeId: url }),
    ['motion', 'inspect', '--', url]);
  for (const argv of [
    ['motion', 'styles', 'extra'],
    ['motion', 'styles', '--future'],
    ['motion', 'inspect'],
    ['motion', 'inspect', '1:2', '2:3'],
    ['motion', 'inspect', '--future', '1:2'],
  ]) assert.equal(acceptsMotionReadArgv(argv), false, argv.join(' '));
});

test('Motion Styles preserves the complete legacy style facts in native order', async () => {
  const result = await executeMotionRead({ action: 'styles' }, { evaluate: evaluate(runtime()) });
  assert.deepEqual(result.result.styles, STYLES);
  assert.match(result.stdout, /^2 animation styles/m);
  assert.match(result.stdout, /opacity\s+motion\.preset_name\.opacity/);
  assert.equal(result.stderr, '');
});

test('Motion Inspect preserves timelines, manual tracks, and applied styles', async () => {
  const node = scene();
  const result = await executeMotionRead({ action: 'inspect', nodeId: node.id }, {
    evaluate: evaluate(runtime({ nodes: [node] })),
  });
  assert.deepEqual(result.result, {
    requestedNodeId: '1:2', nodeId: '1:2', nodeName: 'Animated Card',
    descended: false, fromName: null, motion: MOTION,
  });
  assert.match(result.stdout, /^Motion on Animated Card/m);
  assert.deepEqual(JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))), MOTION);
});

test('top-level Motion resolution descends exactly one child and retains ambiguity', async () => {
  const child = scene({ id: '2:1', parent: null });
  const frame = { id: '1:1', type: 'FRAME', name: 'Prototype', children: [child] };
  child.parent = frame;
  const result = await executeMotionRead({ action: 'inspect', nodeId: frame.id }, {
    evaluate: evaluate(runtime({ nodes: [frame] })),
  });
  assert.equal(result.result.nodeId, child.id);
  assert.equal(result.result.descended, true);
  assert.equal(result.result.fromName, 'Prototype');

  const second = scene({ id: '2:2', name: 'Second', parent: frame });
  frame.children.push(second);
  await assert.rejects(() => executeMotionRead({ action: 'inspect', nodeId: frame.id }, {
    evaluate: evaluate(runtime({ nodes: [frame] })),
  }), (error) => /choose one child by id/.test(error.message)
    && error.message.includes('2:1') && error.message.includes('2:2'));
});

test('Motion Read reports beta availability, target failures, and invalid native facts', async () => {
  await assert.rejects(() => executeMotionRead({ action: 'styles' }, {
    evaluate: evaluate(runtime({ motion: false })),
  }), /not enabled/);
  await assert.rejects(() => executeMotionRead({ action: 'inspect', nodeId: '9:9' }, {
    evaluate: evaluate(runtime()),
  }), /was not found/);
  const empty = { id: '1:1', type: 'FRAME', name: 'Empty', children: [] };
  await assert.rejects(() => executeMotionRead({ action: 'inspect', nodeId: empty.id }, {
    evaluate: evaluate(runtime({ nodes: [empty] })),
  }), /top-level frame with no children/);
  await assert.rejects(() => executeMotionRead({ action: 'styles' }, {
    evaluate: evaluate(runtime({ editorType: 'figjam' })),
  }), /requires Figma Design/);

  const tooMany = runtime();
  tooMany.motion.figmaAnimationStyles = () => Array.from({ length: MAX_MOTION_STYLES + 1 }, () => STYLES[0]);
  await assert.rejects(() => executeMotionRead({ action: 'styles' }, {
    evaluate: evaluate(tooMany),
  }), /invalid or excessive native facts/);
});

test('one safe-read Motion Plan owns equivalent CLI and MCP policy', async () => {
  const url = 'https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2';
  const cli = planFigmaCommand(['motion', 'inspect', url], { adapter: 'cli' });
  const mcp = planFigmaCommand(['motion', 'inspect', '--', url], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, ['motion', 'inspect', '--', '1:2']);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.effects.figma, 'read');
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.availability.feature, 'motion-beta');
  assert.equal(motionReadPlanRoute(cli), 'command-application');
  const node = scene();
  assert.equal((await executeMotionReadPlan(cli, {
    evaluate: evaluate(runtime({ nodes: [node] })),
  })).result.nodeId, node.id);
  assert.throws(() => motionReadPlanRoute({ ...cli }), /requires a Command Plan/);
});

test('malformed and forged Plugin results cannot become Motion facts', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'ok' })]) {
    await assert.rejects(() => executeMotionRead({ action: 'styles' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const node = scene();
  const figma = runtime({ nodes: [node] });
  const serialized = await evaluate(figma)(motionReadCode({ action: 'inspect', nodeId: node.id }));
  const forged = JSON.parse(serialized);
  forged.data.requestedNodeId = '9:9';
  await assert.rejects(() => executeMotionRead({ action: 'inspect', nodeId: node.id }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Motion Read generated Plugin code parses without a private timer', () => {
  const code = motionReadCode({ action: 'inspect', nodeId: '1:2' });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /figma\.motion\.figmaAnimationStyles/);
  assert.match(code, /manualKeyframeTracks/);
});
