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

function runtime(rows, { editorType = 'slides', focusedSlide = null } = {}) {
  const figma = {
    editorType,
    currentPage: { focusedSlide },
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

  it('rejects a payload whose header disagrees with its body', async () => {
    const tampered = {
      evaluate: async () => JSON.stringify({
        schemaVersion: 1,
        status: 'ok',
        data: { schema: SLIDES_MANIFEST_SCHEMA, slideCount: 9, focusedId: null, rows: [] },
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
  const lint = async (rows, argv = ['slides', 'lint']) => {
    const live = runtime(rows);
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
