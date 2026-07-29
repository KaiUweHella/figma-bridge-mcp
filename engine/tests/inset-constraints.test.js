// Constraint semantics for overlays (semantic regression): an overlay
// covering its parent edge-to-edge must be spec'd as `inset:0` (size WITH the
// parent), not pinned top-left with fixed numbers — the profile-card
// background SVG case (12:34 in a w:fill instance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWalkerCode } from '../src/design-extract.js';
import { absSeg, specLines, specModel, formatCodeSpec } from '../src/lib/code-spec.js';

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (root) =>
  new Function('figma', `return ${nodeWalkerCode(root.id)}`)(stubFigma(root));

/** profile-card fixture: card + background vector spanning it edge-to-edge. */
const cardFixture = () => {
  const card = {
    id: 'c:1', name: 'profile-card', type: 'FRAME', visible: true,
    width: 199, height: 116, layoutMode: 'VERTICAL', clipsContent: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 199, height: 116 },
    children: [],
  };
  const bg = {
    id: 'c:2', name: 'Vector', type: 'VECTOR', visible: true,
    width: 201, height: 116, x: 0, y: 2, layoutPositioning: 'ABSOLUTE',
    constraints: { horizontal: 'STRETCH', vertical: 'STRETCH' },
    absoluteBoundingBox: { x: 0, y: 2, width: 201, height: 116 },
    absoluteRenderBounds: { x: 0, y: 2, width: 201, height: 114 },
    fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.3 } }],
    children: [], parent: card,
  };
  const text = {
    id: 'c:3', name: 'Name', type: 'TEXT', visible: true, width: 100, height: 20,
    x: 16, y: 16, characters: 'Robert Meyer',
    fontName: { family: 'Geist', style: 'SemiBold' }, fontSize: 16,
    children: [], parent: card,
  };
  card.children = [bg, text];
  return card;
};

test('walker: edge-to-edge overlays get abs.inset (±2px tolerance)', async () => {
  const result = JSON.parse(await runWalker(cardFixture()));
  const bg = result.frames[0].kids[0];
  assert.equal(bg.abs.inset, true);
});

test('walker: inset judges the RENDERED box — clipped geometry overhang still counts as fill', async () => {
  // rotated deco wave: geometry box spills far below the card (clipped),
  // but every drawn pixel covers the card edge-to-edge → inset, no ov.
  const card = cardFixture();
  card.children[0].absoluteBoundingBox = { x: 0, y: 2, width: 201, height: 198 };
  const result = JSON.parse(await runWalker(card));
  const bg = result.frames[0].kids[0];
  assert.equal(bg.abs.inset, true, 'render bounds fill the card');
  assert.equal(bg.ov, undefined, 'no overhang flag for an inset fill');
});

test('walker: a small corner badge does NOT get inset', async () => {
  const card = cardFixture();
  card.children[0].absoluteBoundingBox = { x: 10, y: 10, width: 60, height: 24 };
  card.children[0].absoluteRenderBounds = { x: 10, y: 10, width: 60, height: 24 };
  const result = JSON.parse(await runWalker(card));
  assert.equal(result.frames[0].kids[0].abs.inset, undefined);
});

test('absSeg: inset wins; scale anchors carry the proportional hint', () => {
  assert.equal(absSeg({ a: 'stretch-stretch', x: 0, y: 2, inset: true }),
    'abs inset:0 (fills parent — size with it)');
  assert.match(absSeg({ a: 'scale-scale', x: 10, y: 10 }), /scales with parent — keep proportional/);
  assert.doesNotMatch(absSeg({ a: 'top-left', x: 10, y: 10 }), /scales/);
});

test('vector art line: inset place instead of fixed offsets; MAX anchors say pinned', async () => {
  const result = JSON.parse(await runWalker(cardFixture()));
  const text = formatCodeSpec(result, { phase: 'style' });
  assert.match(text, /place inset:0 \(fills parent — the svg stretches with it, width\/height 100%\)/);
  assert.doesNotMatch(text, /place left:0 top:2/);
  // MAX-anchored artwork: fixed offsets + pin note
  const pinned = specLines({
    t: 'VECTOR', n: 'Wave', id: 'p:1', w: 100, h: 40,
    abs: { a: 'bottom-right', x: 4, y: 4 }, rb: { x: 200, y: 60, w: 100, h: 40 },
    fills: ['#123456'],
  }, 0, 'style', null, ['card'])[0];
  assert.match(pinned, /place left:200 top:60 in parent \(design pins it to the right\+bottom edge — keep that on resize\)/);
});

test('yaml/json model: inset place rides along', async () => {
  const result = JSON.parse(await runWalker(cardFixture()));
  const model = specModel(result, { phase: 'all' });
  const bg = model.frames[0].kids[0];
  assert.deepEqual(bg.place, { inset: 0 });
  assert.equal(bg.abs.inset, true);
});
