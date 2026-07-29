// M2: content-addressed style dedup + yaml/json spec formats.
//
// The central guarantee is NO INFORMATION LOSS: dedup only changes WHERE a
// value is written, never WHETHER it is written. Two property tests hold
// that: expandSpecModel(specModel(dedup)) must deep-equal the undeduped
// model, and fromYaml(toYaml(model)) must deep-equal the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  styleFields, bundleKey, stableStringify, countStyleBundles, newDedupCtx,
  specLines, formatCodeSpec, specModel, expandSpecModel,
} from '../src/lib/code-spec.js';
import { toYaml, fromYaml } from '../src/lib/yaml.js';

// ---- fixture: 3 cards sharing one bundle, texts sharing two more ----

const CARD_STYLE = {
  lm: 'VERTICAL', gap: 6, pad: [16, 16, 16, 16],
  fills: ['#ffffff'], strokes: ['#e6eae1'], sw: 1, r: 14,
  bv: { fills: 'color/surface' },
};
const TITLE_TXT = { font: 'Inter', style: 'Semi Bold', size: 14 };
const META_TXT = { font: 'Inter', style: 'Regular', size: 12 };

const card = (id, title, meta) => ({
  t: 'FRAME', n: `Card ${title}`, id, w: 240, h: 120, ...CARD_STYLE,
  kids: [
    { t: 'TEXT', n: 'Title', id: `${id}t`, w: 208, h: 17, fills: ['#16202b'], txt: { chars: title, ...TITLE_TXT } },
    { t: 'TEXT', n: 'Meta', id: `${id}m`, w: 208, h: 15, fills: ['#6b7a6e'], txt: { chars: meta, ...META_TXT } },
  ],
});

const FIXTURE = {
  id: '7:1', name: 'Cards',
  frames: [{
    t: 'FRAME', n: 'Grid', id: '7:2', w: 800, h: 140, lm: 'HORIZONTAL', gap: 16,
    kids: [
      card('7:3', 'Monstera', 'Living Room'),
      card('7:4', 'Fern', 'Bathroom'),
      card('7:5', 'Fig', 'Kitchen'),
      // unique style — must stay inline, no ref
      { t: 'FRAME', n: 'Odd Panel', id: '7:6', w: 100, h: 140, lm: 'VERTICAL', gap: 3, fills: ['#123456'], r: 99 },
    ],
  }],
};

// ---- bundle keying ----

test('bundleKey: identical style fields → identical key, regardless of text content', () => {
  const a = { t: 'TEXT', n: 'A', fills: ['#16202b'], txt: { chars: 'Hello', ...TITLE_TXT } };
  const b = { t: 'TEXT', n: 'B', fills: ['#16202b'], txt: { chars: 'Completely different', ...TITLE_TXT } };
  assert.equal(bundleKey(a), bundleKey(b));
});

test('bundleKey: any style difference changes the key; style-less nodes have none', () => {
  const a = { fills: ['#16202b'], txt: { ...TITLE_TXT } };
  assert.notEqual(bundleKey(a), bundleKey({ ...a, fills: ['#000000'] }));
  assert.equal(bundleKey({ t: 'FRAME', n: 'Bare' }), null);
});

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ a: 1, b: [{ x: 1, y: 2 }] }), stableStringify({ b: [{ y: 2, x: 1 }], a: 1 }));
});

test('styleFields excludes characters but keeps typography', () => {
  const f = styleFields({ txt: { chars: 'Hi', ...TITLE_TXT }, fills: ['#111111'] });
  assert.equal(f.txt.chars, undefined);
  assert.equal(f.txt.font, 'Inter');
  assert.deepEqual(f.fills, ['#111111']);
});

// ---- text renderer dedup ----

