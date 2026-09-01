import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PNG } from 'pngjs';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeGradientExtractPlan,
  executePreparedGradientExtract,
  gradientExtractMutationCode,
  gradientExtractPlanRoute,
  gradientExtractRequiresFigma,
  prepareGradientExtractPlan,
} from '../src/application/gradient-extract-command.js';
import {
  acceptsGradientExtractArgv,
  gradientExtractArgvFromRequest,
  gradientExtractPlanningArgvFromRequest,
  parseGradientExtractRequest,
} from '../src/application/gradient-extract-request.js';
import { extractGradient } from '../src/gradient-extractor.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const LINEAR = {
  direction: 'horizontal', angle: 90,
  box: { left: 0, top: 0, right: 9, bottom: 9 },
  imageSize: { width: 10, height: 10 },
  stops: [
    { position: 0, rgb: [255, 0, 0] },
    { position: 1, rgb: [0, 0, 255] },
  ],
};
const MESH = {
  mode: 'mesh', base: '#112233', blurFraction: 0.38,
  imageSize: { width: 10, height: 10 },
  box: { left: 0, top: 0, right: 9, bottom: 9 },
  blobs: [
    { fx: 0.2, fy: 0.3, r: 0.4, color: '#FF0000' },
    { fx: 0.8, fy: 0.7, r: 0.5, color: '#0000FF', blurMul: 0.5 },
  ],
};

function prepared(request, { linear = LINEAR, mesh = MESH, reads = [] } = {}) {
  const planning = gradientExtractPlanningArgvFromRequest(request);
  const plan = planFigmaCommand(planning, { adapter: 'mcp', workspaceDir: '/workspace' });
  const workspaceIO = {
    read(path, options) { reads.push({ path, options }); return Buffer.from('fixture'); },
  };
  const value = prepareGradientExtractPlan(plan, {
    workspaceIO,
    extractLinear(path, options, adapters) {
      adapters.workspaceIO.read(path, { role: 'gradient-image', maxBytes: 32 * 1024 * 1024 });
      assert.equal(options.trim, request.trim !== false);
      return copy(linear);
    },
    extractMeshRecipe(path, options, adapters) {
      adapters.workspaceIO.read(path, { role: 'gradient-image', maxBytes: 32 * 1024 * 1024 });
      assert.equal(options.trim, request.trim !== false);
      return copy(mesh);
    },
  });
  return { plan, value, reads };
}

function paintFixture({ mode = 'normal', selection = false, before } = {}) {
  let fills = copy(before || [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]);
  let writes = 0;
  const node = {
    id: '1:2', name: 'Gradient Target', type: 'RECTANGLE',
    get fills() { return copy(fills); },
    set fills(value) {
      writes += 1;
      if (mode === 'ignore-first' && writes === 1) return;
      if (mode === 'wrong-first' && writes === 1) { fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; return; }
      fills = copy(value);
      if (mode === 'throw-after-first' && writes === 1) throw new Error('paint acknowledgement');
    },
  };
  const figma = {
    currentPage: { selection: selection ? [node] : [] },
    async getNodeByIdAsync(id) { return id === node.id ? node : null; },
  };
  return { figma, node, fills: () => copy(fills), writes: () => writes };
}

