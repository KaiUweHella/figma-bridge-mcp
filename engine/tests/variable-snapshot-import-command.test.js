import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeVariableSnapshotImport,
  prepareVariableSnapshotImport,
  variableSnapshotImportCode,
} from '../src/application/variable-snapshot-import-command.js';

function fixture() {
  return {
    schemaVersion: 2,
    kind: 'figma-variable-snapshot',
    complete: true,
    collections: [
      {
        handle: 'collection:one', name: 'Theme', hiddenFromPublishing: false,
        defaultMode: 'collection:one/mode:light',
        modes: [
          { handle: 'collection:one/mode:light', name: 'Light' },
          { handle: 'collection:one/mode:dark', name: 'Dark' },
        ],
        variables: [
          {
            handle: 'collection:one/variable:color', name: 'color/base', type: 'COLOR',
            description: 'Base', hiddenFromPublishing: false, scopes: ['ALL_FILLS'],
            codeSyntax: { WEB: '--base' },
            values: {
              'collection:one/mode:light': { r: 1, g: 1, b: 1, a: 1 },
              'collection:one/mode:dark': { r: 0, g: 0, b: 0, a: 1 },
            },
          },
          {
            handle: 'collection:one/variable:alias', name: 'color/alias', type: 'COLOR',
            description: '', hiddenFromPublishing: true, scopes: ['ALL_SCOPES'], codeSyntax: {},
            values: {
              'collection:one/mode:light': { $alias: {
                status: 'local', collection: 'collection:two',
                variable: 'collection:two/variable:target',
              } },
            },
          },
        ],
      },
      {
        handle: 'collection:two', name: 'Theme', hiddenFromPublishing: true,
        defaultMode: 'collection:two/mode:base',
        modes: [{ handle: 'collection:two/mode:base', name: 'Base' }],
        variables: [{
          handle: 'collection:two/variable:target', name: 'color/base', type: 'COLOR',
          description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
          values: { 'collection:two/mode:base': '#336699' },
        }],
      },
    ],
  };
}

function pluginFixture({ existingName = null, failOn = null, foreignOnFailure = false } = {}) {
  let next = 1;
  const collections = new Map();
  const variables = new Map();
  const makeCollection = (name) => {
    const id = `CollectionID:${next++}`;
    const collection = {
      id, name, remote: false, hiddenFromPublishing: false,
      defaultModeId: `${id}:default`,
      modes: [{ modeId: `${id}:default`, name: 'Mode 1' }], variableIds: [],
      renameMode(modeId, nameValue) {
        const mode = this.modes.find((entry) => entry.modeId === modeId);
        if (!mode) throw new Error('missing mode');
        mode.name = nameValue;
      },
      addMode(nameValue) {
        const modeId = `${id}:mode:${this.modes.length + 1}`;
        this.modes.push({ modeId, name: nameValue }); return modeId;
      },
      remove() {
        collections.delete(id);
        for (const variableId of [...this.variableIds]) variables.get(variableId)?.remove();
      },
    };
    collections.set(id, collection); return collection;
  };
  const makeVariable = (name, collection, type) => {
    const id = `VariableID:${next++}`;
    const variable = {
      id, name, resolvedType: type, remote: false, variableCollectionId: collection.id,
      description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'],
      codeSyntax: {}, valuesByMode: {},
      setVariableCodeSyntax(platform, value) { this.codeSyntax[platform] = value; },
      setValueForMode(modeId, value) {
        this.valuesByMode[modeId] = value;
        if (failOn === name) {
          if (foreignOnFailure) makeVariable('foreign/unrelated', collection, 'FLOAT');
          throw new Error('injected value failure');
        }
      },
      remove() {
        variables.delete(id);
        collection.variableIds = collection.variableIds.filter((entry) => entry !== id);
      },
    };
    variables.set(id, variable); collection.variableIds.push(id); return variable;
  };
  if (existingName) makeCollection(existingName);
  const figma = { variables: {
    getLocalVariableCollectionsAsync: async () => [...collections.values()],
    getLocalVariablesAsync: async () => [...variables.values()],
    getVariableCollectionByIdAsync: async (id) => collections.get(id) || null,
    getVariableByIdAsync: async (id) => variables.get(id) || null,
    createVariableCollection: (name) => makeCollection(name),
    createVariable: (name, collection, type) => makeVariable(name, collection, type),
    createVariableAlias: (target) => ({ type: 'VARIABLE_ALIAS', id: target.id }),
  } };
  return { figma, collections, variables };
}

