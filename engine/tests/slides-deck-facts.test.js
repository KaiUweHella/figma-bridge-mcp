// The shared deck-facts eval fragment: one grid walk and one fact shape that
// every deck-wide Slides reader splices in, so a new command cannot drift from
// what the others report.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK_FACT_KEYS,
  SLIDE_LABEL_KEY,
  slideDeckFactsFragment,
} from '../src/lib/slides-snippets.js';

function slide(id, name, {
  label = '',
  skipped = false,
  children = 0,
  transition = { style: 'DISSOLVE', duration: 0.35, curve: 'GENTLE', timing: { type: 'ON_CLICK' } },
  type = 'SLIDE',
} = {}) {
  return {
    id,
    name,
    type,
    isSkippedSlide: skipped,
    children: Array.from({ length: children }, (_, index) => ({ id: `${id}:${index}` })),
    getPluginData(key) { return key === SLIDE_LABEL_KEY ? label : ''; },
    getSlideTransition() { return transition; },
  };
}

function deck(rows, { focusedSlide = null, editorType = 'slides' } = {}) {
  return {
    editorType,
    currentPage: { focusedSlide },
    getCanvasGrid() { return rows; },
  };
}

// Runs the fragment against a fake runtime and returns whatever `body` yields.
function run(figma, body) {
  return new Function('figma', `${slideDeckFactsFragment()}\n${body}`)(figma);
}

describe('shared Slides deck facts fragment', () => {
  it('walks the grid, records coordinates and reports focus', () => {
    const a = slide('1:1', '1', { label: 'Cover', children: 2 });
    const b = slide('1:2', '2', { skipped: true });
    const c = slide('1:3', '3');
    const figma = deck([[a, b], [c]], { focusedSlide: b });

    const read = run(figma, 'const d = __deckRead(); return { count: d.slides.length, rowShape: d.rows.map((r) => r.length), focusedId: d.focusedId };');
    assert.deepEqual(read, { count: 3, rowShape: [2, 1], focusedId: '1:2' });

    const facts = run(figma, '__deckRead(); return __deckFacts(figma.getCanvasGrid()[0][0]);');
    assert.deepEqual(Object.keys(facts).sort(), [...DECK_FACT_KEYS].sort(), 'the closed fact shape');
    assert.deepEqual(facts, {
      id: '1:1',
      name: '1',
      label: 'Cover',
      row: 0,
      col: 0,
      skipped: false,
      transition: { style: 'DISSOLVE', duration: 0.35, curve: 'GENTLE', timing: { type: 'ON_CLICK' } },
      childCount: 2,
    });

    const second = run(figma, '__deckRead(); return __deckFacts(figma.getCanvasGrid()[1][0]);');
    assert.equal(second.row, 1);
    assert.equal(second.col, 0);
    assert.equal(second.label, null, 'an unset label reports null, never an empty string');
  });

  it('keeps a slide-shaped label and an AFTER_DELAY timing exactly', () => {
    const a = slide('1:1', '1', {
      transition: { style: 'SMART_ANIMATE', duration: 1.25, curve: 'BOUNCY', timing: { type: 'AFTER_DELAY', delay: 2.5 } },
    });
    const facts = run(deck([[a]]), '__deckRead(); return __deckFacts(figma.getCanvasGrid()[0][0]);');
    assert.deepEqual(facts.transition, {
      style: 'SMART_ANIMATE',
      duration: 1.25,
      curve: 'BOUNCY',
      timing: { type: 'AFTER_DELAY', delay: 2.5 },
    });
  });

  it('ignores non-slide nodes on the canvas grid instead of failing', () => {
    const figma = deck([[slide('1:1', '1'), slide('1:2', 'sticky', { type: 'STICKY' })]]);
    const count = run(figma, 'return __deckRead().slides.length;');
    assert.equal(count, 1, 'a Buzz/other canvas node is not a slide');
  });

  it('refuses every runtime shape it cannot trust', () => {
    const cases = [
      ['a duplicate slide id', deck([[slide('1:1', '1'), slide('1:1', '2')]]), /invalid slide identity/],
      ['a malformed slide id', deck([[slide('nope', '1')]]), /invalid slide identity/],
      ['a grid that is not an array', deck(null), /invalid slide grid/],
      ['a row that is not an array', deck(['nope']), /invalid slide row/],
      ['a focused slide with a bad id', deck([[slide('1:1', '1')]], { focusedSlide: { id: 'nope' } }), /invalid focused slide/],
    ];
    for (const [label, figma, pattern] of cases) {
      assert.throws(() => run(figma, 'return __deckRead();'), pattern, label);
    }

    const unknownStyle = slide('1:1', '1', {
      transition: { style: 'TELEPORT', duration: 0.3, curve: 'GENTLE', timing: { type: 'ON_CLICK' } },
    });
    assert.throws(
      () => run(deck([[unknownStyle]]), '__deckRead(); return __deckFacts(figma.getCanvasGrid()[0][0]);'),
      /invalid slide transition/,
      'an unlisted transition style is not silently passed through',
    );

    const extraTimingField = slide('1:1', '1', {
      transition: { style: 'DISSOLVE', duration: 0.3, curve: 'GENTLE', timing: { type: 'ON_CLICK', delay: 1 } },
    });
    assert.throws(
      () => run(deck([[extraTimingField]]), '__deckRead(); return __deckFacts(figma.getCanvasGrid()[0][0]);'),
      /invalid slide transition timing/,
      'ON_CLICK must not carry a delay',
    );

    const missingReader = { ...slide('1:1', '1') };
    delete missingReader.getSlideTransition;
    assert.throws(
      () => run(deck([[missingReader]]), '__deckRead(); return __deckFacts(figma.getCanvasGrid()[0][0]);'),
      /invalid slide transition reader/,
    );
  });
});
