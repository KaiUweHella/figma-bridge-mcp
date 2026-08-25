import assert from 'node:assert/strict';
import test from 'node:test';
import { variableFactsCode } from '../src/application/variable-facts-command.js';
import {
  collectionExtendCode, parseBoolean,
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
    extend(name) { return { ...this, id: 'C:2', name, isExtension: true }; },
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
});

test('collection extension prefers the native local collection and supports a library key', async () => {
  const { figma } = fixture();
  const local = await execute(collectionExtendCode({ collection: 'Primitives', name: 'Brand' }), figma);
  assert.equal(local.name, 'Brand');
  assert.equal(local.isExtension, true);
  figma.variables.extendLibraryCollectionByKeyAsync = async (key, name) => ({
    id: 'C:3', key, name, remote: false, isExtension: true, hiddenFromPublishing: false,
    defaultModeId: 'M:1', modes: [], variableIds: [], getPublishStatusAsync: async () => 'UNPUBLISHED',
  });
  const remote = await execute(collectionExtendCode({ collection: 'LIBRARY_KEY', name: 'Market' }), figma);
  assert.equal(remote.key, 'LIBRARY_KEY');
});

test('variable show exposes metadata, modes, values, scopes, and publish status', async () => {
  const { figma } = fixture();
  const shown = JSON.parse(await execute(variableFactsCode({ variable: 'space/md' }), figma));
  assert.equal(shown.collection.name, 'Primitives');
  assert.equal(shown.publishStatus, 'CURRENT');
});
