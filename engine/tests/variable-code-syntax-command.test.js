import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableCodeSyntax,
  executeVariableCodeSyntaxPlan,
  variableCodeSyntaxCommandCode,
  variableCodeSyntaxPlanRoute,
} from '../src/application/variable-code-syntax-command.js';
import {
  acceptsVariableCodeSyntaxArgv,
  parseVariableCodeSyntaxRequest,
  variableCodeSyntaxArgvFromRequest,
} from '../src/application/variable-code-syntax-request.js';

function fixture({
  initialSyntax = {},
  publishFails = false,
  restoreFails = false,
} = {}) {
  const mode = { modeId: 'ModeId:default', name: 'Mode 1' };
  const collection = {
    id: 'VariableCollectionId:1', name: 'Tokens', remote: false, modes: [mode],
  };
  let mutationCalls = 0;
  let publishCalls = 0;
  const variable = {
    id: 'VariableID:1', key: 'variable-key', name: 'space/md', description: 'Spacing',
    resolvedType: 'FLOAT', remote: false, variableCollectionId: collection.id,
    hiddenFromPublishing: false, scopes: ['GAP'], codeSyntax: { ...initialSyntax },
    valuesByMode: { [mode.modeId]: 12 },
    setVariableCodeSyntax(platform, value) {
      mutationCalls++;
      if (restoreFails && mutationCalls > 1) throw new Error('restore failed');
      this.codeSyntax[platform] = value;
    },
    removeVariableCodeSyntax(platform) {
      mutationCalls++;
      if (restoreFails && mutationCalls > 1) throw new Error('restore failed');
      delete this.codeSyntax[platform];
    },
    async getPublishStatusAsync() {
      publishCalls++;
      if (publishFails && publishCalls > 1) throw new Error('publish failed');
      return 'CURRENT';
    },
  };
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
      getLocalVariablesAsync: async () => [variable],
    },
  };
  return { collection, figma, variable, get mutationCalls() { return mutationCalls; } };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${variableCodeSyntaxCommandCode(request)};`)(figma);
}

test('Variable Code Syntax request closes set/remove grammar and canonicalizes platforms', () => {
  assert.deepEqual(parseVariableCodeSyntaxRequest([
    'variables', 'code-syntax', '-cTokens', '--', '-space/md', 'ios', '-token-space-md',
  ]), {
    variable: '-space/md', collection: 'Tokens', platform: 'iOS',
    value: '-token-space-md', remove: false,
  });
  assert.deepEqual(variableCodeSyntaxArgvFromRequest({
    variable: 'space/md', collection: 'Tokens', platform: 'web', remove: true,
  }), [
    'var', 'code-syntax', '--collection', 'Tokens', '--remove', '--',
    'space/md', 'WEB',
  ]);
  for (const args of [
    ['var', 'code-syntax', 'space/md', 'WEB'],
    ['var', 'code-syntax', '--remove', 'space/md', 'WEB', '--token'],
    ['var', 'code-syntax', 'space/md', 'FUTURE', '--token'],
    ['var', 'code-syntax', '-c', 'Tokens', '-c', 'Other', 'space/md', 'WEB', '--token'],
    ['var', 'code-syntax', '--future', 'private-value', 'space/md', 'WEB'],
    ['var', 'code-syntax', 'one', 'WEB', 'value', 'extra'],
  ]) assert.equal(acceptsVariableCodeSyntaxArgv(args), false, args.join(' '));
});

test('Variable Code Syntax sets and removes exact platform syntax with legacy Facts output', async () => {
  const setState = fixture();
  const setSerialized = await runCode({
    variable: 'space/md', collection: 'Tokens', platform: 'web', value: '--space-md',
  }, setState.figma);
  const setResult = await executeVariableCodeSyntax({
    variable: 'space/md', collection: 'Tokens', platform: 'web', value: '--space-md',
  }, { evaluate: async () => setSerialized });
  assert.equal(setState.variable.codeSyntax.WEB, '--space-md');
  const output = JSON.parse(setResult.stdout);
  assert.deepEqual(output.codeSyntax, { WEB: '--space-md' });
  assert.equal(Object.hasOwn(output, 'schemaVersion'), false);

  const removeState = fixture({ initialSyntax: { WEB: '--old' } });
  const removeSerialized = await runCode({
    variable: 'space/md', platform: 'WEB', remove: true,
  }, removeState.figma);
  const removeResult = await executeVariableCodeSyntax({
    variable: 'space/md', platform: 'WEB', remove: true,
  }, { evaluate: async () => removeSerialized });
  assert.deepEqual(removeState.variable.codeSyntax, {});
  assert.deepEqual(JSON.parse(removeResult.stdout).codeSyntax, {});
});

test('Variable Code Syntax restores overwritten and newly added syntax after post-set failure', async () => {
  const overwritten = fixture({ initialSyntax: { WEB: '--old' }, publishFails: true });
  const overwrittenPayload = await runCode({
    variable: 'space/md', platform: 'WEB', value: '--new',
  }, overwritten.figma);
  assert.equal(overwritten.variable.codeSyntax.WEB, '--old');
  await assert.rejects(
    () => executeVariableCodeSyntax({
      variable: 'space/md', platform: 'WEB', value: '--new',
    }, { evaluate: async () => overwrittenPayload }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.variableCodeSyntaxMutationReport.restored === 1,
  );

  const added = fixture({ publishFails: true });
  const addedPayload = await runCode({
    variable: 'space/md', platform: 'WEB', value: '--new',
  }, added.figma);
  assert.deepEqual(added.variable.codeSyntax, {});
  await assert.rejects(
    () => executeVariableCodeSyntax({
      variable: 'space/md', platform: 'WEB', value: '--new',
    }, { evaluate: async () => addedPayload }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.variableCodeSyntaxMutationReport.residueCount === 0,
  );
});

test('Variable Code Syntax reports bounded residue when restoration fails', async () => {
  const state = fixture({ initialSyntax: { WEB: '--old' }, publishFails: true, restoreFails: true });
  const serialized = await runCode({
    variable: 'space/md', platform: 'WEB', value: '--new',
  }, state.figma);
  assert.equal(state.variable.codeSyntax.WEB, '--new');
  await assert.rejects(
    () => executeVariableCodeSyntax({
      variable: 'space/md', platform: 'WEB', value: '--new',
    }, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.variableCodeSyntaxMutationReport.restoreReason === 'restore-failed'
      && error.variableCodeSyntaxMutationReport.residueCount === 1,
  );
});

test('Variable mutation runtime rejects incompatible preflight Facts before the first write', async () => {
  const state = fixture({ initialSyntax: { FUTURE: 'unsupported' } });
  await assert.rejects(
    () => runCode({
      variable: 'space/md', platform: 'WEB', value: '--new',
    }, state.figma),
    /incompatible preflight metadata/,
  );
  assert.equal(state.mutationCalls, 0);
  assert.deepEqual(state.variable.codeSyntax, { FUTURE: 'unsupported' });
});

test('Variable Code Syntax rejects malformed results and accepts only authentic Plans', async () => {
  await assert.rejects(
    () => executeVariableCodeSyntax({
      variable: 'space/md', platform: 'WEB', value: '--space-md',
    }, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  const cli = planFigmaCommand([
    'var', 'code-syntax', '-cTokens', 'space/md', 'web', 'var(--space-md)',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'code-syntax', '--collection=Tokens', '--', 'space/md', 'WEB', 'var(--space-md)',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(variableCodeSyntaxPlanRoute(cli), 'command-application');
  const { figma } = fixture();
  const serialized = await runCode({
    variable: 'space/md', collection: 'Tokens', platform: 'WEB', value: 'var(--space-md)',
  }, figma);
  assert.equal((await executeVariableCodeSyntaxPlan(cli, {
    evaluate: async () => serialized,
  })).result.value, 'var(--space-md)');
  await assert.rejects(
    () => executeVariableCodeSyntaxPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(variableCodeSyntaxPlanRoute(planFigmaCommand(['var', 'show', 'space/md'])),
    'not-variable-code-syntax');
});
