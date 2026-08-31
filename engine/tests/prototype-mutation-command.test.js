import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executePrototypeMutation,
  executePrototypeMutationPlan,
  prototypeMutationCode,
  prototypeMutationPlanRoute,
} from '../src/application/prototype-mutation-command.js';
import {
  acceptsPrototypeMutationArgv,
  parsePrototypeMutationRequest,
  prototypeMutationArgvFromRequest,
  prototypeMutationFigmaUrlFileKeyFromArgv,
  prototypeMutationPlanningArgvFromRequest,
} from '../src/application/prototype-mutation-request.js';

const original = Object.freeze([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }]);

function fixture({ mode = 'apply' } = {}) {
  let reactions = structuredClone(original);
  let writes = 0;
  const node = {
    id: '1:2', name: 'Prototype trigger', type: 'FRAME',
    get reactions() { return reactions; },
    async setReactionsAsync(next) {
      writes += 1;
      if (mode === 'throw-after-apply' && writes === 1) {
        reactions = structuredClone(next);
        throw new Error('native setter reported failure');
      }
      if (['wrong', 'rollback-fails'].includes(mode) && writes === 1) {
        reactions = [{ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'CLOSE' }] }];
        return;
      }
      if (mode === 'oversized' && writes === 1) {
        reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'URL', url: 'x'.repeat(400_001) }] }];
        return;
      }
      if (mode === 'rollback-fails' && writes > 1) return;
      reactions = structuredClone(next);
    },
  };
  return {
    figma: { getNodeByIdAsync: async (id) => id === node.id ? node : null },
    reactions: () => reactions,
    writes: () => writes,
  };
}

const plugin = (request, figma) => new Function('figma', `return ${prototypeMutationCode(request)}`)(figma);

test('Prototype Mutation closes add, set and clear inputs and URL identity', () => {
  const sourceUrl = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=1-2';
  const targetUrl = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=3-4';
  assert.deepEqual(parsePrototypeMutationRequest([
    'prototype', 'add', sourceUrl, '--trigger', 'after:0.5', '--navigate-to', targetUrl,
    '--transition', '{"type":"DISSOLVE","duration":0.2}',
  ]), {
    action: 'add', nodeId: '1:2', trigger: { type: 'AFTER_TIMEOUT', timeout: 0.5 },
    reactions: null,
    actions: [{ type: 'NODE', destinationId: '3:4', navigation: 'NAVIGATE', transition: { type: 'DISSOLVE', duration: 0.2 } }],
  });
  assert.deepEqual(parsePrototypeMutationRequest([
    'prototype', 'set', '1:2', '--json', '[{"trigger":null,"actions":[{"type":"CLOSE"}]}]',
  ]), {
    action: 'set', nodeId: '1:2', trigger: null, actions: null,
    reactions: [{ trigger: null, actions: [{ type: 'CLOSE' }] }],
  });
  assert.equal(parsePrototypeMutationRequest(['prototype', 'clear', '1:2']).action, 'clear');
  assert.equal(prototypeMutationFigmaUrlFileKeyFromArgv([
    'prototype', 'add', sourceUrl, '--navigate-to', targetUrl,
  ]), 'PLACEHOLDERFILEKEY');
  const destinationTarget = planFigmaCommand(prototypeMutationPlanningArgvFromRequest({
    action: 'add', nodeId: '1:2', navigateTo: targetUrl,
  }));
  assert.equal(destinationTarget.target.fileKey, 'PLACEHOLDERFILEKEY');
  assert.throws(() => prototypeMutationFigmaUrlFileKeyFromArgv([
    'prototype', 'add', sourceUrl, '--navigate-to',
    'https://www.figma.com/design/SECONDPLACEHOLDERKEY/FILE_NAME?node-id=3-4',
  ]), /different Figma files/);
  for (const argv of [
    ['prototype', 'add', '1:2'],
    ['prototype', 'set', '1:2'],
    ['prototype', 'clear', '1:2', '--json', '[]'],
    ['prototype', 'add', '1:2', '--actions', '{}'],
    ['prototype', 'set', 'not-a-node', '--json', '[]'],
  ]) assert.equal(acceptsPrototypeMutationArgv(argv), false, argv.join(' '));
});

