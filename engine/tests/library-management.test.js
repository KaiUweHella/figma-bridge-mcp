import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  importComponentCode, importStyleCode, importVariableCode, libraryCollectionsCode,
  libraryVariablesCode, parseLibraryVariableType, requirePublishKey,
} from '../src/lib/library-management.js';

const execute = (code, figma) => new Function('figma', `return ${code}`)(figma);

function fixture() {
  const collections = [
    { key: 'COL_B', name: 'Tokens', libraryName: 'Zeta' },
    { key: 'COL_A', name: 'Primitives', libraryName: 'Acme' },
  ];
  const variables = [
    { key: 'VAR_SPACE', name: 'space/md', resolvedType: 'FLOAT' },
    { key: 'VAR_COLOR', name: 'color/brand', resolvedType: 'COLOR' },
  ];
  const calls = [];
  const figma = {
    teamLibrary: {
      getAvailableLibraryVariableCollectionsAsync: async () => collections,
      getVariablesInLibraryCollectionAsync: async (key) => { calls.push(['variables', key]); return variables; },
    },
    variables: {
      importVariableByKeyAsync: async (key) => {
        calls.push(['variable', key]);
        return { id: 'V:1', key, name: 'space/md', resolvedType: 'FLOAT', remote: true, variableCollectionId: 'C:1' };
      },
      getVariableCollectionByIdAsync: async () => ({ id: 'C:1', key: 'COL_A', name: 'Primitives', remote: true }),
    },
    importStyleByKeyAsync: async (key) => {
      calls.push(['style', key]);
      return { id: 'S:1', key, name: 'Brand', type: 'PAINT', remote: true, description: 'Brand paint' };
    },
    importComponentByKeyAsync: async (key) => {
      calls.push(['component', key]);
      return { id: 'N:1', key, name: 'Button', type: 'COMPONENT', remote: true, description: '' };
    },
    importComponentSetByKeyAsync: async (key) => {
      calls.push(['component-set', key]);
      return { id: 'N:2', key, name: 'Button', type: 'COMPONENT_SET', remote: true, description: '' };
    },
  };
  return { calls, figma };
}

test('library input validation matches the installed Plugin API types', () => {
  assert.equal(parseLibraryVariableType('color'), 'COLOR');
  assert.equal(parseLibraryVariableType(undefined), null);
  assert.throws(() => parseLibraryVariableType('NUMBER'), /must be one of/);
  assert.equal(requirePublishKey(' key-1 '), 'key-1');
  assert.throws(() => requirePublishKey('  '), /non-empty published library key/);
});

test('the shipped plugin declares Figma team-library permission', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../plugin/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('teamlibrary'));
});

test('enabled collections are reported deterministically with library identity', async () => {
  const { figma } = fixture();
  const result = await execute(libraryCollectionsCode(), figma);
  assert.deepEqual(result.map((item) => `${item.libraryName}/${item.name}`), ['Acme/Primitives', 'Zeta/Tokens']);
});

test('library discovery owns a named timeout below the daemon deadline', () => {
  const code = libraryCollectionsCode();
  assert.match(code, /did not respond within 18s/);
  assert.match(code, /getAvailableLibraryVariableCollectionsAsync/);
  assert.match(code, /clearTimeout/);
});

test('variables resolve collection by key or unambiguous name and filter by type', async () => {
  const { calls, figma } = fixture();
  const result = await execute(libraryVariablesCode({ collection: 'COL_A', type: 'float' }), figma);
  assert.equal(result.collection.libraryName, 'Acme');
  assert.deepEqual(result.variables, [{ key: 'VAR_SPACE', name: 'space/md', resolvedType: 'FLOAT' }]);
  assert.deepEqual(calls, [['variables', 'COL_A']]);
});

test('published variable and style imports use their native key APIs', async () => {
  const { calls, figma } = fixture();
  const variable = await execute(importVariableCode({ key: 'VAR_SPACE' }), figma);
  const style = await execute(importStyleCode({ key: 'STYLE_BRAND' }), figma);
  assert.equal(variable.collection.name, 'Primitives');
  assert.equal(style.type, 'PAINT');
  assert.deepEqual(calls, [['variable', 'VAR_SPACE'], ['style', 'STYLE_BRAND']]);
});

test('component and component-set imports remain distinct operations', async () => {
  const { calls, figma } = fixture();
  assert.equal((await execute(importComponentCode({ key: 'COMP_BUTTON' }), figma)).kind, 'COMPONENT');
  assert.equal((await execute(importComponentCode({ key: 'SET_BUTTON', set: true }), figma)).kind, 'COMPONENT_SET');
  assert.deepEqual(calls, [['component', 'COMP_BUTTON'], ['component-set', 'SET_BUTTON']]);
});
