import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeGradientMeshPlan,
  executePreparedGradientMesh,
  gradientMeshCode,
  gradientMeshPlanRoute,
  prepareGradientMeshPlan,
} from '../src/application/gradient-mesh-command.js';
import {
  acceptsGradientMeshArgv,
  gradientMeshArgvFromRequest,
  gradientMeshPlanningArgvFromRequest,
  parseGradientMeshRequest,
} from '../src/application/gradient-mesh-request.js';

const copy = (value) => JSON.parse(JSON.stringify(value));

function prepared(request) {
  const planning = gradientMeshPlanningArgvFromRequest({ seed: 42, ...request });
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  return { plan, value: prepareGradientMeshPlan(plan) };
}

function fixture({
  existing = true,
  selection = false,
  resizeEllipseThrows = false,
  ignoreSecondOldRemoval = false,
  ignoreFrameRemoval = false,
  createFrameThrows = false,
  viewportThrows = false,
} = {}) {
  let next = 0; let viewportCalls = 0;
  const registry = new Map();
  const page = { id: '0:1', type: 'PAGE', children: [], selection: [] };
  const detach = (node) => {
    if (!node.parent) return;
    const index = node.parent.children.indexOf(node);
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = null;
    for (const child of node.children || []) child.parent = null;
  };
  const removable = (node, ignore = false) => Object.assign(node, {
    remove() { if (!ignore) detach(this); },
  });
  const oldOne = removable({ id: '2:1', name: 'Old One', type: 'RECTANGLE', x: 0, width: 10, parent: null });
  const oldTwo = removable({ id: '2:2', name: 'Old Two', type: 'RECTANGLE', x: 0, width: 10, parent: null }, ignoreSecondOldRemoval);
  const frame = removable({
    id: '1:2', name: 'Existing Mesh', type: 'FRAME', x: 50, y: 0, width: 120, height: 80,
    clipsContent: false, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 1 }, radius: 2, spread: 0, visible: true, blendMode: 'NORMAL' }],
    children: [oldOne, oldTwo], parent: page,
    resize(width, height) { this.width = width; this.height = height; },
    appendChild(node) { detach(node); node.parent = this; this.children.push(node); },
  });
  oldOne.parent = frame; oldTwo.parent = frame;
  if (existing) { page.children.push(frame); registry.set(frame.id, frame); }
  registry.set(oldOne.id, oldOne); registry.set(oldTwo.id, oldTwo);
  if (selection && existing) page.selection = [frame];
  const figma = {
    currentPage: page,
    viewport: {
      scrollAndZoomIntoView(nodes) {
        viewportCalls += 1; assert.equal(nodes.length, 1);
        if (viewportThrows) throw new Error('viewport acknowledgement');
      },
    },
    async getNodeByIdAsync(id) {
      const node = registry.get(id);
      return node?.parent ? node : null;
    },
    createFrame() {
      if (createFrameThrows) throw new Error('unattributed frame creation');
      const node = removable({
        id: '8:1', name: 'Frame', type: 'FRAME', x: 0, y: 0, width: 100, height: 100,
        clipsContent: false, fills: [], effects: [], children: [], parent: page,
        resize(width, height) { this.width = width; this.height = height; },
        appendChild(child) { detach(child); child.parent = this; this.children.push(child); },
      }, ignoreFrameRemoval);
      page.children.push(node); registry.set(node.id, node); return node;
    },
    createEllipse() {
      next += 1;
      const node = removable({
        id: `9:${next}`, name: 'Ellipse', type: 'ELLIPSE', x: 0, y: 0, width: 0, height: 0,
        fills: [], effects: [], children: [], parent: page,
        resize(width, height) {
          if (resizeEllipseThrows && next === 1) throw new Error('ellipse resize failed');
          this.width = width; this.height = height;
        },
      });
      page.children.push(node); registry.set(node.id, node); return node;
    },
  };
  return { figma, frame, page, viewportCalls: () => viewportCalls, oldIds: [oldOne.id, oldTwo.id] };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Gradient Mesh closes and canonicalizes palette, target, style, dimensions, effects, and seed', () => {
  const url = 'https://www.figma.com/design/FILEA/Mesh?node-id=1-2';
  assert.deepEqual(parseGradientMeshRequest([
    'gradient', 'mesh', '--apply-to', url, '--base', '#abc', '--size', '640X480',
    '--blur', '1', '--grain', '2', '--texture', '--style', 'aurora', '--seed=-1',
    '--name', 'Neutral Mesh', '--json', '#f00,#0000ff',
  ]), {
    colors: ['#FF0000', '#0000FF'], selector: { kind: 'node', nodeId: '1:2' }, base: '#AABBCC',
    size: { width: 640, height: 480 }, blur: 0.8, grain: 1, texture: true,
    style: 'drift', seed: 0xffff_ffff, name: 'Neutral Mesh', json: true,
  });
  assert.equal(parseGradientMeshRequest(['gradient', 'mesh', '#f00,#00f', '--grain']).grain, 0.18);
  assert.deepEqual(gradientMeshArgvFromRequest({ colors: ['#f00', '#00f'], selector: null, width: 20, height: 10 }).slice(-2), [
    '--', '#FF0000,#0000FF',
  ]);
  assert.equal(gradientMeshPlanningArgvFromRequest({ colors: '#f00,#00f', applyTo: url }).includes(url), true);
  for (const argv of [
    ['gradient', 'mesh'],
    ['gradient', 'mesh', '#fff'],
    ['gradient', 'mesh', '#private,#fff'],
    ['gradient', 'mesh', '--size', 'big', '#fff,#000'],
    ['gradient', 'mesh', '--apply-to', 'private-target', '#fff,#000'],
    ['gradient', 'mesh', '--style', 'private-style', '#fff,#000'],
    ['gradient', 'mesh', '--grain=nan', '#fff,#000'],
    ['gradient', 'mesh', '--json=true', '#fff,#000'],
    ['gradient', 'mesh', '#fff,#000', 'extra'],
    ['gradient', 'mesh', '--future', 'private-value', '#fff,#000'],
  ]) assert.equal(acceptsGradientMeshArgv(argv), false, argv.join(' '));
});

