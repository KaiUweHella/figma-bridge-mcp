import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseStyleProperties, parseStyleType, styleApplyCode, styleConsumersCode,
  styleCreateCode, styleListCode, stylePublishStatusCode, styleUpdateCode,
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

test('style create uses the native factory, loads text fonts, and returns facts', async () => {
  const loaded = [];
  const style = { id: 'S:1', key: 'key', type: 'TEXT', remote: false, name: '', description: '', fontName: { family: 'Inter', style: 'Regular' } };
  const figma = {
    ...emptyLists, getStyleByIdAsync: async () => null, createTextStyle: () => style,
    loadFontAsync: async (font) => loaded.push(font),
  };
  const result = await execute(styleCreateCode({
    type: 'TEXT', name: 'Heading', description: 'Hero',
    properties: { fontName: { family: 'Inter', style: 'Bold' }, fontSize: 48 },
  }), figma);
  assert.deepEqual(loaded, [{ family: 'Inter', style: 'Bold' }]);
  assert.equal(result.name, 'Heading');
  assert.equal(result.fontSize, 48);
});

test('style list and update resolve local styles without REST', async () => {
  const style = { id: 'S:2', key: 'k', type: 'PAINT', remote: false, name: 'Brand', description: '', paints: [] };
  const figma = { ...emptyLists, getLocalPaintStylesAsync: async () => [style], getStyleByIdAsync: async () => null };
  assert.equal((await execute(styleListCode({ type: 'paint' }), figma))[0].id, 'S:2');
  const updated = await execute(styleUpdateCode({ style: 'Brand', type: 'PAINT', name: 'Primary', properties: { paints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] } }), figma);
  assert.equal(updated.name, 'Primary');
  assert.equal(updated.paints.length, 1);
});

test('style apply, consumers, and publish status call the official async APIs', async () => {
  const calls = [];
  const node = { id: '1:2', name: 'Card', type: 'FRAME', setFillStyleIdAsync: async (id) => calls.push(id) };
  const style = {
    id: 'S:3', key: 'k', type: 'PAINT', remote: false, name: 'Surface', description: '', paints: [],
    getStyleConsumersAsync: async () => [{ node, fields: ['fillStyleId'] }],
    getPublishStatusAsync: async () => 'CURRENT',
  };
  const figma = { ...emptyLists, getStyleByIdAsync: async () => style, getNodeByIdAsync: async () => node };
  const applied = await execute(styleApplyCode({ style: 'S:3', nodeIds: '1:2', field: 'fill' }), figma);
  assert.deepEqual(calls, ['S:3']);
  assert.equal(applied.applied[0].id, '1:2');
  const consumers = await execute(styleConsumersCode({ style: 'S:3' }), figma);
  assert.deepEqual(consumers.consumers[0].fields, ['fillStyleId']);
  assert.equal((await execute(stylePublishStatusCode({ style: 'S:3' }), figma)).publishStatus, 'CURRENT');
});
