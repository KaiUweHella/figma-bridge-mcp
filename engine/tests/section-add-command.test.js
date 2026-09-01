import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSectionAdd,
  executeSectionAddPlan,
  MAX_SECTION_ADD_PARENT_CHILDREN,
  sectionAddCode,
  sectionAddPlanRoute,
} from '../src/application/section-add-command.js';
import {
  acceptsSectionAddArgv,
  MAX_SECTION_ADD_NODES,
  parseSectionAddRequest,
  sectionAddArgvFromRequest,
  sectionAddFigmaUrlFileKeyFromArgv,
  sectionAddPlanningArgvFromRequest,
} from '../src/application/section-add-request.js';

function multiplyPosition(transform, x, y) {
  return {
    x: transform[0][0] * x + transform[0][1] * y + transform[0][2],
    y: transform[1][0] * x + transform[1][1] * y + transform[1][2],
  };
}

function runtime({
  appendFailureAt = null,
  throwAfter = false,
  noEffect = false,
  rollbackNoEffect = false,
  failRollbackRead = false,
} = {}) {
  const pageTransform = [[1, 0, 0], [0, 1, 0]];
  const sectionTransform = [[0, -1, 500], [1, 0, 200]];
  const sourceTransform = [[1, 0, 100], [0, 1, 50]];
  let appendCalls = 0;
  let rollbackStarted = false;
  const nodes = new Map();
  const makeParent = (id, name, type, absoluteTransform) => {
    const parent = {
      id, name, type, absoluteTransform, children: [], parent: null,
      appendChild(node) {
        appendCalls += 1;
        if (appendFailureAt === appendCalls && !throwAfter) {
          throw new Error('injected append failure');
        }
        if (!noEffect) move(node, parent, parent.children.length);
        if (appendFailureAt === appendCalls && throwAfter) {
          throw new Error('injected append acknowledgement');
        }
      },
      insertChild(index, node) {
        rollbackStarted = true;
        if (!rollbackNoEffect) move(node, parent, index);
      },
    };
    nodes.set(id, parent);
    return parent;
  };
  const page = makeParent('0:1', 'Page', 'PAGE', pageTransform);
  const section = makeParent('1:1', 'Target', 'SECTION', sectionTransform);
  const source = makeParent('2:0', 'Source', 'FRAME', sourceTransform);
  section.parent = page;
  source.parent = page;
  page.children.push(section, source);

  function move(node, parent, index) {
    if (node.parent) {
      const oldIndex = node.parent.children.indexOf(node);
      if (oldIndex >= 0) node.parent.children.splice(oldIndex, 1);
    }
    const insertion = Math.min(index, parent.children.length);
    parent.children.splice(insertion, 0, node);
    node.parent = parent;
  }
  function makeNode(id, name, parent, x, y) {
    const state = { x, y };
    const node = {
      id, name, type: 'FRAME', parent,
      get x() { return state.x; },
      set x(value) { if (!noEffect || rollbackStarted) state.x = value; },
      get y() { return state.y; },
      set y(value) { if (!noEffect || rollbackStarted) state.y = value; },
      get absoluteTransform() {
        const transform = node.parent === section ? sectionTransform : sourceTransform;
        const position = multiplyPosition(transform, state.x, state.y);
        return [[1, 0, position.x], [0, 1, position.y]];
      },
    };
    parent.children.push(node);
    nodes.set(id, node);
    return node;
  }
  const first = makeNode('2:1', 'First', source, 10, 20);
  const middle = makeNode('2:2', 'Middle', source, 30, 40);
  const second = makeNode('2:3', 'Second', source, 50, 60);
  const inside = makeNode('1:2', 'Inside', section, 7, 8);

  const snapshot = () => ({
    section: section.children.map((node) => node.id),
    source: source.children.map((node) => node.id),
    nodes: [first, second, inside].map((node) => ({
      id: node.id, parentId: node.parent.id, x: node.x, y: node.y,
      absolute: { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2] },
    })),
  });
  return {
    section, source, middle, snapshot,
    figma: {
      async getNodeByIdAsync(id) {
        if (failRollbackRead && rollbackStarted) throw new Error('injected rollback read failure');
        return nodes.get(id) || null;
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Section Add closes comma batches, canonical node identities, and option arity', () => {
  assert.deepEqual(parseSectionAddRequest([
    'section', 'add', '1-1', '2-1, 2:2',
  ]), { sectionId: '1:1', nodeIds: ['2:1', '2:2'], warning: '' });
  assert.deepEqual(sectionAddArgvFromRequest({
    sectionId: '1-1', nodeIds: ['2-1', '2:2'],
  }), ['section', 'add', '1:1', '2:1,2:2']);
  for (const argv of [
    ['section', 'add'],
    ['section', 'add', '1:1'],
    ['section', 'add', '1:1', ''],
    ['section', 'add', '1:1', '2:1,'],
    ['section', 'add', '1:1', '2:1,2-1'],
    ['section', 'add', '1:1', '1:1'],
    ['section', 'add', '1:1', 'not-a-node'],
    ['section', 'add', '1:1', '2:1', '3:1'],
    ['section', 'add', '--future', '1:1', '2:1'],
  ]) assert.equal(acceptsSectionAddArgv(argv), false, argv.join(' '));

  assert.equal(acceptsSectionAddArgv([
    'section', 'add', '1:1', Array.from(
      { length: MAX_SECTION_ADD_NODES + 1 }, (_, index) => `${index + 2}:1`).join(','),
  ]), false);
});

test('Section Add derives one file target from semantic section and node URL fields', () => {
  const sectionUrl = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  const nodeUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  const planning = sectionAddPlanningArgvFromRequest({
    sectionId: sectionUrl, nodeIds: [nodeUrl, '2:2'],
  });
  assert.equal(sectionAddFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  assert.equal(planFigmaCommand(planning, { adapter: 'mcp' }).target.fileKey, 'FILEA');
  assert.throws(() => sectionAddPlanningArgvFromRequest({
    sectionId: sectionUrl,
    nodeIds: ['https://www.figma.com/design/FILEB/Test?node-id=2-1'],
  }), /multiple Figma files/);
});

test('Section Add reparents a mixed batch, preserves absolute positions, and verifies all memberships', async () => {
  const live = runtime();
  const before = live.snapshot();
  const result = await executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1', '2:3', '1:2'],
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'added');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.attempted, 3);
  assert.deepEqual(live.snapshot().section, ['2:1', '2:3', '1:2']);
  assert.deepEqual(live.snapshot().source, ['2:2']);
  assert.deepEqual(live.snapshot().nodes.map((node) => node.absolute),
    before.nodes.map((node) => node.absolute));
  assert.equal(result.stdout, '✓ Added 3 node(s) to "Target" (1:1). Total children: 3');
});

