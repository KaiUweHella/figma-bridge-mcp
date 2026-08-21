// M4: asset export (collector + naming) and the spec's asset references.
// The naming contract is the load-bearing part: vector files use semantic
// layer names; IMAGE fills use their stable Figma hash so isolated spec and
// export calls still agree on the exact filename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetSlug, isGenericName, effectiveAssetName, assetFileName, imageAssetBase } from '../src/lib/asset-names.js';
import { assetContentDigest, planAssetExport, publishAssetExportPlan } from '../src/lib/asset-manifest.js';
import { assetCollectorCode, imageBytesCode, nodeWalkerCode, svgBytesCode } from '../src/design-extract.js';
import { paintSeg, specLines, styleFields, bundleKey } from '../src/lib/code-spec.js';

// ---- naming contract ----

test('assetSlug: kebab, diacritics stripped, bounded, never empty', () => {
  assert.equal(assetSlug('DLS Logo'), 'dls-logo');
  assert.equal(assetSlug('card_artwork (1)'), 'card-artwork-1');
  assert.equal(assetSlug('Über-Bild'), 'uber-bild');
  assert.equal(assetSlug('  '), 'asset');
  assert.ok(assetSlug('x'.repeat(200)).length <= 60);
});

test('generic layer names fall back to the nearest meaningful ancestor', () => {
  assert.equal(isGenericName('Group'), true);
  assert.equal(isGenericName('Frame 2610008'), true);
  assert.equal(isGenericName('Vector 12'), true);
  assert.equal(isGenericName('DLS Logo'), false);
  assert.equal(effectiveAssetName('Group', ['content', 'test-logo']), 'test-logo');
  assert.equal(effectiveAssetName('Group', ['Frame 1', 'Group']), 'Group', 'all-generic chain keeps own name');
  assert.equal(assetFileName('Group', 'svg', ['sidebar', 'test-logo']), 'test-logo.svg');
});

test('IMAGE filename base is stable across layer names and requested roots', () => {
  assert.equal(imageAssetBase('HASH-1'), 'image-hash1');
  assert.equal(imageAssetBase('HASH-1'), imageAssetBase('HASH-1'));
  assert.notEqual(imageAssetBase('HASH-1'), imageAssetBase('HASH-2'));
});

// ---- collector eval (against a stub figma) ----

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
});
const run = (code, root) => new Function('figma', `return ${code}`)(stubFigma(root));

const TREE = {
  id: 'a:1', name: 'Screen', type: 'FRAME', visible: true, width: 800, height: 600,
  children: [
    {
      id: 'a:2', name: 'card-image', type: 'RECTANGLE', visible: true, width: 561, height: 300,
      fills: [{ type: 'IMAGE', imageHash: 'HASH-1', visible: true }], children: [],
    },
    {
      id: 'a:3', name: 'avatar', type: 'ELLIPSE', visible: true, width: 40, height: 40,
      fills: [{ type: 'IMAGE', imageHash: 'HASH-1', visible: true }], children: [],
    },
    {
      id: 'a:4', name: 'test-logo', type: 'GROUP', visible: true, width: 120, height: 32,
      children: [
        { id: 'a:5', name: 'Vector', type: 'VECTOR', visible: true, width: 100, height: 30, children: [] },
        { id: 'a:6', name: 'Vector', type: 'VECTOR', visible: true, width: 20, height: 30, children: [] },
      ],
    },
    {
      id: 'a:7', name: 'Hidden Art', type: 'GROUP', visible: false, width: 100, height: 100,
      children: [{ id: 'a:8', name: 'Vector', type: 'VECTOR', visible: true, width: 100, height: 100, children: [] }],
    },
    {
      // plain rect+ellipse group: styling, NOT vector art (no hard vector)
      id: 'a:9', name: 'Deco', type: 'GROUP', visible: true, width: 50, height: 50,
      children: [{ id: 'a:10', name: 'Rectangle', type: 'RECTANGLE', visible: true, width: 50, height: 50, children: [] }],
    },
  ],
};