test('Gradient Mesh prepares one deterministic bounded recipe and effect graph', () => {
  const target = prepared({
    colors: '#f00,#00f', applyTo: '1:2', grain: 0.2, texture: true, style: 'diagonal',
  });
  assert.equal(target.value.recipe.seed, 42);
  assert.equal(target.value.recipe.style, 'diagonal');
  assert.equal(target.value.recipe.blobs.length, 4);
  assert.equal(Object.isFrozen(target.value.recipe.blobs), true);
  assert.deepEqual(target.value.effects.map((effect) => effect.type), ['NOISE', 'TEXTURE']);
  assert.equal(Object.isFrozen(target.value.effects[0].color), true);
});

test('Gradient Mesh replaces an existing Frame and verifies recipe, native effects, and viewport', async () => {
  const target = prepared({ colors: '#f00,#00f', applyTo: '1:2', grain: 0.2, texture: true });
  const state = fixture();
  const result = await executeGradientMeshPlan(target.plan, target.value, { evaluate: evaluate(state.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.details.created, false);
  assert.equal(state.frame.children.length, target.value.recipe.blobs.length);
  assert.deepEqual(state.frame.effects.map((effect) => effect.type), ['NOISE', 'TEXTURE']);
  assert.equal(state.viewportCalls(), 1);
  assert.match(result.stdout, /Built on Existing Mesh \(120x80, 4 blobs\)/);
});

test('Gradient Mesh creates, positions, verifies, and focuses a new Frame', async () => {
  const target = prepared({ colors: '#f00,#00f', size: '200x100', name: 'Neutral Mesh' });
  const state = fixture();
  const result = await executeGradientMeshPlan(target.plan, target.value, { evaluate: evaluate(state.figma) });
  assert.equal(result.result.details.created, true);
  assert.deepEqual(result.result.details, { created: true, blobs: 4, blur: 42, width: 200, height: 100 });
  const created = state.page.children.find((node) => node.id === result.result.node.id);
  assert.equal(created.name, 'Neutral Mesh');
  assert.equal(created.x, 300);
  assert.equal(created.children.length, 4);
  assert.equal(state.viewportCalls(), 1);
  assert.match(result.stdout, /Created Neutral Mesh \(200x100, 4 blobs\)/);
});

test('Gradient Mesh accepts a viewport acknowledgement error only after exact document readback', async () => {
  const target = prepared({ colors: '#f00,#00f', applyTo: 'selected' });
  const state = fixture({ selection: true, viewportThrows: true });
  const result = await executeGradientMeshPlan(target.plan, target.value, { evaluate: evaluate(state.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /complete document postcondition/);
});

test('existing-frame staging failure rolls back exactly before any child deletion', async () => {
  const target = prepared({ colors: '#f00,#00f', applyTo: '1:2', grain: 0.2 });
  const state = fixture({ resizeEllipseThrows: true });
  const beforeEffects = copy(state.frame.effects);
  await assert.rejects(() => executeGradientMeshPlan(target.plan, target.value, {
    evaluate: evaluate(state.figma),
  }), (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  assert.deepEqual(state.frame.children.map((node) => node.id), state.oldIds);
  assert.deepEqual(state.frame.effects, beforeEffects);
  assert.equal(state.page.children.filter((node) => node.type === 'ELLIPSE').length, 0);
});

test('existing-frame child deletion is an explicit irreversible partial-residue boundary', async () => {
  const target = prepared({ colors: '#f00,#00f', applyTo: '1:2' });
  const state = fixture({ ignoreSecondOldRemoval: true });
  await assert.rejects(() => executeGradientMeshPlan(target.plan, target.value, {
    evaluate: evaluate(state.figma),
  }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
  assert.equal(state.frame.children.some((node) => node.id === state.oldIds[0]), false);
  assert.equal(state.frame.children.some((node) => node.id === state.oldIds[1]), true);
});

test('new-frame failure deletes attributed resources and keeps unattributed creation uncertainty explicit', async () => {
  const target = prepared({ colors: '#f00,#00f' });
  const reversible = fixture({ existing: false, resizeEllipseThrows: true });
  await assert.rejects(() => executeGradientMeshPlan(target.plan, target.value, {
    evaluate: evaluate(reversible.figma),
  }), (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  assert.equal(reversible.page.children.length, 0);

  const unknown = fixture({ existing: false, createFrameThrows: true });
  await assert.rejects(() => executeGradientMeshPlan(target.plan, target.value, {
    evaluate: evaluate(unknown.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable' && error.mutationReport.residueCount === 1);
});

test('Gradient Mesh owns one non-retrying URL-targeted Plan across CLI and MCP', () => {
  const url = 'https://www.figma.com/design/FILEA/Mesh?node-id=1-2';
  const planning = gradientMeshPlanningArgvFromRequest({ colors: '#f00,#00f', applyTo: url, seed: 42 });
  const cli = planFigmaCommand(planning, { adapter: 'cli' });
  const mcp = planFigmaCommand(planning, { adapter: 'mcp' });
  for (const plan of [cli, mcp]) {
    assert.equal(plan.id, 'gradient.mesh');
    assert.equal(plan.allowed, true);
    assert.equal(plan.target.fileKey, 'FILEA');
    assert.equal(plan.effects.figma, 'write');
    assert.equal(plan.effects.editor, 'write');
    assert.equal(plan.execution.retry, 'never');
    assert.equal(gradientMeshPlanRoute(plan), 'command-application');
  }
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
});

test('JSON stays recipe-only and forged Plugin results cannot claim Mesh success', async () => {
  const target = prepared({ colors: '#f00,#00f', applyTo: '1:2', json: true });
  const state = fixture();
  const output = await executeGradientMeshPlan(target.plan, target.value, { evaluate: evaluate(state.figma) });
  assert.deepEqual(JSON.parse(output.stdout), target.value.recipe);
  for (const serialized of [
    'private-output',
    JSON.stringify({ schemaVersion: 1, status: 'applied', outcome: 'verified', attempted: 1 }),
    JSON.stringify({ schemaVersion: 1, status: 'applied', outcome: 'verified', attempted: 1,
      node: { id: '9:9', name: 'Wrong', type: 'FRAME' },
      details: { created: false, blobs: 4, blur: 34, width: 120, height: 80 }, residue: [], warnings: [] }),
  ]) await assert.rejects(() => executePreparedGradientMesh(target.value, {
    evaluate: async () => serialized,
  }), (error) => error.kind === 'plugin-result');
  await assert.rejects(() => executePreparedGradientMesh({}, {}), /authentic prepared input/);
});

test('Gradient Mesh generated code parses and Source MCP routes without compatibility fallback', () => {
  const target = prepared({ colors: '#f00,#00f', applyTo: '1:2' });
  assert.doesNotThrow(() => new Function(`return ${gradientMeshCode(target.value)};`));
  const server = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf('const gradientMeshRoute'), server.indexOf('const motionApplyRoute'));
  assert.match(route, /prepareGradientMeshPlan\(plan\)/);
  assert.match(route, /executeGradientMeshPlan\(plan, prepared/);
  assert.match(route, /compatibilityFallback: false/);
});
