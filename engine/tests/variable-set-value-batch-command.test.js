import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableSetValueBatch,
  executeVariableSetValueBatchPlan,
  variableSetValueBatchCommandCode,
  variableSetValueBatchPlanRoute,
} from '../src/application/variable-set-value-batch-command.js';
import {
  acceptsVariableSetValueBatchArgv,
  parseVariableSetValueBatchRequest,
  variableSetValueBatchArgvFromRequest,
  VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY,
} from '../src/application/variable-set-value-batch-request.js';

function fixture({ failResultFor = null, failRestoreFor = null } = {}) {
  const modes = [
    { modeId: 'ModeId:light', name: 'Light' },
    { modeId: 'ModeId:dark', name: 'Dark' },
  ];
  const collection = {
    id: 'VariableCollectionId:1', name: 'Tokens', remote: false, modes,
  };
  let writeCount = 0;
  let preflightComplete = false;
  const create = (index, name, type, valuesByMode) => {
    let publishCalls = 0;
    let setterCalls = 0;
    return {
      id: `VariableID:${index}`, key: `key-${index}`, name, description: '',
      resolvedType: type, remote: false, variableCollectionId: collection.id,
      hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
      valuesByMode: { ...valuesByMode },
      setValueForMode(modeId, value) {
        setterCalls++;
        writeCount++;
        if (failRestoreFor === this.id && setterCalls > 1) throw new Error('restore failed');
        this.valuesByMode[modeId] = type === 'COLOR' && value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, channel]) => [
              key, typeof channel === 'number' ? Math.fround(channel) : channel,
            ]))
          : value;
      },
      async getPublishStatusAsync() {
        publishCalls++;
        if (failResultFor === this.id && publishCalls > 1) throw new Error('result failed');
        return 'CURRENT';
      },
    };
  };
  const variables = [
    create(1, 'space/s', 'FLOAT', { 'ModeId:light': 8 }),
    create(2, 'space/m', 'FLOAT', { 'ModeId:light': 16 }),
    create(3, 'color/accent', 'COLOR', { 'ModeId:light': { r: 0, g: 0, b: 0, a: 1 } }),
    create(4, 'motion/quick', 'EASING', { 'ModeId:light': { type: 'LINEAR' } }),
    create(5, 'space/alias', 'FLOAT', { 'ModeId:light': 24 }),
    create(6, 'feature/enabled', 'BOOLEAN', { 'ModeId:light': true }),
    create(7, 'copy/title', 'STRING', { 'ModeId:light': 'Old title' }),
    create(8, 'duration/fast', 'TIMING', { 'ModeId:light': 120 }),
  ];
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
      getLocalVariablesAsync: async () => {
        preflightComplete = true;
        return variables;
      },
      createVariableAlias: (target) => ({ type: 'VARIABLE_ALIAS', id: target.id }),
    },
  };
  return {
    collection, figma, modes, variables,
    get writeCount() { return writeCount; },
    get preflightComplete() { return preflightComplete; },
  };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${variableSetValueBatchCommandCode(request)};`)(figma);
}

test('Variable Set Value Batch request closes and canonicalizes convenient JSON literals', () => {
  const parsed = parseVariableSetValueBatchRequest([
    'variables', 'set-value-batch', JSON.stringify([
      { variable: 'space/s', collection: 'Tokens', mode: 'Light', value: 12 },
      { variable: 'motion/quick', mode: 'Dark', value: { type: 'GENTLE' } },
      { variable: 'space/m', mode: 'Light', alias: 'space/alias' },
    ]),
  ]);
  assert.equal(parsed.policy, VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY);
  assert.equal(parsed.items[0].value, '12');
  assert.equal(parsed.items[1].value, '{"type":"GENTLE"}');
  assert.equal(parsed.items[2].alias, 'space/alias');
  assert.deepEqual(variableSetValueBatchArgvFromRequest(parsed), [
    'var', 'set-value-batch', '--', JSON.stringify(parsed.items),
  ]);
  for (const args of [
    ['var', 'set-value-batch', '[]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light"}]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light","value":1,"alias":"y"}]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light","value":1,"future":true}]'],
    ['var', 'set-value-batch', '[{"variable":"x","mode":"Light","value":1},{"variable":"x","mode":"Light","value":2}]'],
    ['var', 'set-value-batch', '--future', 'private-value'],
  ]) assert.equal(acceptsVariableSetValueBatchArgv(args), false, args.join(' '));
});

test('Variable Set Value Batch commits literals, aliases and formerly empty modes', async () => {
  const state = fixture();
  const request = { items: [
    { variable: 'space/s', collection: 'Tokens', mode: 'Light', value: 12 },
    { variable: 'color/accent', mode: 'Dark', value: '#BFFF47' },
    { variable: 'motion/quick', mode: 'Light', value: { type: 'GENTLE' } },
    { variable: 'space/m', mode: 'Dark', alias: 'space/alias' },
    { variable: 'feature/enabled', mode: 'Dark', value: false },
    { variable: 'copy/title', mode: 'Light', value: 'New title' },
    { variable: 'duration/fast', mode: 'Dark', value: 180 },
  ] };
  const serialized = await runCode(request, state.figma);
  const result = await executeVariableSetValueBatch(request, { evaluate: async () => serialized });
  assert.equal(result.result.outcome, 'committed');
  assert.equal(result.result.policy, 'best-effort-rollback');
  assert.deepEqual(result.result.rollbackCoverage.reversible.map((entry) => entry.index), [0, 2, 5]);
  assert.deepEqual(result.result.rollbackCoverage.nonReversible.map((entry) => entry.index), [1, 3, 4, 6]);
  assert.equal(result.result.confirmed.length, 7);
  assert.equal(state.variables[0].valuesByMode['ModeId:light'], 12);
  assert.deepEqual(state.variables[2].valuesByMode['ModeId:dark'], {
    r: Math.fround(191 / 255), g: 1, b: Math.fround(71 / 255), a: 1,
  });
  assert.deepEqual(state.variables[3].valuesByMode['ModeId:light'], { type: 'GENTLE' });
  assert.deepEqual(state.variables[1].valuesByMode['ModeId:dark'], {
    type: 'VARIABLE_ALIAS', id: 'VariableID:5',
  });
  assert.equal(state.variables[5].valuesByMode['ModeId:dark'], false);
  assert.equal(state.variables[6].valuesByMode['ModeId:light'], 'New title');
  assert.equal(state.variables[7].valuesByMode['ModeId:dark'], 180);
});

test('Variable Set Value Batch completes all resolution and type preflight before its first write', async () => {
  const state = fixture();
  await assert.rejects(() => runCode({ items: [
    { variable: 'space/s', mode: 'Light', value: 12 },
    { variable: 'space/m', mode: 'Dark', alias: 'color/accent' },
  ] }, state.figma), /Alias type does not match/);
  assert.equal(state.preflightComplete, true);
  assert.equal(state.writeCount, 0);

  await assert.rejects(() => runCode({ items: [
    { variable: 'space/s', mode: 'Light', value: 12 },
    { variable: 'VariableID:1', collection: 'Tokens', mode: 'ModeId:light', value: 14 },
  ] }, state.figma), /duplicate resolved Variable\/mode pair/);
  assert.equal(state.writeCount, 0);
});

test('Variable Set Value Batch refuses composed color rollback gaps before every write', async () => {
  const state = fixture();
  const composed = {
    type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
    expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:3' }, 42],
  };
  state.variables[2].valuesByMode['ModeId:light'] = composed;
  await assert.rejects(() => runCode({ items: [
    { variable: 'space/s', mode: 'Light', value: 12 },
    { variable: 'color/accent', mode: 'Light', value: '#ffffff' },
  ] }, state.figma), /cannot restore composed color values/i);
  assert.equal(state.writeCount, 0);
  assert.deepEqual(state.variables[2].valuesByMode['ModeId:light'], composed);
});

test('Variable Set Value Batch restores prior values and reports exact empty-mode residue', async () => {
  const partial = fixture({ failResultFor: 'VariableID:2' });
  const request = { items: [
    { variable: 'space/s', mode: 'Dark', value: 10 },
    { variable: 'space/m', mode: 'Light', value: 20 },
  ] };
  const serialized = await runCode(request, partial.figma);
  const payload = JSON.parse(serialized);
  assert.equal(payload.outcome, 'partial-residue');
  assert.equal(partial.variables[1].valuesByMode['ModeId:light'], 16);
  assert.equal(partial.variables[0].valuesByMode['ModeId:dark'], 10);
  assert.deepEqual(payload.restored.map((entry) => entry.index), [1]);
  assert.equal(payload.residual[0].index, 0);
  assert.equal(payload.residual[0].reason, 'no-reversal-api');
  await assert.rejects(
    () => executeVariableSetValueBatch(request, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.variableValueBatchMutationReport.policy === 'best-effort-rollback'
      && error.variableValueBatchMutationReport.restored === 1
      && error.variableValueBatchMutationReport.residueCount === 1,
  );

  const reversible = fixture({ failResultFor: 'VariableID:2' });
  const reversibleRequest = { items: [
    { variable: 'space/s', mode: 'Light', value: 10 },
    { variable: 'space/m', mode: 'Light', value: 20 },
  ] };
  const reversibleSerialized = await runCode(reversibleRequest, reversible.figma);
  assert.equal(JSON.parse(reversibleSerialized).outcome, 'rolled-back');
  assert.equal(reversible.variables[0].valuesByMode['ModeId:light'], 8);
  assert.equal(reversible.variables[1].valuesByMode['ModeId:light'], 16);
});

test('Variable Set Value Batch rejects malformed Outcomes and only accepts authentic Plans', async () => {
  const request = { items: [
    { variable: 'space/s', mode: 'Light', value: 12 },
  ] };
  await assert.rejects(
    () => executeVariableSetValueBatch(request, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  const cli = planFigmaCommand([
    'var', 'set-value-batch', JSON.stringify(request.items),
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'set-value-batch', '--', JSON.stringify(request.items),
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.mutationPolicy.rollback, 'best-effort-rollback');
  assert.equal(variableSetValueBatchPlanRoute(cli), 'command-application');
  const state = fixture();
  const serialized = await runCode(request, state.figma);
  const tampered = JSON.parse(serialized);
  tampered.policy = 'atomic';
  await assert.rejects(
    () => executeVariableSetValueBatch(request, { evaluate: async () => JSON.stringify(tampered) }),
    /invalid bounded result/,
  );
  assert.equal((await executeVariableSetValueBatchPlan(cli, {
    evaluate: async () => serialized,
  })).result.outcome, 'committed');
  await assert.rejects(
    () => executeVariableSetValueBatchPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
});
