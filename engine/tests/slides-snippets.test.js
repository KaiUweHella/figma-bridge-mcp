import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import * as slides from '../src/lib/slides-snippets.js';

const transition = {
  style: 'DISSOLVE',
  duration: 0.3,
  curve: 'EASE_IN_AND_OUT',
  timing: { type: 'ON_CLICK' },
};

const CASES = {
  'inspect deck': () => slides.inspect(),
  'inspect one': () => slides.inspect('Intro'),
  create: () => slides.create('Intro', { row: 0, col: 1 }),
  duplicate: () => slides.duplicate('1:2', { label: 'Copy', row: 1, col: 0 }),
  move: () => slides.move('1:2', 2, 3),
  transition: () => slides.transition('1:2', transition),
  skip: () => slides.skip('1:2', true),
  include: () => slides.skip('1:2', false),
  delete: () => slides.remove('1:2'),
};

for (const [name, build] of Object.entries(CASES)) {
  test(`snippet parses: ${name}`, () => {
    new Script(build(), { filename: `slides-snippet:${name}` });
  });
}

test('every snippet refuses non-Slides editors before using the Slides API', async () => {
  for (const [name, build] of Object.entries(CASES)) {
    const source = build();
    assert.match(source, /figma\.editorType !== 'slides'/, name);
    const result = await new Function('figma', `return ${source}`)({ editorType: 'figma' });
    assert.deepEqual(result, { error: 'WRONG_EDITOR', editor: 'figma' }, name);
  }
});

function fixture() {
  let next = 3;
  let grid = [];
  const registry = new Map();

  const makeSlide = (id, name) => {
    let currentTransition = { style: 'NONE', duration: 0, curve: 'LINEAR', timing: { type: 'ON_CLICK' } };
    const pluginData = new Map();
    const node = {
      id, name, type: 'SLIDE', children: [], isSkippedSlide: false, removed: false,
      getPluginData: key => pluginData.get(key) || '',
      setPluginData: (key, value) => pluginData.set(key, value),
      getSlideTransition: () => currentTransition,
      setSlideTransition: (value) => { currentTransition = value; },
      clone: () => {
        const copy = makeSlide(`1:${next++}`, `${node.name} copy`);
        for (const [key, value] of pluginData) copy.setPluginData(key, value);
        if (!grid.length) grid.push([]);
        grid[grid.length - 1].push(copy);
        return copy;
      },
      remove: () => {
        node.removed = true;
        grid = grid.map(row => row.filter(item => item.id !== node.id)).filter(row => row.length);
        registry.delete(node.id);
      },
    };
    registry.set(id, node);
    return node;
  };

  const intro = makeSlide('1:1', 'Intro');
  const details = makeSlide('1:2', 'Details');
  grid = [[intro, details]];
  const currentPage = { focusedSlide: intro, selection: [] };

  const moveNodesToCoord = (ids, rowIndex, colIndex) => {
    const nodes = ids.map(id => registry.get(id));
    grid = grid.map(row => row.filter(node => !ids.includes(node.id))).filter(row => row.length);
    if (rowIndex === undefined) {
      if (!grid.length) grid.push([]);
      grid[grid.length - 1].push(...nodes);
      return;
    }
    while (grid.length <= rowIndex) grid.push([]);
    const target = grid[rowIndex];
    target.splice(colIndex === undefined ? target.length : colIndex, 0, ...nodes);
  };

  const figma = {
    editorType: 'slides', currentPage,
    getCanvasGrid: () => grid,
    getNodeByIdAsync: async id => registry.get(id) || null,
    moveNodesToCoord,
    createSlide: (rowIndex, colIndex) => {
      const node = makeSlide(`1:${next++}`, 'Slide');
      if (rowIndex === undefined) {
        if (!grid.length) grid.push([]);
        grid[grid.length - 1].push(node);
      } else {
        while (grid.length <= rowIndex) grid.push([]);
        grid[rowIndex].splice(colIndex === undefined ? grid[rowIndex].length : colIndex, 0, node);
      }
      return node;
    },
  };
  return { figma, intro, details, getGrid: () => grid };
}

const execute = (source, figma) => new Function('figma', `return ${source}`)(figma);

test('inspect exposes the native grid, focus, skip and transition facts', async () => {
  const { figma } = fixture();
  const deck = await execute(slides.inspect(), figma);
  assert.equal(deck.slideCount, 2);
  assert.equal(deck.focusedId, '1:1');
  assert.deepEqual(deck.rows[0].map(item => item.name), ['Intro', 'Details']);

  const one = await execute(slides.inspect('tail'), figma);
  assert.equal(one.slide.id, '1:2', 'a unique substring resolves');
});

