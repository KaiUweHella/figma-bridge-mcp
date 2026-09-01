import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  createImageArgvFromRequest,
  createImageCode,
  createImagePlanRoute,
  executeCreateImage,
  executeCreateImagePlan,
  prepareCreateImagePlan,
} from '../src/application/create-image-command.js';
import { parseCreateImageRequest } from '../src/application/create-image-request.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const SHA256 = createHash('sha256').update(PNG).digest('hex');

const request = (overrides = {}) => ({
  url: 'https://assets.example/photo.png?token=secret',
  width: 200,
  height: null,
  x: null,
  y: -12.5,
  name: 'Product image',
  spacing: 24,
  ...overrides,
});

const materialized = (overrides = {}) => Object.freeze({
  kind: 'embedded-raster',
  name: 'photo.png',
  base64: PNG.toString('base64'),
  width: 1,
  height: 1,
  sha256: SHA256,
  source: Object.freeze({ kind: 'remote-http', label: 'https://assets.example/photo.png' }),
  ...overrides,
});

function planFor(adapter = 'mcp', overrides = {}) {
  return planFigmaCommand(createImageArgvFromRequest(request(overrides)), {
    adapter, fileKey: 'FILEA',
  });
}

async function preparedFor(plan, asset = materialized()) {
  return prepareCreateImagePlan(plan, {
    remainingMs: () => 5_000,
    materializeRemoteImage: async () => asset,
  });
}

function fixture({
  wrongWidth = false,
  resizeThrows = false,
  imageThrows = false,
  viewportThrows = false,
  invalidChildGeometry = false,
} = {}) {
  const registry = new Map();
  const first = {
    id: '2:1', type: 'RECTANGLE', name: 'First', x: 10,
    y: 0, width: invalidChildGeometry ? Number.NaN : 40, height: 20, parent: null,
  };
  const page = {
    id: '0:1', type: 'PAGE', name: 'Test Page', children: [first], selection: [first],
  };
  first.parent = page;
  registry.set(page.id, page);
  registry.set(first.id, first);
  let creates = 0;
  let images = 0;
  const figma = {
    currentPage: page,
    getNodeByIdAsync: async (id) => registry.get(id) || null,
    base64Decode: (value) => Buffer.from(value, 'base64'),
    createImage(bytes) {
      assert.deepEqual(Buffer.from(bytes), PNG);
      images += 1;
      if (imageThrows) throw new Error('image resource rejected');
      return { hash: `image:${images}` };
    },
    createRectangle() {
      creates += 1;
      let width = 100;
      let height = 100;
      const node = {
        id: `9:${creates}`, type: 'RECTANGLE', name: 'Rectangle', parent: page,
        x: 0, y: 0, fills: [],
        get width() { return width; },
        get height() { return height; },
        resize(nextWidth, nextHeight) {
          if (resizeThrows) throw new Error('resize rejected');
          width = wrongWidth ? nextWidth + 1 : nextWidth;
          height = nextHeight;
        },
        remove() {
          const index = page.children.indexOf(this);
          if (index !== -1) page.children.splice(index, 1);
          this.parent = null;
          registry.delete(this.id);
        },
      };
      registry.set(node.id, node);
      page.children.push(node);
      return node;
    },
    viewport: {
      scrollAndZoomIntoView() {
        if (viewportThrows) throw new Error('viewport unavailable');
      },
    },
  };
  return { figma, first, creates: () => creates, images: () => images };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Create Image request closes remote URL, aliases, signed values and excess input', () => {
  assert.deepEqual(parseCreateImageRequest([
    'create', 'image', 'https://assets.example/photo.png?token=secret',
    '-w', '200', '-h=100', '-x', '-5.5', '-y=-12.5',
    '-n', 'Product image', '--spacing=24',
  ]), request({ width: 200, height: 100, x: -5.5 }));
  assert.deepEqual(createImageArgvFromRequest(request()), [
    'create', 'image', 'https://assets.example/photo.png?token=secret',
    '--width=200', '--y=-12.5', '--name=Product image', '--spacing=24',
  ]);
  for (const args of [
    ['create', 'image'],
    ['create', 'image', 'file:///tmp/photo.png'],
    ['create', 'image', ['https://user', 'pass@assets.example/photo.png'].join(':')],
    ['create', 'image', 'https://assets.example/photo.png#part'],
    ['create', 'image', 'https://assets.example/photo.png', '--width', '0'],
    ['create', 'image', 'https://assets.example/photo.png', '--x', 'NaN'],
    ['create', 'image', 'https://assets.example/photo.png', '--future'],
    ['create', 'image', 'https://assets.example/a.png', 'https://assets.example/b.png'],
  ]) assert.throws(() => parseCreateImageRequest(args), /Invalid create image command/);
});

