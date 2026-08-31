import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  createFrameArgvFromRequest,
  createFrameCode,
  createFramePlanRoute,
  createFramePlanningArgvFromRequest,
  executeCreateFrame,
  executeCreateFramePlan,
} from '../src/application/create-frame-command.js';
import { parseCreateFrameRequest } from '../src/application/create-frame-request.js';

function fixture({ wrongWidth = false, removeNoEffect = false, variables = [] } = {}) {
  const registry = new Map();
  const attach = (parent, index, node) => {
    if (node.parent?.children) {
      const oldIndex = node.parent.children.indexOf(node);
      if (oldIndex !== -1) node.parent.children.splice(oldIndex, 1);
    }
    parent.children.splice(index, 0, node);
    node.parent = parent;
  };
  const container = (id, type, name, children = []) => ({
    id, type, name, remote: false, parent: null, children, x: 0, width: 100,
    appendChild(node) { attach(this, this.children.length, node); },
    insertChild(index, node) { attach(this, index, node); },
  });
  const first = { id: '2:1', type: 'RECTANGLE', name: 'First', x: 10, y: 0, width: 40, parent: null };
  const second = { id: '2:2', type: 'RECTANGLE', name: 'Second', x: 100, y: 0, width: 25, parent: null };
  const page = container('0:1', 'PAGE', 'Test Page', [first, second]);
  const parentFirst = { id: '4:1', type: 'TEXT', name: 'Child', parent: null };
  const parent = container('3:1', 'FRAME', 'Parent', [parentFirst]);
  page.appendChild(parent);
  for (const node of [page, first, second, parent, parentFirst]) registry.set(node.id, node);
  let creates = 0;
  const figma = {
    currentPage: { ...page, selection: [first] },
    getNodeByIdAsync: async (id) => registry.get(id) || null,
    variables: {
      getLocalVariablesAsync: async () => variables,
      setBoundVariableForPaint: (paint, property, variable) => ({
        ...paint, boundVariables: { [property]: { type: 'VARIABLE_ALIAS', id: variable.id } },
      }),
    },
    createFrame() {
      creates += 1;
      let width = 100;
      let height = 100;
      const node = {
        id: `9:${creates}`, type: 'FRAME', name: 'Frame', parent: null,
        x: 0, y: 0, fills: [], cornerRadius: 0,
        get width() { return width; },
        get height() { return height; },
        resize(nextWidth, nextHeight) {
          width = wrongWidth ? nextWidth + 1 : nextWidth;
          height = nextHeight;
        },
        remove() {
          if (removeNoEffect) return;
          const index = this.parent?.children?.indexOf(this) ?? -1;
          if (index !== -1) this.parent.children.splice(index, 1);
          this.parent = null;
          registry.delete(this.id);
        },
      };
      registry.set(node.id, node);
      figma.currentPage.appendChild(node);
      return node;
    },
  };
  // The shallow copy above keeps the same children and methods but is the real
  // current-page object observed by createFrame().
  registry.set(figma.currentPage.id, figma.currentPage);
  for (const child of figma.currentPage.children) child.parent = figma.currentPage;
  return { figma, parent, first, creates: () => creates };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (overrides = {}) => ({
  name: 'Card', width: 320, height: 180, x: -12.5, y: 24,
  fill: '#AABBCC', fillKind: 'literal', variable: null,
  radius: 12, smart: false, gap: 100,
  parentId: '3:1', index: 0, ...overrides,
});

test('Create Frame request closes aliases, signed coordinates and URL parent targets', () => {
  assert.deepEqual(parseCreateFrameRequest([
    'create', 'frame', 'Card', '-w', '320', '--height=180', '-x', '-12.5',
    '-y=24', '--fill', '#abc', '--radius', '12', '--parent', '3-1', '--index=0',
  ]), request());
  assert.deepEqual(createFrameArgvFromRequest(request()), [
    'create', 'frame', 'Card', '--width=320', '--height=180', '--x=-12.5',
    '--y=24', '--fill=#AABBCC', '--radius=12', '--parent', '3:1', '--index=0',
  ]);
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const argv = createFramePlanningArgvFromRequest(request({ parentId: url }));
  const plan = planFigmaCommand(argv, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, createFrameArgvFromRequest(request()));

  for (const args of [
    ['create', 'frame'],
    ['create', 'frame', 'Card', '--width', '0'],
    ['create', 'frame', 'Card', '--x', 'NaN'],
    ['create', 'frame', 'Card', '--fill', 'red'],
    ['create', 'frame', 'Card', '--index', '-1'],
    ['create', 'frame', 'Card', '--future'],
  ]) assert.throws(() => parseCreateFrameRequest(args), /Invalid create frame command/);
});

test('Create Frame applies and freshly verifies one nested frame', async () => {
  const live = fixture();
  const result = await executeCreateFrame(request(), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'created');
  assert.deepEqual(result.result.node, {
    id: '9:1', name: 'Card', type: 'FRAME', parentId: '3:1', index: 0,
    x: -12.5, y: 24, width: 320, height: 180,
  });
  assert.equal(result.result.fill.kind, 'literal');
  assert.equal(result.result.radius, 12);
  assert.deepEqual(live.parent.children.map((node) => node.id), ['9:1', '4:1']);
  assert.deepEqual(live.figma.currentPage.selection.map((node) => node.id), ['9:1']);
  assert.equal(live.creates(), 1);
});

test('Create Frame keeps legacy smart positioning and explicit var: binding', async () => {
  const live = fixture({ variables: [{
    id: 'VariableID:1', name: 'color/brand', resolvedType: 'COLOR', remote: false,
  }] });
  const result = await executeCreateFrame(request({
    x: null, smart: true, gap: 10, parentId: null, index: null,
    fill: 'var:color/brand', radius: null,
  }), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.node.x, 145);
  assert.deepEqual(result.result.fill, {
    kind: 'variable', value: 'var:color/brand', variableId: 'VariableID:1',
  });
});

test('ambiguous explicit Variable and invalid parent refuse before createFrame()', async () => {
  const duplicateVariables = [
    { id: 'VariableID:1', name: 'brand', resolvedType: 'COLOR', remote: false },
    { id: 'VariableID:2', name: 'brand', resolvedType: 'COLOR', remote: false },
  ];
  for (const [live, input] of [
    [fixture({ variables: duplicateVariables }), request({ fill: 'var:brand' })],
    [fixture(), request({ parentId: '8:8' })],
  ]) {
    await assert.rejects(() => executeCreateFrame(input, { evaluate: evaluate(live.figma) }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.creates(), 0);
  }
});

test('failed Create Frame postcondition removes the frame and restores selection', async () => {
  const live = fixture({ wrongWidth: true });
  await assert.rejects(() => executeCreateFrame(request(), { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
    });
    return true;
  });
  assert.equal(live.creates(), 1);
  assert.deepEqual(live.parent.children.map((node) => node.id), ['4:1']);
  assert.deepEqual(live.figma.currentPage.selection.map((node) => node.id), ['2:1']);
});

test('failed rollback reports exact created-node and selection residue', async () => {
  const live = fixture({ wrongWidth: true, removeNoEffect: true });
  await assert.rejects(() => executeCreateFrame(request(), { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
});

test('one authentic non-retrying Create Frame plan crosses both Adapters', async () => {
  const argv = createFrameArgvFromRequest(request());
  const native = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEA' });
  const compatibility = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(native.allowed, true);
  assert.equal(compatibility.allowed, true);
  assert.equal(native.id, 'create.frame');
  assert.equal(native.execution.retry, 'never');
  assert.deepEqual(native.effects, compatibility.effects);
  assert.deepEqual(native.target, compatibility.target);
  assert.equal(createFramePlanRoute(native), 'command-application');
  assert.throws(() => createFramePlanRoute({ ...native }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeCreateFramePlan(native, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'created');
  assert.equal(evaluations, 1);
});

test('generated Create Frame code keeps its name inert and rejects malformed results', async () => {
  const name = '`); globalThis.CREATE_FRAME_INJECTED = true; //';
  const code = createFrameCode(request({ name }));
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.equal(globalThis.CREATE_FRAME_INJECTED, undefined);
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeCreateFrame(request(), {
      evaluate: async () => value,
    }), /invalid/i);
  }
});
