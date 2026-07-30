// M3: layout semantics (abs positioning, gradients, dash) + instance
// props-diff grouping. The grouping tests exercise the veto rules hard —
// losing a real visual difference is the failure mode that matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkerCode, nodeWalkerCode } from '../src/design-extract.js';
import { gradientTransformFromCssAngle } from '../src/lib/paint-css.js';
import {
  layoutSeg, paintSeg, instanceDiff, groupInstanceSiblings, specLines,
  formatCodeSpec, newDedupCtx,
} from '../src/lib/code-spec.js';

// ---- 2.4 absolute positioning ----

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (code, root) => new Function('figma', `return ${code}`)(stubFigma(root));

test('walker captures ABSOLUTE overlays with anchor + edge offsets', async () => {
  const parent = {
    id: '9:1', name: 'Panel', type: 'FRAME', width: 400, height: 300, visible: true,
    layoutMode: 'VERTICAL', children: [],
  };
  const badge = {
    id: '9:2', name: 'Corner Badge', type: 'FRAME', width: 60, height: 24, visible: true,
    layoutPositioning: 'ABSOLUTE', x: 324, y: 260,
    constraints: { horizontal: 'MAX', vertical: 'MAX' }, children: [], parent,
  };
  const flow = { id: '9:3', name: 'Flow Child', type: 'FRAME', width: 100, height: 40, visible: true, x: 0, y: 0, children: [], parent };
  parent.children = [flow, badge];
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1'), parent));
  const [flowOut, badgeOut] = result.frames[0].kids;
  assert.equal(flowOut.abs, undefined, 'flow children carry no abs');
  assert.deepEqual(badgeOut.abs, { a: 'bottom-right', x: 16, y: 16 }, 'offsets measured from anchored edges');
});

test('walker positions EVERY child of a non-auto-layout frame (Background Pattern case)', async () => {
  const parent = {
    id: '8:1', name: 'Canvas', type: 'FRAME', width: 1440, height: 1024, visible: true,
    layoutMode: 'NONE', children: [],
  };
  const pattern = {
    id: '8:2', name: 'Background Pattern', type: 'FRAME', width: 741, height: 982, visible: true,
    x: 120, y: 30, opacity: 0.4, children: [], parent,
  };
  parent.children = [pattern];
  const result = JSON.parse(await runWalker(nodeWalkerCode('8:1'), parent));
  const out = result.frames[0].kids[0];
  assert.deepEqual(out.abs, { a: 'top-left', x: 120, y: 30 }, 'free children carry abs from constraints');
  assert.equal(out.op, 0.4, 'layer opacity is captured');
});

test('walker captures clipsContent and rotation', async () => {
  const root = {
    id: '8:9', name: 'card-image', type: 'FRAME', width: 561, height: 300, visible: true,
    clipsContent: true, rotation: -12.34, children: [],
  };
  const result = JSON.parse(await runWalker(nodeWalkerCode('8:9'), root));
  assert.equal(result.frames[0].clip, true);
  assert.equal(result.frames[0].rot, -12.3);
});

test('layoutSeg renders abs before flow detail, in both phases', () => {
  const node = { abs: { a: 'bottom-right', x: 16, y: 16 }, lm: 'HORIZONTAL', gap: 8 };
  assert.equal(layoutSeg(node, { detail: false }), 'row abs right:16 bottom:16');
  assert.match(layoutSeg(node, { detail: true }), /^row abs right:16 bottom:16 gap8/);
  // center anchors count from left/top (directly buildable), stretch pins both edges
  assert.equal(layoutSeg({ abs: { a: 'center-left', x: -13, y: 0 } }, { detail: false }), 'abs left:-13 top:0');
  assert.equal(layoutSeg({ abs: { a: 'center-stretch', x: 0, y: -64, r: 0 } }, { detail: false }), 'abs left:0 right:0 top:-64');
});

// ---- 2.5 gradients ----