test('preparation validates bytes, derives size and redacts retrieval credentials', async () => {
  const plan = planFor();
  let materializedUrl = null;
  const prepared = await prepareCreateImagePlan(plan, {
    remainingMs: () => 5_000,
    materializeRemoteImage: async (url) => {
      materializedUrl = url;
      return materialized();
    },
  });
  assert.equal(materializedUrl, request().url);
  assert.equal(prepared.width, 200);
  assert.equal(prepared.height, 200);
  assert.equal(prepared.asset.source.label, 'https://assets.example/photo.png');
  assert.doesNotMatch(JSON.stringify(prepared), /token=secret/);

  await assert.rejects(() => preparedFor(plan, materialized({ sha256: '0'.repeat(64) })),
    /inconsistent raster metadata/);
  await assert.rejects(() => preparedFor(plan, materialized({
    source: Object.freeze({ kind: 'remote-http', label: 'https://assets.example/photo.png?secret=1' }),
  })), /invalid bounded raster asset/);
});

test('Create Image applies one embedded raster and verifies the fresh node', async () => {
  const plan = planFor();
  const prepared = await preparedFor(plan);
  const live = fixture();
  const result = await executeCreateImagePlan(plan, prepared, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'created');
  assert.deepEqual(result.result.node, {
    id: '9:1', name: 'Product image', type: 'RECTANGLE', parentId: '0:1', index: 1,
    x: 74, y: -12.5, width: 200, height: 200,
  });
  assert.deepEqual(result.result.source, {
    kind: 'remote-http', label: 'https://assets.example/photo.png',
  });
  assert.equal(result.result.sha256, SHA256);
  assert.deepEqual(live.figma.currentPage.selection.map((node) => node.id), ['9:1']);
  assert.equal(live.figma.currentPage.children[1].fills[0].imageHash, 'image:1');
  assert.equal(live.creates(), 1);
  assert.equal(live.images(), 1);
});

test('invalid page geometry refuses before image or node creation', async () => {
  const plan = planFor();
  const prepared = await preparedFor(plan);
  const live = fixture({ invalidChildGeometry: true });
  await assert.rejects(
    () => executeCreateImagePlan(plan, prepared, { evaluate: evaluate(live.figma) }),
    (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    },
  );
  assert.equal(live.creates(), 0);
  assert.equal(live.images(), 0);
});

test('failure before image creation rolls the rectangle back exactly', async () => {
  const plan = planFor();
  const prepared = await preparedFor(plan);
  const live = fixture({ resizeThrows: true });
  await assert.rejects(
    () => executeCreateImagePlan(plan, prepared, { evaluate: evaluate(live.figma) }),
    (error) => {
      assert.deepEqual(error.mutationReport, {
        version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
      });
      return true;
    },
  );
  assert.deepEqual(live.figma.currentPage.children.map((node) => node.id), ['2:1']);
  assert.deepEqual(live.figma.currentPage.selection.map((node) => node.id), ['2:1']);
});

test('postcondition failure reports the undeletable image resource residue', async () => {
  const plan = planFor();
  const prepared = await preparedFor(plan);
  for (const live of [fixture({ wrongWidth: true }), fixture({ imageThrows: true })]) {
    await assert.rejects(
      () => executeCreateImagePlan(plan, prepared, { evaluate: evaluate(live.figma) }),
      (error) => {
        assert.equal(error.mutationOutcome, 'partial-residue');
        assert.equal(error.mutationReport.residueCount, 1);
        return true;
      },
    );
    assert.deepEqual(live.figma.currentPage.children.map((node) => node.id), ['2:1']);
  }
});

test('editor navigation failure preserves the verified document mutation with one warning', async () => {
  const plan = planFor();
  const prepared = await preparedFor(plan);
  const live = fixture({ viewportThrows: true });
  const result = await executeCreateImagePlan(plan, prepared, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'created');
  assert.deepEqual(result.result.warnings, ['viewport unavailable']);
  assert.equal(result.stderr, '⚠ viewport unavailable');
  assert.deepEqual(live.figma.currentPage.children.map((node) => node.id), ['2:1', '9:1']);
});

test('one non-retrying Create Image capability crosses native and compatibility adapters', async () => {
  const native = planFor('mcp');
  const compatibility = planFor('cli');
  assert.equal(native.allowed, true);
  assert.equal(compatibility.allowed, true);
  assert.equal(native.id, 'create.image');
  assert.equal(native.execution.retry, 'never');
  assert.deepEqual(native.effects, {
    figma: 'write', editor: 'write', workspace: 'none', network: 'read', shared: 'none',
  });
  assert.deepEqual(native.effects, compatibility.effects);
  assert.deepEqual(native.target, compatibility.target);
  assert.equal(createImagePlanRoute(native), 'command-application');
  assert.throws(() => createImagePlanRoute({ ...native }), /requires a Command Plan/);

  const prepared = await preparedFor(native);
  await assert.rejects(
    () => executeCreateImagePlan(compatibility, prepared, { evaluate: async () => '' }),
    /does not belong/,
  );
});

test('generated Create Image code contains bytes but no retrieval URL or Plugin network fallback', async () => {
  const plan = planFor();
  const prepared = await preparedFor(plan);
  const code = createImageCode(prepared);
  assert.match(code, /figma\.createImage\(bytes\)/);
  assert.doesNotMatch(code, /createImageAsync/);
  assert.doesNotMatch(code, /token=secret/);
  assert.doesNotMatch(code, /assets\.example\/photo\.png\?token/);
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));

  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeCreateImage(prepared, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});
