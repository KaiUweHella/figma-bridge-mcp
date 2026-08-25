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
  collections = null, float32ColorReadback = false,
  verificationUnavailableAfterRemoval = false,
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
      createVariable(name, target, type) {
        const variable = {
          id: `VariableID:new:${created.length}`, key: '', name, resolvedType: type,
          remote: false, variableCollectionId: target.id, valuesByMode: {}, removed: false,
          setValueForMode(modeId, value) {
            if (name === setFailsFor) throw new Error('set failed');
            this.valuesByMode[modeId] = float32ColorReadback && type === 'COLOR'
              ? Object.fromEntries(Object.entries(value).map(([key, channel]) => [key, Math.fround(channel)]))
              : structuredClone(value);
          },
          remove() {
            if (name === removeFailsFor) throw new Error('remove failed');
            this.removed = true;
          },
        };
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
      { name: 'duration', type: 'timing', value: 180 },
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
      { name: 'duration', type: 'TIMING', value: 180 },
      { name: 'motion', type: 'EASING', value: { type: 'GENTLE' } },
    ],
  });
  assert.deepEqual(parseVariableCreateBatchRequest(variableCreateBatchArgvFromRequest(parsed)), parsed);
  for (const args of [
    ['var', 'create-batch', '-c', 'Tokens', '[]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x","future":true}]'],
    ['var', 'create-batch', '-c', 'Tokens', '[{"name":"x"},{"name":"x"}]'],
    ['var', 'create-batch', '[{"name":"x"}]'],
    ['var', 'create-batch', '-c', 'Tokens', '--future', 'private-value'],
  ]) assert.equal(acceptsVariableCreateBatchArgv(args), false, args.join(' '));
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
