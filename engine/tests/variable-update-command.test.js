import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableUpdate,
  executeVariableUpdatePlan,
  variableUpdateCommandCode,
  variableUpdatePlanRoute,
} from '../src/application/variable-update-command.js';
import {
  acceptsVariableUpdateArgv,
  parseVariableUpdateRequest,
  variableUpdateArgvFromRequest,
} from '../src/application/variable-update-request.js';

function fixture({ publishFails = false, restoreFails = false, invalidSyntax = false } = {}) {
  const mode = { modeId: 'ModeId:default', name: 'Mode 1' };
  const collection = {
    id: 'VariableCollectionId:1', name: 'Tokens', remote: false, modes: [mode],
  };
  let description = 'Old description';
  let descriptionWrites = 0;
  let publishCalls = 0;
  const variable = {
    id: 'VariableID:1', key: 'variable-key', name: 'space/md',
    resolvedType: 'FLOAT', remote: false, variableCollectionId: collection.id,
    hiddenFromPublishing: false, scopes: ['ALL_SCOPES'],
    codeSyntax: invalidSyntax ? { FUTURE: 'unsupported' } : {},
    valuesByMode: { [mode.modeId]: 12 },
    async getPublishStatusAsync() {
      publishCalls++;
      if (publishFails && publishCalls > 1) throw new Error('publish failed');
      return 'CURRENT';
    },
  };
  Object.defineProperty(variable, 'description', {
    enumerable: true,
    get: () => description,
    set(value) {
      descriptionWrites++;
      if (restoreFails && descriptionWrites > 1) throw new Error('restore failed');
      description = value;
    },
  });
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
      getLocalVariablesAsync: async () => [variable],
    },
  };
  return { collection, figma, variable, get descriptionWrites() { return descriptionWrites; } };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${variableUpdateCommandCode(request)};`)(figma);
}

test('Variable Update request closes metadata grammar and canonicalizes typed fields', () => {
  assert.deepEqual(parseVariableUpdateRequest([
    'variables', 'update', '-cTokens', '-n', ' space/lg ', '-d', '',
    '--hidden=FALSE', '--scopes=gap,font_size', '--', '-space/md',
  ]), {
    variable: '-space/md', collection: 'Tokens', name: 'space/lg', description: '',
    hidden: false, scopes: ['GAP', 'FONT_SIZE'],
  });
  assert.deepEqual(variableUpdateArgvFromRequest({
    variable: 'space/md', description: 'Medium', hidden: true, scopes: [],
  }), [
    'var', 'update', '--description', 'Medium', '--hidden', 'true', '--scopes', '',
    '--', 'space/md',
  ]);
  for (const args of [
    ['var', 'update', 'space/md'],
    ['var', 'update', '-c', 'Tokens', 'space/md'],
    ['var', 'update', '-n', 'One', '-n', 'Two', 'space/md'],
    ['var', 'update', '--hidden', 'maybe', 'space/md'],
    ['var', 'update', '--scopes', 'FUTURE', 'space/md'],
    ['var', 'update', '--future', 'private-value', 'space/md'],
    ['var', 'update', '-d', 'Description', 'one', 'two'],
  ]) assert.equal(acceptsVariableUpdateArgv(args), false, args.join(' '));
});

test('Variable Update applies every metadata field and preserves exact legacy Facts output', async () => {
  const state = fixture();
  const serialized = await runCode({
    variable: 'space/md', collection: 'Tokens', name: 'space/lg',
    description: 'Large spacing', hidden: true, scopes: ['GAP'],
  }, state.figma);
  const result = await executeVariableUpdate({
    variable: 'space/md', collection: 'Tokens', name: 'space/lg',
    description: 'Large spacing', hidden: true, scopes: ['GAP'],
  }, { evaluate: async () => serialized });
  const output = JSON.parse(result.stdout);
  assert.equal(output.name, 'space/lg');
  assert.equal(output.description, 'Large spacing');
  assert.equal(output.hiddenFromPublishing, true);
  assert.deepEqual(output.scopes, ['GAP']);
  assert.equal(Object.hasOwn(output, 'schemaVersion'), false);
  assert.deepEqual(result.result.requestedFields,
    ['name', 'description', 'hiddenFromPublishing', 'scopes']);
});

test('Variable Update restores every requested field after post-write failure', async () => {
  const state = fixture({ publishFails: true });
  const serialized = await runCode({
    variable: 'space/md', name: 'space/lg', description: 'New',
    hidden: true, scopes: ['GAP'],
  }, state.figma);
  assert.equal(state.variable.name, 'space/md');
  assert.equal(state.variable.description, 'Old description');
  assert.equal(state.variable.hiddenFromPublishing, false);
  assert.deepEqual(state.variable.scopes, ['ALL_SCOPES']);
  await assert.rejects(
    () => executeVariableUpdate({
      variable: 'space/md', name: 'space/lg', description: 'New',
      hidden: true, scopes: ['GAP'],
    }, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.variableUpdateMutationReport.restored === 4
      && error.variableUpdateMutationReport.residueCount === 0,
  );
});

test('Variable Update reports failed field restoration and blocks invalid preflight before writes', async () => {
  const residue = fixture({ publishFails: true, restoreFails: true });
  const residuePayload = await runCode({
    variable: 'space/md', description: 'New',
  }, residue.figma);
  assert.equal(residue.variable.description, 'New');
  await assert.rejects(
    () => executeVariableUpdate({
      variable: 'space/md', description: 'New',
    }, { evaluate: async () => residuePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.variableUpdateMutationReport.restoreFailures[0] === 'description'
      && error.variableUpdateMutationReport.residueCount === 1,
  );

  const preflight = fixture({ invalidSyntax: true });
  await assert.rejects(
    () => runCode({ variable: 'space/md', description: 'New' }, preflight.figma),
    /incompatible preflight metadata/,
  );
  assert.equal(preflight.descriptionWrites, 0);
});

test('Variable Update rejects malformed results and accepts only authentic Plans', async () => {
  await assert.rejects(
    () => executeVariableUpdate({
      variable: 'space/md', description: 'Medium',
    }, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  const cli = planFigmaCommand([
    'var', 'update', '-cTokens', '-dMedium', '--hidden=false', '--scopes=GAP', 'space/md',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'update', '--collection=Tokens', '--description=Medium', '--hidden', 'false',
    '--scopes', 'GAP', '--', 'space/md',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(variableUpdatePlanRoute(cli), 'command-application');
  const { figma } = fixture();
  const serialized = await runCode({
    variable: 'space/md', collection: 'Tokens', description: 'Medium',
    hidden: false, scopes: ['GAP'],
  }, figma);
  assert.equal((await executeVariableUpdatePlan(cli, {
    evaluate: async () => serialized,
  })).result.variable.description, 'Medium');
  await assert.rejects(
    () => executeVariableUpdatePlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(variableUpdatePlanRoute(planFigmaCommand(['var', 'show', 'space/md'])),
    'not-variable-update');
});