test('collector: a hidden helper layer does not shatter a vector group', async () => {
  const root = {
    id: 'h:1', name: 'Wrap', type: 'FRAME', visible: true, width: 200, height: 200,
    children: [{
      id: 'h:2', name: 'Logo', type: 'GROUP', visible: true, width: 100, height: 40,
      children: [
        { id: 'h:3', name: 'Vector', type: 'VECTOR', visible: true, width: 100, height: 40, children: [] },
        { id: 'h:4', name: 'Guide', type: 'FRAME', visible: false, width: 10, height: 10, children: [] },
      ],
    }],
  };
  const result = JSON.parse(await run(assetCollectorCode('h:1'), root));
  assert.deepEqual(result.vectors.map((v) => v.id), ['h:2'], 'group stays whole despite hidden non-vector child');
});

test('collector: a mostly-vector container clusters into ONE artwork', async () => {
  const shapes = Array.from({ length: 20 }, (_, i) => ({
    id: `p:${i + 10}`, name: 'Vector', type: 'VECTOR', visible: true, width: 42, height: 56, children: [],
  }));
  const root = {
    id: 'p:1', name: 'Screen', type: 'FRAME', visible: true, width: 800, height: 600,
    children: [{
      id: 'p:2', name: 'Background Pattern', type: 'FRAME', visible: true, width: 741, height: 982,
      // one stray non-vector child — previously this exploded into 20 files
      children: [...shapes, { id: 'p:9', name: 'Tint', type: 'FRAME', visible: true, width: 741, height: 982, fills: [], children: [] }],
    }],
  };
  const result = JSON.parse(await run(assetCollectorCode('p:1'), root));
  assert.equal(result.vectors.length, 1);
  assert.equal(result.vectors[0].id, 'p:2');
  assert.equal(result.vectors[0].cluster, 20);
});

test('collector: images deduped by hash, vector art topmost, hidden + soft-only groups skipped', async () => {
  const result = JSON.parse(await run(assetCollectorCode('a:1'), TREE));
  assert.equal(result.images.length, 1, 'HASH-1 collected once');
  assert.deepEqual(result.images[0].nodes.map((n) => n.id), ['a:2', 'a:3'], 'both users recorded');
  assert.deepEqual(result.vectors.map((v) => v.id), ['a:4'], 'logo group only — hidden and soft-only skipped');
  assert.equal(result.vectors[0].name, 'test-logo');
});

test('collector reports post-transform placement in both parent and export-root coordinates', async () => {
  const root = {
    id: 'rot:0', name: 'Screen', type: 'FRAME', visible: true, width: 1194, height: 834,
    absoluteBoundingBox: { x: 200, y: 300, width: 1194, height: 834 },
    children: [{
      id: 'rot:1', name: 'layout', type: 'GROUP', visible: true, width: 834, height: 1194,
      absoluteBoundingBox: { x: 200, y: 300, width: 1194, height: 834 },
      children: [{
        id: 'rot:2', name: 'Ring', type: 'GROUP', visible: true, width: 346, height: 346,
        absoluteBoundingBox: { x: 200, y: 788, width: 346, height: 346 },
        absoluteRenderBounds: { x: 200, y: 788, width: 346, height: 346 },
        children: [{ id: 'rot:3', name: 'Vector', type: 'VECTOR', visible: true, width: 346, height: 346, children: [] }],
      }, { id: 'rot:4', name: 'Dashboard', type: 'FRAME', visible: true, width: 1194, height: 834, children: [] }],
    }],
  };
  const layout = root.children[0], ring = layout.children[0], vector = ring.children[0], dashboard = layout.children[1];
  layout.parent = root; ring.parent = layout; vector.parent = ring; dashboard.parent = layout;
  const result = JSON.parse(await run(assetCollectorCode(root.id), root));
  assert.deepEqual({
    x: result.vectors[0].x, y: result.vectors[0].y,
    rootX: result.vectors[0].rootX, rootY: result.vectors[0].rootY,
    coordinateSpace: result.vectors[0].coordinateSpace, rootId: result.vectors[0].rootId,
  }, { x: 0, y: 488, rootX: 0, rootY: 488, coordinateSpace: 'export-root', rootId: 'rot:0' });
});

