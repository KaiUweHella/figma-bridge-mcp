import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableSetValue,
  executeVariableSetValuePlan,
  variableSetValueCommandCode,
  variableSetValuePlanRoute,
} from '../src/application/variable-set-value-command.js';
import {
  acceptsVariableSetValueArgv,
  parseVariableSetValueRequest,
  variableSetValueArgvFromRequest,
} from '../src/application/variable-set-value-request.js';

function fixture({
  initial = 12,
  hasInitial = true,
  publishFails = false,
  restoreFails = false,
  type = 'FLOAT',
  } = {}) {
  const mode = { modeId: 'ModeId:default', name: 'Mode 1' };
  const collection = {
    id: 'VariableCollectionId:1', name: 'Tokens', remote: false, modes: [mode],
  };
  let setterCalls = 0;
  let publishCalls = 0;
  const variable = {
    id: 'VariableID:1', key: 'variable-key', name: 'space/md', description: 'Spacing',
    resolvedType: type, remote: false, variableCollectionId: collection.id,
    hiddenFromPublishing: false, scopes: ['GAP'], codeSyntax: { WEB: '--space-md' },
    valuesByMode: hasInitial ? { [mode.modeId]: initial } : {},
    setValueForMode(modeId, value) {
      setterCalls++;
      if (restoreFails && setterCalls > 1) throw new Error('restore failed');
      this.valuesByMode[modeId] = value;
    },
    async getPublishStatusAsync() {
      publishCalls++;
      if (publishFails && publishCalls > 1) throw new Error('publish failed');
      return 'CURRENT';
    },
  };
  const alias = {
    ...variable,
    id: 'VariableID:2', key: 'alias-key', name: 'space/lg', valuesByMode: {},
  };
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
      getLocalVariablesAsync: async () => [variable, alias],
      createVariableAlias: (target) => ({ type: 'VARIABLE_ALIAS', id: target.id }),
    },
  };
  return { alias, collection, figma, mode, variable, get setterCalls() { return setterCalls; } };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${variableSetValueCommandCode(request)};`)(figma);
}

test('Variable Set Value request closes literal and alias grammar and canonicalizes payloads', () => {
  assert.deepEqual(parseVariableSetValueRequest([
    'variables', 'set-value', '-mMode 1', '-cTokens', '--', '-space/md', '-12',
  ]), {
    variable: '-space/md', collection: 'Tokens', mode: 'Mode 1', value: '-12', alias: null,
  });
  assert.deepEqual(variableSetValueArgvFromRequest({
    variable: 'space/md', collection: 'Tokens', mode: 'Mode 1', alias: 'space/lg',
  }), [
    'var', 'set-value', '--mode', 'Mode 1', '--collection', 'Tokens',
    '--alias', 'space/lg', '--', 'space/md',
  ]);
  for (const args of [
    ['var', 'set-value', 'space/md', '12'],
    ['var', 'set-value', '-m', 'Mode 1', 'space/md'],
    ['var', 'set-value', '-m', 'Mode 1', '--alias', 'space/lg', 'space/md', '12'],
    ['var', 'set-value', '-m', 'Mode 1', '-m', 'Other', 'space/md', '12'],
    ['var', 'set-value', '-m', 'Mode 1', '--future', 'private-value', 'space/md'],
    ['var', 'set-value', '-m', 'Mode 1', 'one', 'two', 'three'],
  ]) assert.equal(acceptsVariableSetValueArgv(args), false, args.join(' '));
});

test('Variable Set Value preserves literal, named easing and alias utility with exact legacy output', async () => {
  const float = fixture();
  const serialized = await runCode({
    variable: 'space/md', collection: 'Tokens', mode: 'Mode 1', value: '20',
  }, float.figma);
  const result = await executeVariableSetValue({
    variable: 'space/md', collection: 'Tokens', mode: 'Mode 1', value: '20',
  }, { evaluate: async () => serialized });
  assert.equal(float.variable.valuesByMode['ModeId:default'], 20);
  const output = JSON.parse(result.stdout);
  assert.equal(output.variable.name, 'space/md');
  assert.equal(Object.hasOwn(output.variable, 'schemaVersion'), false);
  assert.deepEqual(output.mode, { modeId: 'ModeId:default', name: 'Mode 1' });
  assert.equal(output.value, 20);

  const easing = fixture({ type: 'EASING', initial: { type: 'LINEAR' } });
  const easingPayload = await runCode({
    variable: 'space/md', mode: 'Mode 1', value: 'ease-in-back',
  }, easing.figma);
  assert.deepEqual(JSON.parse(easingPayload).value, { type: 'EASE_IN_BACK' });

  const alias = fixture();
  const aliasPayload = await runCode({
    variable: 'space/md', mode: 'Mode 1', alias: 'space/lg',
  }, alias.figma);
  assert.deepEqual(JSON.parse(aliasPayload).value, {
    type: 'VARIABLE_ALIAS', id: 'VariableID:2',
  });
});

test('Variable Set Value restores an existing value after post-set failure', async () => {
  const state = fixture({ initial: 12, publishFails: true });
  const serialized = await runCode({
    variable: 'space/md', mode: 'Mode 1', value: '20',
  }, state.figma);
  assert.equal(state.variable.valuesByMode['ModeId:default'], 12);
  await assert.rejects(
    () => executeVariableSetValue({
      variable: 'space/md', mode: 'Mode 1', value: '20',
    }, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.variableValueMutationReport.restored === 1
      && error.variableValueMutationReport.residueCount === 0,
  );
});

test('Variable Set Value reports truthful bounded residue when Figma cannot reverse the write', async () => {
  const absent = fixture({ hasInitial: false, publishFails: true });
  const absentPayload = await runCode({
    variable: 'space/md', mode: 'Mode 1', value: '20',
  }, absent.figma);
  await assert.rejects(
    () => executeVariableSetValue({
      variable: 'space/md', mode: 'Mode 1', value: '20',
    }, { evaluate: async () => absentPayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.variableValueMutationReport.restoreReason === 'no-reversal-api'
      && error.variableValueMutationReport.residueCount === 1,
  );

  const failedRestore = fixture({ initial: 12, publishFails: true, restoreFails: true });
  const restorePayload = await runCode({
    variable: 'space/md', mode: 'Mode 1', value: '20',
  }, failedRestore.figma);
  assert.equal(failedRestore.variable.valuesByMode['ModeId:default'], 20);
  await assert.rejects(
    () => executeVariableSetValue({
      variable: 'space/md', mode: 'Mode 1', value: '20',
    }, { evaluate: async () => restorePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.variableValueMutationReport.restoreReason === 'restore-failed',
  );
});

test('Variable Set Value rejects malformed results and accepts only authentic non-retrying Plans', async () => {
  await assert.rejects(
    () => executeVariableSetValue({
      variable: 'space/md', mode: 'Mode 1', value: '20',
    }, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  const cli = planFigmaCommand([
    'var', 'set-value', '-mMode 1', '-cTokens', 'space/md', '20',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'set-value', '--mode=Mode 1', '--collection=Tokens', '--', 'space/md', '20',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(variableSetValuePlanRoute(cli), 'command-application');
  const { figma } = fixture();
  const serialized = await runCode({
    variable: 'space/md', collection: 'Tokens', mode: 'Mode 1', value: '20',
  }, figma);
  const wrongLiteral = JSON.parse(serialized);
  wrongLiteral.value = 21;
  wrongLiteral.variable.valuesByMode['ModeId:default'] = 21;
  await assert.rejects(
    () => executeVariableSetValue({
      variable: 'space/md', collection: 'Tokens', mode: 'Mode 1', value: '20',
    }, { evaluate: async () => JSON.stringify(wrongLiteral) }),
    /invalid bounded result/,
  );
  assert.equal((await executeVariableSetValuePlan(cli, {
    evaluate: async () => serialized,
  })).result.value, 20);
  await assert.rejects(
    () => executeVariableSetValuePlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(variableSetValuePlanRoute(planFigmaCommand(['var', 'show', 'space/md'])),
    'not-variable-set-value');
});
