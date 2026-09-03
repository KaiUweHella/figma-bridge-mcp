import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOpacityToHex,
  composedColorValueParts,
  isComposedColorValue,
  isOpacityPercent,
  isVariableAliasValue,
} from '../src/lib/variable-values.js';

const alias = (id = 'VariableID:1:2') => ({ type: 'VARIABLE_ALIAS', id });
const composed = (opacity, target = alias()) => ({
  type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
  expressionArguments: [target, opacity],
});

test('isVariableAliasValue accepts only the exact native alias shape', () => {
  assert.equal(isVariableAliasValue(alias()), true);
  assert.equal(isVariableAliasValue({ type: 'VARIABLE_ALIAS', id: '' }), false);
  assert.equal(isVariableAliasValue({ type: 'VARIABLE_ALIAS', id: 'x', extra: 1 }), false);
  assert.equal(isVariableAliasValue({ type: 'VARIABLE_ALIAS' }), false);
  assert.equal(isVariableAliasValue(null), false);
  assert.equal(isVariableAliasValue([]), false);
  assert.equal(isVariableAliasValue('VARIABLE_ALIAS'), false);
});

test('isOpacityPercent is closed to finite 0..100 numbers', () => {
  for (const ok of [0, 42, 100, 0.5]) assert.equal(isOpacityPercent(ok), true, String(ok));
  for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, '42', null, undefined]) {
    assert.equal(isOpacityPercent(bad), false, String(bad));
  }
});

test('composedColorValueParts returns the alias and percentage only for COMPOSE_COLOR', () => {
  assert.deepEqual(composedColorValueParts(composed(42)), { alias: alias(), opacity: 42 });
  assert.equal(isComposedColorValue(composed(0)), true);
  assert.equal(isComposedColorValue(composed(100)), true);
  assert.equal(composedColorValueParts(composed(101)), null);
  assert.equal(composedColorValueParts(composed(42, { type: 'VARIABLE_ALIAS', id: '' })), null);
  assert.equal(composedColorValueParts({ ...composed(42), expressionFunction: 'OTHER' }), null);
  assert.equal(composedColorValueParts({ ...composed(42), expressionArguments: [alias()] }), null);
  assert.equal(composedColorValueParts({ ...composed(42), extra: true }), null);
  assert.equal(composedColorValueParts(alias()), null);
  assert.equal(composedColorValueParts({ r: 1, g: 0, b: 0 }), null);
  assert.equal(composedColorValueParts(undefined), null);
});

test('applyOpacityToHex composes with an existing alpha byte and keeps 0 and 100 explicit', () => {
  assert.equal(applyOpacityToHex('#FFCC66', 42), '#ffcc666b');
  assert.equal(applyOpacityToHex('#ff000080', 50), '#ff000040');
  assert.equal(applyOpacityToHex('#336699', 0), '#33669900');
  assert.equal(applyOpacityToHex('#336699', 100), '#336699ff');
});

test('applyOpacityToHex refuses non-hex inputs and out-of-range opacity', () => {
  assert.equal(applyOpacityToHex('#fff', 50), null);
  assert.equal(applyOpacityToHex('ff0000', 50), null);
  assert.equal(applyOpacityToHex(null, 50), null);
  assert.equal(applyOpacityToHex({ r: 1 }, 50), null);
  assert.equal(applyOpacityToHex('#ff0000', 101), null);
  assert.equal(applyOpacityToHex('#ff0000', '50'), null);
});
