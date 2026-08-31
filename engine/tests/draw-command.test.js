import test from 'node:test';
import assert from 'node:assert/strict';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  drawCommandCode,
  drawCommandPlanRoute,
  executeDrawCommand,
  executeDrawCommandPlan,
} from '../src/application/draw-command.js';
import {
  drawArgvFromRequest,
  drawFigmaUrlFileKeyFromArgv,
  drawPlanningArgvFromRequest,
  parseDrawRequest,
} from '../src/application/draw-request.js';

function fixture({ transformMismatch = false, ignoreBrushWrite = false, mixedPattern = false, textPathMismatch = false } = {}) {
  const nodes = new Map();
  const detach = (node) => {
    const children = node.parent?.children;
    if (Array.isArray(children)) { const index = children.indexOf(node); if (index >= 0) children.splice(index, 1); }
  };
  const parent = (id, type = 'FRAME') => ({
    id, name: id, type, children: [],
    insertChild(index, node) { detach(node); this.children.splice(index, 0, node); node.parent = this; },
  });
  const page = parent('PAGE:1', 'PAGE');
  const target = {
    id: '1:2', name: 'Curve', type: 'ELLIPSE', x: 10, y: 20, parent: page,
    complexStrokeProperties: { type: 'BASIC' }, variableWidthStrokeProperties: null,
    fills: mixedPattern ? Symbol('mixed') : [], strokes: [],
    async setFillsAsync(value) { this.fills = value; },
    async setStrokesAsync(value) { this.strokes = value; },
  };
  const source = { id: '1:3', name: 'Dot', type: 'ELLIPSE', x: 30, y: 40, parent: page };
  page.children.push(target, source); nodes.set(target.id, target); nodes.set(source.id, source); nodes.set(page.id, page);
  let serial = 0; let writes = 0;
  let complexStroke = target.complexStrokeProperties;
  let widthStroke = target.variableWidthStrokeProperties;
  Object.defineProperties(target, {
    complexStrokeProperties: {
      get: () => complexStroke,
      set: (value) => { writes += 1; if (!ignoreBrushWrite || value?.type === 'BASIC') complexStroke = value; },
      configurable: true,
    },
    variableWidthStrokeProperties: {
      get: () => widthStroke,
      set: (value) => { writes += 1; widthStroke = value; },
      configurable: true,
    },
  });
  const figma = {
    editorType: 'figma', mixed: mixedPattern ? target.fills : Symbol('mixed'), currentPage: page,
    getNodeByIdAsync: async (id) => nodes.get(id) || null,
    loadFontAsync: async () => {}, loadBrushesAsync: async () => {},
    createTextPath(base, segment, position) {
      writes += 1;
      base.type = 'TEXT_PATH'; base.textPathStartData = { segment, position: textPathMismatch ? position + 0.1 : position }; base.characters = ''; base.fontName = null; return base;
    },
    transformGroup(groupNodes, destination, index, modifiers) {
      writes += 1;
      const group = parent(`TG:${++serial}`, 'TRANSFORM_GROUP'); group.name = 'Transform Group'; group.transformModifiers = transformMismatch ? [{ ...modifiers[0], count: modifiers[0].count + 1 }] : modifiers;
      destination.insertChild(index, group); nodes.set(group.id, group);
      for (const node of groupNodes) group.insertChild(group.children.length, node);
      group.remove = function remove() { detach(this); nodes.delete(this.id); };
      return group;
    },
  };
  const originalFill = target.setFillsAsync.bind(target);
  target.setFillsAsync = async (value) => { writes += 1; await originalFill(value); };
  const originalStroke = target.setStrokesAsync.bind(target);
  target.setStrokesAsync = async (value) => { writes += 1; await originalStroke(value); };
  return { figma, nodes, page, source, target, writes: () => writes };
}

const plugin = (request, figma) => new Function('figma', `return ${drawCommandCode(request)}`)(figma);

