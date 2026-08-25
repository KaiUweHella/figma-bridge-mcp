import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeVariableDelete,
  executeVariableDeletePlan,
  variableDeleteArgvFromRequest,
  variableDeletePlanRoute,
} from '../src/application/variable-delete-command.js';
import { parseVariableDeleteRequest } from '../src/application/variable-delete-request.js';
import { planFigmaCommand } from '../../src/capability-catalog.js';

const evaluate = (code, figma) => new Function('figma', `return ${code}`)(figma);

function fixture({ removeFailures = [], verificationUnavailable = false } = {}) {
  const collections = [
    { id: 'C:1', name: 'Primitives', remote: false },
    { id: 'C:2', name: 'Semantic', remote: false },
  ];
  const variables = [];
  const add = (id, name, collectionId) => {
    const variable = {
      id, name, variableCollectionId: collectionId, remote: false,
      remove() {
        if (removeFailures.includes(id)) throw new Error('remove failed');
        variables.splice(variables.findIndex((item) => item.id === id), 1);
      },
    };
    variables.push(variable);
    return variable;
  };
  add('V:1', 'space/md', 'C:1');
  add('V:2', 'space/lg', 'C:1');
  add('V:3', 'space/md', 'C:2');
  let variableReads = 0;
  const figma = { variables: {
    getLocalVariableCollectionsAsync: async () => [...collections],
    getLocalVariablesAsync: async () => {
      variableReads++;
      if (verificationUnavailable && variableReads > 1) throw new Error('read failed');
      return [...variables];
    },
  } };
  return { figma, variables };
}

test('Variable Deletion request closes exact batch and Collection scope', () => {
  assert.deepEqual(parseVariableDeleteRequest([
    'var', 'delete', 'space/md', '--collection=Primitives', 'space/lg',
  ]), { names: ['space/md', 'space/lg'], collection: 'Primitives' });
  const literalArgv = variableDeleteArgvFromRequest({
    names: ['-literal'], collection: '-scope',
  });
  assert.deepEqual(literalArgv, ['var', 'delete', '--collection=-scope', '--', '-literal']);
  assert.deepEqual(parseVariableDeleteRequest(literalArgv), {
    names: ['-literal'], collection: '-scope',
  });
  for (const args of [
    ['var', 'delete'],
    ['var', 'delete', 'space/md', 'space/md'],
    ['var', 'delete', '--collection', 'Primitives'],
    ['var', 'delete', '--future', 'private-value'],
  ]) assert.throws(() => parseVariableDeleteRequest(args));
});

test('Variable Deletion removes an exact scoped batch and preserves missing output', async () => {
  const { figma, variables } = fixture();
  const result = await executeVariableDelete({
    names: ['space/md', 'space/lg', 'missing'], collection: 'Primitives',
  }, { evaluate: (code) => evaluate(code, figma) });
  assert.deepEqual(result.result.deleted.map((item) => item.id), ['V:1', 'V:2']);
  assert.deepEqual(result.result.missing, ['missing']);
  assert.deepEqual(variables.map((item) => item.id), ['V:3']);
  assert.equal(result.stdout, '✓ Deleted: space/md, space/lg\n⚠ Not deleted: missing');
});

test('Variable Deletion rejects ambiguity and duplicate resolved identity before mutation', async () => {
  const first = fixture();
  await assert.rejects(() => executeVariableDelete({ names: ['space/md'], collection: null }, {
    evaluate: (code) => evaluate(code, first.figma),
  }), /ambiguous/i);
  assert.equal(first.variables.length, 3);
  const second = fixture();
  await assert.rejects(() => executeVariableDelete({
    names: ['V:1', 'space/md'], collection: 'Primitives',
  }, { evaluate: (code) => evaluate(code, second.figma) }), /same Variable/i);
  assert.equal(second.variables.length, 3);
});

test('Variable Deletion reports unchanged and partial irreversible residue exactly', async () => {
  const unchanged = fixture({ removeFailures: ['V:1'] });
  await assert.rejects(() => executeVariableDelete({
    names: ['V:1'], collection: null,
  }, { evaluate: (code) => evaluate(code, unchanged.figma) }),
  (error) => error.mutationOutcome === 'unchanged'
    && error.variableDeleteMutationReport.residueCount === 1);

  const partial = fixture({ removeFailures: ['V:2'] });
  await assert.rejects(() => executeVariableDelete({
    names: ['V:1', 'V:2'], collection: null,
  }, { evaluate: (code) => evaluate(code, partial.figma) }),
  (error) => error.mutationOutcome === 'partial-residue'
    && error.variableDeleteMutationReport.deletedCount === 1
    && error.variableDeleteMutationReport.residueCount === 1);
});

test('Variable Deletion reports unavailable post-dispatch verification without guessing', async () => {
  const { figma } = fixture({ verificationUnavailable: true });
  await assert.rejects(() => executeVariableDelete({ names: ['V:1'], collection: null }, {
    evaluate: (code) => evaluate(code, figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable'
    && error.variableDeleteMutationReport.targetedCount === 1);
});

test('Variable Deletion rejects malformed bounded results', async () => {
  for (const serialized of [
    'not json',
    JSON.stringify({ schemaVersion: 1, status: 'deleted' }),
    JSON.stringify({
      schemaVersion: 1, status: 'failed', outcome: 'unchanged', scope: null,
      targeted: [], deleted: [], missing: [], residue: [], residueTruncated: false,
    }),
  ]) await assert.rejects(() => executeVariableDelete({ names: ['V:1'], collection: null }, {
    evaluate: async () => serialized,
  }), /invalid/i);
});

test('Variable Deletion accepts only authentic non-retrying Plans', async () => {
  const plan = planFigmaCommand(['var', 'delete', 'V:1']);
  assert.equal(variableDeletePlanRoute(plan), 'command-application');
  assert.equal(plan.execution.retry, 'never');
  assert.throws(() => variableDeletePlanRoute({ ...plan }));
  const { figma } = fixture();
  const result = await executeVariableDeletePlan(plan, {
    evaluate: (code) => evaluate(code, figma),
  });
  assert.equal(result.result.status, 'deleted');
});