test('first occurrence defines (≡S1) and renders full detail; repeats collapse to the ref', () => {
  const ctx = newDedupCtx(FIXTURE.frames);
  const text = specLines(FIXTURE.frames[0], 0, 'style', ctx).join('\n');
  // exactly one definition per bundle
  assert.equal((text.match(/≡S1/g) || []).length, 1);
  assert.equal((text.match(/≡S2/g) || []).length, 1);
  assert.equal((text.match(/≡S3/g) || []).length, 1);
  // the defining card line still carries its full paint detail
  const defLine = text.split('\n').find((l) => l.includes('≡S1'));
  assert.match(defLine, /fill #ffffff → var\(color\/surface\)/);
  assert.match(defLine, /r14/);
  // ref lines: direction survives, values are gone, ids survive
  const refLines = text.split('\n').filter((l) => / S1( |$)/.test(l) && !l.includes('≡'));
  assert.equal(refLines.length, 2, 'two of three cards are refs');
  for (const l of refLines) {
    assert.match(l, /col · S1/);
    assert.doesNotMatch(l, /#ffffff/);
    assert.match(l, /\[7:[45]\]/);
  }
  // unique panel stays fully inline without any tag
  const odd = text.split('\n').find((l) => l.includes('Odd Panel'));
  assert.match(odd, /fill #123456/);
  assert.doesNotMatch(odd, /S\d/);
});

test('text nodes dedup by typography+color even though their characters differ', () => {
  const ctx = newDedupCtx(FIXTURE.frames);
  const text = specLines(FIXTURE.frames[0], 0, 'style', ctx).join('\n');
  const titleLines = text.split('\n').filter((l) => l.includes('Title:') || /"(Monstera|Fern|Fig)"/.test(l));
  const withDef = titleLines.filter((l) => l.includes('≡S2'));
  const withRef = titleLines.filter((l) => /· S2/.test(l) && !l.includes('≡'));
  assert.equal(withDef.length, 1);
  assert.equal(withRef.length, 2);
  // characters stay on every line — content is never deduped away
  assert.ok(titleLines.every((l) => /"(Monstera|Fern|Fig)"/.test(l)));
});

test('short bundles below the threshold stay inline even when repeated', () => {
  const frames = [{
    t: 'FRAME', n: 'Root', kids: [
      { t: 'FRAME', n: 'A', sh: 'FILL' },
      { t: 'FRAME', n: 'B', sh: 'FILL' },
    ],
  }];
  const ctx = newDedupCtx(frames);
  const text = specLines(frames[0], 0, 'style', ctx).join('\n');
  assert.doesNotMatch(text, /S\d/);
  assert.equal((text.match(/w:fill/g) || []).length, 2);
});

test('structure phase never dedups (no style segs to dedup)', () => {
  const md = formatCodeSpec(FIXTURE, { phase: 'structure' });
  assert.doesNotMatch(md, /≡S\d/);
});

test('formatCodeSpec: dedup on by default with notation footer; --no-dedup restores inline form', () => {
  const deduped = formatCodeSpec(FIXTURE, { phase: 'style' });
  assert.match(deduped, /≡S1/);
  assert.match(deduped, /defines a repeated style bundle/);
  const plain = formatCodeSpec(FIXTURE, { phase: 'style', dedup: false });
  assert.doesNotMatch(plain, /≡S\d/);
  assert.doesNotMatch(plain, /defines a repeated style bundle/);
  // every card carries its fill inline again
  assert.equal((plain.match(/fill #ffffff/g) || []).length, 3);
});

test('deduped spec is measurably smaller on the repeat fixture', () => {
  const deduped = formatCodeSpec(FIXTURE, { phase: 'style' });
  const plain = formatCodeSpec(FIXTURE, { phase: 'style', dedup: false });
  assert.ok(deduped.length < plain.length, `expected ${deduped.length} < ${plain.length}`);
});

test('defining lines equal their undeduped counterparts except for the ≡ tag', () => {
  const dedupedLines = formatCodeSpec(FIXTURE, { phase: 'style' }).split('\n');
  const plainLines = formatCodeSpec(FIXTURE, { phase: 'style', dedup: false }).split('\n');
  let checked = 0;
  for (let i = 0; i < dedupedLines.length; i++) {
    const d = dedupedLines[i];
    // Spec lines only — the notation footer also mentions ≡S in backticks.
    if (d.includes('≡S') && d.trimStart().startsWith('-')) {
      assert.equal(d.replace(/ · ≡S\d+/, ''), plainLines[i], `line ${i} definition must be verbatim`);
      checked++;
    }
  }
  assert.equal(checked, 3, 'all three definitions were compared');
});

test('identSeg: props already stated by the variant name are not repeated', async () => {
  const { identSeg } = await import('../src/lib/code-spec.js');
  const seg = identSeg({
    t: 'INSTANCE', n: 'Button Snooze', mc: 'Button Snooze',
    main: 'Variant=Ghost, Size=SM', set: 'Button',
    props: { Variant: 'Ghost', Size: 'SM', Label: 'Snooze', 'Show icon': false },
  });
  assert.match(seg, /→ Button\/Variant=Ghost, Size=SM/);
  assert.match(seg, /Label=Snooze/);
  assert.match(seg, /Show icon=false/);
  // each variant pair appears exactly once (in the name, not the parens)
  assert.equal((seg.match(/Variant=Ghost/g) || []).length, 1);
  assert.equal((seg.match(/Size=SM/g) || []).length, 1);
});

// ---- structured model + expansion property ----

test('specModel: repeated bundles land in the styles map, nodes carry s-refs', () => {
  const model = specModel(FIXTURE, { phase: 'style' });
  assert.ok(model.styles.S1, 'styles map present');
  const cards = model.frames[0].kids.filter((k) => k.n.startsWith('Card'));
  assert.equal(cards.length, 3);
  for (const c of cards) {
    assert.equal(c.s, 'S1');
    assert.equal(c.style, undefined, 'no inline style next to a ref');
  }
  assert.deepEqual(model.styles.S1.fills, ['#ffffff']);
  // singleton keeps its style inline and the map does not grow for it
  const odd = model.frames[0].kids.find((k) => k.n === 'Odd Panel');
  assert.equal(odd.s, undefined);
  assert.deepEqual(odd.style.fills, ['#123456']);
});

test('PROPERTY: expandSpecModel(specModel(dedup)) deep-equals the undeduped model', () => {
  for (const phase of ['style', 'all']) {
    const expanded = expandSpecModel(specModel(FIXTURE, { phase }));
    const plain = specModel(FIXTURE, { phase, dedup: false });
    assert.deepEqual(expanded, plain, `phase ${phase}`);
  }
});

test('specModel structure phase: content and hierarchy, no geometry, no styles', () => {
  const model = specModel(FIXTURE, { phase: 'structure' });
  assert.equal(model.styles, undefined);
  const title = model.frames[0].kids[0].kids[0];
  assert.equal(title.text, 'Monstera');
  assert.equal(title.w, undefined);
  assert.equal(title.style, undefined);
  assert.equal(model.frames[0].dir, 'row');
});

test('specModel preserves hidden/repeat/more markers', () => {
  const frames = [{
    t: 'FRAME', n: 'Root', kids: [
      { t: 'FRAME', n: 'Ghost', hidden: true },
      { t: 'FRAME', n: 'Deep', more: 7 },
      { t: 'FRAME', n: 'Twin', id: 'x', repeat: 3 },
    ],
  }];
  const model = specModel({ id: '1', name: 'X', frames }, { phase: 'all' });
  const [ghost, deep, twin] = model.frames[0].kids;
  assert.equal(ghost.hidden, true);
  assert.equal(deep.more, 7);
  assert.equal(twin.repeat, 3);
});

// ---- yaml policy ----

test('PROPERTY: yaml roundtrip preserves the spec model exactly', () => {
  const model = specModel(FIXTURE, { phase: 'all' });
  assert.deepEqual(fromYaml(toYaml(model)), model);
});

test('yaml quoting: tricky scalars survive the roundtrip typed correctly', () => {
  const value = {
    nodeId: '12:34',              // colon — must come back a string
    literalTrue: 'true',          // string, not boolean
    realBool: true,
    hash: 'a # not a comment',
    unicodeSegs: 'col gap6 · fill #fff → var(x) ≡S1 ×3',
    num: 1.17,
    empty: [], nothing: {},
  };
  const back = fromYaml(toYaml(value));
  assert.deepEqual(back, value);
  assert.equal(typeof back.nodeId, 'string');
  assert.equal(typeof back.literalTrue, 'string');
  assert.equal(typeof back.realBool, 'boolean');
});

test('yaml policy: long strings are not folded, shared objects are not aliased', () => {
  const long = 'x'.repeat(300);
  assert.equal(toYaml({ long }).split('\n').length, 1);
  const shared = { fills: ['#ffffff'] };
  const out = toYaml({ a: shared, b: shared });
  assert.doesNotMatch(out, /[&*]/, 'no anchors/aliases in output');
  assert.equal((out.match(/#ffffff/g) || []).length, 2);
});

test('yaml model output is smaller than pretty JSON of the same model', () => {
  const model = specModel(FIXTURE, { phase: 'all' });
  const yaml = toYaml(model);
  const json = JSON.stringify(model, null, 2);
  assert.ok(yaml.length < json.length, `yaml ${yaml.length} vs json ${json.length}`);
});