test('Draw request closes grammar, canonical values, URL targeting, and duplicate sources', () => {
  const url = 'https://www.figma.com/design/FILE123/Test?node-id=1-2';
  assert.deepEqual(parseDrawRequest(['draw', 'text-path', url, '--text', 'Hello']), {
    action: 'text-path', nodeId: '1:2', text: 'Hello', segment: 0, position: 0,
    fontFamily: 'Inter', fontStyle: 'Regular',
  });
  assert.deepEqual(drawArgvFromRequest({
    action: 'pattern', nodeId: '1:2', sourceNodeId: '1:3', field: 'FILL',
    tileType: 'horizontal_hexagonal', scalingFactor: 2, spacingX: -1, spacingY: 3,
    alignment: 'start', replace: true,
  }), ['draw', 'pattern', '--field', 'fill', '--tile', 'HORIZONTAL_HEXAGONAL', '--scale', '2', '--spacing-x', '-1', '--spacing-y', '3', '--alignment', 'START', '--replace', '--', '1:2', '1:3']);
  assert.equal(drawFigmaUrlFileKeyFromArgv(['draw', 'inspect', url]), 'FILE123');
  for (const args of [
    ['draw', 'inspect'],
    ['draw', 'inspect', '1:2', '--future', 'secret'],
    ['draw', 'text-path', '1:2'],
    ['draw', 'transform-group', '1:2,1:2', '--modifiers', '[{"type":"REPEAT"}]'],
    ['draw', 'stroke-profile', '1:2'],
    ['draw', 'stroke-profile', '1:2', '--clear', '--preset', 'TAPER'],
    ['draw', 'pattern', '1:2', '1:3'],
  ]) assert.throws(() => parseDrawRequest(args), /Invalid Draw command/);
});

test('Draw inspect returns bounded facts without a write', async () => {
  const live = fixture();
  const result = await executeDrawCommand({ action: 'inspect', nodeId: '1:2' }, { evaluate: async () => plugin({ action: 'inspect', nodeId: '1:2' }, live.figma) });
  assert.equal(result.result.status, 'inspected');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.attempted, 0);
  assert.equal(result.result.result.id, '1:2');
  assert.equal(live.writes(), 0);
});

test('Draw inspect failures remain read failures without a mutation projection', async () => {
  const live = fixture();
  await assert.rejects(() => executeDrawCommand({ action: 'inspect', nodeId: '9:9' }, { evaluate: async () => plugin({ action: 'inspect', nodeId: '9:9' }, live.figma) }), (error) => {
    assert.equal(error.kind, 'execution');
    assert.equal(error.mutationOutcome, undefined);
    return true;
  });
});

test('Draw Text Path preserves exact multiline characters in the public result', async () => {
  const live = fixture();
  const request = { action: 'text-path', nodeId: '1:2', text: 'Hello\n世界' };
  const result = await executeDrawCommand(request, { evaluate: async () => plugin(request, live.figma) });
  assert.equal(result.result.result.characters, request.text);
  assert.equal(JSON.parse(result.stdout).characters, request.text);
});

