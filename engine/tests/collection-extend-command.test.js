import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectionExtendArgvFromRequest,
  collectionExtendCommandCode,
  collectionExtendPlanRoute,
  executeCollectionExtend,
  executeCollectionExtendPlan,
} from '../src/application/collection-extend-command.js';
import { parseCollectionExtendRequest } from '../src/application/collection-extend-request.js';
import { planFigmaCommand } from '../../src/capability-catalog.js';

const evaluate = (code, figma) => new Function('figma', `return ${code}`)(figma);

function fixture({ badTopology = false, removeFails = false } = {}) {
  const collections = [];
  let nextId = 2;
  const extension = (name, {
    parentId = 'C:1', rootId = 'C:1', parentModeId = 'M:1', variableIds = ['V:1'],
  } = {}) => {
    const value = {
      id: `C:${nextId++}`, key: `extended-key-${nextId}`, name,
      remote: false, isExtension: true, hiddenFromPublishing: false,
      defaultModeId: `EM:${nextId}`,
      modes: [{ modeId: `EM:${nextId}`, name: 'Light', parentModeId }],
      variableIds, parentVariableCollectionId: parentId,
      rootVariableCollectionId: rootId,
      getPublishStatusAsync: async () => 'UNPUBLISHED',
      remove() {
        if (removeFails) throw new Error('remove failed');
        collections.splice(collections.findIndex((item) => item.id === this.id), 1);
      },
    };
    collections.push(value);
    return value;
  };
  const source = {
    id: 'C:1', key: 'source-key', name: 'Primitives', remote: false,
    isExtension: false, hiddenFromPublishing: false, defaultModeId: 'M:1',
    modes: [{ modeId: 'M:1', name: 'Light' }], variableIds: ['V:1'],
    getPublishStatusAsync: async () => 'CURRENT',
    extend(name) {
      return extension(name, badTopology ? { parentId: 'C:wrong' } : {});
    },
  };
  collections.push(source);
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [...collections],
      extendLibraryCollectionByKeyAsync: async (_key, name) => extension(name, {
        parentId: 'C:library', rootId: 'C:library', parentModeId: 'M:library', variableIds: [],
      }),
    },
  };
  return { collections, figma, source };
}

test('Collection Extension request is closed and canonical', () => {
  assert.deepEqual(parseCollectionExtendRequest(['col', 'extend', 'Primitives', 'Brand']), {
    collection: 'Primitives', name: 'Brand',
  });
  assert.deepEqual(collectionExtendArgvFromRequest({ collection: '-source', name: '-brand' }), [
    'col', 'extend', '--', '-source', '-brand',
  ]);
  for (const args of [
    ['col', 'extend'], ['col', 'extend', 'Primitives'],
    ['col', 'extend', '--future', 'private-value'],
    ['col', 'extend', 'Primitives', 'Brand', 'extra'],
  ]) assert.throws(() => parseCollectionExtendRequest(args));
});

test('Collection Extension validates local inheritance and preserves legacy mode topology', async () => {
  const { figma } = fixture();
  const result = await executeCollectionExtend({ collection: 'Primitives', name: 'Brand' }, {
    evaluate: (code) => evaluate(code, figma),
  });
  assert.equal(result.result.resolution, 'name');
  assert.equal(result.result.source.id, 'C:1');
  assert.equal(result.result.collection.parentVariableCollectionId, 'C:1');
  assert.equal(result.result.collection.rootVariableCollectionId, 'C:1');
  const output = JSON.parse(result.stdout);
  assert.equal(output.name, 'Brand');
  assert.equal(output.isExtension, true);
  assert.equal(output.modes[0].parentModeId, 'M:1');
  assert.equal(Object.hasOwn(output, 'parentVariableCollectionId'), false);
});

test('Collection Extension supports a published library key without weakening local ambiguity', async () => {
  const { figma, collections, source } = fixture();
  const result = await executeCollectionExtend({ collection: 'LIBRARY_KEY', name: 'Market' }, {
    evaluate: (code) => evaluate(code, figma),
  });
  assert.equal(result.result.resolution, 'library-key');
  assert.equal(result.result.source.kind, 'library-key');
  collections.push({ ...source, id: 'C:other', name: 'Primitive aliases' });
  await assert.rejects(() => executeCollectionExtend({ collection: 'Primitive', name: 'Nope' }, {
    evaluate: (code) => evaluate(code, figma),
  }), /ambiguous/i);
});

test('Collection Extension removes a created Collection after guarded topology failure', async () => {
  const { figma, collections } = fixture({ badTopology: true });
  await assert.rejects(
    () => executeCollectionExtend({ collection: 'Primitives', name: 'Brand' }, {
      evaluate: (code) => evaluate(code, figma),
    }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.created === 1 && error.mutationReport.removed === 1,
  );
  assert.deepEqual(collections.map((item) => item.id), ['C:1']);
});

test('Collection Extension reports one possible residue when cleanup fails', async () => {
  const { figma } = fixture({ badTopology: true, removeFails: true });
  await assert.rejects(
    () => executeCollectionExtend({ collection: 'Primitives', name: 'Brand' }, {
      evaluate: (code) => evaluate(code, figma),
    }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );
});

test('Collection Extension rejects malformed bounded results', async () => {
  for (const serialized of [
    'not json',
    JSON.stringify({ schemaVersion: 1, status: 'extended' }),
    JSON.stringify({ schemaVersion: 1, status: 'mutation-failed', cleanup: 'removed', residue: [{}] }),
  ]) {
    await assert.rejects(() => executeCollectionExtend({ collection: 'Primitives', name: 'Brand' }, {
      evaluate: async () => serialized,
    }), /invalid/i);
  }
  assert.match(collectionExtendCommandCode({ collection: 'Primitives', name: 'Brand' }), /parentModeId/);
});

test('Collection Extension accepts only authentic non-retrying Plans', async () => {
  const plan = planFigmaCommand(['col', 'extend', 'Primitives', 'Brand']);
  assert.equal(collectionExtendPlanRoute(plan), 'command-application');
  assert.equal(plan.execution.retry, 'never');
  assert.throws(() => collectionExtendPlanRoute({ ...plan }));
  const { figma } = fixture();
  const result = await executeCollectionExtendPlan(plan, {
    evaluate: (code) => evaluate(code, figma),
  });
  assert.equal(result.result.status, 'extended');
});
