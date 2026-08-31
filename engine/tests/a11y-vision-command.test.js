import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  a11yVisionCode,
  a11yVisionPlanRoute,
  executeA11yVision,
  executeA11yVisionPlan,
} from '../src/application/a11y-vision-command.js';
import {
  A11Y_VISION_TYPES,
  acceptsA11yVisionArgv,
  a11yVisionArgvFromRequest,
  a11yVisionFigmaUrlFileKeyFromArgv,
  a11yVisionPlanningArgvFromRequest,
  parseA11yVisionRequest,
} from '../src/application/a11y-vision-request.js';

const clone = (value) => structuredClone(value);
const solid = (r, g, b, extra = {}) => ({
  type: 'SOLID', color: { r, g, b }, ...extra,
});

function runtime({
  selection = true,
  wrongCloneX = false,
  removeNoEffect = false,
  throwClone = false,
} = {}) {
  const registry = new Map();
  const page = {
    id: '0:1', name: 'Neutral test page', type: 'PAGE', parent: null, children: [], selection: [],
  };
  registry.set(page.id, page);
  let rootSequence = 2;
  let descendantSequence = 20;
  let cloneCalls = 0;

  const registerTree = (node) => {
    registry.set(node.id, node);
    for (const child of node.children || []) registerTree(child);
  };
  const unregisterTree = (node) => {
    registry.delete(node.id);
    for (const child of node.children || []) unregisterTree(child);
  };
  const makeNode = ({
    id, name, type = 'FRAME', parent = null, x = 0, y = 0, width = 10, height = 10,
    fills = [], strokes = [], children = [], cloneable = false,
  }) => {
    const state = { x };
    const node = {
      id, name, type, parent, y, width, height,
      get x() { return state.x; },
      set x(value) { state.x = wrongCloneX && id !== '1:2' ? value + 1 : value; },
      fills: clone(fills), strokes: clone(strokes), children,
      remove() {
        if (removeNoEffect) return;
        const index = node.parent?.children.indexOf(node) ?? -1;
        if (index >= 0) node.parent.children.splice(index, 1);
        unregisterTree(node);
        node.parent = null;
      },
    };
    for (const child of children) child.parent = node;
    if (cloneable) node.clone = () => {
      cloneCalls += 1;
      if (throwClone) throw new Error('injected clone failure');
      const copyTree = (original, parent, root = false) => makeNode({
        id: root ? `${rootSequence++}:1` : `9:${descendantSequence++}`,
        name: original.name,
        type: original.type,
        parent,
        x: original.x,
        y: original.y,
        width: original.width,
        height: original.height,
        fills: original.fills,
        strokes: original.strokes,
        children: (original.children || []).map((child) => copyTree(child, null)),
      });
      const copy = copyTree(node, page, true);
      const sourceIndex = page.children.indexOf(node);
      page.children.splice(sourceIndex + 1, 0, copy);
      registerTree(copy);
      return copy;
    };
    return node;
  };

  const child = makeNode({
    id: '1:3', name: 'Neutral child', type: 'RECTANGLE',
    fills: [solid(0, 1, 0)],
  });
  const source = makeNode({
    id: '1:2', name: 'Neutral source', parent: page, x: 10, y: 20, width: 100, height: 80,
    fills: [solid(1, 0, 0), solid(0.5, 0.5, 0.5, { visible: false })],
    strokes: [solid(0, 0, 1)], children: [child], cloneable: true,
  });
  page.children.push(source);
  page.selection = selection ? [source] : [];
  registerTree(source);

  return {
    page,
    source,
    cloneCalls: () => cloneCalls,
    figma: {
      currentPage: page,
      async getNodeByIdAsync(id) { return registry.get(id) || null; },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('A11y Vision closes type, option, and canonical URL node grammar', () => {
  assert.deepEqual(parseA11yVisionRequest([
    'a11y', 'vision', '1-2', '--type=PROTANOPIA', '--json',
  ]), {
    nodeId: '1:2', type: 'protanopia', json: true, warning: '',
  });
  assert.deepEqual(a11yVisionArgvFromRequest({
    nodeId: '1-2', type: 'protanopia', json: true,
  }), ['a11y', 'vision', '1:2', '--type=protanopia', '--json']);

  const url = 'https://www.figma.com/design/FILEA/Neutral?node-id=1-2';
  const planning = a11yVisionPlanningArgvFromRequest({ nodeId: url, type: 'all' });
  assert.equal(a11yVisionFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  assert.equal(planFigmaCommand(planning, { adapter: 'mcp' }).target.fileKey, 'FILEA');

  for (const argv of [
    ['a11y', 'vision', '1:2', '2:3'],
    ['a11y', 'vision', 'not-a-node'],
    ['a11y', 'vision', '--type'],
    ['a11y', 'vision', '--type=private'],
    ['a11y', 'vision', '--type=all', '--type=protanopia'],
    ['a11y', 'vision', '--json', '--json'],
    ['a11y', 'vision', '--future'],
  ]) assert.equal(acceptsA11yVisionArgv(argv), false, argv.join(' '));
});

test('one simulation clones, transforms, freshly verifies, and preserves legacy JSON', async () => {
  const live = runtime();
  const result = await executeA11yVision({
    nodeId: '1:2', type: 'protanopia', json: true,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(live.cloneCalls(), 1);
  assert.equal(result.result.status, 'simulated');
  assert.equal(result.result.outcome, 'applied');
  assert.equal(result.result.totalColors, 3);
  assert.deepEqual(result.result.types, ['protanopia']);
  assert.equal(live.page.children.length, 2);
  const created = live.page.children.find((node) => node.id !== live.source.id);
  assert.equal(created.name, 'Neutral source (Protanopia)');
  assert.equal(created.x, 210);
  assert.equal(created.y, 20);
  assert.deepEqual(created.fills[0].color, {
    r: 0.152286, g: 0.114503, b: 0,
  });
  const projected = JSON.parse(result.stdout);
  assert.deepEqual(projected.clones, [{
    id: created.id, name: created.name, type: 'protanopia',
  }]);
  assert.equal(projected.original, 'Neutral source');
  assert.equal(projected.totalColors, 3);
});

test('all simulations create exactly four typed copies at deterministic positions', async () => {
  const live = runtime();
  const result = await executeA11yVision({ type: 'all' }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(result.result.types, A11Y_VISION_TYPES);
  assert.equal(result.result.clones.length, 4);
  assert.deepEqual(result.result.clones.map((item) => item.simulationType), A11Y_VISION_TYPES);
  assert.deepEqual(result.result.clones.map((item) => item.x), [210, 370, 530, 690]);
  assert.match(result.stdout, /Color Blindness Simulation/);
  assert.match(result.stdout, /Created simulation copies/);
});

test('missing selection and missing explicit nodes refuse before mutation', async () => {
  const noSelection = runtime({ selection: false });
  await assert.rejects(() => executeA11yVision({ type: 'all' }, {
    evaluate: evaluate(noSelection.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && error.mutationReport.attempted === 0);
  assert.equal(noSelection.cloneCalls(), 0);

  const missing = runtime();
  await assert.rejects(() => executeA11yVision({ nodeId: '9:9', type: 'protanopia' }, {
    evaluate: evaluate(missing.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(missing.cloneCalls(), 0);
});

test('failed postconditions roll back every attributed simulation copy', async () => {
  const live = runtime({ wrongCloneX: true });
  await assert.rejects(() => executeA11yVision({
    nodeId: '1:2', type: 'protanopia',
  }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.attempted === 1
    && error.mutationReport.restored === 1
    && error.mutationReport.residueCount === 0);
  assert.deepEqual(live.page.children.map((node) => node.id), ['1:2']);
});

test('rollback residue and unattributed clone failures remain explicit', async () => {
  const residue = runtime({ wrongCloneX: true, removeNoEffect: true });
  await assert.rejects(() => executeA11yVision({
    nodeId: '1:2', type: 'protanopia',
  }, { evaluate: evaluate(residue.figma) }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
  assert.equal(residue.page.children.length, 2);

  const unavailable = runtime({ throwClone: true });
  await assert.rejects(() => executeA11yVision({
    nodeId: '1:2', type: 'protanopia',
  }, { evaluate: evaluate(unavailable.figma) }),
  (error) => error.mutationOutcome === 'verification-unavailable'
    && error.mutationReport.attempted === 1
    && error.mutationReport.residueCount === 1);
});

test('CLI and MCP share one confirmed, non-retrying write Plan', async () => {
  const cli = planFigmaCommand([
    'a11y', 'vision', '1-2', '--type=protanopia', '--json',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'a11y', 'vision', '--json', '--type', 'PROTANOPIA', '--', '1:2',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(a11yVisionPlanRoute(cli), 'command-application');

  const selectionPlan = planFigmaCommand(['a11y', 'vision'], { adapter: 'mcp' });
  assert.equal(selectionPlan.effects.figma, 'write');
  assert.equal(selectionPlan.effects.editor, 'read');

  const live = runtime();
  assert.equal((await executeA11yVisionPlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'simulated');
});

test('malformed and forged Plugin results cannot claim successful simulation', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'simulated' })]) {
    await assert.rejects(() => executeA11yVision({
      nodeId: '1:2', type: 'protanopia',
    }, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(a11yVisionCode({
    nodeId: '1:2', type: 'protanopia',
  }));
  const payload = JSON.parse(serialized);
  for (const forged of [
    { ...payload, attempted: 0 },
    { ...payload, types: ['tritanopia'] },
    { ...payload, clones: payload.clones.map((item) => ({ ...item, x: item.x + 10 })) },
    { ...payload, futureField: 'private' },
  ]) {
    await assert.rejects(() => executeA11yVision({
      nodeId: '1:2', type: 'protanopia',
    }, { evaluate: async () => JSON.stringify(forged) }), /invalid bounded result/);
  }
});

test('A11y Vision generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${a11yVisionCode({ nodeId: '1:2', type: 'protanopia' })}`));
});
