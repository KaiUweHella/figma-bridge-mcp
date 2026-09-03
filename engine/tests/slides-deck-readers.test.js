// Deck-wide Slides readers: manifest and lint. Both splice the shared
// deck-facts fragment, so they are exercised against one fake runtime here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SLIDE_LABEL_KEY } from '../src/lib/slides-snippets.js';
import {
  SLIDES_MANIFEST_SCHEMA,
  executeSlidesManifest,
} from '../src/application/slides-manifest-command.js';
import { executeSlidesLint, slidesLintCode } from '../src/application/slides-lint-command.js';
import { parseSlidesLintRequest } from '../src/application/slides-lint-request.js';
import { slidesManifestCode } from '../src/application/slides-manifest-command.js';

const DISSOLVE = { style: 'DISSOLVE', duration: 0.35, curve: 'GENTLE', timing: { type: 'ON_CLICK' } };
const NONE = { style: 'NONE', duration: 0, curve: 'EASE_IN', timing: { type: 'ON_CLICK' } };

function slide(id, name, {
  label = '', skipped = false, children = 1, transition = DISSOLVE, tree = null,
} = {}) {
  return {
    id,
    name,
    type: 'SLIDE',
    isSkippedSlide: skipped,
    children: tree || Array.from({ length: children }, (_, index) => ({ id: `${id}:${index}` })),
    getPluginData(key) { return key === SLIDE_LABEL_KEY ? label : ''; },
    getSlideTransition() { return transition; },
  };
}

const interactive = (id, kind, name = kind.toLowerCase()) => ({
  id, name, type: 'INTERACTIVE_SLIDE_ELEMENT', interactiveSlideElementType: kind,
});

function runtime(rows, { editorType = 'slides', focusedSlide = null, extraSlides = [] } = {}) {
  // The page tree mirrors the grid, plus any slide the grid deliberately omits
  // (which Figma really does: see the unlisted-slide finding).
  const figma = {
    editorType,
    currentPage: {
      focusedSlide,
      type: 'PAGE',
      children: rows.map((row, index) => ({
        type: 'SLIDE_ROW',
        id: `row:${index}`,
        children: index === rows.length - 1 ? [...row, ...extraSlides] : [...row],
      })),
    },
    getCanvasGrid() { return rows; },
  };
  return {
    figma,
    evaluate: (code) => new Function('figma', `return ${code}`)(figma),
  };
}

// A deck shaped like a real one: slide 1 deliberately has no transition.
const healthyDeck = () => [[
  slide('1:1', '1', { label: '01 · Cover', transition: NONE }),
  slide('1:2', '2', { label: '02 · Body' }),
], [
  slide('1:3', '3', { label: '03 · Close' }),
]];