test('collector and spec export a small vector-only icon INSTANCE at frame bounds', async () => {
  const vector = {
    id: 'icon:2', name: 'Vector', type: 'VECTOR', visible: true,
    width: 20, height: 22, x: 2, y: 1, children: [],
  };
  const icon = {
    id: 'icon:1', name: 'distinguish/m/bell', type: 'INSTANCE', visible: true,
    width: 24, height: 24, x: 0, y: 0, children: [vector],
    getPluginData: (key) => key === 'figma-bridge-design-entity'
      ? JSON.stringify({ version: 1, id: 'icon.bell', kind: 'component' }) : '',
  };
  const root = {
    id: 'icon:0', name: 'Toolbar', type: 'FRAME', visible: true,
    width: 100, height: 40, children: [icon],
  };
  icon.parent = root;
  vector.parent = icon;
  const collected = JSON.parse(await run(assetCollectorCode(root.id), root));
  assert.deepEqual(collected.vectors.map(({ id, name, w, h }) => ({ id, name, w, h })), [{
    id: 'icon:1', name: 'distinguish/m/bell', w: 24, h: 24,
  }]);
  assert.equal(collected.vectors[0].designEntityId, 'icon.bell');

  const lines = specLines({
    t: 'INSTANCE', n: 'distinguish/m/bell', id: 'icon:1', w: 24, h: 24,
    kids: [{ t: 'VECTOR', n: 'Vector', id: 'icon:2', w: 20, h: 22 }],
  }, 0, 'style');
  assert.match(lines[0], /distinguish\/m\/bell · 24×24 · vector art → assets\/distinguish-m-bell\.svg/);
});

test('node walker captures the canonical hash-derived IMAGE filename used by export', async () => {
  const imageNode = {
    id: 'image:1', name: 'Frame 64', type: 'RECTANGLE', visible: true,
    width: 80, height: 80, fills: [{ type: 'IMAGE', imageHash: 'HASH-1', visible: true }],
    strokes: [], effects: [], children: [],
  };
  const figma = {
    mixed: Symbol('mixed'),
    getNodeByIdAsync: async (id) => (id === imageNode.id ? imageNode : null),
    getImageByHash: (hash) => hash === 'HASH-1'
      ? { getBytesAsync: async () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) }
      : null,
  };
  const raw = await new Function('figma', `return ${nodeWalkerCode(imageNode.id, { withIds: true })}`)(figma);
  const capture = JSON.parse(raw);
  assert.deepEqual(capture.frames[0].images, [{ hash: 'HASH-1', file: 'image-hash1.png' }]);
  assert.equal(paintSeg(capture.frames[0]), 'fill IMAGE → assets/image-hash1.png (export assets)');
});

test('node walker cleans float noise and drops inconsistent shared padding bindings', async () => {
  const variable = { id: 'v:1', name: 'space/2xs' };
  const node = {
    id: 'float:1', name: 'Scaled Panel', type: 'FRAME', visible: true,
    width: 100, height: 40, layoutMode: 'VERTICAL', itemSpacing: 0.0000415,
    paddingTop: 4.463, paddingRight: 4.51, paddingBottom: -0.02, paddingLeft: 4.463,
    primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN',
    fills: [], strokes: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0, b: 0 } }],
    strokeWeight: 0.743875, cornerRadius: 1.48777, effects: [], children: [],
    boundVariables: {
      paddingTop: variable, paddingRight: variable, paddingBottom: variable, paddingLeft: variable,
    },
    getCSSAsync: async () => ({ padding: 'var(--space-2xs, 4.463px) var(--space-2xs, 4.510px)' }),
  };
  const figma = {
    mixed: Symbol('mixed'),
    getNodeByIdAsync: async (id) => id === node.id ? node : null,
    variables: { getVariableByIdAsync: async (id) => id === variable.id ? variable : null },
  };
  const capture = JSON.parse(await new Function('figma', `return ${nodeWalkerCode(node.id, { withIds: true, withVars: true })}`)(figma));
  const out = capture.frames[0];
  assert.equal(out.gap, undefined, 'sub-0.05 gap becomes zero and is omitted');
  assert.deepEqual(out.pad, [4.46, 4.51, 0, 4.46]);
  assert.equal(out.sw, 0.74);
  assert.equal(out.r, 1.49);
  assert.equal(out.bv, undefined, 'misleading same-token padding bindings removed');
  assert.equal(out.css.padding, '4.46px 4.51px');
});

