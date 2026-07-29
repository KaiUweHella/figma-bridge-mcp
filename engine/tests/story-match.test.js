// Figma↔Storybook matching (lib/story-match.js) — pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, matchComponents, mergeMaps } from '../src/lib/story-match.js';

let nextNodeId = 0;
const fig = (name, extra = {}) => ({
  name, page: 'Components', nodeId: `1:${++nextNodeId}`, kind: 'set',
  figmaKey: 'fk-' + normalizeName(name), figmaVariantKey: 'vk-' + normalizeName(name),
  ...extra,
});
const story = (title, extra = {}) => {
  const name = title.split('/').pop();
  return {
    name, title, category: title.includes('/') ? title.split('/')[0] : undefined,
    importPath: `./src/${name}.stories.tsx`,
    variants: ['Primary'],
    stories: [{ id: `${normalizeName(title)}--primary`, name: 'Primary' }],
    ...extra,
  };
};

test('normalizeName strips case and separators', () => {
  assert.equal(normalizeName('Button/Primary CTA'), 'buttonprimarycta');
  assert.equal(normalizeName('  Nav-Bar_2 '), 'navbar2');
  assert.equal(normalizeName(null), '');
});

test('high: exact normalized name match, both sides reduced to last segment', () => {
  const r = matchComponents(
    [fig('Components/Button')],
    [story('Design System/Button')],
  );
  assert.equal(r.mappings.length, 1);
  assert.equal(r.mappings[0].confidence, 'high');
  assert.equal(r.mappings[0].matchedBy, 'name');
  assert.equal(r.mappings[0].storyId, 'designsystembutton--primary');
  assert.equal(r.mappings[0].figmaKey, 'fk-componentsbutton');
  assert.equal(r.unmatchedFigma.length, 0);
  assert.equal(r.unmatchedStories.length, 0);
});

test('medium: plural-insensitive match', () => {
  const r = matchComponents([fig('Badges')], [story('Components/Badge')]);
  assert.equal(r.mappings.length, 1);
  assert.equal(r.mappings[0].confidence, 'medium');
});

test('low: unique substring containment; short names never match by containment', () => {
  const r = matchComponents([fig('PrimaryButton')], [story('Components/Button')]);
  assert.equal(r.mappings.length, 1);
  assert.equal(r.mappings[0].confidence, 'low');

  const short = matchComponents([fig('Tab')], [story('Components/Tabs2000')]);
  // 'tab' is only 3 chars — containment is not trusted; plural pass misses too.
  assert.equal(short.mappings.length, 0);
});

test('ambiguous duplicate Figma names go unmatched instead of guessing', () => {
  const r = matchComponents(
    [fig('Button', { nodeId: '1:1' }), fig('button', { nodeId: '2:2' })],
    [story('Components/Button')],
  );
  assert.equal(r.mappings.length, 0);
  assert.equal(r.unmatchedFigma.length, 2);
  assert.ok(r.unmatchedFigma.every((f) => f.reason === 'ambiguous-name'));
  assert.equal(r.unmatchedStories.length, 1);
});

test('each side is matched at most once; leftovers reported', () => {
  const r = matchComponents(
    [fig('Button'), fig('Card')],
    [story('Components/Button'), story('Components/Modal')],
  );
  assert.equal(r.mappings.length, 1);
  assert.equal(r.mappings[0].figmaName, 'Button');
  assert.deepEqual(r.unmatchedFigma.map((f) => f.name), ['Card']);
  assert.deepEqual(r.unmatchedStories.map((s) => s.storyTitle), ['Components/Modal']);
});

test('mergeMaps: manual entries survive verbatim and block re-assignment', () => {
  const existing = {
    mappings: [
      { figmaName: 'Button', figmaKey: 'fk-button', figmaNodeId: '1:1', storyTitle: 'Components/Button', storyId: 'pinned--story', matchedBy: 'manual', confidence: 'high' },
      { figmaName: 'Card', figmaKey: 'fk-card', figmaNodeId: '2:2', storyTitle: 'Components/Card', storyId: 'old--auto', matchedBy: 'name', confidence: 'high' },
    ],
  };
  const fresh = matchComponents(
    [fig('Button'), fig('Card')],
    [story('Components/Button'), story('Components/Card')],
  );
  const merged = mergeMaps(existing, fresh);
  const pinned = merged.mappings.find((m) => m.matchedBy === 'manual');
  assert.equal(pinned.storyId, 'pinned--story'); // untouched
  // The fresh auto-match for Button (occupied by the pin) is dropped…
  assert.equal(merged.mappings.filter((m) => m.figmaName === 'Button').length, 1);
  // …while Card is re-matched fresh (old non-manual entry NOT preserved).
  const card = merged.mappings.find((m) => m.figmaName === 'Card');
  assert.equal(card.matchedBy, 'name');
  assert.notEqual(card.storyId, 'old--auto');
});