test('Prototype Mutation applies each action with exact fresh readback', async () => {
  const addFixture = fixture();
  const added = await executePrototypeMutation({
    action: 'add', nodeId: '1:2', trigger: 'hover', actions: [{ type: 'CLOSE' }],
  }, { evaluate: async (code) => new Function('figma', `return ${code}`)(addFixture.figma) });
  assert.equal(added.result.status, 'applied');
  assert.equal(added.result.reactions.length, 2);

  const setFixture = fixture();
  const set = await executePrototypeMutation({
    action: 'set', nodeId: '1:2', reactions: [{ trigger: { type: 'ON_PRESS' }, actions: [{ type: 'BACK' }] }],
  }, { evaluate: async () => plugin({ action: 'set', nodeId: '1:2', reactions: [{ trigger: { type: 'ON_PRESS' }, actions: [{ type: 'BACK' }] }] }, setFixture.figma) });
  assert.equal(set.result.reactions[0].trigger.type, 'ON_PRESS');

  const clearFixture = fixture();
  const cleared = await executePrototypeMutation({ action: 'clear', nodeId: '1:2' }, {
    evaluate: async () => plugin({ action: 'clear', nodeId: '1:2' }, clearFixture.figma),
  });
  assert.deepEqual(cleared.result.reactions, []);
});

test('Prototype Mutation preserves verified-after-error, rollback and exact residue', async () => {
  const afterError = fixture({ mode: 'throw-after-apply' });
  const verified = await executePrototypeMutation({ action: 'clear', nodeId: '1:2' }, {
    evaluate: async () => plugin({ action: 'clear', nodeId: '1:2' }, afterError.figma),
  });
  assert.equal(verified.result.outcome, 'verified-after-error');

  const wrong = fixture({ mode: 'wrong' });
  await assert.rejects(() => executePrototypeMutation({ action: 'clear', nodeId: '1:2' }, {
    evaluate: async () => plugin({ action: 'clear', nodeId: '1:2' }, wrong.figma),
  }), (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0
    && JSON.stringify(wrong.reactions()) === JSON.stringify(original));

  const residue = fixture({ mode: 'rollback-fails' });
  await assert.rejects(() => executePrototypeMutation({ action: 'clear', nodeId: '1:2' }, {
    evaluate: async () => plugin({ action: 'clear', nodeId: '1:2' }, residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);

  const oversized = fixture({ mode: 'oversized' });
  await assert.rejects(() => executePrototypeMutation({ action: 'clear', nodeId: '1:2' }, {
    evaluate: async () => plugin({ action: 'clear', nodeId: '1:2' }, oversized.figma),
  }), (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0
    && JSON.stringify(oversized.reactions()) === JSON.stringify(original));
});

test('Prototype Mutation has one non-retrying Plan and one evaluation in both Adapters', async () => {
  const requests = [
    { action: 'add', nodeId: '1:2', trigger: 'click', actions: [{ type: 'BACK' }] },
    { action: 'set', nodeId: '1:2', reactions: [{ trigger: null, actions: [{ type: 'CLOSE' }] }] },
    { action: 'clear', nodeId: '1:2' },
  ];
  for (const request of requests) {
    const argv = prototypeMutationArgvFromRequest(request);
    const mcp = planFigmaCommand(prototypeMutationPlanningArgvFromRequest(request), { adapter: 'mcp' });
    const cli = planFigmaCommand(argv, { adapter: 'cli' });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
    assert.equal(prototypeMutationPlanRoute(mcp), 'command-application');
    assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
    const source = fixture(); let evaluations = 0;
    await executePrototypeMutationPlan(mcp, {
      evaluate: async (code) => { evaluations += 1; return new Function('figma', `return ${code}`)(source.figma); },
    });
    assert.equal(evaluations, 1);
  }
});