test('style cutoff collapses a small SVG subtree instead of exposing vector frontier calls', async () => {
  const vector = { id: 'cut:3', name: 'Vector', type: 'VECTOR', visible: true, width: 16, height: 16, fills: [], strokes: [], effects: [], children: [] };
  const icon = { id: 'cut:2', name: 'interaction/s/link', type: 'GROUP', visible: true, width: 16, height: 16, fills: [], strokes: [], effects: [], children: [vector] };
  const wrapper = { id: 'cut:1', name: 'Button content', type: 'FRAME', visible: true, width: 100, height: 32, layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, fills: [], strokes: [], effects: [], children: [icon] };
  const root = { id: 'cut:0', name: 'Button', type: 'FRAME', visible: true, width: 100, height: 32, fills: [], strokes: [], effects: [], children: [wrapper] };
  wrapper.parent = root; icon.parent = wrapper; vector.parent = icon;
  const figma = { mixed: Symbol('mixed'), getNodeByIdAsync: async (id) => id === root.id ? root : null };
  const capture = JSON.parse(await new Function('figma', `return ${nodeWalkerCode(root.id, { maxDepth: 2, withIds: true })}`)(figma));
  const capturedIcon = capture.frames[0].kids[0].kids[0];
  assert.deepEqual(capturedIcon.vectorAsset, { internalLayers: 1 });
  assert.equal(capturedIcon.frontier, undefined);
  assert.match(specLines(capturedIcon, 0, 'style')[0], /vector art → assets\/interaction-s-link\.svg/);
});

test('byte-fetch snippets are valid JS and target the right ids', () => {
  assert.doesNotThrow(() => new Function(`return ${imageBytesCode('HASH-1')}`));
  assert.doesNotThrow(() => new Function(`return ${svgBytesCode('a:4')}`));
  assert.match(imageBytesCode('HASH-1'), /"HASH-1"/);
  assert.match(svgBytesCode('a:4'), /"a:4"/);
});

// ---- manifest merge ----

test('Manifest v2 preserves a prior filename when a later export proposes different content under the same label', () => {
  const files = new Map();
  const adapter = {
    fileExists: (file) => files.has(file),
    digestForFile: (file, kind) => assetContentDigest(files.get(file), kind),
  };
  const firstBytes = Buffer.from('<svg width="16" height="16"><path fill="red" d="M0 0h16v16z"/></svg>');
  const secondBytes = Buffer.from('<svg width="16" height="16"><path fill="blue" d="M0 0h16v16z"/></svg>');
  const candidate = (sourceIdentity, bytes, nodeId) => ({
    sourceIdentity,
    contentDigest: assetContentDigest(bytes, 'vector'),
    semanticLabel: 'arrow-right-4',
    proposedFile: 'arrow-right-4.svg',
    kind: 'vector',
    bytes,
    placements: [{ nodeId, name: 'Arrow right 4', rootId: `root:${nodeId}` }],
  });

  const first = planAssetExport(null, [candidate('design-entity:icon.arrow-a', firstBytes, 'a:1')],
    { id: 'root:a:1', name: 'First' }, adapter);
  for (const write of first.filesToWrite) files.set(write.file, write.bytes);
  assert.equal(first.manifest.schemaVersion, 2);
  assert.equal(first.manifest.assets[0].file, 'arrow-right-4.svg');

  const second = planAssetExport(first.manifest,
    [candidate('design-entity:icon.arrow-b', secondBytes, 'b:1')],
    { id: 'root:b:1', name: 'Second' }, adapter);
  for (const write of second.filesToWrite) files.set(write.file, write.bytes);
  const byIdentity = new Map(second.manifest.assets.map((asset) => [asset.sourceIdentity, asset]));
  assert.equal(byIdentity.get('design-entity:icon.arrow-a').file, 'arrow-right-4.svg');
  assert.notEqual(byIdentity.get('design-entity:icon.arrow-b').file, 'arrow-right-4.svg');
  assert.match(byIdentity.get('design-entity:icon.arrow-b').file, /^arrow-right-4-[a-f0-9]{8}\.svg$/);
  assert.deepEqual(files.get('arrow-right-4.svg'), firstBytes, 'the original file is never overwritten');

  const repeated = planAssetExport(second.manifest,
    [candidate('design-entity:icon.arrow-b', secondBytes, 'b:1')],
    { id: 'root:b:1', name: 'Second' }, adapter);
  assert.equal(repeated.manifest.assets.find((asset) => asset.sourceIdentity === 'design-entity:icon.arrow-b').file,
    byIdentity.get('design-entity:icon.arrow-b').file, 'the collision decision is stable across runs');
  assert.equal(repeated.filesToWrite.length, 0, 'identical content is reused across runs');
});