test('slide resolution refuses ambiguous names and missing slides', async () => {
  const { figma } = fixture();
  figma.createSlide().name = 'Intro';
  await assert.rejects(execute(slides.inspect('Intro'), figma), /Ambiguous slide name/);
  await assert.rejects(execute(slides.inspect('Missing'), figma), /Slide not found/);
});

test('create, duplicate and move update the native canvas grid explicitly', async () => {
  const { figma } = fixture();
  const created = await execute(slides.create('Agenda', { row: 1, col: 0 }), figma);
  assert.deepEqual([created.label, created.row, created.col], ['Agenda', 1, 0]);
  assert.equal(figma.currentPage.focusedSlide.id, created.id);

  const duplicated = await execute(slides.duplicate('Details', { label: 'Details alt', row: 0, col: 0 }), figma);
  assert.equal(duplicated.slide.label, 'Details alt');
  assert.deepEqual([duplicated.slide.row, duplicated.slide.col], [0, 0]);

  const moved = await execute(slides.move('Agenda', 0, 1), figma);
  assert.deepEqual([moved.row, moved.col], [0, 1]);
});

test('create and duplicate label only after Slides has settled grid/focus changes', () => {
  const created = slides.create('Agenda', { row: 0, col: 1 });
  const createFocusAt = created.indexOf('focusedSlide = slide');
  const createSettleAt = created.indexOf('await __settleGrid()');
  const createLabelAt = created.indexOf('slide.setPluginData');
  assert.ok(createFocusAt < createSettleAt && createSettleAt < createLabelAt);

  const duplicated = slides.duplicate('1:2', { label: 'Agenda copy', row: 1, col: 0 });
  const duplicateMoveAt = duplicated.indexOf('figma.moveNodesToCoord');
  const duplicateSettleAt = duplicated.indexOf('await __settleGrid()');
  const duplicateLabelAt = duplicated.indexOf('copy.setPluginData');
  assert.ok(duplicateMoveAt < duplicateSettleAt && duplicateSettleAt < duplicateLabelAt);
});

test('move and duplicate refuse missing rows instead of accepting Figma fallback placement', async () => {
  const { figma } = fixture();
  await assert.rejects(execute(slides.move('1:2', 4, 0), figma), /Target row 4 does not exist/);
  await assert.rejects(execute(slides.duplicate('1:2', { row: 4, col: 0 }), figma), /Target row 4 does not exist/);
  assert.equal((await execute(slides.inspect(), figma)).slideCount, 2, 'a refused duplicate creates nothing');
});

test('move yields to the canvas grid before reporting its resulting coordinate', () => {
  const source = slides.move('1:2', 2, 3);
  assert.ok(source.indexOf('figma.moveNodesToCoord') < source.indexOf('await __settleGrid()'));
  assert.ok(source.indexOf('await __settleGrid()') < source.indexOf('return __facts(slide)'));
});

test('transition, skip and delete mutate only the explicitly resolved slide', async () => {
  const { figma, intro, details } = fixture();
  const transitioned = await execute(slides.transition('1:2', transition), figma);
  assert.deepEqual(transitioned.transition, transition);
  assert.equal(intro.getSlideTransition().style, 'NONE');

  const skipped = await execute(slides.skip('Details', true), figma);
  assert.equal(skipped.skipped, true);
  assert.equal(details.isSkippedSlide, true);

  const removed = await execute(slides.remove('1:2'), figma);
  assert.equal(removed.id, '1:2');
  assert.equal(details.removed, true);
  assert.equal((await execute(slides.inspect(), figma)).slideCount, 1);
});

test('readback normalizes Figma float noise in transition duration and delay', async () => {
  const { figma } = fixture();
  const noisy = {
    style: 'DISSOLVE', duration: 0.44999998807907104, curve: 'EASE_IN_AND_OUT',
    timing: { type: 'AFTER_DELAY', delay: 1.2500000001 },
  };
  const result = await execute(slides.transition('1:2', noisy), figma);
  assert.equal(result.transition.duration, 0.45);
  assert.equal(result.transition.timing.delay, 1.25);
});

test('transition constants mirror the official Plugin API union', () => {
  assert.ok(slides.TRANSITION_STYLES.includes('SMART_ANIMATE'));
  assert.deepEqual(slides.TRANSITION_TIMINGS, ['ON_CLICK', 'AFTER_DELAY']);
  assert.ok(slides.TRANSITION_CURVES.includes('BOUNCY'));
});