const evaluate = (figma) => async (code) =>
  new Function('figma', `return ${code};`)(figma);

test('Variable Snapshot v2 preflight is complete, exact and happens before evaluation', () => {
  const prepared = prepareVariableSnapshotImport(fixture());
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(prepared.collections.length, 2);

  const incomplete = fixture();
  incomplete.complete = false;
  assert.throws(() => prepareVariableSnapshotImport(incomplete), /incomplete/);

  const unresolved = fixture();
  unresolved.collections[0].variables[1].values['collection:one/mode:light'] = {
    $alias: { status: 'unresolved', sourceId: 'VariableID:external' },
  };
  assert.throws(() => prepareVariableSnapshotImport(unresolved), /unresolved external Alias/);

  const composed = fixture();
  composed.collections[0].variables[1].values['collection:one/mode:light'].$alias.opacity = 42;
  assert.throws(() => prepareVariableSnapshotImport(composed),
    /public Figma Plugin API cannot write composed color values/);

  const nonFirstDefault = fixture();
  nonFirstDefault.collections[0].defaultMode = 'collection:one/mode:dark';
  assert.throws(() => prepareVariableSnapshotImport(nonFirstDefault), /non-first default mode/);

  const transportOversized = fixture();
  transportOversized.collections[0].variables = Array.from({ length: 306 }, (_entry, index) => ({
    handle: `collection:one/variable:large-${index}`,
    name: `large-${index}`, type: 'STRING', description: '',
    hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
    values: { 'collection:one/mode:light': 'x'.repeat(16_384) },
  }));
  assert.throws(() => prepareVariableSnapshotImport(transportOversized), /5 MiB transport envelope/);

  const escapeOversized = fixture();
  escapeOversized.collections[0].variables = Array.from({ length: 120 }, (_entry, index) => ({
    handle: `collection:one/variable:escaped-${index}`,
    name: `escaped-${index}`, type: 'STRING', description: '',
    hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
    values: { 'collection:one/mode:light': '"'.repeat(16_384) },
  }));
  assert.throws(() => prepareVariableSnapshotImport(escapeOversized), /5 MiB transport envelope/);
});

