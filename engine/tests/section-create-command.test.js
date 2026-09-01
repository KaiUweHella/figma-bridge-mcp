import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSectionCreate,
  executeSectionCreatePlan,
  MAX_SECTION_CREATE_PARENT_CHILDREN,
  sectionCreateCode,
  sectionCreatePlanRoute,
} from '../src/application/section-create-command.js';
import {
  acceptsSectionCreateArgv,
  MAX_SECTION_CREATE_NODES,
  parseSectionCreateRequest,
  sectionCreateArgvFromRequest,
  sectionCreateFigmaUrlFileKeyFromArgv,
  sectionCreatePlanningArgvFromRequest,
} from '../src/application/section-create-request.js';

function multiplyPosition(transform, x, y) {
  return {
    x: transform[0][0] * x + transform[0][1] * y + transform[0][2],
    y: transform[1][0] * x + transform[1][1] * y + transform[1][2],
  };
}

function runtime({
  appendFailureAt = null,
  throwAfterComplete = false,
  rollbackNoEffect = false,
  failRollbackRead = false,
} = {}) {
  const nodes = new Map();
  const pageTransform = [[1, 0, 0], [0, 1, 0]];
  const sourceTransform = [[1, 0, 100], [0, 1, 50]];
  let nextId = 20;
  let appendCalls = 0;
  let rollbackStarted = false;
  let fitStarted = false;
  let finalNode = null;

  function move(node, parent, index) {
    if (node.parent) {
      const oldIndex = node.parent.children.indexOf(node);
      if (oldIndex >= 0) node.parent.children.splice(oldIndex, 1);
    }
    parent.children.splice(Math.min(index, parent.children.length), 0, node);
    node.parent = parent;
  }
  function makeParent(id, name, type, transform) {
    const parent = {
      id, name, type, parent: null, children: [], absoluteTransform: transform,
      appendChild(node) {
        appendCalls += 1;
        if (appendFailureAt === appendCalls) throw new Error('injected append failure');
        move(node, parent, parent.children.length);
      },
      insertChild(index, node) {
        rollbackStarted = true;
        if (!rollbackNoEffect) move(node, parent, index);
      },
    };
    nodes.set(id, parent);
    return parent;
  }
  const page = makeParent('0:1', 'Page', 'PAGE', pageTransform);
  page.selection = [];
  const source = makeParent('2:0', 'Source', 'FRAME', sourceTransform);
  source.parent = page;
  page.children.push(source);

  function makeNode(id, name, parent, x, y, width, height) {
    const state = { x, y };
    const node = {
      id, name, type: 'FRAME', parent, width, height,
      get x() { return state.x; },
      set x(value) { state.x = value; },
      get y() { return state.y; },
      set y(value) {
        state.y = value;
        if (throwAfterComplete && fitStarted && node === finalNode) {
          throwAfterComplete = false;
          throw new Error('injected final acknowledgement');
        }
      },
      get absoluteTransform() {
        let transform = pageTransform;
        if (node.parent === source) transform = sourceTransform;
        else if (node.parent?.type === 'SECTION') transform = node.parent.absoluteTransform;
        const position = multiplyPosition(transform, state.x, state.y);
        return [[1, 0, position.x], [0, 1, position.y]];
      },
    };
    parent.children.push(node);
    nodes.set(id, node);
    return node;
  }
  const first = makeNode('2:1', 'First', source, 10, 20, 80, 40);
  const middle = makeNode('2:2', 'Middle', source, 30, 40, 20, 20);
  const second = makeNode('2:3', 'Second', source, 150, 80, 100, 60);
  const pageNode = makeNode('3:1', 'Page node', page, 500, 300, 50, 30);
  finalNode = pageNode;

  function createSection() {
    const state = { name: 'Section', x: 0, y: 0, width: 500, height: 500 };
    const section = makeParent(`${nextId++}:1`, 'Section', 'SECTION', null);
    Object.defineProperties(section, {
      name: { get: () => state.name, set: (value) => { state.name = value; }, configurable: true },
      x: { get: () => state.x, set: (value) => { state.x = value; } },
      y: { get: () => state.y, set: (value) => { state.y = value; } },
      width: { get: () => state.width },
      height: { get: () => state.height },
      absoluteTransform: {
        get: () => [[1, 0, state.x], [0, 1, state.y]], configurable: true,
      },
    });
    section.resizeWithoutConstraints = (width, height) => {
      state.width = width;
      state.height = height;
      fitStarted = true;
    };
    section.remove = () => {
      rollbackStarted = true;
      if (rollbackNoEffect) return;
      const index = section.parent?.children.indexOf(section) ?? -1;
      if (index >= 0) section.parent.children.splice(index, 1);
      nodes.delete(section.id);
      section.parent = null;
    };
    section.parent = page;
    page.children.push(section);
    return section;
  }

  const snapshot = () => ({
    page: page.children.map((node) => node.id),
    source: source.children.map((node) => node.id),
    nodes: [first, second, pageNode].map((node) => ({
      id: node.id, parentId: node.parent.id, x: node.x, y: node.y,
      absolute: { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2] },
    })),
  });
  return {
    page, source, snapshot,
    figma: {
      get currentPage() { return page; },
      createSection,
      async getNodeByIdAsync(id) {
        if (failRollbackRead && rollbackStarted) throw new Error('injected rollback read failure');
        return nodes.get(id) || null;
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Section Create closes its name, optional batch, canonical identities, and arity', () => {
  assert.deepEqual(parseSectionCreateRequest([
    'section', 'create', 'Components', '2-1, 2:2',
  ]), { name: 'Components', nodeIds: ['2:1', '2:2'], warning: '' });
  assert.deepEqual(sectionCreateArgvFromRequest({
    name: 'Components', nodeIds: ['2-1', '2:2'],
  }), ['section', 'create', 'Components', '2:1,2:2']);
  assert.deepEqual(sectionCreateArgvFromRequest({ name: 'Empty' }),
    ['section', 'create', 'Empty']);
  assert.deepEqual(sectionCreateArgvFromRequest({ name: '--help' }),
    ['section', 'create', '--', '--help']);
  assert.deepEqual(parseSectionCreateRequest(['section', 'create', '--', '--help']), {
    name: '--help', nodeIds: [], warning: '',
  });
  for (const argv of [
    ['section', 'create'],
    ['section', 'create', ''],
    ['section', 'create', 'Name', '2:1,'],
    ['section', 'create', 'Name', '2:1,2-1'],
    ['section', 'create', 'Name', 'not-a-node'],
    ['section', 'create', 'Name', '2:1', '3:1'],
    ['section', 'create', '--future', 'Name'],
  ]) assert.equal(acceptsSectionCreateArgv(argv), false, argv.join(' '));
  assert.equal(acceptsSectionCreateArgv([
    'section', 'create', 'Name', Array.from(
      { length: MAX_SECTION_CREATE_NODES + 1 }, (_, index) => `${index + 2}:1`).join(','),
  ]), false);
});

test('Section Create derives one file target only from semantic node URL fields', () => {
  const first = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  const second = 'https://www.figma.com/design/FILEA/Test?node-id=2-2';
  const planning = sectionCreatePlanningArgvFromRequest({
    name: 'Components', nodeIds: [first, second],
  });
  assert.equal(sectionCreateFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  assert.equal(planFigmaCommand(planning, { adapter: 'mcp' }).target.fileKey, 'FILEA');
  assert.throws(() => sectionCreatePlanningArgvFromRequest({
    name: 'Components',
    nodeIds: [first, 'https://www.figma.com/design/FILEB/Test?node-id=2-2'],
  }), /multiple Figma files/);
});

test('Section Create owns creation, mixed-parent batch reparenting, fit, and absolute fidelity', async () => {
  const live = runtime();
  const before = live.snapshot();
  const result = await executeSectionCreate({
    name: 'Components', nodeIds: ['2:1', '2:3', '3:1'],
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.actual.section.x, 46);
  assert.equal(result.result.actual.section.y, -34);
  assert.equal(result.result.actual.section.width, 568);
  assert.equal(result.result.actual.section.height, 428);
  assert.deepEqual(result.result.actual.section.childIds, ['2:1', '2:3', '3:1']);
  assert.deepEqual(live.snapshot().source, ['2:2']);
  assert.deepEqual(live.snapshot().nodes.map((node) => node.absolute),
    before.nodes.map((node) => node.absolute));
  assert.equal(result.stdout, '✓ Created section "Components" (20:1) with 3 child(ren)');
});

test('Section Create verifies an empty Section without inventing fitted geometry', async () => {
  const live = runtime();
  const result = await executeSectionCreate({ name: 'Empty' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.actual.section.width, 500);
  assert.equal(result.result.actual.section.height, 500);
  assert.deepEqual(result.result.actual.section.childIds, []);
});

test('a final native acknowledgement error succeeds only after the complete fitted state is verified', async () => {
  const live = runtime({ throwAfterComplete: true });
  const result = await executeSectionCreate({
    name: 'Components', nodeIds: ['2:1', '2:3', '3:1'],
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /injected final acknowledgement/);
});

test('mid-batch failure restores nodes and removes the newly created Section', async () => {
  const live = runtime({ appendFailureAt: 2 });
  const before = live.snapshot();
  await assert.rejects(() => executeSectionCreate({
    name: 'Components', nodeIds: ['2:1', '2:3', '3:1'],
  }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.restored === 1);
  assert.deepEqual(live.snapshot(), before);
});

test('rollback residue and unavailable verification remain explicit', async () => {
  const residue = runtime({ appendFailureAt: 2, rollbackNoEffect: true });
  await assert.rejects(() => executeSectionCreate({
    name: 'Components', nodeIds: ['2:1', '2:3'],
  }, { evaluate: evaluate(residue.figma) }),
  (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);

  const unavailable = runtime({ appendFailureAt: 2, failRollbackRead: true });
  await assert.rejects(() => executeSectionCreate({
    name: 'Components', nodeIds: ['2:1', '2:3'],
  }, { evaluate: evaluate(unavailable.figma) }),
  (error) => error.mutationOutcome === 'verification-unavailable');
});

test('missing nodes and excessive parent inventories refuse before Section creation', async () => {
  const missing = runtime();
  await assert.rejects(() => executeSectionCreate({
    name: 'Components', nodeIds: ['9:9'],
  }, { evaluate: evaluate(missing.figma) }),
  (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(missing.page.children.filter((node) => node.type === 'SECTION').length, 0);

  const excessive = runtime();
  excessive.source.children.length = MAX_SECTION_CREATE_PARENT_CHILDREN + 1;
  await assert.rejects(() => executeSectionCreate({
    name: 'Components', nodeIds: ['2:1'],
  }, { evaluate: evaluate(excessive.figma) }),
  (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(excessive.page.children.filter((node) => node.type === 'SECTION').length, 0);
});

test('one non-retrying Section Create Plan owns identical CLI and MCP policy', async () => {
  const cli = planFigmaCommand(['section', 'create', 'Components', '2-1,2:3'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['section', 'create', 'Components', '2:1,2-3'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'read');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(sectionCreatePlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeSectionCreatePlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'created');
});

test('malformed and forged Plugin results cannot become successful Section Creates', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeSectionCreate({ name: 'Components' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(sectionCreateCode({
    name: 'Components', nodeIds: ['2:1'],
  }));
  const forged = structuredClone(JSON.parse(serialized));
  forged.actual.section.width += 10;
  await assert.rejects(() => executeSectionCreate({
    name: 'Components', nodeIds: ['2:1'],
  }, { evaluate: async () => JSON.stringify(forged) }), /invalid bounded result/);
});

test('Section Create generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${sectionCreateCode({ name: 'Components', nodeIds: ['2:1'] })}`));
});
