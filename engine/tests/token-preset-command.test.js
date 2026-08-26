import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeTokenPreset,
  executeTokenPresetPlan,
  tokenPresetCommandCode,
  tokenPresetPlanRoute,
} from '../src/application/token-preset-command.js';
import {
  acceptsTokenPresetArgv,
  parseTokenPresetRequest,
  tokenPresetArgvFromRequest,
} from '../src/application/token-preset-request.js';

function fixture({
  existingCollection = false,
  duplicateCollection = false,
  existingVariables = [],
  setValueFailsAt = null,
  removeVariableFailsAt = null,
  ignoreScopeAssignments = false,
  staleExistingAtVerification = false,
  retainRemovedReadback = false,
  staleMembershipOnRemove = false,
  foreignOnCleanup = false,
} = {}) {
  const collections = [];
  const variables = [];
  let collectionSequence = 0;
  let variableSequence = 0;
  let setCalls = 0;
  let foreignAdded = false;
  const variableReads = new Map();
  const makeCollection = (name) => {
    const collection = {
      id: `VariableCollectionId:${++collectionSequence}`, name, remote: false,
      defaultModeId: 'ModeId:light', removed: false,
      variableIds: [],
      modes: [
        { modeId: 'ModeId:dark', name: 'Dark' },
        { modeId: 'ModeId:light', name: 'Light' },
      ],
      remove() {
        this.removed = true;
        for (const variable of variables) {
          if (variable.variableCollectionId === this.id) variable.removed = true;
        }
      },
    };
    collections.push(collection);
    return collection;
  };
  const target = existingCollection ? makeCollection('Radii') : null;
  if (duplicateCollection) makeCollection('Radii');
  const makeVariable = (name, collection, type = 'FLOAT', value = undefined) => {
    const variable = {
      id: `VariableID:${++variableSequence}`, name, remote: false,
      resolvedType: type, variableCollectionId: collection.id,
      valuesByMode: value === undefined ? {} : { 'ModeId:light': value },
      removed: false,
      setValueForMode(modeId, next) {
        setCalls++;
        if (setCalls === setValueFailsAt) throw new Error('set failed');
        this.valuesByMode[modeId] = next;
      },
      remove() {
        if (this.id === removeVariableFailsAt) throw new Error('remove failed');
        this.removed = true;
        if (!staleMembershipOnRemove) {
          collection.variableIds = collection.variableIds.filter((id) => id !== this.id);
        }
      },
    };
    let scopes = ['ALL_SCOPES'];
    Object.defineProperty(variable, 'scopes', {
      get() { return scopes; },
      set(value) { if (!ignoreScopeAssignments) scopes = value; },
      enumerable: true,
    });
    variables.push(variable);
    collection.variableIds.push(variable.id);
    return variable;
  };
  for (const item of existingVariables) {
    makeVariable(item.name, item.collection || target, item.type, item.value);
  }
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => collections.filter((item) => !item.removed),
      getLocalVariablesAsync: async () => variables.filter((item) => !item.removed),
      getVariableCollectionByIdAsync: async (id) => {
        const collection = collections.find((item) => item.id === id && !item.removed) || null;
        if (foreignOnCleanup && collection && !foreignAdded && variables.length) {
          foreignAdded = true;
          const foreign = makeVariable('foreign/member', collection, 'STRING', 'owned elsewhere');
          foreign.scopes = ['ALL_SCOPES'];
        }
        return collection;
      },
      getVariableByIdAsync: async (id) => {
        const variable = variables.find((item) => item.id === id
          && (!item.removed || retainRemovedReadback)) || null;
        const reads = (variableReads.get(id) || 0) + 1;
        variableReads.set(id, reads);
        if (staleExistingAtVerification && reads === 2 && variable?.name === 'radius/none') {
          variable.removed = true;
          return null;
        }
        return variable;
      },
      createVariableCollection: makeCollection,
      createVariable: makeVariable,
    },
  };
  return { collections, variables, target, figma };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${tokenPresetCommandCode(request)};`)(figma);
}

test('Token Preset request closes preset and Collection options', () => {
  assert.deepEqual(parseTokenPresetRequest(['tokens', 'spacing']), {
    preset: 'spacing', collection: 'Spacing',
  });
  assert.deepEqual(parseTokenPresetRequest(['tokens', 'radii', '-cRadii v2']), {
    preset: 'radii', collection: 'Radii v2',
  });
  assert.deepEqual(tokenPresetArgvFromRequest({ preset: 'radii', collection: 'Radius' }),
    ['tokens', 'radii', '--collection=Radius']);
  for (const args of [
    ['tokens', 'colors'], ['tokens', 'spacing', '--future'],
    ['tokens', 'radii', '-cOne', '-cTwo'], ['tokens', 'spacing', 'extra'],
    ['tokens', 'spacing', '-c'], ['tokens', 'radii', '--', '-cLiteral'],
  ]) assert.equal(acceptsTokenPresetArgv(args), false, args.join(' '));
  assert.throws(() => tokenPresetArgvFromRequest({ preset: 'spacing', collection: 'Bad\nName' }),
    /control characters/);
  assert.throws(() => tokenPresetArgvFromRequest({ preset: 'spacing', collection: 'x'.repeat(513) }),
    /at most 512/);
});

test('Token Preset creates a journaled scoped scale in the declared default mode', async () => {
  const target = fixture();
  const request = { preset: 'radii', collection: 'Radii' };
  const serialized = await runCode(request, target.figma);
  const result = await executeTokenPreset(request, { evaluate: async () => serialized });
  assert.equal(result.stdout, 'Created 9 radius variables');
  assert.equal(result.result.collection.created, true);
  assert.equal(result.result.mode.id, 'ModeId:light');
  assert.equal(result.result.created.length, 9);
  assert.ok(target.variables.every((item) => item.scopes[0] === 'CORNER_RADIUS'));
  assert.ok(target.variables.every((item) => Object.hasOwn(item.valuesByMode, 'ModeId:light')));
  assert.ok(target.variables.every((item) => !Object.hasOwn(item.valuesByMode, 'ModeId:dark')));
});

test('Token Preset scopes identity to the target Collection and preserves authored conflicts', async () => {
  const target = fixture({ existingCollection: true });
  const other = target.figma.variables.createVariableCollection('Other');
  target.figma.variables.createVariable('radius/lg', other, 'FLOAT').setValueForMode('ModeId:light', 999);
  const matching = target.figma.variables.createVariable('radius/none', target.target, 'FLOAT');
  matching.setValueForMode('ModeId:light', 0);
  const different = target.figma.variables.createVariable('radius/sm', target.target, 'FLOAT');
  different.setValueForMode('ModeId:light', 200);
  target.figma.variables.createVariable('radius/default', target.target, 'STRING');
  const scopeMismatch = target.figma.variables.createVariable('radius/md', target.target, 'FLOAT');
  scopeMismatch.setValueForMode('ModeId:light', 6);
  scopeMismatch.scopes = ['WIDTH_HEIGHT'];

  const request = { preset: 'radii', collection: 'Radii' };
  const serialized = await runCode(request, target.figma);
  const result = await executeTokenPreset(request, { evaluate: async () => serialized });
  assert.equal(result.result.created.length, 5);
  assert.equal(result.result.existing.length, 4);
  assert.equal(result.result.conflictCount, 3);
  assert.equal(result.result.existing.find((item) => item.name === 'radius/md').state,
    'scope-mismatch');
  assert.match(result.stderr, /Preserved 3 existing preset variables/);
  assert.equal(different.valuesByMode['ModeId:light'], 200);
  assert.equal(target.variables.filter((item) => item.name === 'radius/lg'
    && item.variableCollectionId === target.target.id).length, 1);
});

test('Token Preset completes ambiguity preflight before its first factory', async () => {
  const target = fixture({ existingCollection: true, duplicateCollection: true });
  const collectionCount = target.collections.length;
  await assert.rejects(() => runCode({ preset: 'radii', collection: 'Radii' }, target.figma),
    /Collection name is ambiguous/);
  assert.equal(target.collections.length, collectionCount);
  assert.equal(target.variables.length, 0);

  const duplicateVariable = fixture({ existingCollection: true });
  duplicateVariable.figma.variables.createVariable('radius/none', duplicateVariable.target, 'FLOAT');
  duplicateVariable.figma.variables.createVariable('radius/none', duplicateVariable.target, 'FLOAT');
  const variableCount = duplicateVariable.variables.length;
  await assert.rejects(() => runCode({ preset: 'radii', collection: 'Radii' },
    duplicateVariable.figma), /Variable name is ambiguous/);
  assert.equal(duplicateVariable.variables.length, variableCount);
});

test('Token Preset rolls back a new Collection and reports existing-Collection residue', async () => {
  const createdCollection = fixture({ setValueFailsAt: 2 });
  const request = { preset: 'radii', collection: 'Radii' };
  const rolledBackPayload = await runCode(request, createdCollection.figma);
  await assert.rejects(() => executeTokenPreset(request, {
    evaluate: async () => rolledBackPayload,
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.residueCount === 0);
  assert.ok(createdCollection.collections.every((item) => item.removed));
  assert.ok(createdCollection.variables.every((item) => item.removed));

  const ignoredScope = fixture({ ignoreScopeAssignments: true });
  const ignoredPayload = await runCode(request, ignoredScope.figma);
  await assert.rejects(() => executeTokenPreset(request, { evaluate: async () => ignoredPayload }),
    (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  assert.ok(ignoredScope.collections.every((item) => item.removed));

  const tombstoned = fixture({
    existingCollection: true, setValueFailsAt: 2, retainRemovedReadback: true,
  });
  const tombstonedPayload = await runCode(request, tombstoned.figma);
  await assert.rejects(() => executeTokenPreset(request, {
    evaluate: async () => tombstonedPayload,
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.residueCount === 0);
  assert.deepEqual(tombstoned.target.variableIds, []);

  const stale = fixture({ existingCollection: true, staleExistingAtVerification: true });
  const staleVariable = stale.figma.variables.createVariable('radius/none', stale.target, 'FLOAT');
  staleVariable.setValueForMode('ModeId:light', 0);
  const stalePayload = await runCode(request, stale.figma);
  await assert.rejects(() => executeTokenPreset(request, { evaluate: async () => stalePayload }),
    (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  assert.ok(stale.variables.filter((item) => item.id !== staleVariable.id)
    .every((item) => item.removed));

  const existing = fixture({
    existingCollection: true, setValueFailsAt: 2, removeVariableFailsAt: 'VariableID:1',
  });
  const residuePayload = await runCode(request, existing.figma);
  await assert.rejects(() => executeTokenPreset(request, { evaluate: async () => residuePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1);

  const staleMembership = fixture({
    existingCollection: true, setValueFailsAt: 2, staleMembershipOnRemove: true,
  });
  const staleMembershipPayload = await runCode(request, staleMembership.figma);
  await assert.rejects(() => executeTokenPreset(request, {
    evaluate: async () => staleMembershipPayload,
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount === 2);

  const foreign = fixture({ setValueFailsAt: 2, foreignOnCleanup: true });
  const foreignPayload = await runCode(request, foreign.figma);
  await assert.rejects(() => executeTokenPreset(request, {
    evaluate: async () => foreignPayload,
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residue.some((item) => item.kind === 'collection'));
  assert.equal(foreign.collections[0].removed, false);
  assert.equal(foreign.variables.some((item) => item.name === 'foreign/member'
    && !item.removed), true);
});

test('Token Preset rejects forged results and accepts only authentic Plans', async () => {
  await assert.rejects(() => executeTokenPreset({ preset: 'spacing' }, {
    evaluate: async () => '{}',
  }), /invalid bounded result/);
  await assert.rejects(() => executeTokenPreset({ preset: 'radii', collection: 'Radii' }, {
    evaluate: async () => JSON.stringify({
      schemaVersion: 1, status: 'failed', outcome: 'partial-residue',
      attempted: [
        { kind: 'variable', id: 'VariableID:1', name: 'radius/none' },
        { kind: 'variable', id: 'VariableID:1', name: 'radius/sm' },
      ], removed: [], residue: [
        { kind: 'variable', id: 'VariableID:1', name: 'radius/none' },
        { kind: 'variable', id: 'VariableID:1', name: 'radius/sm' },
      ], residueTruncated: false,
    }),
  }), /invalid bounded result/);
  const target = fixture();
  const authentic = JSON.parse(await runCode({ preset: 'radii', collection: 'Radii' }, target.figma));
  const forgedState = structuredClone(authentic);
  forgedState.collection.created = false;
  const stateItem = forgedState.created.pop();
  forgedState.existing.push({ ...stateItem, resolvedType: 'STRING', state: 'matching' });
  await assert.rejects(() => executeTokenPreset({ preset: 'radii', collection: 'Radii' }, {
    evaluate: async () => JSON.stringify(forgedState),
  }), /invalid bounded result/);
  const forgedCreatedCollection = structuredClone(authentic);
  forgedCreatedCollection.created.pop();
  forgedCreatedCollection.existing.push({
    ...authentic.created[0], state: 'matching',
  });
  await assert.rejects(() => executeTokenPreset({ preset: 'radii', collection: 'Radii' }, {
    evaluate: async () => JSON.stringify(forgedCreatedCollection),
  }), /invalid bounded result/);
  const cli = planFigmaCommand(['tokens', 'spacing', '-cSpacing'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['tokens', 'spacing', '--collection=Spacing'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.equal(cli.execution.retry, 'never');
  assert.equal(tokenPresetPlanRoute(cli), 'command-application');
  const planTarget = fixture();
  const serialized = await runCode({ preset: 'spacing', collection: 'Spacing' }, planTarget.figma);
  assert.equal((await executeTokenPresetPlan(cli, { evaluate: async () => serialized })).result.expectedCount, 27);
  await assert.rejects(() => executeTokenPresetPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/);
});
