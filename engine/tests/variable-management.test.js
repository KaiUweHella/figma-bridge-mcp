import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectionModeCode, collectionUpdateCode, parseBoolean, parseCodePlatform,
  parseScopes, variableCodeSyntaxCode, variableResolveCode, variableSetValueCode,
  variableShowCode, variableUpdateCode,
} from '../src/lib/variable-management.js';

const execute = (code, figma) => new Function('figma', `return ${code}`)(figma);

function fixture(type = 'FLOAT') {
  const collection = {
    id: 'C:1', key: 'ck', name: 'Primitives', remote: false, isExtension: false,
    hiddenFromPublishing: false, defaultModeId: 'M:1', variableIds: ['V:1'],
    modes: [{ modeId: 'M:1', name: 'Light' }],
    getPublishStatusAsync: async () => 'CHANGED',
    addMode(name) { const modeId = `M:${this.modes.length + 1}`; this.modes.push({ modeId, name }); return modeId; },
    renameMode(id, name) { this.modes.find((mode) => mode.modeId === id).name = name; },
    removeMode(id) { this.modes = this.modes.filter((mode) => mode.modeId !== id); },
  };
  const variable = {
    id: 'V:1', key: 'vk', name: 'space/md', description: '', resolvedType: type,
    remote: false, variableCollectionId: collection.id, hiddenFromPublishing: false,
    scopes: ['ALL_SCOPES'], codeSyntax: {}, valuesByMode: { 'M:1': type === 'FLOAT' ? 8 : '#unset' },
    getPublishStatusAsync: async () => 'CURRENT',
    setValueForMode(mode, value) { this.valuesByMode[mode] = value; },
    setVariableCodeSyntax(platform, value) { this.codeSyntax[platform] = value; },
    removeVariableCodeSyntax(platform) { delete this.codeSyntax[platform]; },
    resolveForConsumer: () => ({ value: 8, resolvedType: type }),
  };
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection], getLocalVariablesAsync: async () => [variable],
      getVariableCollectionByIdAsync: async (id) => id === collection.id ? collection : null,
      getVariableByIdAsync: async (id) => id === variable.id ? variable : null,
      createVariableAlias: (target) => ({ type: 'VARIABLE_ALIAS', id: target.id }),
    },
    getNodeByIdAsync: async () => ({ id: '1:2', name: 'Card', type: 'FRAME' }),
  };
  return { collection, variable, figma };
}

test('variable metadata parsers are strict and match current plugin typings', () => {
  assert.equal(parseBoolean('false'), false);
  assert.equal(parseCodePlatform('ios'), 'iOS');
  assert.deepEqual(parseScopes('font_size, line_height'), ['FONT_SIZE', 'LINE_HEIGHT']);
  assert.throws(() => parseScopes('made_up'), /Unknown variable scopes/);
});

test('variable show and update expose metadata, modes, values, scopes, and publish status', async () => {
  const { variable, figma } = fixture();
  const shown = await execute(variableShowCode({ variable: 'space/md' }), figma);
  assert.equal(shown.collection.name, 'Primitives');
  assert.equal(shown.publishStatus, 'CURRENT');
  const updated = await execute(variableUpdateCode({ variable: 'V:1', description: 'Medium space', hidden: true, scopes: ['GAP'] }), figma);
  assert.equal(variable.description, 'Medium space');
  assert.equal(updated.hiddenFromPublishing, true);
  assert.deepEqual(updated.scopes, ['GAP']);
});

test('variable values parse by resolved type and aliases use createVariableAlias', async () => {
  const { variable, figma } = fixture();
  const result = await execute(variableSetValueCode({ variable: 'V:1', mode: 'Light', value: '12' }), figma);
  assert.equal(result.value, 12);
  await execute(variableSetValueCode({ variable: 'V:1', mode: 'M:1', alias: 'V:1' }), figma);
  assert.deepEqual(variable.valuesByMode['M:1'], { type: 'VARIABLE_ALIAS', id: 'V:1' });
});

test('code syntax, consumer resolution, collection metadata, and modes stay plugin-first', async () => {
  const { collection, variable, figma } = fixture();
  const syntax = await execute(variableCodeSyntaxCode({ variable: 'V:1', platform: 'web', value: 'var(--space-md)' }), figma);
  assert.equal(syntax.codeSyntax.WEB, 'var(--space-md)');
  const resolved = await execute(variableResolveCode({ variable: 'V:1', nodeId: '1:2' }), figma);
  assert.equal(resolved.consumer.name, 'Card');
  await execute(collectionUpdateCode({ collection: 'Primitives', name: 'Core', hidden: true }), figma);
  assert.equal(collection.name, 'Core');
  const withMode = await execute(collectionModeCode({ collection: 'C:1', action: 'add', name: 'Dark' }), figma);
  assert.equal(withMode.modes.at(-1).name, 'Dark');
  assert.equal(variable.codeSyntax.WEB, 'var(--space-md)');
});
