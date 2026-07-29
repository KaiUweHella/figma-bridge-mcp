// Rendered-bounds pipeline (rendered-bounds regression): rotated/transformed
// vector art must be spec'd with the dimensions and offsets of the file
// `export assets` actually writes — not the pre-rotation node box. Modeled on
// the metric-item wave (12:34): node 204×363 rotated -90°, exported SVG
// 363×76, parent 363×76 with clipsContent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWalkerCode, assetCollectorCode } from '../src/design-extract.js';
import { specLines, specModel, absSeg, formatCodeSpec } from '../src/lib/code-spec.js';

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (code, root) => new Function('figma', `return ${code}`)(stubFigma(root));

/** metric-item fixture: clipping card + rotated deco wave + text. */
const kennzahlFixture = () => {
  const card = {
    id: 'k:1', name: 'metric-item', type: 'FRAME', visible: true,
    width: 363, height: 76, layoutMode: 'VERTICAL', clipsContent: true,
    absoluteBoundingBox: { x: 100, y: 200, width: 363, height: 76 },
    children: [],
  };
  const wave = {
    id: 'k:2', name: 'Vector', type: 'VECTOR', visible: true,
    width: 204, height: 363, x: 0, y: -64, rotation: -90,
    layoutPositioning: 'ABSOLUTE',
    constraints: { horizontal: 'STRETCH', vertical: 'CENTER' },
    // geometry box post-rotation: 363×204 starting 64px above the card
    absoluteBoundingBox: { x: 100, y: 136, width: 363, height: 204 },
    // actually drawn pixels: exactly the card area — matches the exported SVG
    absoluteRenderBounds: { x: 100, y: 200, width: 363, height: 76 },
    fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.15, b: 0.27 } }],
    children: [], parent: card,
  };
  const label = {
    id: 'k:3', name: 'Label', type: 'TEXT', visible: true, width: 145, height: 14,
    x: 16, y: 16, characters: 'Example agency',
    fontName: { family: 'Geist', style: 'Medium' }, fontSize: 14,
    children: [], parent: card,
  };
  card.children = [wave, label];
  return card;
};

test('walker: rotated vector carries the RENDERED box (rb), not pre-rotation w/h', async () => {
  const result = JSON.parse(await runWalker(nodeWalkerCode('k:1'), kennzahlFixture()));
  const wave = result.frames[0].kids[0];
  assert.deepEqual(wave.rb, { x: 0, y: 0, w: 363, h: 76 }, 'render bounds relative to parent');
  assert.equal(wave.w, 204, 'node box stays available');
  assert.equal(wave.rot, -90);
});

test('walker: abs offsets are post-transform; stretch pins both edges', async () => {
  const result = JSON.parse(await runWalker(nodeWalkerCode('k:1'), kennzahlFixture()));
  const wave = result.frames[0].kids[0];
  // geometry box: x 0..363, y -64..140 → left:0 top:-64, stretch → right:0
  assert.equal(wave.abs.a, 'center-stretch');
  assert.equal(wave.abs.x, 0);
  assert.equal(wave.abs.y, -64);
  assert.equal(wave.abs.r, 0, 'stretch emits the far edge too');
});

test('walker: overhang uses the rendered box — fully drawn-inside art gets NO flag', async () => {
  const result = JSON.parse(await runWalker(nodeWalkerCode('k:1'), kennzahlFixture()));
  const wave = result.frames[0].kids[0];
  // geometry overhangs (y -64) but every drawn pixel is inside → no marker
  assert.equal(wave.ov, undefined);
});

