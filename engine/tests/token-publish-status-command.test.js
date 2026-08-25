import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeTokenPublishStatus,
  executeTokenPublishStatusPlan,
  tokenPublishStatusCode,
  tokenPublishStatusPlanRoute,
} from '../src/application/token-publish-status-command.js';
import {
  acceptsTokenPublishStatusArgv,
  parseTokenPublishStatusRequest,
  tokenPublishStatusArgvFromRequest,
} from '../src/application/token-publish-status-request.js';

function fixture() {
  const collections = [
    {
      id: 'VariableCollectionId:1:1', name: 'Primitives',
      getPublishStatusAsync: async () => 'CURRENT',
    },
    {
      id: 'VariableCollectionId:2:1', name: 'Semantic',
      getPublishStatusAsync: async () => 'UNPUBLISHED',
    },
  ];
  const variables = [
    {
      id: 'VariableID:1:2', name: 'space/md', variableCollectionId: collections[0].id,
      getPublishStatusAsync: async () => 'CHANGED',
    },
    {
      id: 'VariableID:2:2', name: 'layout/md', variableCollectionId: collections[1].id,
      getPublishStatusAsync: async () => 'CURRENT',
    },
  ];
  return {
    collections,
    variables,
    figma: {
      variables: {
        getLocalVariableCollectionsAsync: async () => collections,
        getVariableCollectionByIdAsync: async (id) =>
          collections.find((collection) => collection.id === id) || null,
        getLocalVariablesAsync: async () => variables,
        getVariableByIdAsync: async (id) =>
          variables.find((variable) => variable.id === id) || null,
      },
    },
  };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${tokenPublishStatusCode(request)};`)(figma);
}

test('Token Publish Status request closes both command shapes and preserves literals', () => {
  assert.deepEqual(parseTokenPublishStatusRequest([
    'var', 'publish-status', '--collection=Primitives', '--', '-md',
  ]), { kind: 'variable', query: '-md', collection: 'Primitives' });
  assert.deepEqual(parseTokenPublishStatusRequest([
    'collections', 'publish-status', '--', '-Theme',
  ]), { kind: 'collection', query: '-Theme', collection: null });
  assert.deepEqual(tokenPublishStatusArgvFromRequest({
    kind: 'variable', query: '-md', collection: '-Primitives',
  }), ['var', 'publish-status', '--collection=-Primitives', '--', '-md']);
  for (const args of [
    ['var', 'publish-status'],
    ['var', 'publish-status', 'one', 'two'],
    ['var', 'publish-status', '--collection'],
    ['col', 'publish-status', '--collection', 'Theme', 'Theme'],
    ['col', 'publish-status', '--future', 'private-value'],
  ]) assert.equal(acceptsTokenPublishStatusArgv(args), false, args.join(' '));
});

test('Token Publish Status preserves legacy projection for Variable and Collection reads', async () => {
  const { figma } = fixture();
  const variableSerialized = await runCode({
    kind: 'variable', query: 'md', collection: 'Primitives',
  }, figma);
  const variable = await executeTokenPublishStatus({
    kind: 'variable', query: 'md', collection: 'Primitives',
  }, { evaluate: async () => variableSerialized });
  assert.deepEqual(JSON.parse(variable.stdout), {
    id: 'VariableID:1:2', name: 'space/md', publishStatus: 'CHANGED',
  });
  assert.equal(variable.result.resolution, 'tail-name');
  assert.equal(variable.result.collectionResolution, 'exact-name');

  const collectionSerialized = await runCode({
    kind: 'collection', query: 'VariableCollectionId:2:1',
  }, figma);
  const collection = await executeTokenPublishStatus({
    kind: 'collection', query: 'VariableCollectionId:2:1',
  }, { evaluate: async () => collectionSerialized });
  assert.deepEqual(JSON.parse(collection.stdout), {
    id: 'VariableCollectionId:2:1', name: 'Semantic', publishStatus: 'UNPUBLISHED',
  });
  assert.equal(collection.result.resolution, 'id');
});

test('Token Publish Status rejects ambiguity and self-inconsistent Plugin results', async () => {
  const { figma } = fixture();
  await assert.rejects(
    () => runCode({ kind: 'variable', query: 'md' }, figma),
    /Ambiguous variable.*2 matches/,
  );
  const malformed = JSON.stringify({
    schemaVersion: 1,
    kind: 'variable',
    resolution: 'exact-name',
    query: 'space/md',
    collectionHint: 'Primitives',
    collectionResolution: 'id',
    subject: {
      id: 'VariableID:1:2', name: 'space/md',
      collection: { id: 'VariableCollectionId:1:1', name: 'Primitives' },
    },
    publishStatus: 'CURRENT',
  });
  await assert.rejects(
    () => executeTokenPublishStatus({
      kind: 'variable', query: 'space/md', collection: 'Primitives',
    }, { evaluate: async () => malformed }),
    /invalid bounded result/,
  );
  await assert.rejects(
    () => executeTokenPublishStatus({ kind: 'collection', query: 'Semantic' }, {
      evaluate: async () => '{}',
    }),
    /invalid bounded result/,
  );
});

test('Token Publish Status accepts only authentic policy-identical safe-read Plans', async () => {
  const variable = planFigmaCommand([
    'var', 'publish-status', 'space/md', '--collection', 'Primitives',
  ], { adapter: 'mcp' });
  const collection = planFigmaCommand(['col', 'publish-status', 'Semantic'], { adapter: 'mcp' });
  for (const plan of [variable, collection]) {
    assert.equal(plan.allowed, true);
    assert.equal(plan.execution.retry, 'safe-read');
    assert.equal(tokenPublishStatusPlanRoute(plan), 'command-application');
  }
  const { figma } = fixture();
  const serialized = await runCode({
    kind: 'variable', query: 'space/md', collection: 'Primitives',
  }, figma);
  assert.equal((await executeTokenPublishStatusPlan(variable, {
    evaluate: async () => serialized,
  })).result.publishStatus, 'CHANGED');
  await assert.rejects(
    () => executeTokenPublishStatusPlan({ ...variable }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(tokenPublishStatusPlanRoute(planFigmaCommand(['var', 'update', 'space/md'])),
    'not-token-publish-status');
});