test('generated Variable Snapshot importer is a two-pass journaled exact transaction', () => {
  const code = variableSnapshotImportCode(fixture());
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /createVariableCollection/);
  assert.match(code, /createVariableAlias/);
  assert.match(code, /target already contains/);
  assert.match(code, /journaled\('collection'/);
  assert.match(code, /for \(let index = journal\.length - 1/);
  assert.match(code, /getVariableCollectionByIdAsync/);
  assert.match(code, /getLocalVariablesAsync/);
  assert.match(code, /could not verify exact mode values/);
});

test('Variable Snapshot importer creates duplicate Collection names and cross-Collection aliases exactly', async () => {
  const live = pluginFixture();
  const result = await executeVariableSnapshotImport(fixture(), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'complete');
  assert.equal(live.collections.size, 2);
  assert.equal(live.variables.size, 3);
  assert.deepEqual([...live.collections.values()].map((collection) => collection.name),
    ['Theme', 'Theme']);
  assert.deepEqual([...live.collections.values()][0].modes.map((mode) => mode.name),
    ['Light', 'Dark']);
  const alias = [...live.variables.values()].find((variable) => variable.name === 'color/alias');
  const target = [...live.variables.values()].find((variable) =>
    variable.variableCollectionId === [...live.collections.values()][1].id);
  assert.deepEqual(Object.values(alias.valuesByMode)[0], {
    type: 'VARIABLE_ALIAS', id: target.id,
  });
  const base = [...live.variables.values()].find((variable) => variable.name === 'color/base'
    && variable.variableCollectionId === [...live.collections.values()][0].id);
  assert.equal(base.description, 'Base');
  assert.deepEqual(base.scopes, ['ALL_FILLS']);
  assert.deepEqual(base.codeSyntax, { WEB: '--base' });
});

test('Variable Snapshot importer conflicts before writes and rolls back the complete journal', async () => {
  const conflict = pluginFixture({ existingName: 'Theme' });
  await assert.rejects(
    () => executeVariableSnapshotImport(fixture(), { evaluate: evaluate(conflict.figma) }),
    /never merges by display name/,
  );
  assert.equal(conflict.collections.size, 1);
  assert.equal(conflict.variables.size, 0);

  const failing = pluginFixture({ failOn: 'color/alias' });
  await assert.rejects(
    () => executeVariableSnapshotImport(fixture(), { evaluate: evaluate(failing.figma) }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.residueCount === 0,
  );
  assert.equal(failing.collections.size, 0);
  assert.equal(failing.variables.size, 0);

  const concurrent = pluginFixture({
    failOn: 'color/alias', foreignOnFailure: true,
  });
  await assert.rejects(
    () => executeVariableSnapshotImport(fixture(), { evaluate: evaluate(concurrent.figma) }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1
      && error.mutationReport.residue[0].kind === 'collection',
  );
  assert.equal([...concurrent.collections.values()].length, 1);
  assert.deepEqual([...concurrent.variables.values()].map((variable) => variable.name),
    ['foreign/unrelated']);
});

test('Variable Snapshot importer accepts only an exact bounded success result', async () => {
  const result = await executeVariableSnapshotImport(fixture(), {
    evaluate: async () => JSON.stringify({
      schemaVersion: 1, status: 'complete', collections: 2,
      variables: 3, aliases: 1, residue: 0,
    }),
  });
  assert.match(result.stdout, /Imported 3 Variable\(s\) across 2 Collection\(s\)/);
  for (const payload of [
    { schemaVersion: 1, status: 'complete', collections: 1, variables: 3, aliases: 1, residue: 0 },
    { schemaVersion: 1, status: 'complete', collections: 2, variables: 3, aliases: 0, residue: 0 },
    { schemaVersion: 1, status: 'complete', collections: 2, variables: 3, aliases: 1, residue: 0, extra: true },
  ]) {
    await assert.rejects(
      () => executeVariableSnapshotImport(fixture(), {
        evaluate: async () => JSON.stringify(payload),
      }),
      /invalid bounded result/,
    );
  }
});

test('Variable Snapshot importer projects rolled-back and residue outcomes truthfully', async () => {
  const rolledBack = {
    schemaVersion: 1, status: 'failed', outcome: 'rolled-back', attempted: 2,
    removed: [0, 1], residue: { total: 0, indexes: [], items: [], omitted: 0 },
    failure: 'setter failed',
  };
  await assert.rejects(
    () => executeVariableSnapshotImport(fixture(), {
      evaluate: async () => JSON.stringify(rolledBack),
    }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.created === 2 && error.mutationReport.removed === 2,
  );

  const residue = {
    schemaVersion: 1, status: 'failed', outcome: 'partial-residue', attempted: 3,
    removed: [0, 1], residue: { total: 1, indexes: [2], items: [{
      kind: 'variable', handle: 'collection:one/variable:color', id: 'VariableID:1',
      journalIndex: 2,
    }], omitted: 0 }, failure: 'remove failed',
  };
  await assert.rejects(
    () => executeVariableSnapshotImport(fixture(), {
      evaluate: async () => JSON.stringify(residue),
    }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );

  const forgedJournal = structuredClone(residue);
  forgedJournal.residue.items[0].kind = 'collection';
  await assert.rejects(
    () => executeVariableSnapshotImport(fixture(), {
      evaluate: async () => JSON.stringify(forgedJournal),
    }),
    /invalid bounded result/,
  );
});