test('walker: drawn-outside overlay is flagged over/clip by parent clipsContent', async () => {
  const make = (clips) => {
    const parent = {
      id: 'f:1', name: 'nav-step', type: 'FRAME', visible: true,
      width: 118, height: 36, layoutMode: 'HORIZONTAL', clipsContent: clips,
      absoluteBoundingBox: { x: 0, y: 0, width: 118, height: 36 },
      children: [],
    };
    const flame = {
      id: 'f:2', name: 'Vector', type: 'VECTOR', visible: true,
      width: 26, height: 34, x: -13, y: 0, layoutPositioning: 'ABSOLUTE',
      constraints: { horizontal: 'MIN', vertical: 'CENTER' },
      absoluteBoundingBox: { x: -13, y: 1, width: 26, height: 34 },
      absoluteRenderBounds: { x: -13, y: 1, width: 26, height: 34 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
      children: [], parent,
    };
    parent.children = [flame];
    return parent;
  };
  const open = JSON.parse(await runWalker(nodeWalkerCode('f:1'), make(false)));
  assert.equal(open.frames[0].kids[0].ov, 'over', 'no clip → visible by design');
  assert.deepEqual(open.frames[0].kids[0].abs, { a: 'center-left', x: -13, y: 1 });
  const clipped = JSON.parse(await runWalker(nodeWalkerCode('f:1'), make(true)));
  assert.equal(clipped.frames[0].kids[0].ov, 'clip', 'clip → parent cuts the excess');
});

test('spec text: vector art line uses rendered size + inset place, matching the exported file', async () => {
  const result = JSON.parse(await runWalker(nodeWalkerCode('k:1'), kennzahlFixture()));
  const text = formatCodeSpec(result, { phase: 'style' });
  // the wave fills the card edge-to-edge → inset, not a fixed top-left pin
  assert.match(text, /Vector · 363×76 · vector art → assets\/metric-item\.svg \(export assets\) · place inset:0 \(fills parent/,
    'rendered numbers + inset, not 204×363 / top:-64');
  assert.doesNotMatch(text, /204×363/);
});

test('spec text: overhanging art carries the do-not-drop marker', () => {
  const flame = {
    t: 'VECTOR', n: 'Vector', id: 'f:2', w: 26, h: 34,
    abs: { a: 'center-left', x: -13, y: 1 }, rb: { x: -13, y: 1, w: 26, h: 34 },
    ov: 'over', fills: ['#a75fff'],
  };
  const line = specLines(flame, 0, 'style', null, ['navigation step'])[0];
  assert.match(line, /place left:-13 top:1 in parent/);
  assert.match(line, /overhangs parent — visible by design, do not drop or resize/);
});

test('spec model (yaml/json): art nodes carry rendered w/h, place and overhang', async () => {
  const result = JSON.parse(await runWalker(nodeWalkerCode('k:1'), kennzahlFixture()));
  const model = specModel(result, { phase: 'all' });
  const art = model.frames[0].kids.find((k) => k.vectorArt);
  assert.equal(art.w, 363);
  assert.equal(art.h, 76);
  assert.deepEqual(art.place, { inset: 0 }, 'edge-to-edge artwork sizes with its parent');
  const flagged = specModel({ id: 'r', name: 'X', frames: [{
    t: 'FRAME', n: 'nav', id: 'n:1', kids: [
      { t: 'VECTOR', n: 'Vector', id: 'n:2', w: 26, h: 34, ov: 'over', fills: ['#fff'] },
      { t: 'TEXT', n: 'Label', id: 'n:3', txt: { chars: 'Owner' } },
    ],
  }] }, { phase: 'all' });
  assert.equal(flagged.frames[0].kids[0].overhang, 'visible-by-design');
});

test('absSeg: css-ready output for every anchor family', () => {
  assert.equal(absSeg({ a: 'top-left', x: 10, y: 10 }), 'abs left:10 top:10');
  assert.equal(absSeg({ a: 'bottom-right', x: 16, y: 16 }), 'abs right:16 bottom:16');
  assert.equal(absSeg({ a: 'center-center', x: 5, y: 6 }), 'abs left:5 top:6');
  assert.equal(absSeg({ a: 'stretch-stretch', x: 0, y: 2, r: 4, b: 6 }), 'abs left:0 right:4 top:2 bottom:6');
});

test('collector: vector entries carry rendered w/h and parent-relative x/y', async () => {
  const parent = {
    id: 'a:1', name: 'card', type: 'FRAME', visible: true, width: 363, height: 76,
    absoluteBoundingBox: { x: 100, y: 200, width: 363, height: 76 },
    children: [],
  };
  const wave = {
    id: 'a:2', name: 'Vector', type: 'VECTOR', visible: true, width: 204, height: 363,
    absoluteBoundingBox: { x: 100, y: 136, width: 363, height: 204 },
    absoluteRenderBounds: { x: 100, y: 200, width: 363, height: 76 },
    children: [], parent,
  };
  parent.children = [wave];
  const stub = { mixed: Symbol('m'), getNodeByIdAsync: async (id) => (id === 'a:1' ? parent : null) };
  const result = JSON.parse(await new Function('figma', `return ${assetCollectorCode('a:1')}`)(stub));
  assert.equal(result.vectors.length, 1);
  const v = result.vectors[0];
  assert.equal(v.w, 363, 'rendered width');
  assert.equal(v.h, 76, 'rendered height');
  assert.equal(v.x, 0, 'offset relative to parent');
  assert.equal(v.y, 0);
});
