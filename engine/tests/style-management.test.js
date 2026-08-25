import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseStyleProperties, parseStyleType,
  styleBindVariableCode, styleUpdateCode,
} from '../src/lib/style-management.js';

const emptyLists = {
  getLocalPaintStylesAsync: async () => [], getLocalTextStylesAsync: async () => [],
  getLocalEffectStylesAsync: async () => [], getLocalGridStylesAsync: async () => [],
};
const execute = (code, figma) => new Function('figma', `return ${code}`)(figma);

test('style input accepts only current type-specific Figma fields', () => {
  assert.equal(parseStyleType('paint'), 'PAINT');
  assert.deepEqual(parseStyleProperties('{"paints":[]}', 'PAINT'), { paints: [] });
  assert.throws(() => parseStyleProperties('{"effects":[]}', 'PAINT'), /Unsupported PAINT/);
  assert.throws(() => parseStyleProperties('[]', 'TEXT'), /JSON object/);
});

test('text style variable binding uses the native TextStyle API and supports unbinding', async () => {
  const bindings = [];
  const style = {
    id: 'S:4', key: 'k', type: 'TEXT', remote: false, name: 'Body', description: '',
    fontName: { family: 'Inter', style: 'Regular' }, setBoundVariable: (field, variable) => bindings.push([field, variable]),
  };
  const variable = { id: 'V:1', name: 'type/size/body', resolvedType: 'FLOAT' };
  const figma = {
    ...emptyLists, getStyleByIdAsync: async () => style,
    variables: { getLocalVariablesAsync: async () => [variable], getVariableByIdAsync: async (id) => id === variable.id ? variable : null },
  };
  await execute(styleBindVariableCode({ style: 'S:4', field: 'fontSize', variable: 'V:1' }), figma);
  await execute(styleBindVariableCode({ style: 'S:4', field: 'fontSize' }), figma);
  assert.deepEqual(bindings, [['fontSize', variable], ['fontSize', null]]);
  assert.throws(() => styleBindVariableCode({ style: 'S:4', field: 'width', variable: 'V:1' }), /Text style variable field/);
});

test('style update resolves local styles without REST', async () => {
  const style = { id: 'S:2', key: 'k', type: 'PAINT', remote: false, name: 'Brand', description: '', paints: [] };
  const figma = { ...emptyLists, getLocalPaintStylesAsync: async () => [style], getStyleByIdAsync: async () => null };
  const updated = await execute(styleUpdateCode({ style: 'Brand', type: 'PAINT', name: 'Primary', properties: { paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] } }), figma);
  assert.equal(updated.name, 'Primary');
  assert.equal(updated.paints.length, 1);
});
