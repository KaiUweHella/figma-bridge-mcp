// GRID auto-layout (semantic regression): the sidebar/topbar/main shell
// of fixture grid is a Figma grid. The walker used to know only
// HORIZONTAL/VERTICAL, mislabeled grids as `col` and gave the children no
// positions at all — the builder had to guess the shell and collapsed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWalkerCode } from '../src/design-extract.js';
import { layoutSeg, cellSeg, specLines, specModel, formatCodeSpec, newDedupCtx } from '../src/lib/code-spec.js';

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (root) =>
  new Function('figma', `return ${nodeWalkerCode(root.id)}`)(stubFigma(root));

/** Shell fixture: 2×2 grid — sidebar spans both rows, topbar + main right. */
const shellFixture = ({ withGridProps = true } = {}) => {
  const root = {
    id: 'g:1', name: 'fixture grid', type: 'FRAME', visible: true,
    width: 1512, height: 2320, layoutMode: 'GRID',
    absoluteBoundingBox: { x: 0, y: 0, width: 1512, height: 2320 },
    children: [],
  };
  if (withGridProps) {
    root.gridRowCount = 2; root.gridColumnCount = 2;
    root.gridRowGap = 0; root.gridColumnGap = 2;
  }
  const child = (id, name, x, y, w, h, cell) => ({
    id, name, type: 'FRAME', visible: true, width: w, height: h, x, y,
    constraints: { horizontal: 'MIN', vertical: 'MIN' },
    absoluteBoundingBox: { x, y, width: w, height: h },
    children: [], parent: root,
    ...(withGridProps && cell ? cell : {}),
  });
  root.children = [
    child('g:2', 'menu', 0, 0, 260, 982, { gridRowAnchorIndex: 0, gridColumnAnchorIndex: 0, gridRowSpan: 2 }),
    child('g:3', 'Navigation Container', 260, 0, 1250, 98, { gridRowAnchorIndex: 0, gridColumnAnchorIndex: 1 }),
    child('g:4', 'content-container', 260, 98, 1250, 2220, { gridRowAnchorIndex: 1, gridColumnAnchorIndex: 1 }),
  ];
  return root;
};

test('walker: GRID layout carries template + per-child cells', async () => {
  const result = JSON.parse(await runWalker(shellFixture()));
  const shell = result.frames[0];
  assert.equal(shell.lm, 'GRID');
  assert.deepEqual(shell.grid, { rows: 2, cols: 2, rowGap: 0, colGap: 2 });
  const [menu, topbar, main] = shell.kids;
  assert.deepEqual(menu.cell, { r: 0, c: 0, rs: 2 });
  assert.deepEqual(topbar.cell, { r: 0, c: 1 });
  assert.deepEqual(main.cell, { r: 1, c: 1 });
});

test('walker: grid children ALWAYS carry x/y placement (fallback + cross-check)', async () => {
  // even when the grid template properties are unreadable, no child may end
  // up position-less — that was the collapsed-shell failure.
  const bare = JSON.parse(await runWalker(shellFixture({ withGridProps: false })));
  const shell = bare.frames[0];
  assert.equal(shell.lm, 'GRID');
  assert.equal(shell.grid, undefined);
  const [menu, topbar, main] = shell.kids;
  assert.equal(menu.cell, undefined);
  assert.deepEqual(topbar.abs, { a: 'top-left', x: 260, y: 0 });
  assert.deepEqual(main.abs, { a: 'top-left', x: 260, y: 98 });
  assert.deepEqual(menu.abs, { a: 'top-left', x: 0, y: 0 });
});

test('walker: children of an UNKNOWN future layoutMode still get positions', async () => {
  const root = shellFixture({ withGridProps: false });
  root.layoutMode = 'RADIAL';
  const result = JSON.parse(await runWalker(root));
  assert.deepEqual(result.frames[0].kids[1].abs, { a: 'top-left', x: 260, y: 0 });
});

test('spec text: grid template, cells and the CSS-grid footer', async () => {
  const result = JSON.parse(await runWalker(shellFixture()));
  const text = formatCodeSpec(result, { phase: 'all' });
  assert.match(text, /fixture grid .*grid 2×2 row-gap0 col-gap2/);
  assert.match(text, /menu .*cell row:1\/span 2 col:1/);
  assert.match(text, /Navigation Container .*cell row:1 col:2/);
  assert.match(text, /content-container .*cell row:2 col:2/);
  assert.match(text, /`grid R×C` = a CSS grid/, 'footer mapping present');
  const plain = formatCodeSpec({ id: 'r', name: 'X', frames: [{ t: 'FRAME', n: 'F', lm: 'VERTICAL' }] }, { phase: 'all' });
  assert.doesNotMatch(plain, /`grid R×C`/, 'footer only when a grid exists');
});

test('layoutSeg/cellSeg unit shapes', () => {
  assert.equal(layoutSeg({ lm: 'GRID', grid: { rows: 2, cols: 3, colGap: 8 } }, { detail: false }), 'grid 2×3 col-gap8');
  assert.equal(layoutSeg({ lm: 'GRID' }, { detail: false }), 'grid');
  assert.equal(cellSeg({ r: 0, c: 1, cs: 2 }), 'cell row:1 col:2/span 2');
});

test('S<n> refs keep geometry: abs and cell survive on ref lines', () => {
  const style = { fills: ['#131c34'], r: 12, pad: [16, 16, 16, 16], gap: 12 };
  const mk = (id, extra) => ({ t: 'FRAME', n: 'card', id, lm: 'VERTICAL', ...style, ...extra,
    kids: [{ t: 'TEXT', n: 'T', id: `${id}t`, txt: { chars: id } }] });
  const frames = [{ t: 'FRAME', n: 'root', id: 'r:0', kids: [
    mk('a:1', { abs: { a: 'top-left', x: 10, y: 10 } }),
    mk('a:2', { abs: { a: 'top-left', x: 500, y: 10 }, cell: { r: 0, c: 1 } }),
  ] }];
  const ctx = newDedupCtx(frames);
  const lines = frames.map((f) => specLines(f, 0, 'style', ctx)).flat().join('\n');
  assert.match(lines, /≡S1/, 'bundle defined');
  const refLine = lines.split('\n').find((l) => l.includes('[a:2]'));
  assert.match(refLine, /cell row:1 col:2/, 'cell survives on the ref line');
  assert.match(refLine, /abs left:500 top:10/, 'abs survives on the ref line (used to be dropped)');
  assert.match(refLine, /S1/);
});

test('yaml/json model: dir grid + template + cell ride along', async () => {
  const result = JSON.parse(await runWalker(shellFixture()));
  const model = specModel(result, { phase: 'all' });
  const shell = model.frames[0];
  assert.equal(shell.dir, 'grid');
  assert.deepEqual(shell.grid, { rows: 2, cols: 2, rowGap: 0, colGap: 2 });
  assert.deepEqual(shell.kids[0].cell, { r: 0, c: 0, rs: 2 });
});
