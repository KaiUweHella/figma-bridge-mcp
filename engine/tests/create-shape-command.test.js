import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  createShapeArgvFromRequest,
  createShapePlanRoute,
  createShapePlanningArgvFromRequest,
  executeCreateShape,
  executeCreateShapePlan,
} from '../src/application/create-shape-command.js';
import { parseCreateShapeRequest } from '../src/application/create-shape-request.js';

function fixture({ wrongWidth = false, removeNoEffect = false, variables = [] } = {}) {
  const registry = new Map();
  const attach = (parent, index, node) => {
    const old = node.parent?.children?.indexOf(node) ?? -1;
    if (old !== -1) node.parent.children.splice(old, 1);
    parent.children.splice(index, 0, node); node.parent = parent;
  };
  const container = (id, type, children = []) => ({
    id, type, name: type, remote: false, parent: null, children, x: 0, width: 50,
    appendChild(node) { attach(this, this.children.length, node); },
    insertChild(index, node) { attach(this, index, node); },
  });
  const existing = { id: '2:1', type: 'RECTANGLE', name: 'Existing', x: 20, width: 30, parent: null };
  const page = container('0:1', 'PAGE', [existing]);
  const child = { id: '4:1', type: 'TEXT', name: 'Child', parent: null };
  const parent = container('3:1', 'FRAME', [child]);
  page.appendChild(parent);
  const figma = {
    currentPage: { ...page, selection: [existing] },
    getNodeByIdAsync: async (id) => registry.get(id) || null,
    variables: {
      getLocalVariablesAsync: async () => variables,
      setBoundVariableForPaint: (paint, property, variable) => ({
        ...paint, boundVariables: { [property]: { type: 'VARIABLE_ALIAS', id: variable.id } },
      }),
    },
  };
  registry.set(figma.currentPage.id, figma.currentPage);
  for (const node of [existing, parent, child]) registry.set(node.id, node);
  for (const node of figma.currentPage.children) node.parent = figma.currentPage;
  let creates = 0;
  const factory = (type) => () => {
    creates += 1;
    let width = 100; let height = 100;
    const node = {
      id: `9:${creates}`, type, name: type, parent: null, x: 0, y: 0,
      fills: [], strokes: [], strokeWeight: 1, cornerRadius: 0, opacity: 1,
      pointCount: type === 'POLYGON' ? 3 : type === 'STAR' ? 5 : undefined,
      innerRadius: type === 'STAR' ? 0.382 : undefined,
      get width() { return width; }, get height() { return height; },
      resize(w, h) { width = wrongWidth ? w + 1 : w; height = h; },
      remove() {
        if (removeNoEffect) return;
        const index = this.parent?.children?.indexOf(this) ?? -1;
        if (index !== -1) this.parent.children.splice(index, 1);
        this.parent = null; registry.delete(this.id);
      },
    };
    registry.set(node.id, node); figma.currentPage.appendChild(node); return node;
  };
  Object.assign(figma, {
    createRectangle: factory('RECTANGLE'), createEllipse: factory('ELLIPSE'),
    createPolygon: factory('POLYGON'), createStar: factory('STAR'),
  });
  return { figma, parent, existing, creates: () => creates };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Create Shape closes aliases, defaults, extras and URL parents', () => {
  assert.deepEqual(parseCreateShapeRequest([
    'create', 'rectangle', 'Card', '-w', '320', '-h=180', '-x', '-12', '-y=24',
    '--fill', '#abc', '--stroke=var:border', '--radius', '8', '--opacity=.5',
    '--parent', '3-1', '--index=0',
  ]), {
    kind: 'rect', name: 'Card', width: 320, height: 180, x: -12, y: 24,
    fill: '#AABBCC', fillKind: 'literal', fillVariable: null,
    stroke: 'var:border', strokeKind: 'variable', strokeVariable: 'border',
    radius: 8, opacity: 0.5, points: null, innerRadius: null,
    parentId: '3:1', index: 0,
  });
  assert.deepEqual(parseCreateShapeRequest(['create', 'circle', '--width', '80']), {
    kind: 'ellipse', name: 'Ellipse', width: 80, height: 80, x: null, y: 0,
    fill: '#D9D9D9', fillKind: 'literal', fillVariable: null,
    stroke: null, strokeKind: null, strokeVariable: null,
    radius: null, opacity: null, points: null, innerRadius: null,
    parentId: null, index: null,
  });
  assert.equal(parseCreateShapeRequest(['create', 'polygon', '--points', '7']).points, 7);
  assert.deepEqual(
    parseCreateShapeRequest(['create', 'star', '--points=6', '--inner-radius=.25']),
    {
      kind: 'star', name: 'Star', width: 100, height: 100, x: null, y: 0,
      fill: '#D9D9D9', fillKind: 'literal', fillVariable: null,
      stroke: null, strokeKind: null, strokeVariable: null,
      radius: null, opacity: null, points: 6, innerRadius: 0.25,
      parentId: null, index: null,
    },
  );
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const argv = createShapePlanningArgvFromRequest({ kind: 'rect', name: 'Card', parentId: url });
  const plan = planFigmaCommand(argv, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv.includes('3:1'), true);

  for (const argvValue of [
    ['create', 'rect', '--width', '0'],
    ['create', 'ellipse', '--height', 'nan'],
    ['create', 'polygon', '--points', '2'],
    ['create', 'star', '--inner-radius', '2'],
    ['create', 'rect', '--opacity', '-.1'],
    ['create', 'rect', '--future'],
  ]) assert.throws(() => parseCreateShapeRequest(argvValue), /Invalid create shape command/);
});