describe('Slides deck manifest', () => {
  it('projects the whole deck in grid order with a reconciled count', async () => {
    const live = runtime(healthyDeck(), { focusedSlide: { id: '1:2' } });
    const result = await executeSlidesManifest({ evaluate: live.evaluate });

    assert.equal(result.code, 0);
    assert.equal(result.result.schema, SLIDES_MANIFEST_SCHEMA);
    assert.equal(result.result.slideCount, 3);
    assert.equal(result.result.focusedId, '1:2');
    assert.deepEqual(result.result.rows.map((row) => row.length), [2, 1]);
    assert.deepEqual(result.result.rows[0][0], {
      id: '1:1',
      name: '1',
      label: '01 · Cover',
      row: 0,
      col: 0,
      skipped: false,
      transition: NONE,
      childCount: 1,
      interactive: [],
      interactiveTruncated: false,
    });
    assert.match(result.stdout, /3 slide\(s\), focused 1:2/);
    assert.match(result.stdout, /\[0,1\] 1:2 "02 · Body" — 1 child\(ren\) · DISSOLVE 0\.35s GENTLE/);
  });

  it('inventories interactive elements a slide carries, however deeply nested', async () => {
    const rows = [[
      slide('1:1', '1', {
        tree: [
          interactive('1:10', 'POLL', 'Warm-up poll'),
          { id: '1:11', type: 'FRAME', children: [interactive('1:12', 'FACEPILE')] },
        ],
      }),
      slide('1:2', '2'),
    ]];
    const live = runtime(rows);
    const result = await executeSlidesManifest({ evaluate: live.evaluate });

    const [first, second] = result.result.rows[0];
    assert.deepEqual(first.interactive, [
      { id: '1:10', type: 'POLL', name: 'Warm-up poll' },
      { id: '1:12', type: 'FACEPILE', name: 'facepile' },
    ]);
    assert.equal(first.interactiveTruncated, false);
    assert.deepEqual(second.interactive, []);
    assert.match(result.stdout, /interactive: POLL, FACEPILE/);
  });

  it('reports an element type the typings do not declare as UNKNOWN', async () => {
    const rows = [[slide('1:1', '1', { tree: [interactive('1:10', 'TELEPORT')] })]];
    const result = await executeSlidesManifest({ evaluate: runtime(rows).evaluate });
    assert.deepEqual(result.result.rows[0][0].interactive,
      [{ id: '1:10', type: 'UNKNOWN', name: 'teleport' }]);
  });

  it('refuses a deck it cannot read and a non-Slides editor', async () => {
    const wrongEditor = runtime(healthyDeck(), { editorType: 'figma' });
    await assert.rejects(
      () => executeSlidesManifest({ evaluate: wrongEditor.evaluate }),
      /requires a Figma Slides deck/,
    );

    const broken = runtime([[slide('1:1', '1'), slide('1:1', '2')]]);
    await assert.rejects(
      () => executeSlidesManifest({ evaluate: broken.evaluate }),
      /could not read a bounded native deck/,
      'a duplicate slide id is a runtime the manifest must not project',
    );
  });

  it('reports a focused slide the grid has not listed yet instead of refusing', async () => {
    // Reproduces a real state: a timed-out `slides create` had created and
    // focused a slide that figma.getCanvasGrid() did not yet list. Requiring
    // the focus to appear in the walk turned a readable deck into an error.
    const rows = [[slide('1:1', '1', { label: 'Cover' })]];
    const live = runtime(rows, { focusedSlide: { id: '9:99' } });
    const result = await executeSlidesManifest({ evaluate: live.evaluate });

    assert.equal(result.result.slideCount, 1);
    assert.equal(result.result.focusedId, '9:99');
    assert.match(result.stdout, /focused 9:99 \(not yet listed in the grid\)/);
  });

  it('reports a slide the canvas grid omits, and gives it no coordinate', async () => {
    const hidden = slide('9:9', '9', { label: 'Hidden', children: 0 });
    const live = runtime([[slide('1:1', '1', { label: 'Cover' })]], { extraSlides: [hidden] });
    const result = await executeSlidesManifest({ evaluate: live.evaluate });

    assert.equal(result.result.slideCount, 2, 'the page tree is authoritative for existence');
    assert.deepEqual(result.result.rows.map((row) => row.length), [1]);
    assert.equal(result.result.unlisted.length, 1);
    assert.equal(result.result.unlisted[0].id, '9:9');
    assert.equal(result.result.unlisted[0].row, null, 'no grid position, so none is claimed');
    assert.equal(result.result.unlisted[0].col, null);
    assert.match(result.stdout, /1 slide\(s\) exist on the page but are not listed/);
  });

  it('rejects a payload whose header disagrees with its body', async () => {
    const tampered = {
      evaluate: async () => JSON.stringify({
        schemaVersion: 1,
        status: 'ok',
        data: { schema: SLIDES_MANIFEST_SCHEMA, slideCount: 9, focusedId: null, rows: [], unlisted: [] },
      }),
    };
    await assert.rejects(
      () => executeSlidesManifest(tampered),
      /invalid bounded result/,
      'slideCount must equal the slides actually listed',
    );
  });

  it('generates code that never mutates', () => {
    const code = slidesManifestCode();
    for (const forbidden of ['createSlide', 'moveNodesToCoord', 'setSlideTransition', 'remove(', 'appendChild', 'setPluginData']) {
      assert.ok(!code.includes(forbidden), `manifest code must not reference ${forbidden}`);
    }
  });
});

