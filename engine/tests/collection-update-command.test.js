import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  collectionUpdateCommandCode,
  collectionUpdatePlanRoute,
  executeCollectionUpdate,
  executeCollectionUpdatePlan,
} from '../src/application/collection-update-command.js';
import {
  acceptsCollectionUpdateArgv,
  collectionUpdateArgvFromRequest,
  parseCollectionUpdateRequest,
} from '../src/application/collection-update-request.js';

function fixture({ publishFails = false, restoreFails = false, invalidFacts = false } = {}) {
  let name = 'Primitives';
  let nameWrites = 0;
  let publishCalls = 0;
  const collection = {
    id: 'VariableCollectionId:1', key: 'collection-key', remote: false,
    isExtension: false, hiddenFromPublishing: false,
    defaultModeId: invalidFacts ? 'ModeId:missing' : 'ModeId:default',
    modes: [{ modeId: 'ModeId:default', name: 'Mode 1' }],
    variableIds: ['VariableID:1'],
    async getPublishStatusAsync() {
      publishCalls++;
      if (publishFails && publishCalls > 1) throw new Error('publish failed');
      return 'CURRENT';
    },
  };
  Object.defineProperty(collection, 'name', {
    enumerable: true,
    get: () => name,
    set(value) {
      nameWrites++;
      if (restoreFails && nameWrites > 1) throw new Error('restore failed');
      name = value;
    },
  });
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
    },
  };
  return { collection, figma, get nameWrites() { return nameWrites; } };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${collectionUpdateCommandCode(request)};`)(figma);
}

test('Collection Update request closes metadata grammar and canonicalizes fields', () => {
  assert.deepEqual(parseCollectionUpdateRequest([
    'collections', 'update', '-n', ' Core ', '--hidden=FALSE', '--', '-Primitives',
  ]), { collection: '-Primitives', name: 'Core', hidden: false });
  assert.deepEqual(collectionUpdateArgvFromRequest({
    collection: 'Primitives', hidden: true,
  }), ['col', 'update', '--hidden', 'true', '--', 'Primitives']);
  for (const args of [
    ['col', 'update', 'Primitives'],
    ['col', 'update', '-n', 'One', '-n', 'Two', 'Primitives'],
    ['col', 'update', '--hidden', 'maybe', 'Primitives'],
    ['col', 'update', '--name', '   ', 'Primitives'],
    ['col', 'update', '--future', 'private-value', 'Primitives'],
    ['col', 'update', '--hidden', 'true', 'one', 'two'],
  ]) assert.equal(acceptsCollectionUpdateArgv(args), false, args.join(' '));
});

test('Collection Update applies every metadata field and preserves exact legacy Facts output', async () => {
  const state = fixture();
  const serialized = await runCode({
    collection: 'Primitives', name: 'Core', hidden: true,
  }, state.figma);
  const result = await executeCollectionUpdate({
    collection: 'Primitives', name: 'Core', hidden: true,
  }, { evaluate: async () => serialized });
  const output = JSON.parse(result.stdout);
  assert.equal(output.name, 'Core');
  assert.equal(output.hiddenFromPublishing, true);
  assert.deepEqual(output.modes, [{ modeId: 'ModeId:default', name: 'Mode 1' }]);
  assert.deepEqual(output.variableIds, ['VariableID:1']);
  assert.equal(Object.hasOwn(output, 'schemaVersion'), false);
  assert.deepEqual(result.result.requestedFields, ['name', 'hiddenFromPublishing']);
});

test('Collection Update restores every requested field after post-write failure', async () => {
  const state = fixture({ publishFails: true });
  const serialized = await runCode({
    collection: 'Primitives', name: 'Core', hidden: true,
  }, state.figma);
  assert.equal(state.collection.name, 'Primitives');
  assert.equal(state.collection.hiddenFromPublishing, false);
  await assert.rejects(
    () => executeCollectionUpdate({
      collection: 'Primitives', name: 'Core', hidden: true,
    }, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.collectionUpdateMutationReport.restored === 2
      && error.collectionUpdateMutationReport.residueCount === 0,
  );
});

test('Collection Update reports failed field restoration and blocks invalid preflight', async () => {
  const residue = fixture({ publishFails: true, restoreFails: true });
  const residuePayload = await runCode({
    collection: 'Primitives', name: 'Core', hidden: true,
  }, residue.figma);
  assert.equal(residue.collection.name, 'Core');
  assert.equal(residue.collection.hiddenFromPublishing, false,
    'later fields still restore after one field fails');
  await assert.rejects(
    () => executeCollectionUpdate({
      collection: 'Primitives', name: 'Core', hidden: true,
    }, { evaluate: async () => residuePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.collectionUpdateMutationReport.restoreFailures[0] === 'name'
      && error.collectionUpdateMutationReport.residueCount === 1,
  );

  const preflight = fixture({ invalidFacts: true });
  await assert.rejects(
    () => runCode({ collection: 'Primitives', name: 'Core' }, preflight.figma),
    /incompatible preflight metadata/,
  );
  assert.equal(preflight.nameWrites, 0);
});

test('Collection Update rejects malformed results and accepts only authentic Plans', async () => {
  await assert.rejects(
    () => executeCollectionUpdate({
      collection: 'Primitives', hidden: false,
    }, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  const cli = planFigmaCommand([
    'col', 'update', '-nCore', '--hidden=false', 'Primitives',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'col', 'update', '--name=Core', '--hidden', 'false', '--', 'Primitives',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(collectionUpdatePlanRoute(cli), 'command-application');
  const { figma } = fixture();
  const serialized = await runCode({
    collection: 'Primitives', name: 'Core', hidden: false,
  }, figma);
  assert.equal((await executeCollectionUpdatePlan(cli, {
    evaluate: async () => serialized,
  })).result.collection.name, 'Core');
  await assert.rejects(
    () => executeCollectionUpdatePlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(collectionUpdatePlanRoute(planFigmaCommand(['col', 'show', 'Primitives'])),
    'not-collection-update');
});
