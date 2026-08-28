// Pure parsing and clone-nearest selection for `component add-variant`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVariantPairs,
  variantNamePairs,
  nearestVariant,
} from '../src/lib/variant-snippets.js';

describe('parseVariantPairs', () => {
  test('single and multiple pairs, whitespace tolerated', () => {
    assert.deepEqual(parseVariantPairs('State=Hover'), { State: 'Hover' });
    assert.deepEqual(parseVariantPairs(' Size = XL , State=Hover '), { Size: 'XL', State: 'Hover' });
  });

  test('a segment without = is refused, naming the segment', () => {
    assert.throws(() => parseVariantPairs('Hover'), /Invalid variant pair "Hover"/);
    assert.throws(() => parseVariantPairs('State=Hover,Size'), /Invalid variant pair "Size"/);
  });

  test('empty spec and empty key/value are refused', () => {
    assert.throws(() => parseVariantPairs(''), /Empty variant spec/);
    assert.throws(() => parseVariantPairs('=Hover'), /Invalid variant pair/);
    assert.throws(() => parseVariantPairs('State='), /Invalid variant pair/);
  });

  test('a duplicated axis is refused', () => {
    assert.throws(() => parseVariantPairs('State=A,State=B'), /specified twice/);
  });
});

describe('variantNamePairs', () => {
  test('parses the Figma name convention leniently', () => {
    assert.deepEqual(variantNamePairs('State=Hover, Size=XL'), { State: 'Hover', Size: 'XL' });
    // Odd segment without "=" is skipped, not fatal — real files contain them.
    assert.deepEqual(variantNamePairs('Hover, Size=XL'), { Size: 'XL' });
    assert.deepEqual(variantNamePairs(''), {});
  });
});

describe('nearestVariant', () => {
  const v = (id, name) => ({ id, name, pairs: variantNamePairs(name) });
  const list = [
    v('1', 'State=Default, Size=M'),
    v('2', 'State=Hover, Size=M'),
    v('3', 'State=Default, Size=XL'),
  ];

  test('a match on a specified axis beats default-nearness', () => {
    // Target Size=XL, State=Hover: variant 2 matches State=Hover (score 1),
    // variant 3 matches nothing specified for State but Size=XL (score 1)…
    // both score 1 → tie broken by closeness to default (id 1) on the
    // remaining axes: v2 shares Size=M with default, v3 shares State=Default.
    const hit = nearestVariant(list, { State: 'Hover', Size: 'XL' }, '1');
    assert.ok(hit.id === '2' || hit.id === '3'); // both score 1, defNear 1
    // Make it decisive: target only State=Hover — v2 is the exact axis match.
    assert.equal(nearestVariant(list, { State: 'Hover' }, '1').id, '2');
  });

  test('with no axis match, the default variant wins', () => {
    assert.equal(nearestVariant(list, { State: 'Loading' }, '1').id, '1');
  });

  test('without a default, child order decides', () => {
    assert.equal(nearestVariant(list, { State: 'Loading' }, null).id, '1');
  });

  test('empty list returns null', () => {
    assert.equal(nearestVariant([], { State: 'X' }, null), null);
  });
});