test('Draw Text Path reports irreversible conversion residue without deleting the source', async () => {
  const live = fixture({ textPathMismatch: true });
  const request = { action: 'text-path', nodeId: '1:2', text: 'Hello', position: 0.25 };
  await assert.rejects(() => executeDrawCommand(request, { evaluate: async () => plugin(request, live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.equal(live.nodes.get('1:2')?.type, 'TEXT_PATH');
  assert.equal(live.page.children.some((node) => node.id === '1:2'), true);
});

test('Draw writes use native APIs and prove each fresh result', async () => {
  const cases = [
    { action: 'text-path', nodeId: '1:2', text: 'Hello', segment: 0, position: 0.25, fontFamily: 'Inter', fontStyle: 'Regular' },
    { action: 'transform-group', nodeIds: ['1:2', '1:3'], parentId: null, index: 0, modifiers: [{ type: 'REPEAT', repeatType: 'RADIAL', count: 4, unitType: 'PIXELS', offset: 20 }] },
    { action: 'brush', nodeId: '1:2', properties: { type: 'BRUSH', brushType: 'STRETCH', brushName: 'NOIR', direction: 'FORWARD' } },
    { action: 'stroke-profile', nodeId: '1:2', preset: 'TAPER' },
    { action: 'pattern', nodeId: '1:2', sourceNodeId: '1:3', field: 'fill', tileType: 'RECTANGULAR', scalingFactor: 1, spacingX: 0, spacingY: 0, alignment: 'CENTER', replace: false },
  ];
  for (const request of cases) {
    const live = fixture();
    const result = await executeDrawCommand(request, { evaluate: async () => plugin(request, live.figma) });
    assert.equal(result.result.outcome, 'verified', request.action);
    assert.equal(result.result.attempted, 1, request.action);
    assert.equal(result.stderr, '');
    assert.ok(live.writes() >= 1, request.action);
  }
});

test('Draw field writes avoid exact no-ops and roll back failed proof', async () => {
  const noOp = fixture();
  const noOpResult = await executeDrawCommand({ action: 'brush', nodeId: '1:2', properties: { type: 'BASIC' } }, { evaluate: async () => plugin({ action: 'brush', nodeId: '1:2', properties: { type: 'BASIC' } }, noOp.figma) });
  assert.equal(noOpResult.result.outcome, 'no-op');
  assert.equal(noOpResult.result.attempted, 0);
  const clearNoOp = await executeDrawCommand({ action: 'stroke-profile', nodeId: '1:2', clear: true }, { evaluate: async () => plugin({ action: 'stroke-profile', nodeId: '1:2', clear: true }, noOp.figma) });
  assert.equal(clearNoOp.result.outcome, 'no-op');
  assert.equal(clearNoOp.result.attempted, 0);

  const rolledBack = fixture({ ignoreBrushWrite: true });
  await assert.rejects(() => executeDrawCommand({ action: 'brush', nodeId: '1:2', properties: { type: 'DYNAMIC' } }, { evaluate: async () => plugin({ action: 'brush', nodeId: '1:2', properties: { type: 'DYNAMIC' } }, rolledBack.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, { version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0 });
    return true;
  });
});

test('Draw Transform Group restores parents, indices and geometry after failed proof', async () => {
  const live = fixture({ transformMismatch: true });
  const request = { action: 'transform-group', nodeIds: ['1:2', '1:3'], parentId: null, index: 0, modifiers: [{ type: 'REPEAT', repeatType: 'RADIAL', count: 4, unitType: 'PIXELS', offset: 20 }] };
  await assert.rejects(() => executeDrawCommand(request, { evaluate: async () => plugin(request, live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back'); return true;
  });
  assert.deepEqual(live.page.children.map((node) => node.id), ['1:2', '1:3']);
  assert.deepEqual([live.target.x, live.target.y], [10, 20]);
});

test('CLI and MCP Draw requests resolve equivalent Plans and one Application', async () => {
  const requests = [
    { action: 'inspect', nodeId: '1:2' },
    { action: 'text-path', nodeId: '1:2', text: 'Hello' },
    { action: 'transform-group', nodeIds: ['1:2', '1:3'], modifiers: [{ type: 'REPEAT', repeatType: 'RADIAL', count: 2, unitType: 'PIXELS', offset: 10 }] },
    { action: 'brush', nodeId: '1:2', properties: { type: 'BASIC' } },
    { action: 'stroke-profile', nodeId: '1:2', clear: true },
    { action: 'pattern', nodeId: '1:2', sourceNodeId: '1:3', field: 'fill' },
  ];
  for (const request of requests) {
    const cli = planFigmaCommand(drawArgvFromRequest(request), { adapter: 'cli' });
    const mcp = planFigmaCommand(drawPlanningArgvFromRequest(request), { adapter: 'mcp' });
    assert.equal(cli.id, `draw.${request.action}`);
    assert.equal(mcp.id, cli.id);
    assert.deepEqual(mcp.effects, cli.effects);
    assert.equal(mcp.execution.retry, cli.execution.retry);
    assert.equal(drawCommandPlanRoute(mcp), 'command-application');
    assert.equal(mcp.confirmation !== 'none', request.action !== 'inspect');
    if (request.action === 'inspect') assert.equal(mcp.execution.retry, 'safe-read');
    const live = fixture();
    await executeDrawCommandPlan(mcp, { evaluate: async () => plugin(request, live.figma) });
  }
});

test('Draw planning preserves a URL-derived CLI target while canonical argv uses node ids', () => {
  const url = 'https://www.figma.com/design/FILE123/Test?node-id=1-2';
  const plan = planFigmaCommand(drawPlanningArgvFromRequest({ action: 'inspect', nodeId: url }), { adapter: 'cli' });
  assert.equal(plan.target.fileKey, 'FILE123');
  assert.deepEqual(plan.argv, ['draw', 'inspect', '--', '1:2']);
});
