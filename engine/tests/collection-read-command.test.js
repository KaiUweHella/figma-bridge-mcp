import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  collectionCatalogCode,
  collectionCatalogPlanRoute,
  executeCollectionCatalog,
  executeCollectionCatalogPlan,
} from '../src/application/collection-catalog-command.js';
import {
  acceptsCollectionCatalogArgv,
  collectionCatalogArgvFromRequest,
  parseCollectionCatalogRequest,
} from '../src/application/collection-catalog-request.js';
import {
  collectionFactsCode,
  collectionFactsPlanRoute,
  executeCollectionFacts,
  executeCollectionFactsPlan,
} from '../src/application/collection-facts-command.js';
import {
  acceptsCollectionFactsArgv,
  collectionFactsArgvFromRequest,
  parseCollectionFactsRequest,
} from '../src/application/collection-facts-request.js';

function fixture(overrides = {}) {
  const collections = overrides.collections || [
    {
      id: 'VariableCollectionId:2:1', key: 'key-z', name: 'Zeta', remote: false,
      isExtension: false, hiddenFromPublishing: false, defaultModeId: '2:0',
      modes: [{ modeId: '2:0', name: 'Default' }], variableIds: ['VariableID:2:2'],
      getPublishStatusAsync: async () => 'UNPUBLISHED',
    },
    {
      id: 'VariableCollectionId:1:1', key: 'key-a', name: 'Alpha', remote: false,
      isExtension: true, hiddenFromPublishing: true, defaultModeId: '1:0',
      modes: [{ modeId: '1:0', name: 'Light' }, { modeId: '1:1', name: 'Dark' }],
      variableIds: ['VariableID:1:2', 'VariableID:1:3'],
      getPublishStatusAsync: async () => 'CURRENT',
    },
  ];
  return {
    collections,
    figma: {
      variables: {
        getLocalVariableCollectionsAsync: async () => collections,
        getVariableCollectionByIdAsync: async (id) =>
          collections.find((collection) => collection.id === id) || null,
      },
    },
  };
}

async function runCode(code, figma) {
  return new Function('figma', `return ${code};`)(figma);
}

test('Collection Catalog request closes options and canonicalizes the alias', () => {
  assert.deepEqual(parseCollectionCatalogRequest(['collections', 'list', '--json', '-l2']), {
    limit: 2, json: true,
  });
  assert.deepEqual(collectionCatalogArgvFromRequest({ limit: 2, json: true }), [
    'col', 'list', '--limit', '2', '--json',
  ]);
  for (const argv of [
    ['col', 'list', '--limit', '0'], ['col', 'list', '--json', '--json'],
    ['col', 'list', '--future'], ['col', 'list', 'payload'],
  ]) assert.equal(acceptsCollectionCatalogArgv(argv), false, argv.join(' '));
});

test('Collection Catalog preserves legacy text and optional deterministic identity JSON', async () => {
  const { figma } = fixture();
  const serialized = await runCode(collectionCatalogCode({ limit: 1, json: false }), figma);
  const text = await executeCollectionCatalog({ limit: 1 }, { evaluate: async () => serialized });
  assert.equal(text.stdout, 'Alpha (2 vars)\n(1 more collection(s) omitted — raise --limit)');
  assert.equal(text.result.complete, false);
  assert.equal(text.result.collections[0].id, 'VariableCollectionId:1:1');

  const allSerialized = await runCode(collectionCatalogCode({ limit: 10, json: true }), figma);
  const json = await executeCollectionCatalog({ limit: 10, json: true }, {
    evaluate: async () => allSerialized,
  });
  assert.deepEqual(json.result.collections.map((collection) => collection.name), ['Alpha', 'Zeta']);
  assert.match(json.stdout, /"modeCount": 2/);
  assert.match(json.stdout, /"variableCount": 2/);
});

test('Collection Facts request preserves literal dash names and returns exact bounded facts', async () => {
  assert.deepEqual(parseCollectionFactsRequest(['collections', 'show', '--', '-Theme']), {
    collection: '-Theme',
  });
  assert.deepEqual(collectionFactsArgvFromRequest({ collection: '-Theme' }), [
    'col', 'show', '--', '-Theme',
  ]);
  assert.equal(acceptsCollectionFactsArgv(['col', 'show', '--future']), false);
  assert.equal(acceptsCollectionFactsArgv(['col', 'show', 'A', 'B']), false);

  const { figma } = fixture();
  const serialized = await runCode(collectionFactsCode({ collection: 'Alpha' }), figma);
  const result = await executeCollectionFacts({ collection: 'Alpha' }, {
    evaluate: async () => serialized,
  });
  assert.equal(result.result.schemaVersion, 1);
  assert.equal(result.result.defaultModeId, '1:0');
  assert.deepEqual(result.result.variableIds, ['VariableID:1:2', 'VariableID:1:3']);
  assert.doesNotMatch(result.stdout, /schemaVersion/);
});

test('Collection Facts rejects ambiguity and both reads reject malformed Plugin results', async () => {
  const { figma } = fixture({
    collections: [
      { ...fixture().collections[0], id: 'one', name: 'Theme One' },
      { ...fixture().collections[1], id: 'two', name: 'Theme Two' },
    ],
  });
  await assert.rejects(() => runCode(collectionFactsCode({ collection: 'Theme' }), figma),
    /Ambiguous collection.*2 matches/);

  await assert.rejects(
    () => executeCollectionCatalog({ limit: 10 }, { evaluate: async () => JSON.stringify({}) }),
    /invalid bounded result/,
  );
  const invalidFacts = {
    schemaVersion: 1, id: 'id', key: null, name: 'Bad', remote: false,
    isExtension: false, hiddenFromPublishing: false, defaultModeId: 'missing',
    modes: [{ modeId: 'actual', name: 'Default' }], variableIds: [],
    publishStatus: 'CURRENT',
  };
  await assert.rejects(
    () => executeCollectionFacts({ collection: 'Bad' }, {
      evaluate: async () => JSON.stringify(invalidFacts),
    }),
    /invalid bounded result/,
  );
});

test('Collection reads accept only authentic policy-identical safe-read Plans', async () => {
  const catalog = planFigmaCommand(['col', 'list', '--json', '--limit', '2'], { adapter: 'mcp' });
  const facts = planFigmaCommand(['col', 'show', 'Alpha'], { adapter: 'mcp' });
  assert.equal(catalog.id, 'col.list');
  assert.equal(facts.id, 'col.show');
  assert.equal(catalog.execution.retry, 'safe-read');
  assert.equal(facts.execution.retry, 'safe-read');
  assert.equal(collectionCatalogPlanRoute(catalog), 'command-application');
  assert.equal(collectionFactsPlanRoute(facts), 'command-application');

  const { figma } = fixture();
  const catalogSerialized = await runCode(collectionCatalogCode({ limit: 2, json: true }), figma);
  const factsSerialized = await runCode(collectionFactsCode({ collection: 'Alpha' }), figma);
  assert.equal((await executeCollectionCatalogPlan(catalog, {
    evaluate: async () => catalogSerialized,
  })).result.returned, 2);
  assert.equal((await executeCollectionFactsPlan(facts, {
    evaluate: async () => factsSerialized,
  })).result.name, 'Alpha');
  await assert.rejects(
    () => executeCollectionCatalogPlan({ ...catalog }, { evaluate: async () => catalogSerialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(collectionFactsPlanRoute(planFigmaCommand(['col', 'update', 'Alpha'])),
    'not-collection-facts');
});