test('walker emits css-ready gradients with stops instead of bare type names', async () => {
  const root = {
    id: '9:1', name: 'G', type: 'FRAME', width: 100, height: 100, visible: true, children: [],
    fills: [{
      type: 'GRADIENT_LINEAR',
      gradientStops: [
        { position: 0, color: { r: 0x21 / 255, g: 0x30 / 255, b: 0x59 / 255, a: 1 } },
        { position: 1, color: { r: 0x13 / 255, g: 0x1c / 255, b: 0x34 / 255, a: 0.5 } },
      ],
      // shared writer (lib/paint-css.js): the reader must round-trip it
      gradientTransform: gradientTransformFromCssAngle(135),
    }],
  };
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1'), root));
  const fill = result.frames[0].fills[0];
  assert.equal(fill, 'linear-gradient(135deg, #213059 0%, #131c34@50 100%)');
});

test('radial/angular gradients carry stops without an angle; unknown paints stay type names', async () => {
  const root = {
    id: '9:1', name: 'G', type: 'FRAME', width: 10, height: 10, visible: true, children: [],
    fills: [
      { type: 'GRADIENT_RADIAL', gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }] },
      { type: 'IMAGE' },
    ],
  };
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1'), root));
  assert.deepEqual(result.frames[0].fills, ['radial-gradient(#ffffff 0%, #000000 100%)', 'IMAGE']);
});

// ---- 2.6 dash pattern ----

