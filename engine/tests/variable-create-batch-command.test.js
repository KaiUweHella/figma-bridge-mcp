import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableCreateBatch,
  executeVariableCreateBatchPlan,
  variableCreateBatchCommandCode,
  variableCreateBatchPlanRoute,
} from '../src/application/variable-create-batch-command.js';
import {
  acceptsVariableCreateBatchArgv,
  parseVariableCreateBatchRequest,
  variableCreateBatchArgvFromRequest,
} from '../src/application/variable-create-batch-request.js';

function fixture({
  existing = [], setFailsFor = null, removeFailsFor = null,
  collections = null, float32ColorReadback = false, nativeOpaqueAlphaReadback = false,
  verificationUnavailableAfterRemoval = false,
  nativeValuesByMode = {}, nativeValuesForType = null, easingPresetReadback = false,
  easingPresetBounce = 0.25, scopeSetIgnoredFor = null,
} = {}) {
  const collection = {
    id: 'VariableCollectionId:1', key: 'collection-key', name: 'Tokens', remote: false,
    defaultModeId: 'ModeId:default',
    modes: [
      { modeId: 'ModeId:default', name: 'Light' },
      { modeId: 'ModeId:dark', name: 'Dark' },
    ],
  };
  const created = [];
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => collections || [collection],
      getLocalVariablesAsync: async () => {
        if (verificationUnavailableAfterRemoval && created.length
          && created.every((item) => item.removed)) throw new Error('catalog unavailable');
        return [...existing, ...created].filter((item) => !item.removed);
      },
      getVariableByIdAsync: async (id) => [...existing, ...created]
        .find((item) => item.id === id && !item.removed) || null,
      createVariableAlias(variable) {
        return { type: 'VARIABLE_ALIAS', id: variable.id };
      },
      createVariable(name, target, type) {
        const initialNativeValues = nativeValuesForType
          ? nativeValuesForType(type) : nativeValuesByMode;
        const variable = {
          id: `VariableID:new:${created.length}`, key: '', name, resolvedType: type,
          remote: false, variableCollectionId: target.id,
          description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'],
          valuesByMode: structuredClone(initialNativeValues), removed: false,
          setValueForMode(modeId, value) {
            if (name === setFailsFor) throw new Error('set failed');
            if ((float32ColorReadback || nativeOpaqueAlphaReadback) && type === 'COLOR') {
              this.valuesByMode[modeId] = Object.fromEntries(
                Object.entries(value).map(([key, channel]) => [key, Math.fround(channel)]),
              );
              if (nativeOpaqueAlphaReadback && !Object.hasOwn(value, 'a')) {
                this.valuesByMode[modeId].a = 1;
              }
            } else if (easingPresetReadback && type === 'EASING' && value?.type === 'GENTLE') {
              this.valuesByMode[modeId] = {
                type: 'GENTLE', easingFunctionSpring: { bounce: easingPresetBounce },
              };
            } else this.valuesByMode[modeId] = structuredClone(value);
          },
          remove() {
            if (name === removeFailsFor) throw new Error('remove failed');
            this.removed = true;
          },
        };
        if (name === scopeSetIgnoredFor) {
          Object.defineProperty(variable, 'scopes', {
            enumerable: true, get: () => ['ALL_SCOPES'], set: () => {},
          });
        }
        created.push(variable);
        return variable;
      },
    },
  };
  return { collection, created, figma };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${variableCreateBatchCommandCode(request)};`)(figma);
}

test('Variable Batch Creation closes and canonicalizes a complete bounded batch', () => {
  const parsed = parseVariableCreateBatchRequest([
    'variables', 'create-batch', '-cTokens', '-mDark', '--', JSON.stringify([
      { name: 'color/accent', value: '#1234' },
      { name: 'enabled', type: 'boolean', value: 'false' },
      { name: 'duration', type: 'timing', value: 180, description: 'Seconds', hidden: true },
      { name: 'motion', type: 'easing', value: 'gentle' },
    ]),
  ]);
  assert.deepEqual(parsed, {
    collection: 'Tokens', mode: 'Dark', allowDuplicate: false,
    items: [
      { name: 'color/accent', type: 'COLOR', value: {
        r: 17 / 255, g: 34 / 255, b: 51 / 255, a: 68 / 255,
      } },
      { name: 'enabled', type: 'BOOLEAN', value: false },
      { name: 'duration', type: 'TIMING', value: 180, description: 'Seconds', hidden: true },
      { name: 'motion', type: 'EASING', value: { type: 'GENTLE' } },
    ],
  });
  assert.deepEqual(parseVariableCreateBatchRequest(variableCreateBatchArgvFromRequest(parsed)), parsed);
  for (const args of [
    ['var', 'create-batch', '-c', 'Tokens', '[]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","future":true}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x"},{"name":"x"}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","type":"FLOAT","scopes":["ALL_SCOPES","GAP"]}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","type":"COLOR","scopes":["GAP"]}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","value":1,"alias":"y"}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","aliasCollection":"Primitives"}]'],
    ['var', 'create-batch', '[{"name":"x"}]'],
    ['var', 'create-batch', '-c', 'Tokens', '--future', 'private-value'],
  ]) assert.equal(acceptsVariableCreateBatchArgv(args), false, args.join(' '));
});

test('Variable Batch Creation closes explicit Alias intent without flattening equal literals', () => {
  const parsed = parseVariableCreateBatchRequest([
    'var', 'create-batch', '-c', 'Roles', '--', JSON.stringify([
      { name: 'surface/default', type: 'COLOR', alias: 'color/neutral/0', aliasCollection: 'Primitives' },
      { name: 'surface/equal-literal', type: 'COLOR', value: '#ffffff' },
    ]),
  ]);
  assert.deepEqual(parsed.items, [
    {
      name: 'surface/default', type: 'COLOR', alias: 'color/neutral/0',
      aliasCollection: 'Primitives',
    },
    {
      name: 'surface/equal-literal', type: 'COLOR',
      value: { r: 1, g: 1, b: 1 },
    },
  ]);
  assert.deepEqual(parseVariableCreateBatchRequest(variableCreateBatchArgvFromRequest(parsed)), parsed);
});

test('Variable Batch Creation preserves same-batch and cross-Collection Alias identity', async () => {
  const primitives = {
    id: 'VariableCollectionId:primitive', key: 'primitive-key', name: 'Primitives', remote: false,
    defaultModeId: 'ModeId:primitive', modes: [{ modeId: 'ModeId:primitive', name: 'Base' }],
  };
  const primitive = {
    id: 'VariableID:primitive', key: 'primitive-variable-key', name: 'color/neutral/0',
    resolvedType: 'COLOR', remote: false, variableCollectionId: primitives.id,
    valuesByMode: { 'ModeId:primitive': { r: 1, g: 1, b: 1, a: 1 } },
  };
  const target = fixture({ existing: [primitive] });
  const request = {
    collection: 'Tokens', mode: 'Dark', items: [
      { name: 'role/surface', type: 'COLOR', alias: primitive.id, aliasCollection: primitives.id },
      { name: 'space/base', type: 'FLOAT', value: 12 },
      { name: 'space/card', type: 'FLOAT', alias: 'space/base' },
      { name: 'role/same-color-literal', type: 'COLOR', value: '#ffffff' },
    ],
  };
  target.figma.variables.getLocalVariableCollectionsAsync = async () => [target.collection, primitives];
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreateBatch(request, { evaluate: async () => serialized });

  assert.deepEqual(target.created[0].valuesByMode['ModeId:dark'], {
    type: 'VARIABLE_ALIAS', id: primitive.id,
  });
  assert.deepEqual(target.created[2].valuesByMode['ModeId:dark'], {
    type: 'VARIABLE_ALIAS', id: target.created[1].id,
  });
  assert.deepEqual(target.created[3].valuesByMode['ModeId:dark'], {
    r: 1, g: 1, b: 1,
  }, 'same-value literals remain literals without explicit Alias intent');
  assert.equal(result.result.created[0].modeValue.source, 'requested-alias');
  assert.equal(result.result.created[0].aliasTarget.id, primitive.id);
  assert.equal(result.result.created[2].aliasTarget.id, target.created[1].id);
  assert.equal(result.result.created[3].aliasTarget, null);
  assert.equal(Object.hasOwn(target.created[0].valuesByMode, 'ModeId:default'), false,
    'an Alias for Dark must not fill another mode');
});

test('Variable Batch Creation refuses ambiguous, incompatible and cyclic Alias graphs before factories', async () => {
  const other = {
    id: 'VariableCollectionId:other', key: 'other-key', name: 'Other', remote: false,
    defaultModeId: 'ModeId:other', modes: [{ modeId: 'ModeId:other', name: 'Base' }],
  };
  const duplicateName = (id, collectionId, type = 'FLOAT') => ({
    id, key: `${id}-key`, name: 'space/base', resolvedType: type, remote: false,
    variableCollectionId: collectionId, valuesByMode: {},
  });
  const ambiguous = fixture({
    existing: [
      duplicateName('VariableID:a', 'VariableCollectionId:1'),
      duplicateName('VariableID:b', other.id),
    ],
  });
  ambiguous.figma.variables.getLocalVariableCollectionsAsync = async () => [ambiguous.collection, other];
  await assert.rejects(() => runCode({
    collection: 'Tokens', items: [{ name: 'role/space', type: 'FLOAT', alias: 'space/base' }],
  }, ambiguous.figma), /Alias target is ambiguous/);
  assert.equal(ambiguous.created.length, 0);

  const incompatible = fixture({
    existing: [duplicateName('VariableID:color', other.id, 'COLOR')],
  });
  incompatible.figma.variables.getLocalVariableCollectionsAsync = async () => [incompatible.collection, other];
  await assert.rejects(() => runCode({
    collection: 'Tokens', items: [{ name: 'role/space', type: 'FLOAT', alias: 'VariableID:color' }],
  }, incompatible.figma), /type is incompatible/);
  assert.equal(incompatible.created.length, 0);

  const cyclic = fixture();
  await assert.rejects(() => runCode({
    collection: 'Tokens', items: [
      { name: 'role/a', type: 'FLOAT', alias: 'role/b' },
      { name: 'role/b', type: 'FLOAT', alias: 'role/a' },
    ],
  }, cyclic.figma), /alias graph contains a cycle/);
  assert.equal(cyclic.created.length, 0);
});

test('Variable Batch Creation applies per-item final metadata and preserves empty mode writes', async () => {
  const target = fixture();
  const request = {
    collection: 'Tokens', mode: 'Dark', items: [
      {
        name: 'space/final', type: 'FLOAT', value: 0,
        description: 'Final spacing', hidden: true, scopes: ['GAP'],
      },
      { name: 'label/empty', type: 'STRING', value: '', scopes: ['TEXT_CONTENT'] },
    ],
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreateBatch(request, { evaluate: async () => serialized });
  assert.deepEqual(result.result.created.map((item) => item.metadata), [
    { description: 'Final spacing', hiddenFromPublishing: true, scopes: ['GAP'] },
    { description: '', hiddenFromPublishing: false, scopes: ['TEXT_CONTENT'] },
  ]);
  assert.equal(target.created[0].valuesByMode['ModeId:dark'], 0);
  assert.equal(target.created[1].valuesByMode['ModeId:dark'], '');
});

test('Variable Batch Creation removes its complete journal when final metadata is ignored', async () => {
  const target = fixture({ scopeSetIgnoredFor: 'second' });
  const request = {
    collection: 'Tokens', items: [
      { name: 'first', type: 'FLOAT', value: 1, scopes: ['GAP'] },
      { name: 'second', type: 'FLOAT', value: 2, scopes: ['GAP'] },
    ],
  };
  const serialized = await runCode(request, target.figma);
  await assert.rejects(
    () => executeVariableCreateBatch(request, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.removed === 2,
  );
  assert.deepEqual(target.created.map((item) => item.removed), [true, true]);
});

test('Variable Batch Creation preflights Collection and exact-name ambiguity before factories', async () => {
  const duplicate = fixture({
    existing: [{
      id: 'VariableID:existing', name: 'space/md', resolvedType: 'FLOAT', remote: false,
      variableCollectionId: 'VariableCollectionId:1', valuesByMode: {},
    }],
  });
  await assert.rejects(() => runCode({
    collection: 'Tokens', items: [{ name: 'space/md', type: 'FLOAT', value: 12 }],
  }, duplicate.figma), /exact name already exists.*--allow-duplicate/);
  assert.equal(duplicate.created.length, 0);

  const ambiguousCollection = fixture({ collections: [
    duplicate.collection,
    { ...duplicate.collection, id: 'VariableCollectionId:2' },
  ] });
  await assert.rejects(() => runCode({
    collection: 'Tokens', items: [{ name: 'space/lg', type: 'FLOAT' }],
  }, ambiguousCollection.figma), /Collection is ambiguous/);
  assert.equal(ambiguousCollection.created.length, 0);
});

test('Variable Batch Creation journals, initializes and verifies every item in the selected mode', async () => {
  const target = fixture({ float32ColorReadback: true });
  const request = {
    collection: 'Tokens', mode: 'Dark',
    items: [
      { name: 'color/accent', type: 'COLOR', value: '#12345678' },
      { name: 'enabled', type: 'BOOLEAN', value: true },
      { name: 'label', type: 'STRING', value: 'Bridge' },
    ],
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreateBatch(request, { evaluate: async () => serialized });
  assert.equal(result.stdout, 'Created 3 variables');
  assert.equal(result.result.mode.modeId, 'ModeId:dark');
  assert.equal(result.result.created.length, 3);
  assert.deepEqual(target.created.map((item) => item.valuesByMode['ModeId:dark']), [
    {
      r: Math.fround(18 / 255), g: Math.fround(52 / 255),
      b: Math.fround(86 / 255), a: Math.fround(120 / 255),
    }, true, 'Bridge',
  ]);
});

test('Variable Batch Creation accepts and reports native defaults for items without initial intent', async () => {
  const target = fixture({
    nativeValuesByMode: { 'ModeId:default': 0, 'ModeId:dark': 0 },
  });
  const request = {
    collection: 'Tokens',
    items: [{ name: 'space/native', type: 'FLOAT' }],
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreateBatch(request, { evaluate: async () => serialized });

  assert.deepEqual(result.result.created[0].modeValue, {
    modeId: 'ModeId:default', source: 'native-default', stored: true, value: 0,
  });
  assert.equal(result.result.created[0].observedModeCount, 2);
  assert.equal(target.created[0].removed, false);
});

test('Variable Batch Creation preserves native defaults for every Variable type', async () => {
  const defaults = new Map([
    ['BOOLEAN', false],
    ['COLOR', { r: 0, g: 0, b: 0 }],
    ['EASING', { type: 'EASE_IN_AND_OUT' }],
    ['FLOAT', 0],
    ['STRING', ''],
    ['TIMING', 0],
  ]);
  const target = fixture({
    nativeValuesForType: (type) => ({
      'ModeId:default': defaults.get(type),
      'ModeId:dark': structuredClone(defaults.get(type)),
    }),
  });
  const request = {
    collection: 'Tokens',
    items: [...defaults.keys()].map((type) => ({
      name: `native/${type.toLowerCase()}`, type,
    })),
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreateBatch(request, { evaluate: async () => serialized });
  for (const created of result.result.created) {
    const item = request.items[created.index];
    assert.equal(created.modeValue.source, 'native-default', item.type);
    assert.deepEqual(created.modeValue.value, defaults.get(item.type), item.type);
    assert.equal(created.observedModeCount, 2, item.type);
  }
  assert.deepEqual(target.created.map((item) => item.removed), Array(6).fill(false));
});

test('Variable Batch Creation verifies selected intent without rejecting other native modes', async () => {
  const target = fixture({
    nativeValuesByMode: { 'ModeId:default': 0, 'ModeId:dark': 0 },
  });
  const request = {
    collection: 'Tokens', mode: 'Dark',
    items: [{ name: 'space/explicit', type: 'FLOAT', value: 12 }],
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreateBatch(request, { evaluate: async () => serialized });
  assert.deepEqual(result.result.created[0].modeValue, {
    modeId: 'ModeId:dark', source: 'requested-initial', stored: true, value: 12,
  });
  assert.equal(result.result.created[0].observedModeCount, 2);
  assert.equal(target.created[0].valuesByMode['ModeId:default'], 0);
});

test('Variable Batch Creation accepts Figma canonical parameters for a named EASING preset', async () => {
  const target = fixture({ easingPresetReadback: true });
  const request = {
    collection: 'Tokens', mode: 'Dark',
    items: [{ name: 'motion/gentle', type: 'EASING', value: 'gentle' }],
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreateBatch(request, { evaluate: async () => serialized });
  assert.deepEqual(result.result.created[0].modeValue.value, {
    type: 'GENTLE', easingFunctionSpring: { bounce: 0.25 },
  });
});

test('Variable Batch Creation rejects malformed native parameters for a named EASING preset', async () => {
  const target = fixture({ easingPresetReadback: true, easingPresetBounce: 2 });
  const request = {
    collection: 'Tokens', mode: 'Dark',
    items: [{ name: 'motion/invalid', type: 'EASING', value: 'gentle' }],
  };
  const serialized = await runCode(request, target.figma);
  await assert.rejects(
    () => executeVariableCreateBatch(request, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.removed === 1,
  );
  assert.equal(target.created[0].removed, true);
});

test('Variable Batch Creation accepts only numerically equivalent Figma Float32 readback', async () => {
  const request = {
    collection: 'Tokens',
    items: [{ name: 'color/accent', type: 'COLOR', value: '#12345678' }],
  };
  const rounded = fixture({ float32ColorReadback: true });
  const serialized = await runCode(request, rounded.figma);
  assert.equal((await executeVariableCreateBatch(request, {
    evaluate: async () => serialized,
  })).result.created.length, 1);

  const drifted = fixture();
  const originalCatalog = drifted.figma.variables.getLocalVariablesAsync;
  drifted.figma.variables.getLocalVariablesAsync = async () => {
    const values = await originalCatalog();
    for (const variable of values) {
      if (variable.resolvedType === 'COLOR' && variable.valuesByMode['ModeId:default']) {
        variable.valuesByMode['ModeId:default'].r += 0.01;
      }
    }
    return values;
  };
  const failure = await runCode(request, drifted.figma);
  await assert.rejects(
    () => executeVariableCreateBatch(request, { evaluate: async () => failure }),
    (error) => error.mutationOutcome === 'rolled-back',
  );
});

test('Variable Batch Creation accepts native opaque RGBA readback for RGB intent', async () => {
  const target = fixture({ nativeOpaqueAlphaReadback: true });
  const request = {
    collection: 'Tokens',
    items: [{ name: 'color/opaque', type: 'COLOR', value: '#3366ff' }],
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreateBatch(request, { evaluate: async () => serialized });

  assert.equal(result.result.created[0].modeValue.source, 'requested-initial');
  assert.deepEqual(result.result.created[0].modeValue.value, {
    r: Math.fround(0.2), g: Math.fround(0.4), b: 1, a: 1,
  });
  assert.equal(target.created[0].removed, false);

  const nonOpaque = fixture();
  const originalCatalog = nonOpaque.figma.variables.getLocalVariablesAsync;
  nonOpaque.figma.variables.getLocalVariablesAsync = async () => {
    const variables = await originalCatalog();
    for (const variable of variables) {
      if (variable.valuesByMode['ModeId:default']) {
        variable.valuesByMode['ModeId:default'].a = 0.99;
      }
    }
    return variables;
  };
  const failed = await runCode(request, nonOpaque.figma);
  assert.equal(JSON.parse(failed).status, 'failed');
  assert.equal(nonOpaque.created[0].removed, true);
});

test('Variable Batch Creation removes the whole journal after a later failure and reports residue', async () => {
  const cleaned = fixture({ setFailsFor: 'second' });
  const request = {
    collection: 'Tokens', items: [
      { name: 'first', type: 'FLOAT', value: 1 },
      { name: 'second', type: 'FLOAT', value: 2 },
    ],
  };
  const cleanedPayload = await runCode(request, cleaned.figma);
  await assert.rejects(
    () => executeVariableCreateBatch(request, { evaluate: async () => cleanedPayload }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.created === 2 && error.mutationReport.removed === 2,
  );
  assert.deepEqual(cleaned.created.map((item) => item.removed), [true, true]);

  const residue = fixture({ setFailsFor: 'second', removeFailsFor: 'first' });
  const residuePayload = await runCode(request, residue.figma);
  await assert.rejects(
    () => executeVariableCreateBatch(request, { evaluate: async () => residuePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );

  const unavailable = fixture({
    setFailsFor: 'second', verificationUnavailableAfterRemoval: true,
  });
  const unavailablePayload = await runCode(request, unavailable.figma);
  await assert.rejects(
    () => executeVariableCreateBatch(request, { evaluate: async () => unavailablePayload }),
    (error) => error.mutationOutcome === 'verification-unavailable'
      && error.mutationReport.residueCount === 2,
  );
});

test('Variable Batch Creation rejects forged results and accepts only its authentic Plan', async () => {
  const request = {
    collection: 'Tokens', items: [{ name: 'space/md', type: 'FLOAT', value: 12 }],
  };
  await assert.rejects(
    () => executeVariableCreateBatch(request, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  const cli = planFigmaCommand([
    'var', 'create-batch', '-cTokens', '[{"name":"space/md","type":"FLOAT","value":12}]',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand(variableCreateBatchArgvFromRequest(request), { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(variableCreateBatchPlanRoute(cli), 'command-application');
  const target = fixture();
  const serialized = await runCode(request, target.figma);
  assert.equal((await executeVariableCreateBatchPlan(cli, {
    evaluate: async () => serialized,
  })).result.created.length, 1);
  await assert.rejects(
    () => executeVariableCreateBatchPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(variableCreateBatchPlanRoute(planFigmaCommand(['var', 'show', 'space/md'])),
    'not-variable-create-batch');
});
