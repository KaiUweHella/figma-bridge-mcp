import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  createLineArgvFromRequest,
  createLinePlanRoute,
  createLinePlanningArgvFromRequest,
  executeCreateLine,
  executeCreateLinePlan,
} from '../src/application/create-line-command.js';
import { parseCreateLineRequest } from '../src/application/create-line-request.js';

function fixture({ wrongWidth = false, wrongStroke = false, removeNoEffect = false } = {}) {
  const registry = new Map();
  const attach = (parent, index, node) => {
    const old = node.parent?.children?.indexOf(node) ?? -1;
    if (old !== -1) node.parent.children.splice(old, 1);
    parent.children.splice(index, 0, node); node.parent = parent;
  };
  const container = (id, type, children = []) => ({
    id, type, remote: false, parent: null, children, x: 0, width: 50,
    appendChild(node) { attach(this, this.children.length, node); },
    insertChild(index, node) { attach(this, index, node); },
  });
  const existing = { id: '2:1', type: 'RECTANGLE', x: 20, width: 30, parent: null };
  const page = container('0:1', 'PAGE', [existing]);
  const child = { id: '4:1', type: 'TEXT', parent: null };
  const parent = container('3:1', 'FRAME', [child]); page.appendChild(parent);
  const variables = [{ id: 'VariableID:1:2', name: 'color/line', remote: false, resolvedType: 'COLOR' }];
  const figma = {
    currentPage: { ...page, selection: [existing] },
    getNodeByIdAsync: async (id) => registry.get(id) || null,
    variables: {
      getLocalVariablesAsync: async () => variables,
      setBoundVariableForPaint: (paint, field, variable) => ({
        ...paint, boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } },
      }),
    },
  };
  registry.set(figma.currentPage.id, figma.currentPage);
  for (const node of [existing, parent, child]) registry.set(node.id, node);
  for (const node of figma.currentPage.children) node.parent = figma.currentPage;
  let creates = 0;
  figma.createLine = () => {
    creates += 1; let width = 100; let height = 0; let strokes = [];
    const node = {
      id: `9:${creates}`, type: 'LINE', parent: null, x: 0, y: 0, rotation: 0,
      strokeWeight: 1,
      get width() { return width; }, get height() { return height; },
      get strokes() { return strokes; }, set strokes(value) { strokes = wrongStroke ? [] : value; },
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
  return { figma, parent, creates: () => creates };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Create Line closes numeric, color, hierarchy and URL inputs', () => {
  assert.deepEqual(parseCreateLineRequest([
    'create', 'line', '--x1', '-4', '--y1=8', '--x2', '6', '--y2', '18',
    '--length', '120', '--color', 'var:color/line', '--weight', '2', '--spacing', '24',
    '--parent', '3-1', '--index=0',
  ]), {
    x1: -4, y1: 8, x2: 6, y2: 18, length: 120,
    color: 'var:color/line', colorKind: 'variable', variable: 'color/line',
    weight: 2, spacing: 24, parentId: '3:1', index: 0,
  });
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const plan = planFigmaCommand(createLinePlanningArgvFromRequest({ parentId: url }), { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv.includes('3:1'), true);
  for (const argv of [
    ['create', 'line', '--length', '0'],
    ['create', 'line', '--weight', '-1'],
    ['create', 'line', '--color', 'red'],
    ['create', 'line', '--future'],
  ]) assert.throws(() => parseCreateLineRequest(argv), /Invalid create line command/);
});

test('Create Line applies literal and explicit Variable strokes with legacy geometry', async () => {
  const literal = fixture();
  const literalResult = await executeCreateLine({ length: 120, spacing: 25 }, {
    evaluate: evaluate(literal.figma),
  });
  assert.equal(literalResult.result.node.x, 75);
  assert.equal(literalResult.result.node.width, 120);
  assert.equal(literalResult.result.stroke.kind, 'literal');

  const variable = fixture();
  const variableResult = await executeCreateLine({
    x1: -4, y1: 8, x2: 6, y2: 18, color: 'var:color/line', weight: 2,
    parentId: '3:1', index: 0,
  }, { evaluate: evaluate(variable.figma) });
  assert.equal(variableResult.result.node.width, 10);
  assert.equal(variableResult.result.node.rotation, 45);
  assert.equal(variableResult.result.stroke.kind, 'variable');
  assert.deepEqual(variable.parent.children.map((node) => node.id), ['9:1', '4:1']);
});

test('Create Line refuses ambiguous Variables and reports rollback or residue', async () => {
  const ambiguous = fixture();
  ambiguous.figma.variables.getLocalVariablesAsync = async () => [
    { id: 'VariableID:1:2', name: 'color/line', remote: false, resolvedType: 'COLOR' },
    { id: 'VariableID:1:3', name: 'color/line', remote: false, resolvedType: 'COLOR' },
  ];
  await assert.rejects(() => executeCreateLine({ color: 'var:color/line' }, {
    evaluate: evaluate(ambiguous.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && ambiguous.creates() === 0);

  const mismatch = fixture({ wrongWidth: true });
  await assert.rejects(() => executeCreateLine({}, { evaluate: evaluate(mismatch.figma) }),
    (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  const residue = fixture({ wrongStroke: true, removeNoEffect: true });
  await assert.rejects(() => executeCreateLine({}, { evaluate: evaluate(residue.figma) }),
    (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
});

test('Create Line has one non-retrying Plan and one evaluation in both Adapters', async () => {
  const argv = createLineArgvFromRequest({ x1: 4, x2: 14, y2: 10 });
  const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEA' });
  const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(createLinePlanRoute(mcp), 'command-application');
  assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
  const live = fixture(); let evaluations = 0;
  const result = await executeCreateLinePlan(mcp, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'created'); assert.equal(evaluations, 1);
});