test('walker captures dashPattern; paintSeg renders it on the stroke', async () => {
  const root = {
    id: '9:1', name: 'D', type: 'FRAME', width: 10, height: 10, visible: true, children: [],
    strokes: [{ type: 'SOLID', color: { r: 0x7b / 255, g: 0x8e / 255, b: 0xb7 / 255 } }],
    strokeWeight: 1, dashPattern: [4, 4],
  };
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1'), root));
  assert.deepEqual(result.frames[0].dash, [4, 4]);
  const seg = paintSeg(result.frames[0]);
  assert.match(seg, /stroke #7b8eb7 w1 dash\[4,4\]/);
});

test('solid strokes without dashPattern render unchanged', () => {
  const seg = paintSeg({ strokes: ['#7b8eb7'], sw: 1 });
  assert.equal(seg, 'stroke #7b8eb7 w1');
});

// ---- 2.3 instance props-diff grouping ----

const TXT_STYLE = { font: 'Clash Grotesk', style: 'Semi Bold', size: 32 };
const rechtCard = (id, title, channels, badgeVariant, badgeLabel) => ({
  t: 'INSTANCE', n: 'recht-small', id, w: 561, h: 416,
  mc: 'recht-small', main: 'is active=false', set: 'recht-small',
  props: { Title: title, Channels: channels, 'is active': false },
  kids: [
    { t: 'TEXT', n: 'Title', id: `${id}t`, w: 300, h: 34, fills: ['#f5f7f8'], txt: { chars: title, ...TXT_STYLE } },
    { t: 'TEXT', n: 'Channels', id: `${id}c`, w: 300, h: 20, fills: ['#9aacd6'], txt: { chars: channels, font: 'Geist', style: 'Regular', size: 14 } },
    {
      t: 'INSTANCE', n: 'badge', id: `${id}b`, w: 80, h: 24, mc: 'badge', main: `state=${badgeVariant}`,
      set: 'badge', props: { state: badgeVariant },
      kids: [{ t: 'TEXT', n: 'Label', id: `${id}bl`, w: 60, h: 14, fills: ['#f8b16e'], txt: { chars: badgeLabel, font: 'Geist', style: 'Medium', size: 12 } }],
    },
  ],
});

const CARDS = [
  rechtCard('c1', 'DLS Rechte', 'TV • Amazon Prime', 'default', 'Aktiv'),
  rechtCard('c2', 'FC Bayern Munich', 'TV • Amazon Prime • DAZN', 'attention', 'Deaktiviert'),
  rechtCard('c3', 'Schalke 04', 'TV • YouTube • Sky Sports', 'draft', 'Entwurf'),
];

test('instanceDiff: prop-driven diffs come out key-by-key, prop-driven texts are not doubled', () => {
  const d = instanceDiff(CARDS[0], CARDS[1]);
  assert.ok(d, 'must be groupable');
  assert.equal(d.Title, 'FC Bayern Munich');
  assert.equal(d.Channels, 'TV • Amazon Prime • DAZN');
  // Title/Channels TEXT nodes carry the same values as the props — no doubles:
  assert.equal(Object.keys(d).filter((k) => d[k] === '"FC Bayern Munich"').length, 0);
  // nested badge variant swap recorded compactly, internals not walked
  assert.match(d.badge, /state=attention/);
  assert.equal(d.Label, undefined, 'badge-internal label is covered by the swap');
});

test('instanceDiff vetoes on style differences (nothing visual may vanish silently)', () => {
  const odd = rechtCard('c9', 'X', 'Y', 'default', 'Aktiv');
  odd.kids[0].fills = ['#ff0000']; // same chars possible, different color
  assert.equal(instanceDiff(CARDS[0], odd), null);
});

test('instanceDiff vetoes on structural differences', () => {
  const odd = rechtCard('c9', 'X', 'Y', 'default', 'Aktiv');
  odd.kids.push({ t: 'FRAME', n: 'Extra', id: 'e', w: 10, h: 10 });
  assert.equal(instanceDiff(CARDS[0], odd), null);
});

test('groupInstanceSiblings groups consecutive same-main instances, keeps others apart', () => {
  const stranger = { t: 'FRAME', n: 'Divider', id: 'd1', w: 500, h: 1 };
  const out = groupInstanceSiblings([...CARDS, stranger]);
  assert.equal(out.length, 3, 'base + diff group + stranger');
  assert.equal(out[0].id, 'c1');
  assert.equal(out[1].__diffGroup.variants.length, 2);
  assert.equal(out[2].n, 'Divider');
});

test('groupInstanceSiblings: leaf instances and non-consecutive runs stay untouched', () => {
  const leaf = (id) => ({ t: 'INSTANCE', n: 'icon', id, mc: 'Icon', main: 'Icon=leaf', kids: [] });
  assert.equal(groupInstanceSiblings([leaf('a'), leaf('b')]).length, 2);
  const gap = { t: 'FRAME', n: 'Gap', id: 'g' };
  const out = groupInstanceSiblings([CARDS[0], gap, CARDS[1]]);
  assert.equal(out.length, 3, 'non-consecutive instances are not grouped across the gap');
});

test('specLines renders the diff group as ↻ rows with ids; --no-dedup path expands fully', () => {
  const frames = [{ t: 'FRAME', n: 'List', id: 'l', w: 600, h: 900, lm: 'VERTICAL', gap: 16, kids: CARDS }];
  const result = { id: 'r', name: 'Test Document', frames };

  const deduped = formatCodeSpec(result, { phase: 'all' });
  assert.match(deduped, /↻ ×2 more recht-small — same structure as above, only:/);
  assert.match(deduped, /Title: FC Bayern Munich/);
  assert.match(deduped, /badge: state=attention/);
  assert.match(deduped, /\[c2\]/, 'variant ids survive for export node targeting');
  assert.match(deduped, /Build them as a loop/);
  // full subtree of card 2 must NOT be rendered
  assert.doesNotMatch(deduped, /"FC Bayern Munich" · \d+×\d+/);

  const plain = formatCodeSpec(result, { phase: 'all', dedup: false });
  assert.doesNotMatch(plain, /↻/);
  // Card 3 fully expanded in both sections: its title shows up twice per
  // section (instance-prop list + the TEXT child) → 4 total.
  assert.equal((plain.match(/Schalke 04/g) || []).length, 4, 'structure + style section each render card 3 fully');
});

test('diff grouping also collapses the structure section', () => {
  const frames = [{ t: 'FRAME', n: 'List', id: 'l', kids: CARDS }];
  const md = formatCodeSpec({ id: 'r', name: 'X', frames }, { phase: 'structure' });
  assert.match(md, /↻ ×2 more recht-small/);
  // structure diff rows carry no node-id suffix
  const diffRow = md.split('\n').find((l) => l.includes('FC Bayern Munich'));
  assert.doesNotMatch(diffRow, /\[c2\]/);
});
