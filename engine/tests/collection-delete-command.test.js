import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  collectionDeleteCommandCode,
  collectionDeletePlanRoute,
  executeCollectionDelete,
  executeCollectionDeletePlan,
} from '../src/application/collection-delete-command.js';
import {
  acceptsCollectionDeleteArgv,
  collectionDeleteArgvFromRequest,
  parseCollectionDeleteRequest,
} from '../src/application/collection-delete-request.js';

function fixture({ removeFails = false, leaveVariable = false, postInvalid = false } = {}) {
  let removed = false;
  let collectionReads = 0;
  const variable = { id: 'VariableID:1', variableCollectionId: 'VariableCollectionId:1' };
  const collection = {
    id: 'VariableCollectionId:1', key: 'key', name: 'Disposable', remote: false,
    isExtension: false, hiddenFromPublishing: false, defaultModeId: 'ModeId:1',
    modes: [{ modeId: 'ModeId:1', name: 'Mode 1' }], variableIds: [variable.id],
    getPublishStatusAsync: async () => 'UNPUBLISHED',
    remove() { if (removeFails) throw new Error('remove failed'); removed = true; },
  };
  const figma = { variables: {
    getLocalVariableCollectionsAsync: async () => {
      collectionReads++;
      if (postInvalid && removed && collectionReads === 2) return null;
      return removed ? [] : [collection];
    },
    getLocalVariablesAsync: async () => removed && !leaveVariable ? [] : [variable],
  } };
  return { collection, figma, variable };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${collectionDeleteCommandCode(request)};`)(figma);
}

test('Collection Delete request is closed and canonical', () => {
  assert.deepEqual(parseCollectionDeleteRequest(['collections', 'delete', '--', '-Disposable']),
    { collection: '-Disposable' });
  assert.deepEqual(collectionDeleteArgvFromRequest({ collection: 'Disposable' }),
    ['col', 'delete', '--', 'Disposable']);
  for (const args of [
    ['col', 'delete'], ['col', 'delete', 'one', 'two'],
    ['col', 'delete', '--future', 'private-value'],
  ]) assert.equal(acceptsCollectionDeleteArgv(args), false, args.join(' '));
});

test('Collection Delete verifies complete removal and preserves legacy output', async () => {
  const state = fixture();
  const serialized = await runCode({ collection: 'Disposable' }, state.figma);
  const result = await executeCollectionDelete({ collection: 'Disposable' }, {
    evaluate: async () => serialized,
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    id: state.collection.id, name: 'Disposable', variableCount: 1,
  });
  assert.equal(result.result.status, 'deleted');
});

test('Collection Delete distinguishes unchanged, irreversible applied, and partial residue', async () => {
  for (const [state, expected] of [
    [fixture({ removeFails: true }), 'unchanged'],
    [fixture({ postInvalid: true }), 'irreversible-applied'],
    [fixture({ leaveVariable: true }), 'partial-residue'],
  ]) {
    const serialized = await runCode({ collection: 'Disposable' }, state.figma);
    await assert.rejects(
      () => executeCollectionDelete({ collection: 'Disposable' }, {
        evaluate: async () => serialized,
      }),
      (error) => error.mutationOutcome === expected
        && error.collectionDeleteMutationReport.variableCount === 1,
    );
  }
});

test('Collection Delete rejects inconsistent preflight and malformed results', async () => {
  const state = fixture();
  state.collection.variableIds.push('VariableID:missing');
  await assert.rejects(() => runCode({ collection: 'Disposable' }, state.figma),
    /inconsistent Variable membership/);
  await assert.rejects(
    () => executeCollectionDelete({ collection: 'Disposable' }, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
});

test('Collection Delete accepts only authentic non-retrying Plans', async () => {
  const cli = planFigmaCommand(['col', 'delete', 'Disposable'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['col', 'delete', '--', 'Disposable'], { adapter: 'mcp' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(collectionDeletePlanRoute(cli), 'command-application');
  const state = fixture();
  const serialized = await runCode({ collection: 'Disposable' }, state.figma);
  assert.equal((await executeCollectionDeletePlan(cli, {
    evaluate: async () => serialized,
  })).result.status, 'deleted');
  await assert.rejects(() => executeCollectionDeletePlan({ ...cli }, {
    evaluate: async () => serialized,
  }), /requires a Command Plan created by the Capability Catalog/);
});
