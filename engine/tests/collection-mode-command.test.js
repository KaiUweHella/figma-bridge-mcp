import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  collectionModeCommandCode,
  collectionModePlanRoute,
  executeCollectionMode,
  executeCollectionModePlan,
} from '../src/application/collection-mode-command.js';
import {
  acceptsCollectionModeArgv,
  collectionModeArgvFromRequest,
  parseCollectionModeRequest,
} from '../src/application/collection-mode-request.js';

function fixture({
  secondMode = false, publishFails = false, removeFails = false, renameRestoreFails = false,
} = {}) {
  let publishCalls = 0;
  let renameCalls = 0;
  const modes = [{ modeId: 'ModeId:default', name: 'Light' }];
  if (secondMode) modes.push({ modeId: 'ModeId:dark', name: 'Dark' });
  const variable = {
    id: 'VariableID:1', variableCollectionId: 'VariableCollectionId:1',
    valuesByMode: {
      'ModeId:default': 12,
      ...(secondMode ? { 'ModeId:dark': 16 } : {}),
    },
  };
  const collection = {
    id: 'VariableCollectionId:1', key: 'collection-key', name: 'Primitives',
    remote: false, isExtension: false, hiddenFromPublishing: false,
    defaultModeId: 'ModeId:default', modes, variableIds: [variable.id],
    async getPublishStatusAsync() {
      publishCalls++;
      if (publishFails && publishCalls > 1) throw new Error('publish failed');
      return 'CURRENT';
    },
    addMode(name) {
      const modeId = 'ModeId:created';
      this.modes.push({ modeId, name });
      return modeId;
    },
    renameMode(modeId, name) {
      renameCalls++;
      if (renameRestoreFails && renameCalls > 1) throw new Error('restore failed');
      this.modes.find((mode) => mode.modeId === modeId).name = name;
    },
    removeMode(modeId) {
      if (removeFails) throw new Error('remove failed');
      this.modes = this.modes.filter((mode) => mode.modeId !== modeId);
      delete variable.valuesByMode[modeId];
    },
  };
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
      getLocalVariablesAsync: async () => [variable],
    },
  };
  return { collection, figma, variable };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${collectionModeCommandCode(request)};`)(figma);
}

test('Collection Mode request closes and canonicalizes all three actions', () => {
  assert.deepEqual(parseCollectionModeRequest([
    'collections', 'mode-add', '--', '-Primitives', ' Dark ',
  ]), { action: 'add', collection: '-Primitives', mode: null, name: 'Dark' });
  assert.deepEqual(parseCollectionModeRequest([
    'col', 'mode-rename', 'Primitives', 'Dark', 'Night',
  ]), { action: 'rename', collection: 'Primitives', mode: 'Dark', name: 'Night' });
  assert.deepEqual(collectionModeArgvFromRequest({
    action: 'remove', collection: 'Primitives', mode: 'Night',
  }), ['col', 'mode-remove', '--', 'Primitives', 'Night']);
  for (const args of [
    ['col', 'mode-add', 'Primitives'],
    ['col', 'mode-add', '--future', 'private-value', 'Dark'],
    ['col', 'mode-rename', 'Primitives', 'Dark'],
    ['col', 'mode-rename', 'Primitives', 'Dark', '   '],
    ['col', 'mode-remove', 'Primitives', 'Dark', 'extra'],
  ]) assert.equal(acceptsCollectionModeArgv(args), false, args.join(' '));
});

test('Collection Mode add, rename, and remove preserve exact legacy Collection Facts', async () => {
  const addState = fixture();
  const addPayload = await runCode({
    action: 'add', collection: 'Primitives', name: 'Dark',
  }, addState.figma);
  const added = await executeCollectionMode({
    action: 'add', collection: 'Primitives', name: 'Dark',
  }, { evaluate: async () => addPayload });
  assert.equal(added.result.affectedMode.name, 'Dark');
  assert.equal(JSON.parse(added.stdout).modes.at(-1).name, 'Dark');
  assert.equal(Object.hasOwn(JSON.parse(added.stdout), 'schemaVersion'), false);

  const renameState = fixture({ secondMode: true });
  const renamePayload = await runCode({
    action: 'rename', collection: 'Primitives', mode: 'Dark', name: 'Night',
  }, renameState.figma);
  const renamed = await executeCollectionMode({
    action: 'rename', collection: 'Primitives', mode: 'Dark', name: 'Night',
  }, { evaluate: async () => renamePayload });
  assert.equal(renamed.result.affectedMode.name, 'Night');

  const removeState = fixture({ secondMode: true });
  const removePayload = await runCode({
    action: 'remove', collection: 'Primitives', mode: 'Dark',
  }, removeState.figma);
  const removed = await executeCollectionMode({
    action: 'remove', collection: 'Primitives', mode: 'Dark',
  }, { evaluate: async () => removePayload });
  assert.equal(removed.result.affectedVariableCount, 1);
  assert.equal(removed.result.collection.modes.some((mode) => mode.name === 'Dark'), false);
  assert.equal(Object.hasOwn(removeState.variable.valuesByMode, 'ModeId:dark'), false);
});

test('Collection Mode add and rename own rollback and report cleanup residue', async () => {
  const addRollback = fixture({ publishFails: true });
  const addPayload = await runCode({
    action: 'add', collection: 'Primitives', name: 'Dark',
  }, addRollback.figma);
  assert.equal(addRollback.collection.modes.length, 1);
  await assert.rejects(
    () => executeCollectionMode({
      action: 'add', collection: 'Primitives', name: 'Dark',
    }, { evaluate: async () => addPayload }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.collectionModeMutationReport.residueCount === 0,
  );

  const addResidue = fixture({ publishFails: true, removeFails: true });
  const addResiduePayload = await runCode({
    action: 'add', collection: 'Primitives', name: 'Dark',
  }, addResidue.figma);
  await assert.rejects(
    () => executeCollectionMode({
      action: 'add', collection: 'Primitives', name: 'Dark',
    }, { evaluate: async () => addResiduePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.collectionModeMutationReport.restoreReason === 'remove-failed',
  );

  const renameRollback = fixture({ secondMode: true, publishFails: true });
  const renamePayload = await runCode({
    action: 'rename', collection: 'Primitives', mode: 'Dark', name: 'Night',
  }, renameRollback.figma);
  assert.equal(renameRollback.collection.modes[1].name, 'Dark');
  await assert.rejects(
    () => executeCollectionMode({
      action: 'rename', collection: 'Primitives', mode: 'Dark', name: 'Night',
    }, { evaluate: async () => renamePayload }),
    (error) => error.mutationOutcome === 'rolled-back',
  );

  const renameResidue = fixture({
    secondMode: true, publishFails: true, renameRestoreFails: true,
  });
  const renameResiduePayload = await runCode({
    action: 'rename', collection: 'Primitives', mode: 'Dark', name: 'Night',
  }, renameResidue.figma);
  await assert.rejects(
    () => executeCollectionMode({
      action: 'rename', collection: 'Primitives', mode: 'Dark', name: 'Night',
    }, { evaluate: async () => renameResiduePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.collectionModeMutationReport.restoreReason === 'rename-restore-failed',
  );
});

test('Collection Mode remove reports unchanged versus irreversible-applied truthfully', async () => {
  const unchanged = fixture({ secondMode: true, removeFails: true });
  const unchangedPayload = await runCode({
    action: 'remove', collection: 'Primitives', mode: 'Dark',
  }, unchanged.figma);
  await assert.rejects(
    () => executeCollectionMode({
      action: 'remove', collection: 'Primitives', mode: 'Dark',
    }, { evaluate: async () => unchangedPayload }),
    (error) => error.mutationOutcome === 'unchanged'
      && error.collectionModeMutationReport.affectedVariableCount === 1,
  );

  const applied = fixture({ secondMode: true, publishFails: true });
  const appliedPayload = await runCode({
    action: 'remove', collection: 'Primitives', mode: 'Dark',
  }, applied.figma);
  assert.equal(applied.collection.modes.length, 1);
  await assert.rejects(
    () => executeCollectionMode({
      action: 'remove', collection: 'Primitives', mode: 'Dark',
    }, { evaluate: async () => appliedPayload }),
    (error) => error.mutationOutcome === 'irreversible-applied'
      && error.collectionModeMutationReport.restoreReason === 'no-reversal-api'
      && error.collectionModeMutationReport.residueCount === 1,
  );
});

test('Collection Mode rejects malformed results and accepts only authentic Plans', async () => {
  await assert.rejects(
    () => executeCollectionMode({
      action: 'add', collection: 'Primitives', name: 'Dark',
    }, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  for (const [cliArgv, mcpArgv] of [
    [
      ['col', 'mode-add', 'Primitives', 'Dark'],
      ['col', 'mode-add', '--', 'Primitives', 'Dark'],
    ],
    [
      ['col', 'mode-rename', 'Primitives', 'Dark', 'Night'],
      ['col', 'mode-rename', '--', 'Primitives', 'Dark', 'Night'],
    ],
    [
      ['col', 'mode-remove', 'Primitives', 'Dark'],
      ['col', 'mode-remove', '--', 'Primitives', 'Dark'],
    ],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.confirmation, 'configured');
    assert.equal(collectionModePlanRoute(cli), 'command-application');
  }
  const plan = planFigmaCommand(['col', 'mode-add', 'Primitives', 'Dark']);
  const { figma } = fixture();
  const serialized = await runCode({
    action: 'add', collection: 'Primitives', name: 'Dark',
  }, figma);
  assert.equal((await executeCollectionModePlan(plan, {
    evaluate: async () => serialized,
  })).result.affectedMode.name, 'Dark');
  await assert.rejects(
    () => executeCollectionModePlan({ ...plan }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(collectionModePlanRoute(planFigmaCommand(['col', 'show', 'Primitives'])),
    'not-collection-mode');
});