function meshFixture({ resizeThrows = false, ignoreSecondRemoval = false, ignoreStagedRemoval = false, selection = false } = {}) {
  let next = 0;
  const created = [];
  const page = { children: [] };
  const detach = (node) => {
    if (!node.parent) return;
    const index = node.parent.children.indexOf(node);
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = null;
  };
  const child = (id, { ignoreRemove = false } = {}) => ({
    id, type: 'RECTANGLE', parent: null,
    remove() { if (!ignoreRemove) detach(this); },
  });
  const oldOne = child('2:1');
  const oldTwo = child('2:2', { ignoreRemove: ignoreSecondRemoval });
  let fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  const frame = {
    id: '1:2', name: 'Mesh Target', type: 'FRAME', width: 100, height: 80,
    clipsContent: false, children: [oldOne, oldTwo],
    get fills() { return copy(fills); }, set fills(value) { fills = copy(value); },
    appendChild(node) { detach(node); node.parent = this; this.children.push(node); },
  };
  oldOne.parent = frame; oldTwo.parent = frame;
  const figma = {
    currentPage: { children: page.children, selection: selection ? [frame] : [] },
    async getNodeByIdAsync(id) {
      if (id === frame.id) return frame;
      return created.find((node) => node.id === id && node.parent) || null;
    },
    createEllipse() {
      next += 1;
      const ellipse = {
        id: `9:${next}`, name: 'Ellipse', type: 'ELLIPSE', parent: page,
        width: 0, height: 0, x: 0, y: 0, fills: [], effects: [],
        resize(width, height) {
          if (resizeThrows && next === 1) throw new Error('resize failed');
          this.width = width; this.height = height;
        },
        remove() { if (!ignoreStagedRemoval) detach(this); },
      };
      page.children.push(ellipse);
      created.push(ellipse);
      return ellipse;
    },
  };
  return { figma, frame, oldIds: [oldOne.id, oldTwo.id], page };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('the raster extractor consumes only its injected authorized WorkspaceIO capability', () => {
  const png = new PNG({ width: 4, height: 4 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255; png.data[index + 1] = 0; png.data[index + 2] = 0; png.data[index + 3] = 255;
  }
  const bytes = PNG.sync.write(png);
  const reads = [];
  const result = extractGradient('/workspace/fixture.png', {
    direction: 'horizontal', stops: 2, trim: false,
  }, {
    workspaceIO: {
      read(path, options) { reads.push({ path, options }); return bytes; },
    },
  });
  assert.deepEqual(reads, [{
    path: '/workspace/fixture.png',
    options: { role: 'gradient-image', maxBytes: 32 * 1024 * 1024 },
  }]);
  assert.equal(result.direction, 'horizontal');
  assert.deepEqual(result.stops.map((stop) => stop.rgb), [[255, 0, 0], [255, 0, 0]]);
});

test('Gradient Extract closes grammar, defaults, selection, URL identity, and path payloads', () => {
  const url = 'https://www.figma.com/design/FILEA/Lab?node-id=1-2';
  assert.deepEqual(parseGradientExtractRequest([
    'gradient', 'extract', '--mode=MESH', '--apply-to', url, '--direction', 'vertical',
    '--stops', '5', '--blur', '1', '--no-trim', '--json', 'hero.png',
  ]), {
    image: 'hero.png', mode: 'mesh', direction: 'vertical', stops: 5, blur: 0.8,
    trim: false, json: true, selector: { kind: 'node', nodeId: '1:2' },
  });
  assert.deepEqual(parseGradientExtractRequest(['gradient', 'extract', '--apply-to', 'SELECTED', 'hero.png']).selector,
    { kind: 'selection' });
  assert.deepEqual(gradientExtractArgvFromRequest({ image: '--private.png', selector: null }), [
    'gradient', 'extract', '--mode', 'linear', '--direction', 'auto', '--stops', '3', '--', '--private.png',
  ]);
  assert.equal(gradientExtractPlanningArgvFromRequest({ image: 'hero.png', applyTo: url }).includes(url), true);
  for (const argv of [
    ['gradient', 'extract'],
    ['gradient', 'extract', 'hero.png', 'extra'],
    ['gradient', 'extract', '--mode', 'unknown', 'hero.png'],
    ['gradient', 'extract', '--stops', '6', 'hero.png'],
    ['gradient', 'extract', '--blur', 'nan', 'hero.png'],
    ['gradient', 'extract', '--apply-to', 'private-target', 'hero.png'],
    ['gradient', 'extract', '--json=true', 'hero.png'],
    ['gradient', 'extract', '--future', 'private-value', 'hero.png'],
  ]) assert.equal(acceptsGradientExtractArgv(argv), false, argv.join(' '));
});

test('Gradient Extract prepares one authorized bounded source before optional Figma access', async () => {
  const local = prepared({ image: 'hero.png', mode: 'linear' });
  assert.equal(local.plan.effects.workspace, 'read');
  assert.equal(local.plan.effects.figma, 'none');
  assert.equal(local.reads.length, 1);
  assert.equal(local.reads[0].path, '/workspace/hero.png');
  assert.equal(gradientExtractRequiresFigma(local.value), false);
  const result = await executePreparedGradientExtract(local.value, {
    evaluate() { throw new Error('must stay offline'); },
  });
  assert.match(result.stdout, /Gradient extracted \(linear\)/);
  assert.match(result.stdout, /linear-gradient\(90deg/);

  const target = prepared({ image: 'hero.png', mode: 'mesh', applyTo: 'selected', json: true });
  assert.equal(target.plan.effects.figma, 'write');
  assert.equal(target.plan.effects.editor, 'read');
  assert.equal(gradientExtractRequiresFigma(target.value), true);
  assert.deepEqual(JSON.parse((await executePreparedGradientExtract(
    prepared({ image: 'hero.png', mode: 'mesh', json: true }).value,
  )).stdout), MESH);
});

test('linear extraction apply freshly verifies id and selection targets', async () => {
  const explicit = prepared({ image: 'hero.png', mode: 'linear', applyTo: '1:2' });
  const first = paintFixture();
  const result = await executeGradientExtractPlan(explicit.plan, explicit.value, { evaluate: evaluate(first.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(first.fills()[0].type, 'GRADIENT_LINEAR');
  assert.match(result.stdout, /Applied to Gradient Target \(RECTANGLE\)/);

  const selected = prepared({ image: 'hero.png', mode: 'linear', applyTo: 'selected' });
  const second = paintFixture({ selection: true });
  assert.equal((await executeGradientExtractPlan(selected.plan, selected.value, {
    evaluate: evaluate(second.figma),
  })).result.node.id, '1:2');
});

test('linear extraction distinguishes no-op, acknowledged writes, unchanged state, and rollback', async () => {
  const target = prepared({ image: 'hero.png', mode: 'linear', applyTo: '1:2' });
  const probe = paintFixture();
  await executeGradientExtractPlan(target.plan, target.value, { evaluate: evaluate(probe.figma) });
  const noOp = paintFixture({ before: probe.fills() });
  assert.equal((await executeGradientExtractPlan(target.plan, target.value, {
    evaluate: evaluate(noOp.figma),
  })).result.outcome, 'no-op');
  assert.equal(noOp.writes(), 0);

  const acknowledged = paintFixture({ mode: 'throw-after-first' });
  const accepted = await executeGradientExtractPlan(target.plan, target.value, { evaluate: evaluate(acknowledged.figma) });
  assert.equal(accepted.result.outcome, 'verified-after-error');
  assert.match(accepted.stderr, /fresh readback proved/);

  const unchanged = paintFixture({ mode: 'ignore-first' });
  await assert.rejects(() => executeGradientExtractPlan(target.plan, target.value, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged' && error.mutationReport.residueCount === 1);

  const rollback = paintFixture({ mode: 'wrong-first' });
  await assert.rejects(() => executeGradientExtractPlan(target.plan, target.value, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.restored === 1);
  assert.equal(rollback.fills()[0].type, 'SOLID');
});

test('mesh extraction stages blobs, replaces children, and freshly verifies the exact recipe', async () => {
  const target = prepared({ image: 'hero.png', mode: 'mesh', blur: 0.5, applyTo: '1:2' });
  const fixture = meshFixture();
  const result = await executeGradientExtractPlan(target.plan, target.value, { evaluate: evaluate(fixture.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.details, { blobs: 2, blur: 40 });
  assert.equal(fixture.frame.children.length, 2);
  assert.equal(fixture.frame.children.every((node) => node.type === 'ELLIPSE'), true);
  assert.equal(fixture.page.children.length, 0);
  assert.match(result.stdout, /Mesh built on Mesh Target \(2 blobs, blur 40px\)/);
});

test('mesh extraction rolls back staged work before deletion and reports irreversible partial residue after deletion', async () => {
  const target = prepared({ image: 'hero.png', mode: 'mesh', applyTo: '1:2' });
  const reversible = meshFixture({ resizeThrows: true });
  await assert.rejects(() => executeGradientExtractPlan(target.plan, target.value, {
    evaluate: evaluate(reversible.figma),
  }), (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  assert.deepEqual(reversible.frame.children.map((node) => node.id), reversible.oldIds);
  assert.equal(reversible.page.children.length, 0);

  const failedCleanup = meshFixture({ resizeThrows: true, ignoreStagedRemoval: true });
  await assert.rejects(() => executeGradientExtractPlan(target.plan, target.value, {
    evaluate: evaluate(failedCleanup.figma),
  }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
  assert.equal(failedCleanup.page.children.length, 1);

  const irreversible = meshFixture({ ignoreSecondRemoval: true });
  await assert.rejects(() => executeGradientExtractPlan(target.plan, target.value, {
    evaluate: evaluate(irreversible.figma),
  }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
  assert.equal(irreversible.frame.children.some((node) => node.id === irreversible.oldIds[0]), false);
  assert.equal(irreversible.frame.children.some((node) => node.id === irreversible.oldIds[1]), true);
});

test('Gradient Extract owns one non-retrying conditional Plan across CLI and MCP', () => {
  const url = 'https://www.figma.com/design/FILEA/Lab?node-id=1-2';
  const planning = gradientExtractPlanningArgvFromRequest({ image: 'hero.png', applyTo: url });
  const cli = planFigmaCommand(planning, { adapter: 'cli', workspaceDir: '/workspace' });
  const mcp = planFigmaCommand(planning, { adapter: 'mcp', workspaceDir: '/workspace' });
  for (const plan of [cli, mcp]) {
    assert.equal(plan.id, 'gradient.extract');
    assert.equal(plan.allowed, true);
    assert.equal(plan.target.fileKey, 'FILEA');
    assert.equal(plan.effects.figma, 'write');
    assert.equal(plan.effects.workspace, 'read');
    assert.equal(plan.execution.retry, 'never');
    assert.equal(gradientExtractPlanRoute(plan), 'command-application');
    assert.equal(parseGradientExtractRequest(plan.argv).image, '/workspace/hero.png');
  }
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
});

test('malformed and forged Plugin results cannot become successful Gradient Extracts', async () => {
  const target = prepared({ image: 'hero.png', mode: 'linear', applyTo: '1:2' });
  for (const serialized of [
    'private-output',
    JSON.stringify({ schemaVersion: 1, status: 'applied', mode: 'linear', outcome: 'verified', attempted: 1 }),
    JSON.stringify({ schemaVersion: 1, status: 'applied', mode: 'linear', outcome: 'verified', attempted: 1,
      node: { id: '9:9', name: 'Wrong', type: 'RECTANGLE' }, details: { field: 'fill' }, residue: [], warnings: [] }),
  ]) await assert.rejects(() => executePreparedGradientExtract(target.value, {
    evaluate: async () => serialized,
  }), (error) => error.kind === 'plugin-result');
  await assert.rejects(() => executePreparedGradientExtract({}, {}), /authentic prepared input/);
});

test('Gradient Extract generated code parses and Source MCP routes without compatibility fallback', () => {
  const target = prepared({ image: 'hero.png', mode: 'mesh', applyTo: '1:2' });
  assert.doesNotThrow(() => new Function(`return ${gradientExtractMutationCode(target.value)};`));
  const server = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf('const gradientExtractRoute'), server.indexOf('const motionApplyRoute'));
  assert.match(route, /prepareGradientExtractPlan\(plan/);
  assert.match(route, /gradientExtractRequiresFigma/);
  assert.match(route, /executeGradientExtractPlan\(plan, prepared/);
  assert.match(route, /compatibilityFallback: false/);
});
