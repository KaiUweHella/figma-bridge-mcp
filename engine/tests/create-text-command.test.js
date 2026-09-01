import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  createTextArgvFromRequest,
  createTextPlanRoute,
  createTextPlanningArgvFromRequest,
  executeCreateText,
  executeCreateTextPlan,
} from '../src/application/create-text-command.js';
import { parseCreateTextRequest } from '../src/application/create-text-request.js';

function fixture({ fontFailure = false, wrongCharacters = false, wrongFill = false, removeNoEffect = false } = {}) {
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
  const child = { id: '4:1', type: 'RECTANGLE', parent: null };
  const parent = container('3:1', 'FRAME', [child]); page.appendChild(parent);
  const variables = [{ id: 'VariableID:1:2', name: 'color/text', remote: false, resolvedType: 'COLOR' }];
  let loadedFont = null; let creates = 0;
  const figma = {
    currentPage: { ...page, selection: [existing] },
    getNodeByIdAsync: async (id) => registry.get(id) || null,
    loadFontAsync: async (font) => { if (fontFailure) throw new Error('Font unavailable'); loadedFont = font; },
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
  figma.createText = () => {
    creates += 1; let characters = ''; let width = 1; let height = 20; let fills = [];
    const node = {
      id: `9:${creates}`, type: 'TEXT', parent: null, x: 0, y: 0,
      fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12,
      textAutoResize: 'WIDTH_AND_HEIGHT',
      get characters() { return characters; },
      set characters(value) { characters = wrongCharacters ? `${value}!` : value; width = Math.max(1, value.length * 8); },
      get width() { return width; }, get height() { return height; },
      get fills() { return fills; }, set fills(value) { fills = wrongFill ? [] : value; },
      resize(w, h) { width = w; height = h; },
      remove() {
        if (removeNoEffect) return;
        const index = this.parent?.children?.indexOf(this) ?? -1;
        if (index !== -1) this.parent.children.splice(index, 1);
        this.parent = null; registry.delete(this.id);
      },
    };
    registry.set(node.id, node); figma.currentPage.appendChild(node); return node;
  };
  return { figma, parent, creates: () => creates, loadedFont: () => loadedFont };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Create Text closes content, font, resource, hierarchy and URL inputs', () => {
  assert.deepEqual(parseCreateTextRequest([
    'create', 'text', 'Hello', '-x', '-4', '-y=8', '--size', '18',
    '--color', 'var:color/text', '--weight', 'BOLD', '--font', 'Roboto',
    '--width', '240', '--spacing', '24', '--parent', '3-1', '--index=0',
  ]), {
    content: 'Hello', x: -4, y: 8, size: 18, color: 'var:color/text',
    colorKind: 'variable', variable: 'color/text', weight: 'bold',
    font: { family: 'Roboto', style: 'Bold' }, width: 240, spacing: 24,
    parentId: '3:1', index: 0,
  });
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const plan = planFigmaCommand(createTextPlanningArgvFromRequest({ content: 'Hello', parentId: url }), { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA'); assert.equal(plan.argv.includes('3:1'), true);
  assert.equal(parseCreateTextRequest(createTextArgvFromRequest({ content: '-dash' })).content, '-dash');
  for (const argv of [
    ['create', 'text'],
    ['create', 'text', 'Hello', '--size', '0'],
    ['create', 'text', 'Hello', '--weight', 'black'],
    ['create', 'text', 'Hello', '--color', 'red'],
    ['create', 'text', 'Hello', '--future'],
  ]) assert.throws(() => parseCreateTextRequest(argv), /Invalid create text command/);
});

test('Create Text applies auto-width and fixed-width Variable-backed text', async () => {
  const plain = fixture();
  const plainResult = await executeCreateText({ content: 'Hello', spacing: 25 }, {
    evaluate: evaluate(plain.figma),
  });
  assert.equal(plainResult.result.node.x, 75);
  assert.equal(plainResult.result.node.textAutoResize, 'WIDTH_AND_HEIGHT');
  assert.equal(plainResult.result.charactersApplied, 5);

  const variable = fixture();
  const variableResult = await executeCreateText({
    content: 'Hello', font: 'Roboto', weight: 'semibold', size: 18,
    color: 'var:color/text', width: 240, parentId: '3:1', index: 0,
  }, { evaluate: evaluate(variable.figma) });
  assert.deepEqual(variable.loadedFont(), { family: 'Roboto', style: 'Semi Bold' });
  assert.equal(variableResult.result.node.width, 240);
  assert.equal(variableResult.result.node.textAutoResize, 'HEIGHT');
  assert.equal(variableResult.result.fill.kind, 'variable');
  assert.deepEqual(variable.parent.children.map((node) => node.id), ['9:1', '4:1']);
});

test('Create Text preflight refuses font and Variable failures, then reports rollback or residue', async () => {
  const fontFailure = fixture({ fontFailure: true });
  await assert.rejects(() => executeCreateText({ content: 'Hello' }, {
    evaluate: evaluate(fontFailure.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && fontFailure.creates() === 0);
  const ambiguous = fixture();
  ambiguous.figma.variables.getLocalVariablesAsync = async () => [
    { id: 'VariableID:1:2', name: 'color/text', remote: false, resolvedType: 'COLOR' },
    { id: 'VariableID:1:3', name: 'color/text', remote: false, resolvedType: 'COLOR' },
  ];
  await assert.rejects(() => executeCreateText({ content: 'Hello', color: 'var:color/text' }, {
    evaluate: evaluate(ambiguous.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && ambiguous.creates() === 0);
  const mismatch = fixture({ wrongCharacters: true });
  await assert.rejects(() => executeCreateText({ content: 'Hello' }, { evaluate: evaluate(mismatch.figma) }),
    (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  const residue = fixture({ wrongFill: true, removeNoEffect: true });
  await assert.rejects(() => executeCreateText({ content: 'Hello' }, { evaluate: evaluate(residue.figma) }),
    (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
});

test('Create Text has one non-retrying Plan and one evaluation in both Adapters', async () => {
  const argv = createTextArgvFromRequest({ content: 'Hello', weight: 'medium' });
  const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEA' });
  const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEA' });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(createTextPlanRoute(mcp), 'command-application');
  assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
  const live = fixture(); let evaluations = 0;
  const result = await executeCreateTextPlan(mcp, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'created'); assert.equal(evaluations, 1);
});