test('Create Shape executes and freshly verifies each native factory', async () => {
  const cases = [
    { kind: 'rect', name: 'Rect', radius: 8, opacity: 0.5, expected: 'RECTANGLE' },
    { kind: 'ellipse', name: 'Oval', width: 80, height: 40, expected: 'ELLIPSE' },
    { kind: 'polygon', name: 'Hex', points: 6, expected: 'POLYGON' },
    { kind: 'star', name: 'Spark', points: 7, innerRadius: 0.25, expected: 'STAR' },
  ];
  for (const input of cases) {
    const live = fixture();
    const result = await executeCreateShape({
      width: 120, height: 90, x: -5, y: 12, fill: '#123456', stroke: '#ABCDEF',
      parentId: '3:1', index: 0, ...input,
    }, { evaluate: evaluate(live.figma) });
    assert.equal(result.result.node.type, input.expected);
    assert.equal(result.result.node.parentId, '3:1');
    assert.equal(result.result.node.index, 0);
    assert.equal(result.result.attempted, 1);
    assert.equal(live.creates(), 1);
  }
});

test('Create Shape resolves explicit fill and stroke Variables before creation', async () => {
  const live = fixture({ variables: [
    { id: 'VariableID:1', name: 'fill', resolvedType: 'COLOR', remote: false },
    { id: 'VariableID:2', name: 'stroke', resolvedType: 'COLOR', remote: false },
  ] });
  const result = await executeCreateShape({
    kind: 'rect', fill: 'var:fill', stroke: 'var:stroke', x: null,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.node.x, 250);
  assert.deepEqual(result.result.fill, { kind: 'variable', value: 'var:fill', variableId: 'VariableID:1' });
  assert.deepEqual(result.result.stroke, { kind: 'variable', value: 'var:stroke', variableId: 'VariableID:2' });
});

test('Create Shape refuses ambiguous resources before any factory and rolls back mismatch', async () => {
  const ambiguous = fixture({ variables: [
    { id: 'VariableID:1', name: 'fill', resolvedType: 'COLOR', remote: false },
    { id: 'VariableID:2', name: 'fill', resolvedType: 'COLOR', remote: false },
  ] });
  await assert.rejects(() => executeCreateShape({ kind: 'rect', fill: 'var:fill' }, {
    evaluate: evaluate(ambiguous.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(ambiguous.creates(), 0);

  const mismatch = fixture({ wrongWidth: true });
  await assert.rejects(() => executeCreateShape({ kind: 'ellipse', name: 'Oval' }, {
    evaluate: evaluate(mismatch.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
  assert.equal(mismatch.figma.currentPage.children.some((node) => node.id === '9:1'), false);
  assert.deepEqual(mismatch.figma.currentPage.selection.map((node) => node.id), ['2:1']);
});

test('Create Shape reports created-node residue and crosses both Adapters once', async () => {
  const residue = fixture({ wrongWidth: true, removeNoEffect: true });
  await assert.rejects(() => executeCreateShape({ kind: 'star' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });

  for (const kind of ['rect', 'ellipse', 'polygon', 'star']) {
    const argv = createShapeArgvFromRequest({ kind });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEA' });
    const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEA' });
    assert.equal(mcp.allowed, true);
    assert.equal(cli.allowed, true);
    assert.equal(createShapePlanRoute(mcp), 'command-application');
    assert.deepEqual(mcp.effects, cli.effects);
    const live = fixture(); let evaluations = 0;
    const result = await executeCreateShapePlan(mcp, {
      evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
    });
    assert.equal(result.result.status, 'created');
    assert.equal(evaluations, 1);
  }
});