test('asset publication refuses to overwrite a reserved filename with different content', async () => {
  const { mkdtempSync, readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'asset-publish-'));
  const original = Buffer.from('original');
  const changed = Buffer.from('changed');
  writeFileSync(join(dir, 'reserved.png'), original);
  const plan = {
    manifest: { schemaVersion: 2, root: '1:1', rootName: 'Frame', roots: [], assets: [] },
    filesToWrite: [{
      file: 'reserved.png',
      bytes: changed,
      kind: 'image',
      contentDigest: assetContentDigest(changed, 'image'),
    }],
  };

  assert.throws(() => publishAssetExportPlan(dir, plan), /refusing to overwrite reserved\.png/);
  assert.deepEqual(readFileSync(join(dir, 'reserved.png')), original);
  assert.equal(existsSync(join(dir, 'assets.json')), false, 'manifest is not published after a failed file phase');
});

test('mergeAssetManifest keeps prior entries whose files exist, replaces re-exported nodes', async () => {
  const { mergeAssetManifest } = await import('../src/lib/asset-manifest.js');
  const prior = {
    root: '12:34', rootName: 'Full Page',
    assets: [
      { nodeId: 'a:1', name: 'hero', file: 'hero.png' },
      { nodeId: 'a:2', name: 'old-card', file: 'old-card.svg' },
      { nodeId: 'a:3', name: 'gone', file: 'deleted.svg' },
    ],
  };
  const next = [{ nodeId: 'a:2', name: 'card', file: 'card.svg' }];
  const merged = mergeAssetManifest(prior, next, { id: '12:35', name: 'Card' },
    (file) => file !== 'deleted.svg');
  assert.deepEqual(merged.assets.map((a) => a.nodeId), ['a:1', 'a:2'], 'kept + replaced, missing file dropped');
  assert.equal(merged.assets.find((a) => a.nodeId === 'a:2').file, 'card.svg', 're-export wins');
  assert.deepEqual(merged.roots, [
    { id: '12:34', name: 'Full Page' },
    { id: '12:35', name: 'Card' },
  ], 'every exported root is recorded');
  assert.equal(merged.root, '12:35');
});

test('mergeAssetManifest without a prior manifest returns just the new export', async () => {
  const { mergeAssetManifest } = await import('../src/lib/asset-manifest.js');
  const merged = mergeAssetManifest(null, [{ nodeId: 'x', name: 'X', file: 'x.svg' }], { id: 'r:1', name: 'R' });
  assert.equal(merged.assets.length, 1);
  assert.deepEqual(merged.roots, [{ id: 'r:1', name: 'R' }]);
});

// ---- spec references ----

test('paintSeg: IMAGE fill points at the deterministic asset file', () => {
  const seg = paintSeg({ n: 'DLS Logo', fills: ['IMAGE'] });
  assert.equal(seg, 'fill IMAGE → assets/dls-logo.png (export assets)');
});

test('paintSeg prefers the canonical hash-derived IMAGE filename from capture', () => {
  const seg = paintSeg({
    n: 'Frame 64', fills: ['IMAGE'],
    images: [{ hash: 'HASH-1', file: 'image-hash1.png' }],
  });
  assert.equal(seg, 'fill IMAGE → assets/image-hash1.png (export assets)');
});

test('NAMING CONTRACT: generic layer names resolve via ancestors in spec AND exporter alike', () => {
  // "Frame 64" (the DLS logo node) must reference dls-logo.png — the same
  // name the exporter derives from the same ancestor chain.
  const seg = paintSeg({ n: 'Frame 64', fills: ['IMAGE'] }, { ancestors: ['content', 'DLS Logo'] });
  assert.equal(seg, 'fill IMAGE → assets/dls-logo.png (export assets)');
  // and through the tree: nested image node inherits the chain automatically
  const tree = {
    t: 'FRAME', n: 'DLS Logo', kids: [
      { t: 'FRAME', n: 'Frame 64', id: 'f:64', w: 80, h: 80, fills: ['IMAGE'] },
    ],
  };
  const lines = specLines(tree, 0, 'style');
  assert.match(lines.join('\n'), /assets\/dls-logo\.png/);
  assert.doesNotMatch(lines.join('\n'), /assets\/frame-64\.png/);
});

