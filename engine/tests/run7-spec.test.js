// Run-7 report fixes: transparent frames over abs overlays are marked
// (fill:none + footer visibility relations), and gradient-stroke screens get
// READY-MADE CSS instead of a prose pattern hint. Modeled on the
// rightsholder_inactive_show run: the background pattern behind the fill-less
// menu vanished, and the main-container gradient border "looked off".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  specLines, formatCodeSpec, specModel,
  overlayVisibility, gradientStrokeSpecimens, gradientBorderCss,
} from '../src/lib/code-spec.js';
import { sectionFinderCode } from '../src/design-extract.js';

// The Run-7 shape: decorative abs pattern first (bottom of z-order), then a
// fill-less menu frame over it, then an opaque content frame.
const screen = () => ({
  id: 'r:1',
  frames: [{
    t: 'FRAME', n: 'Screen', id: 'f:1', w: 1512, h: 2320, lm: 'HORIZONTAL',
    kids: [
      {
        t: 'RECTANGLE', n: 'Background Pattern', id: 'f:2', w: 741, h: 982,
        abs: { a: 'top-left', x: 0, y: 0 }, fills: ['#0e1425'],
      },
      {
        t: 'FRAME', n: 'menu', id: 'f:3', w: 300, h: 2320, lm: 'VERTICAL',
        kids: [{ t: 'TEXT', n: 'Home', id: 'f:4', w: 100, h: 20, txt: { chars: 'Home' } }],
      },
      {
        t: 'FRAME', n: 'content', id: 'f:5', w: 1212, h: 2320, lm: 'VERTICAL',
        fills: ['#ffffff'],
        kids: [{ t: 'TEXT', n: 'Title', id: 'f:6', w: 100, h: 20, txt: { chars: 'Title' } }],
      },
    ],
  }],
  name: 'Screen',
});

test('fill-less frame over an abs overlay carries the fill:none note (style phase)', () => {
  const lines = specLines(screen().frames[0], 0, 'style').join('\n');
  assert.match(lines, /menu[^\n]*fill:none \(transparent — "Background Pattern" behind it stays visible through this frame; do NOT give it an opaque background\)/);
  // The opaque sibling gets NO note — it has its own fill.
  assert.doesNotMatch(lines, /content[^\n]*fill:none/);
});

test('no fill:none note without an abs overlay behind, and none in structure phase', () => {
  const s = screen();
  s.frames[0].kids.shift(); // drop the pattern — menu is now just a normal wrapper
  assert.doesNotMatch(specLines(s.frames[0], 0, 'style').join('\n'), /fill:none/);
  assert.doesNotMatch(specLines(screen().frames[0], 0, 'structure').join('\n'), /fill:none/);
});

test('overlayVisibility: overlay → later fill-less container siblings', () => {
  assert.deepEqual(overlayVisibility(screen().frames), [
    { overlay: 'Background Pattern', through: ['menu'] },
  ]);
});

test('footer names the visibility relation next to the overlay checklist', () => {
  const md = formatCodeSpec(screen(), { phase: 'style' });
  assert.match(md, /Overlay "Background Pattern" stays visible through "menu" — that sibling has NO fill in the design \(transparent\)/);
});

test('specModel carries seeThrough on the transparent frame', () => {
  const model = specModel(screen(), { phase: 'style' });
  const menu = model.frames[0].kids.find((k) => k.n === 'menu');
  assert.deepEqual(menu.seeThrough, ['Background Pattern']);
  const content = model.frames[0].kids.find((k) => k.n === 'content');
  assert.equal(content.seeThrough, undefined);
});

// ── gradient-stroke: ready-made CSS ──

const gradientScreen = () => ({
  id: 'r:2',
  frames: [{
    t: 'FRAME', n: 'Root', id: 'g:1', w: 1512, h: 2320,
    kids: [{
      t: 'FRAME', n: 'content-container', id: 'g:2', w: 1212, h: 2320,
      strokes: ['linear-gradient(20deg, #2950a3 0%, #213059 100%)'],
      sw: [1, 0, 0, 1], r: [24, 0, 0, 0],
      kids: [{ t: 'TEXT', n: 'T', id: 'g:3', w: 10, h: 10, txt: { chars: 'T' } }],
    }],
  }],
  name: 'Root',
});

test('gradientStrokeSpecimens: one specimen per unique gradient/width/radius combo', () => {
  const specs = gradientStrokeSpecimens(gradientScreen().frames);
  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0], {
    n: 'content-container',
    gradient: 'linear-gradient(20deg, #2950a3 0%, #213059 100%)',
    sw: [1, 0, 0, 1],
    r: [24, 0, 0, 0],
  });
});

test('gradientBorderCss: per-side widths become padding, radius is real', () => {
  const css = gradientBorderCss(gradientStrokeSpecimens(gradientScreen().frames)[0], 'gradient-border-1');
  assert.match(css, /border-radius: 24px 0 0 0/);
  assert.match(css, /padding: 1px 0 0 1px/);
  assert.match(css, /background: linear-gradient\(20deg, #2950a3 0%, #213059 100%\)/);
  assert.match(css, /mask-composite: exclude/);
});

// ── --section: resolve a named child section without copying its id ──

const runFinder = (root, want) => {
  const stub = { getNodeByIdAsync: async (id) => (id === root.id ? root : null) };
  return new Function('figma', `return ${sectionFinderCode(root.id, want)}`)(stub)
    .then((s) => JSON.parse(s));
};

test('sectionFinder: exact name beats substring, BFS prefers the shallow hit', async () => {
  const root = {
    id: 'r:1', name: 'Screen',
    children: [
      { id: 'c:1', name: 'Navigation Container', children: [
        { id: 'c:2', name: 'Navigation', children: [] },
      ] },
      { id: 'c:3', name: 'Navigation', children: [] },
    ],
  };
  // exact match wins over the earlier substring hit…
  const hit = await runFinder(root, 'navigation');
  assert.equal(hit.id, 'c:3', 'shallow exact match');
  assert.equal(hit.matches, 3);
  // …and a pure substring query takes the shallowest hit
  assert.equal((await runFinder(root, 'container')).id, 'c:1');
});

test('sectionFinder: invisible nodes are skipped, misses explain themselves', async () => {
  const root = {
    id: 'r:1', name: 'Screen',
    children: [{ id: 'c:1', name: 'Sidebar', visible: false, children: [] }],
  };
  const miss = await runFinder(root, 'sidebar');
  assert.match(miss.error, /no node named like "sidebar"/);
  assert.match(miss.error, /structure spec/);
});

test('footer emits the ready-made CSS block for gradient-stroke screens', () => {
  const md = formatCodeSpec(gradientScreen(), { phase: 'style' });
  assert.match(md, /```css\n\/\* content-container — gradient stroke w1\/0\/0\/1, radius 24\/0\/0\/0 \*\//);
  assert.match(md, /Use the ready-made pseudo-element pattern below VERBATIM/);
  // and no ready-made block on screens without gradient strokes
  assert.doesNotMatch(formatCodeSpec(screen(), { phase: 'style' }), /```css/);
});
