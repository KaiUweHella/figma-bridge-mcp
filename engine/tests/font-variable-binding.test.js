import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fontVariableBindingCode,
  parseTypographyField,
  TYPOGRAPHY_VARIABLE_FIELDS,
} from '../src/lib/font-introspection.js';

function fixture({ variableType = 'FLOAT', valuesByMode = {} } = {}) {
  const calls = [];
  const variable = {
    id: 'VariableID:1:7', name: 'type/weight', resolvedType: variableType,
    variableCollectionId: 'col:1', valuesByMode,
  };
  const node = {
    id: '1:2', name: 'Label', type: 'TEXT', characters: 'Hello',
    fontName: { family: 'Inter', style: 'Regular' }, boundVariables: {},
    getRangeAllFontNames: () => [{ family: 'Inter', style: 'Regular' }],
    setBoundVariable(field, value) {
      calls.push(['whole', field, value]);
      if (value) this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: value.id };
      else delete this.boundVariables[field];
    },
    setRangeBoundVariable(start, end, field, value) {
      calls.push(['range', start, end, field, value]);
      this.rangeAlias = value ? { type: 'VARIABLE_ALIAS', id: value.id } : null;
    },
    getRangeBoundVariable: () => node.rangeAlias || null,
  };
  const figma = {
    mixed: Symbol('mixed'),
    getNodeByIdAsync: async () => node,
    loadFontAsync: async (font) => calls.push(['font', font]),
    variables: {
      getVariableByIdAsync: async (id) => id === variable.id ? variable : null,
      getLocalVariableCollectionsAsync: async () => [{ id: 'col:1', name: 'Typography' }],
      getLocalVariablesAsync: async () => [variable],
    },
  };
  return { figma, node, variable, calls };
}

test('typography fields accept kebab-case aliases and carry the documented types', () => {
  assert.equal(parseTypographyField('font-weight'), 'fontWeight');
  assert.equal(parseTypographyField('lineHeight'), 'lineHeight');
  assert.equal(TYPOGRAPHY_VARIABLE_FIELDS.fontFamily, 'STRING');
  assert.equal(TYPOGRAPHY_VARIABLE_FIELDS.fontSize, 'FLOAT');
  assert.throws(() => parseTypographyField('width'), /Unknown typography field/);
});

test('font bind loads current fonts and binds a variable to a text range', async () => {
  const { figma, variable, calls } = fixture();
  const code = fontVariableBindingCode({
    nodeId: '1:2', field: 'fontWeight', variableName: variable.id, start: 1, end: 4,
  });
  const result = await new Function('figma', `return ${code}`)(figma);
  assert.deepEqual(calls[0], ['font', { family: 'Inter', style: 'Regular' }]);
  assert.deepEqual(calls[1], ['range', 1, 4, 'fontWeight', variable]);
  assert.deepEqual(result.range, { start: 1, end: 4 });
  assert.equal(result.variable.name, 'type/weight');
  assert.match(result.note, /not a general variable-axis setter/);
});

test('font bind resolves an unambiguous local name and enforces variable type', async () => {
  const ok = fixture({ variableType: 'STRING' });
  const result = await new Function('figma', `return ${fontVariableBindingCode({
    nodeId: '1:2', field: 'font-family', variableName: 'weight', collection: 'Typography',
  })}`)(ok.figma);
  assert.equal(result.field, 'fontFamily');
  assert.equal(ok.calls.at(-1)[0], 'whole');

  const bad = fixture({ variableType: 'STRING' });
  await assert.rejects(new Function('figma', `return ${fontVariableBindingCode({
    nodeId: '1:2', field: 'fontWeight', variableName: 'weight',
  })}`)(bad.figma), /needs a FLOAT variable/);
});

test('font-family binding preloads styles from every concrete target family', async () => {
  const { figma, calls } = fixture({ variableType: 'STRING', valuesByMode: { light: 'Roboto Flex' } });
  figma.listAvailableFontsAsync = async () => [
    { fontName: { family: 'Inter', style: 'Bold' } },
    { fontName: { family: 'Roboto Flex', style: 'Regular' } },
    { fontName: { family: 'Unrelated', style: 'Regular' } },
  ];
  await new Function('figma', `return ${fontVariableBindingCode({
    nodeId: '1:2', field: 'fontFamily', variableName: 'weight',
  })}`)(figma);
  const loaded = calls.filter(([kind]) => kind === 'font').map(([, font]) => font);
  assert.deepEqual(loaded, [
    { family: 'Inter', style: 'Regular' },
    { family: 'Inter', style: 'Bold' },
    { family: 'Roboto Flex', style: 'Regular' },
  ]);
});

test('font unbind passes null and validates the live range', async () => {
  const { figma, calls } = fixture();
  const result = await new Function('figma', `return ${fontVariableBindingCode({
    nodeId: '1:2', field: 'lineHeight', start: 0, end: 5, unbind: true,
  })}`)(figma);
  assert.deepEqual(calls.at(-1), ['range', 0, 5, 'lineHeight', null]);
  assert.equal(result.unbound, true);

  await assert.rejects(new Function('figma', `return ${fontVariableBindingCode({
    nodeId: '1:2', field: 'lineHeight', start: 0, end: 9, unbind: true,
  })}`)(figma), /outside text length/);
});