test('vector art renders one pointer line — including small glyphs; icon-instance internals stay hidden', () => {
  const big = specLines({ t: 'GROUP', n: 'Background Pattern', id: 'b:1', w: 741, h: 982, kids: [{ t: 'VECTOR', n: 'Vector' }] }, 0, 'style');
  assert.equal(big.length, 1);
  assert.match(big[0], /Background Pattern · 741×982 · vector art → assets\/background-pattern\.svg \(export assets\) · \[b:1\]/);
  const structure = specLines({ t: 'GROUP', n: 'Background Pattern', w: 741, h: 982, kids: [{ t: 'VECTOR', n: 'Vector' }] }, 0, 'structure');
  assert.match(structure[0], /vector art → assets\//);
  assert.doesNotMatch(structure[0], /741×982/);
  // Small glyphs are design (26×34 nav flame, 22×30 speech bubble) — they render.
  const tiny = specLines({ t: 'VECTOR', n: 'Vector', w: 26, h: 34, fills: ['#d5f379'] }, 0, 'style', null, ['navigation step']);
  assert.equal(tiny.length, 1);
  assert.match(tiny[0], /vector art → assets\/navigation-step\.svg/);
  // …but inside an icon INSTANCE the identity is the component name; paths stay hidden.
  const icon = specLines(
    { t: 'INSTANCE', n: 'icon', main: 'calendar', kids: [{ t: 'VECTOR', n: 'Vector', w: 16, h: 16, fills: ['#ffffff'] }] },
    0, 'style',
  );
  assert.equal(icon.length, 1);
  assert.doesNotMatch(icon[0], /vector art/);
});

test('vector art lines carry placement + opacity; paint-less helper shapes stay hidden', () => {
  const art = specLines(
    { t: 'VECTOR', n: 'Vector', id: 'v:1', w: 204, h: 363, abs: { a: 'top-left', x: 159, y: 0 }, op: 0.5, fills: ['#2950a3'] },
    0, 'style', null, ['metric-item'],
  );
  assert.match(art[0], /vector art → assets\/metric-item\.svg \(export assets\) · abs left:159 top:0 · opacity 50% · \[v:1\]/);
  // bounding-box helper without any paint: renders nothing
  assert.deepEqual(specLines({ t: 'RECTANGLE', n: 'Bounds', w: 24, h: 24 }, 0, 'style'), []);
});

test('soft primitives (gradient overlay rectangle) render as regular styled nodes', () => {
  const rect = {
    t: 'RECTANGLE', n: 'Rectangle 28', id: 'r:28', w: 600, h: 600,
    abs: { a: 'top-left', x: 0, y: 0 },
    fills: ['linear-gradient(20deg, #2950a3 0%, #213059@0 100%)'], op: 0.6,
  };
  const lines = specLines(rect, 0, 'style');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Rectangle 28 · 600×600 · abs left:0 top:0 · fill linear-gradient\(20deg, #2950a3 0%, #213059@0 100%\) · opacity 60% · \[r:28\]/);
  assert.doesNotMatch(lines[0], /vector art/, 'a lone rectangle is CSS, not an svg export');
});

test('paintSeg renders clip and rotation', () => {
  assert.equal(paintSeg({ clip: true }), 'clip');
  assert.match(paintSeg({ rot: -12.3 }), /rot -12\.3°/);
});

test('spec cluster parity: a mostly-vector container is ONE line, not per-shape lines', async () => {
  const { isVectorCluster, specModel } = await import('../src/lib/code-spec.js');
  const shapes = Array.from({ length: 20 }, (_, i) => ({ t: 'VECTOR', n: 'Vector', id: `v:${i}`, w: 42, h: 56 }));
  const pattern = { t: 'FRAME', n: 'Background Pattern', id: 'p:2', w: 741, h: 982, kids: [...shapes, { t: 'FRAME', n: 'Tint', id: 'p:9', w: 741, h: 982 }] };
  assert.equal(isVectorCluster(pattern), true);
  const lines = specLines(pattern, 0, 'style');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Background Pattern · 741×982 · vector art ×21 → assets\/background-pattern\.svg/);
  // structured model mirrors it
  const model = specModel({ id: 'r', name: 'X', frames: [pattern] }, { phase: 'style' });
  assert.equal(model.frames[0].vectorArt, 'assets/background-pattern.svg');
  assert.equal(model.frames[0].shapes, 21);
  assert.equal(model.frames[0].kids, undefined, 'shapes are the artwork, not spec nodes');
  // a normal content container is untouched
  assert.equal(isVectorCluster({ t: 'FRAME', n: 'Card', kids: shapes.slice(0, 3) }), false);
});

test('specModel (yaml/json path) emits vector art as pointer nodes instead of dropping them', async () => {
  const { specModel } = await import('../src/lib/code-spec.js');
  const frame = {
    t: 'FRAME', n: 'metric-item', id: 'k:1', w: 363, h: 76, lm: 'HORIZONTAL', gap: 8,
    kids: [
      { t: 'VECTOR', n: 'Vector', id: 'k:2', w: 204, h: 363, abs: { a: 'top-left', x: 159, y: 0 }, op: 0.5, fills: ['#2950a3'] },
      { t: 'TEXT', n: 'Value', id: 'k:3', txt: { chars: '42' } },
    ],
  };
  const model = specModel({ id: 'r', name: 'X', frames: [frame] }, { phase: 'all' });
  const kids = model.frames[0].kids;
  assert.equal(kids.length, 2, 'the deco vector is NOT silently dropped');
  const art = kids.find((k) => k.t === 'VECTOR');
  assert.equal(art.vectorArt, 'assets/metric-item.svg');
  assert.deepEqual(art.abs, { a: 'top-left', x: 159, y: 0 });
  assert.equal(art.op, 0.5);
  // soft gradient rectangle stays a regular styled node in the model too
  const soft = specModel({ id: 'r', name: 'X', frames: [{
    t: 'FRAME', n: 'content', id: 'c:1', kids: [
      { t: 'RECTANGLE', n: 'Rectangle 28', id: 'c:2', w: 600, h: 600, fills: ['linear-gradient(20deg, #2950a3 0%, #213059 100%)'] },
    ],
  }] }, { phase: 'all' });
  const rectNode = soft.frames[0].kids[0];
  assert.equal(rectNode.vectorArt, undefined);
  assert.match(rectNode.style.fills[0], /linear-gradient/);
});

test('footer asset counter: distinct files across art + image fills, dedup by filename', async () => {
  const { countAssetFiles, formatCodeSpec } = await import('../src/lib/code-spec.js');
  const frames = [{
    t: 'FRAME', n: 'screen', id: 's:1', kids: [
      { t: 'GROUP', n: 'Background Pattern', id: 's:2', w: 741, h: 982, kids: [{ t: 'VECTOR', n: 'Vector' }] },
      { t: 'FRAME', n: 'avatar', id: 's:3', w: 40, h: 40, fills: ['IMAGE'] },
      { t: 'FRAME', n: 'avatar', id: 's:4', w: 40, h: 40, fills: ['IMAGE'] }, // same file → counts once
      { t: 'TEXT', n: 'T', id: 's:5', txt: { chars: 'x' } },
    ],
  }];
  const files = countAssetFiles(frames);
  assert.deepEqual([...files].sort(), ['avatar.png', 'background-pattern.svg']);
  const md = formatCodeSpec({ id: 'r', name: 'X', frames }, { phase: 'style' });
  assert.match(md, /references 2 distinct asset file\(s\)/);
  const noAssets = formatCodeSpec({ id: 'r', name: 'X', frames: [{ t: 'FRAME', n: 'plain', id: 'p:1' }] }, { phase: 'style' });
  assert.doesNotMatch(noAssets, /distinct asset file/);
});

test('footer overlay counter: every abs node counts, hidden/helper nodes do not', async () => {
  const { countOverlays, formatCodeSpec } = await import('../src/lib/code-spec.js');
  const frames = [{
    t: 'FRAME', n: 'screen', id: 'o:1', kids: [
      { t: 'RECTANGLE', n: 'Rectangle 28', id: 'o:2', w: 600, h: 600, abs: { a: 'top-left', x: 0, y: 0 }, fills: ['linear-gradient(45deg, #02153b 0%, #0e1425 100%)'] },
      { t: 'VECTOR', n: 'Wave', id: 'o:3', w: 100, h: 40, abs: { a: 'top-left', x: 0, y: 0 }, fills: ['#123456'] },
      { t: 'FRAME', n: 'badge', id: 'o:4', w: 60, h: 24, abs: { a: 'bottom-right', x: 16, y: 16 }, fills: ['#112a5f'], kids: [{ t: 'TEXT', n: 'T', id: 'o:5', txt: { chars: 'x' } }] },
      { t: 'FRAME', n: 'flow', id: 'o:6', w: 100, h: 40, fills: ['#000000'] },
      { t: 'RECTANGLE', n: 'Bounds', id: 'o:7', w: 24, h: 24, abs: { a: 'top-left', x: 0, y: 0 } }, // paint-less helper
      { t: 'FRAME', n: 'ghost', id: 'o:8', hidden: true, abs: { a: 'top-left', x: 0, y: 0 }, fills: ['#ffffff'] },
    ],
  }];
  assert.equal(countOverlays(frames), 3, 'gradient rect + vector art + badge; helper/hidden/flow do not count');
  const md = formatCodeSpec({ id: 'r', name: 'X', frames }, { phase: 'style' });
  assert.match(md, /3 absolutely-positioned overlay\(s\)/);
  assert.match(md, /INCLUDING purely decorative gradient rectangles/);
  const noOverlay = formatCodeSpec({ id: 'r', name: 'X', frames: [{ t: 'FRAME', n: 'plain', id: 'p:1' }] }, { phase: 'style' });
  assert.doesNotMatch(noOverlay, /absolutely-positioned overlay/);
});

test('REGRESSION: standalone soft primitives with gradient/solid fills never become assets', async () => {
  // Exporter side: a lone gradient RECTANGLE (the Rectangle-28 background
  // blob) and a solid ELLIPSE are CSS, not files — collector must skip both.
  const root = {
    id: 'g:1', name: 'content-container', type: 'FRAME', visible: true, width: 1200, height: 800,
    children: [
      {
        id: 'g:2', name: 'Rectangle 28', type: 'RECTANGLE', visible: true, width: 600, height: 600,
        fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [
          { position: 0, color: { r: 0, g: 0.08, b: 0.23, a: 1 } },
          { position: 1, color: { r: 0.05, g: 0.08, b: 0.15, a: 1 } },
        ] }], children: [],
      },
      { id: 'g:3', name: 'Dot', type: 'ELLIPSE', visible: true, width: 12, height: 12,
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], children: [] },
      { id: 'g:4', name: 'Headline', type: 'TEXT', visible: true, width: 200, height: 30, children: [] },
    ],
  };
  const result = JSON.parse(await run(assetCollectorCode('g:1'), root));
  assert.deepEqual(result.vectors, [], 'no soft primitive exports as SVG');
  assert.deepEqual(result.images, [], 'gradient fills are not image fills');
  // Spec side: both render as styled nodes, and the footer counts no assets.
  const { countAssetFiles } = await import('../src/lib/code-spec.js');
  const frames = [{ t: 'FRAME', n: 'content-container', id: 'g:1', kids: [
    { t: 'RECTANGLE', n: 'Rectangle 28', id: 'g:2', w: 600, h: 600, fills: ['linear-gradient(45deg, #02153b 0%, #0e1425 100%)'] },
    { t: 'ELLIPSE', n: 'Dot', id: 'g:3', w: 12, h: 12, fills: ['#ffffff'] },
    { t: 'TEXT', n: 'Headline', id: 'g:4', txt: { chars: 'x' } },
  ] }];
  assert.equal(countAssetFiles(frames).size, 0);
  const lines = specLines(frames[0], 0, 'style');
  assert.match(lines.join('\n'), /Rectangle 28 · 600×600 · fill linear-gradient/);
  assert.doesNotMatch(lines.join('\n'), /vector art/);
});

test('image nodes with different names never share a style bundle', () => {
  const a = { n: 'dls-logo', fills: ['IMAGE'], r: 8 };
  const b = { n: 'card-artwork', fills: ['IMAGE'], r: 8 };
  assert.notEqual(bundleKey(a), bundleKey(b));
  assert.equal(styleFields(a).asset, 'dls-logo');
  // non-image nodes are unaffected
  assert.equal(styleFields({ n: 'X', fills: ['#ffffff'] }).asset, undefined);
});