test('native acknowledgement errors succeed only after the complete batch is freshly verified', async () => {
  const live = runtime({ appendFailureAt: 3, throwAfter: true });
  const result = await executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1', '2:3', '1:2'],
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /injected append acknowledgement/);
});

test('mid-batch failures restore every parent order and original local position', async () => {
  const live = runtime({ appendFailureAt: 2 });
  const before = live.snapshot();
  await assert.rejects(() => executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1', '2:3', '1:2'],
  }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.attempted === 2 && error.mutationReport.restored === 3);
  assert.deepEqual(live.snapshot(), before);
});

test('unchanged, rollback residue, and unavailable verification stay distinct', async () => {
  const unchanged = runtime({ noEffect: true });
  await assert.rejects(() => executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1'],
  }, { evaluate: evaluate(unchanged.figma) }),
  (error) => error.mutationOutcome === 'unchanged');

  const residue = runtime({ appendFailureAt: 2, rollbackNoEffect: true });
  await assert.rejects(() => executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1', '2:3'],
  }, { evaluate: evaluate(residue.figma) }),
  (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);

  const unavailable = runtime({ appendFailureAt: 2, failRollbackRead: true });
  await assert.rejects(() => executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1', '2:3'],
  }, { evaluate: evaluate(unavailable.figma) }),
  (error) => error.mutationOutcome === 'verification-unavailable');
});

test('cycles, missing nodes, and excessive parent inventories refuse before mutation', async () => {
  const cycle = runtime();
  cycle.section.parent = cycle.source.children[0];
  await assert.rejects(() => executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1'],
  }, { evaluate: evaluate(cycle.figma) }),
  (error) => error.mutationOutcome === 'no-mutation');

  const missing = runtime();
  await assert.rejects(() => executeSectionAdd({
    sectionId: '1:1', nodeIds: ['9:9'],
  }, { evaluate: evaluate(missing.figma) }),
  (error) => error.mutationOutcome === 'no-mutation');

  const excessive = runtime();
  excessive.source.children.length = MAX_SECTION_ADD_PARENT_CHILDREN + 1;
  await assert.rejects(() => executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1'],
  }, { evaluate: evaluate(excessive.figma) }),
  (error) => error.mutationOutcome === 'no-mutation');
});

test('one non-retrying Section Add Plan owns identical CLI and MCP policy', async () => {
  const cli = planFigmaCommand(['section', 'add', '1-1', '2-1,2:3'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['section', 'add', '1:1', '2:1,2-3'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(sectionAddPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeSectionAddPlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'added');
});

test('malformed and forged Plugin results cannot become successful Section Adds', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'added' })]) {
    await assert.rejects(() => executeSectionAdd({
      sectionId: '1:1', nodeIds: ['2:1'],
    }, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(sectionAddCode({
    sectionId: '1:1', nodeIds: ['2:1'],
  }));
  const forged = structuredClone(JSON.parse(serialized));
  forged.actual.nodes[0].absolute.x += 10;
  await assert.rejects(() => executeSectionAdd({
    sectionId: '1:1', nodeIds: ['2:1'],
  }, { evaluate: async () => JSON.stringify(forged) }), /invalid bounded result/);
});

test('Section Add generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${sectionAddCode({ sectionId: '1:1', nodeIds: ['2:1'] })}`));
});
