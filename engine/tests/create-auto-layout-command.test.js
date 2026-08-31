import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  createAutoLayoutArgvFromRequest,
  createAutoLayoutPlanRoute,
  createAutoLayoutPlanningArgvFromRequest,
  executeCreateAutoLayout,
  executeCreateAutoLayoutPlan,
} from '../src/application/create-auto-layout-command.js';
import { parseCreateAutoLayoutRequest } from '../src/application/create-auto-layout-request.js';

function fixture({ wrongGap = false, wrongFill = false, removeNoEffect = false } = {}) {
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
  const variables = [{ id: 'VariableID:1:2', name: 'color/surface', remote: false, resolvedType: 'COLOR' }];
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
  figma.createFrame = () => {
    creates += 1; let itemSpacing = 0; let fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    const node = {
      id: `9:${creates}`, type: 'FRAME', name: 'Frame', parent: null, x: 0, y: 0,
      width: 100, height: 100, layoutMode: 'NONE', primaryAxisSizingMode: 'FIXED',
      counterAxisSizingMode: 'FIXED', paddingTop: 0, paddingRight: 0,
      paddingBottom: 0, paddingLeft: 0, cornerRadius: 0,
      get itemSpacing() { return itemSpacing; }, set itemSpacing(value) { itemSpacing = wrongGap ? value + 1 : value; },
      get fills() { return fills; }, set fills(value) { fills = wrongFill ? [] : value; },
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

test('Create Auto Layout closes aliases, layout, resource, hierarchy and URL inputs', () => {
  assert.deepEqual(parseCreateAutoLayoutRequest([
    'create', 'al', 'Stack', '--direction', 'col', '--gap', '12', '--padding=20',
    '-x', '-4', '-y=8', '--fill', 'var:color/surface', '--radius', '6',
    '--spacing', '24', '--parent', '3-1', '--index=0',
  ]), {
    name: 'Stack', direction: 'col', layoutMode: 'VERTICAL', gap: 12, padding: 20,
    x: -4, y: 8, fill: 'var:color/surface', fillKind: 'variable', variable: 'color/surface',
    radius: 6, spacing: 24, parentId: '3:1', index: 0,
  });
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const plan = planFigmaCommand(createAutoLayoutPlanningArgvFromRequest({ parentId: url }), { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA'); assert.equal(plan.argv.includes('3:1'), true);
  for (const argv of [
    ['create', 'autolayout', '--direction', 'grid'],
    ['create', 'autolayout', '--gap', '-1'],
    ['create', 'autolayout', '--fill', 'red'],
    ['create', 'autolayout', '--future'],
  ]) assert.throws(() => parseCreateAutoLayoutRequest(argv), /Invalid create auto-layout command/);
});

test('Create Auto Layout applies transparent and Variable-backed layouts with legacy positioning', async () => {
  const plain = fixture();
  const plainResult = await executeCreateAutoLayout({ name: 'Row', spacing: 25 }, {
    evaluate: evaluate(plain.figma),
  });
  assert.equal(plainResult.result.node.x, 75);
  assert.equal(plainResult.result.node.layoutMode, 'HORIZONTAL');
  assert.equal(plainResult.result.fill, null);

  const variable = fixture();
  const variableResult = await executeCreateAutoLayout({
    name: 'Stack', direction: 'col', gap: 12, padding: 20, fill: 'var:color/surface',
    radius: 6, parentId: '3:1', index: 0,
  }, { evaluate: evaluate(variable.figma) });
  assert.equal(variableResult.result.node.layoutMode, 'VERTICAL');
  assert.equal(variableResult.result.fill.kind, 'variable');
  assert.deepEqual(variable.parent.children.map((node) => node.id), ['9:1', '4:1']);
});

test('Create Auto Layout refuses ambiguous Variables and reports rollback or residue', async () => {
  const ambiguous = fixture();
  ambiguous.figma.variables.getLocalVariablesAsync = async () => [
    { id: 'VariableID:1:2', name: 'color/surface', remote: false, resolvedType: 'COLOR' },
    { id: 'VariableID:1:3', name: 'color/surface', remote: false, resolvedType: 'COLOR' },
  ];
  await assert.rejects(() => executeCreateAutoLayout({ name: 'Stack', fill: 'var:color/surface' }, {
    evaluate: evaluate(ambiguous.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && ambiguous.creates() === 0);
  const mismatch = fixture({ wrongGap: true });
  await assert.rejects(() => executeCreateAutoLayout({ name: 'Row' }, { evaluate: evaluate(mismatch.figma) }),
    (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  const residue = fixture({ wrongFill: true, removeNoEffect: true });
  await assert.rejects(() => executeCreateAutoLayout({ name: 'Row', fill: '#112233' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
});

test('Create Auto Layout has one non-retrying Plan and one evaluation in both Adapters', async () => {
  const argv = createAutoLayoutArgvFromRequest({ name: 'Stack', direction: 'col' });
  const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEA' });
  const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(createAutoLayoutPlanRoute(mcp), 'command-application');
  assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
  const live = fixture(); let evaluations = 0;
  const result = await executeCreateAutoLayoutPlan(mcp, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'created'); assert.equal(evaluations, 1);
});