describe('Slides deck lint', () => {
  const lint = async (rows, argv = ['slides', 'lint'], options = {}) => {
    const live = runtime(rows, options);
    const result = await executeSlidesLint(argv, { evaluate: live.evaluate });
    return { status: 'ok', data: result.result, code: result.code, stdout: result.stdout };
  };

  it('reports nothing for a healthy deck, and forgives the first slide having no transition', async () => {
    const payload = await lint(healthyDeck());
    assert.equal(payload.status, 'ok');
    assert.equal(payload.data.total, 0, JSON.stringify(payload.data.issues));
    assert.equal(payload.data.slidesWalked, 3);
    assert.deepEqual(payload.data.counts, {});
  });

  it('finds each of the four structural kinds', async () => {
    const rows = [[
      slide('1:1', '1', { label: 'Cover', transition: NONE }),
      slide('1:2', '2', { label: 'Cover' }),                       // duplicate label
      slide('1:3', '3', { skipped: true, children: 4 }),           // skipped with content
      slide('1:4', '4', { transition: NONE }),                     // missing transition
      slide('1:5', '5', { children: 0 }),                          // empty
    ]];
    const payload = await lint(rows);
    const byKind = payload.data.issues.reduce((all, issue) => {
      all[issue.kind] = (all[issue.kind] || []).concat(issue.id);
      return all;
    }, {});

    assert.deepEqual(byKind['duplicate-name'], ['1:1', '1:2']);
    assert.deepEqual(byKind['skipped-placement'], ['1:3']);
    assert.deepEqual(byKind['missing-transition'], ['1:4'], 'slide 1 is exempt, slide 4 is not');
    assert.deepEqual(byKind['empty-slide'], ['1:5']);
    assert.equal(payload.data.total, payload.data.issues.length);
    assert.deepEqual(payload.data.counts, {
      'duplicate-name': 2, 'skipped-placement': 1, 'missing-transition': 1, 'empty-slide': 1,
    });
  });

  it('finds a slide the grid does not list, which every grid-only walk missed', async () => {
    const hidden = slide('9:9', '9', { label: 'Stray', children: 0, transition: NONE });
    const rows = [[slide('1:1', '1', { label: 'Cover', transition: NONE })]];
    const payload = await lint(rows, ['slides', 'lint'], { extraSlides: [hidden] });

    assert.equal(payload.data.slidesWalked, 2);
    const byKind = payload.data.issues.reduce((all, issue) => {
      all[issue.kind] = (all[issue.kind] || []).concat(issue.id);
      return all;
    }, {});
    assert.deepEqual(byKind['unlisted-slide'], ['9:9']);
    assert.deepEqual(byKind['empty-slide'], ['9:9']);
    // The first-slide transition exemption is positional, so it must not cover
    // a slide that has no position at all.
    assert.deepEqual(byKind['missing-transition'], ['9:9']);
  });

  it('honours --kinds by emitting only the requested findings', async () => {
    const rows = [[
      slide('1:1', '1', { transition: NONE }),
      slide('1:2', '2', { children: 0, transition: NONE }),
    ]];
    const all = await lint(rows);
    assert.ok(all.data.total > 1);

    const narrowed = await lint(rows, ['slides', 'lint', '--kinds=empty-slide']);
    assert.deepEqual(narrowed.data.counts, { 'empty-slide': 1 });
    assert.equal(narrowed.data.slidesWalked, 2, 'the walk is unchanged; only reporting narrows');
  });

  it('turns findings into a non-zero exit only with --fail-on-issues', async () => {
    const rows = [[slide('1:1', '1'), slide('1:2', '2', { children: 0 })]];
    const live = runtime(rows);

    const quiet = await executeSlidesLint(['slides', 'lint'], { evaluate: live.evaluate });
    assert.equal(quiet.result.total, 1);
    assert.equal(quiet.code, 0, 'a finding is a report, not a transport failure');

    const strict = await executeSlidesLint(
      ['slides', 'lint', '--fail-on-issues'], { evaluate: live.evaluate },
    );
    assert.equal(strict.code, 1);
    assert.match(strict.stdout, /empty-slide/);
  });

  it('generates code that never mutates', () => {
    const code = slidesLintCode(parseSlidesLintRequest(['slides', 'lint']));
    for (const forbidden of ['createSlide', 'moveNodesToCoord', 'setSlideTransition', 'appendChild', 'setPluginData']) {
      assert.ok(!code.includes(forbidden), `lint code must not reference ${forbidden}`);
    }
  });
});

describe('a canvas grid that throws', () => {
  // Seen live on 2026-09-03: after a slide was removed, figma.getCanvasGrid()
  // kept the dead id and threw `The node with id "21:299" does not exist` on
  // every read. The deck still existed; only the grid was unreadable.
  it('manifest lists the whole deck from the page tree and says why positions are unknown', async () => {
    const live = runtime([[slide('1:1', '1', { label: 'Cover' }), slide('1:2', '2')]]);
    live.figma.getCanvasGrid = () => { throw new Error('in getCanvasGrid: The node with id "9:9" does not exist'); };
    const result = await executeSlidesManifest({ evaluate: live.evaluate });
    assert.equal(result.result.slideCount, 2);
    assert.deepEqual(result.result.rows, []);
    assert.deepEqual(result.result.unlisted.map((fact) => fact.id), ['1:1', '1:2']);
    assert.match(result.result.gridError, /does not exist/);
    assert.match(result.stdout, /canvas grid unavailable \(in getCanvasGrid: The node with id "9:9" does not exist\)/);
    assert.match(result.stdout, /2 slide\(s\) exist on the page but are not listed/);
  });

  it('lint reports every slide as unlisted with the grid reason', async () => {
    const live = runtime([[slide('1:1', '1'), slide('1:2', '2')]]);
    live.figma.getCanvasGrid = () => { throw new Error('in getCanvasGrid: The node with id "9:9" does not exist'); };
    const result = await executeSlidesLint(['slides', 'lint', '--kinds', 'unlisted-slide'], { evaluate: live.evaluate });
    assert.equal(result.result.counts['unlisted-slide'], 2);
    assert.match(result.result.issues[0].detail, /could not be read \(in getCanvasGrid: .*does not exist\)/);
  });

  it('a runtime the walk cannot trust names its reason', async () => {
    const broken = runtime([[slide('1:1', '1'), slide('1:1', '2')]]);
    await assert.rejects(
      () => executeSlidesManifest({ evaluate: broken.evaluate }),
      /could not read a bounded native deck: invalid slide identity/,
    );
  });
});
