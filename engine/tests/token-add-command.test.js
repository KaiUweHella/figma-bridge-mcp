import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeTokenAdd,
  executeTokenAddPlan,
  tokenAddCommandCode,
  tokenAddPlanRoute,
} from '../src/application/token-add-command.js';
import {
  acceptsTokenAddArgv,
  parseTokenAddRequest,
  tokenAddArgvFromRequest,
} from '../src/application/token-add-request.js';

function fixture({
  existingCollection = false,
  duplicateCollection = false,
  setValueFails = false,
  ignoreValue = false,
  ignoreScope = false,
  staleCreated = false,
  removeVariableFails = false,
  removeCollectionFails = false,
  foreignOnCleanup = false,
  normalizeOpaqueColor = false,
  removedLookupThrows = false,
} = {}) {
  const collections = [];
  const variables = [];
  let collectionSequence = 0;
  let variableSequence = 0;
  let foreignAdded = false;
  const makeCollection = (name) => {
    const collection = {
      id: `VariableCollectionId:${++collectionSequence}`, name, remote: false,
      defaultModeId: 'ModeId:light', removed: false, variableIds: [],
      modes: [
        { modeId: 'ModeId:dark', name: 'Dark' },
        { modeId: 'ModeId:light', name: 'Light' },
      ],
      remove() {
        if (removeCollectionFails) throw new Error('collection remove failed');
        this.removed = true;
        for (const variable of variables) {
          if (variable.variableCollectionId === this.id) variable.removed = true;
        }
      },
    };
    collections.push(collection);
    return collection;
  };
  const target = existingCollection ? makeCollection('Tokens') : null;
  if (duplicateCollection) makeCollection('Tokens');
  const makeVariable = (name, collection, type) => {
    let scopes = ['ALL_SCOPES'];
    const variable = {
      id: `VariableID:${++variableSequence}`, key: `key-${variableSequence}`,
      name, remote: false, resolvedType: type,
      variableCollectionId: collection.id, valuesByMode: {}, removed: false,
      setValueForMode(modeId, value) {
        if (setValueFails) throw new Error('set failed');
        if (!ignoreValue) {
          const stored = structuredClone(value);
          if (normalizeOpaqueColor && type === 'COLOR' && stored.a === undefined) stored.a = 1;
          this.valuesByMode[modeId] = stored;
        }
      },
      remove() {
        if (removeVariableFails) throw new Error('variable remove failed');
        this.removed = true;
        if (removedLookupThrows) {
          collection.variableIds = collection.variableIds.filter((id) => id !== this.id);
        }
      },
    };
    Object.defineProperty(variable, 'scopes', {
      get() { return scopes; },
      set(value) { if (!ignoreScope) scopes = value; },
      enumerable: true,
    });
    variables.push(variable);
    collection.variableIds.push(variable.id);
    return variable;
  };
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => collections.filter((item) => !item.removed),
      getVariableCollectionByIdAsync: async (id) => {
        const collection = collections.find((item) => item.id === id && !item.removed) || null;
        if (foreignOnCleanup && collection && !foreignAdded && variables.length) {
          foreignAdded = true;
          const foreign = makeVariable('foreign/member', collection, 'STRING');
          foreign.valuesByMode['ModeId:light'] = 'owned elsewhere';
        }
        return collection;
      },
      getVariableByIdAsync: async (id) => {
        if (removedLookupThrows && variables.some((item) => item.id === id && item.removed)) {
          throw new Error('removed Variable lookup rejected');
        }
        const variable = variables.find((item) => item.id === id && !item.removed) || null;
        if (staleCreated && variable && variable.valuesByMode['ModeId:light'] !== undefined) {
          variable.removed = true;
          return null;
        }
        return variable;
      },
      createVariableCollection: makeCollection,
      createVariable: makeVariable,
    },
  };
  return { collections, variables, target, figma, makeCollection, makeVariable };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${tokenAddCommandCode(request)};`)(figma);
}

test('Token Add request closes options and preserves legacy type inference', () => {
  assert.deepEqual(parseTokenAddRequest(['tokens', 'add', 'brand/name', '#ff0000']), {
    name: 'brand/name', value: { r: 1, g: 0, b: 0 }, collection: 'Tokens',
    type: 'COLOR', allowDuplicate: false,
  });
  assert.equal(parseTokenAddRequest(['tokens', 'add', 'size', '4']).type, 'FLOAT');
  assert.equal(parseTokenAddRequest(['tokens', 'add', 'enabled', 'FALSE']).type, 'BOOLEAN');
  assert.equal(parseTokenAddRequest(['tokens', 'add', 'label', 'four']).type, 'STRING');
  assert.deepEqual(parseTokenAddRequest(['tokens', 'add', '-cMotion', '-tTIMING', '--',
    'duration/fast', '-0']), {
    name: 'duration/fast', value: -0, collection: 'Motion', type: 'TIMING', allowDuplicate: false,
  });
  assert.deepEqual(tokenAddArgvFromRequest({ name: '-offset', value: '-4' }), [
    'tokens', 'add', '--collection=Tokens', '--type=FLOAT', '--', '-offset', '-4',
  ]);
  for (const args of [
    ['tokens', 'add'], ['tokens', 'add', 'name'], ['tokens', 'add', 'n', 'v', 'extra'],
    ['tokens', 'add', '--future', 'n', 'v'], ['tokens', 'add', '-c', 'Only'],
    ['tokens', 'add', '-cOne', '-cTwo', 'n', 'v'],
    ['tokens', 'add', '--allow-duplicate', '--allow-duplicate', 'n', 'v'],
  ]) assert.equal(acceptsTokenAddArgv(args), false, args.join(' '));
  assert.throws(() => tokenAddArgvFromRequest({ name: "bad\nname", value: 'x' }),
    /control characters/);
  assert.throws(() => tokenAddArgvFromRequest({ name: 'x', value: 'x'.repeat(16_385) }),
    /at most 16384/);
});

test('Token Add journals auto-Collection and Variable in the declared default mode', async () => {
  const target = fixture();
  const name = "radius/x';throw new Error('injected');//";
  const request = { name, value: '6', collection: 'Tokens' };
  const serialized = await runCode(request, target.figma);
  const result = await executeTokenAdd(request, { evaluate: async () => serialized });
  assert.equal(result.stdout, `Created float token: ${name}`);
  assert.equal(result.stderr, '');
  assert.equal(result.result.collection.created, true);
  assert.equal(result.result.collection.modeId, 'ModeId:light');
  assert.deepEqual(result.result.variable.scopes, ['CORNER_RADIUS']);
  assert.equal(target.variables[0].valuesByMode['ModeId:light'], 6);
  assert.equal(Object.hasOwn(target.variables[0].valuesByMode, 'ModeId:dark'), false);
});

test('Token Add preserves unrestricted ambiguous scopes and returns a host warning', async () => {
  const target = fixture({ normalizeOpaqueColor: true });
  const request = { name: 'brand/primary', value: '#336699' };
  const serialized = await runCode(request, target.figma);
  const result = await executeTokenAdd(request, { evaluate: async () => serialized });
  assert.deepEqual(result.result.variable.scopes, ['ALL_SCOPES']);
  assert.match(result.stderr, /SCOPE DECISION REQUIRED/);
  assert.match(result.stderr, /ALL_FILLS/);
});

test('Token Add scopes duplicates to the exact target Collection and keeps explicit utility', async () => {
  const target = fixture({ existingCollection: true });
  const other = target.makeCollection('Other');
  target.makeVariable('size/md', other, 'FLOAT');
  const request = { name: 'size/md', value: '16', collection: 'Tokens' };
  const first = await runCode(request, target.figma);
  assert.equal((await executeTokenAdd(request, { evaluate: async () => first }))
    .result.duplicateCountBefore, 0);
  await assert.rejects(() => runCode(request, target.figma), /exact name already exists/);
  const duplicateRequest = { ...request, allowDuplicate: true };
  const duplicate = await runCode(duplicateRequest, target.figma);
  assert.equal((await executeTokenAdd(duplicateRequest, { evaluate: async () => duplicate }))
    .result.duplicateCountBefore, 1);
  assert.equal(target.variables.filter((item) => item.variableCollectionId === target.target.id
    && item.name === 'size/md').length, 2);

  const ambiguous = fixture({ existingCollection: true, duplicateCollection: true });
  await assert.rejects(() => runCode(request, ambiguous.figma), /Collection name is ambiguous/);
  assert.equal(ambiguous.variables.length, 0);
});

test('Token Add rolls back ignored setters and reports exact partial residue', async () => {
  for (const target of [fixture({ setValueFails: true }), fixture({ ignoreValue: true }),
    fixture({ ignoreScope: true }), fixture({ staleCreated: true }),
    fixture({ setValueFails: true, removedLookupThrows: true })]) {
    const request = { name: 'radius/md', value: '6' };
    const payload = await runCode(request, target.figma);
    await assert.rejects(() => executeTokenAdd(request, { evaluate: async () => payload }),
      (error) => error.mutationOutcome === 'rolled-back'
        && error.mutationReport.residueCount === 0);
    assert.ok(target.collections.every((item) => item.removed));
  }

  const residue = fixture({ existingCollection: true, setValueFails: true,
    removeVariableFails: true });
  const request = { name: 'radius/md', value: '6' };
  const payload = await runCode(request, residue.figma);
  await assert.rejects(() => executeTokenAdd(request, { evaluate: async () => payload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1);
  assert.equal(residue.target.removed, false);

  const foreign = fixture({ setValueFails: true, foreignOnCleanup: true });
  const foreignPayload = await runCode(request, foreign.figma);
  await assert.rejects(() => executeTokenAdd(request, { evaluate: async () => foreignPayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residue.some((item) => item.kind === 'collection'));
  assert.equal(foreign.collections[0].removed, false);
  assert.equal(foreign.variables.some((item) => item.name === 'foreign/member'
    && !item.removed), true);
});

test('Token Add rejects forged results and accepts only its authentic Plan', async () => {
  await assert.rejects(() => executeTokenAdd({ name: 'x', value: '4' }, {
    evaluate: async () => '{}',
  }), /invalid bounded result/);
  const target = fixture();
  const request = { name: 'spacing/md', value: '16' };
  const authentic = JSON.parse(await runCode(request, target.figma));
  const forged = structuredClone(authentic);
  forged.variable.scopes = ['ALL_SCOPES'];
  await assert.rejects(() => executeTokenAdd(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);

  const cli = planFigmaCommand(['tokens', 'add', 'spacing/md', '16'], { adapter: 'cli' });
  const mcp = planFigmaCommand(tokenAddArgvFromRequest(request), { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(tokenAddPlanRoute(cli), 'command-application');
  const planTarget = fixture();
  const serialized = await runCode(request, planTarget.figma);
  assert.equal((await executeTokenAddPlan(cli, { evaluate: async () => serialized }))
    .result.variable.name, 'spacing/md');
  await assert.rejects(() => executeTokenAddPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/);
});
