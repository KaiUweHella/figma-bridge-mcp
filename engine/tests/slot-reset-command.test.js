import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSlotReset,
  executeSlotResetPlan,
  slotResetCode,
  slotResetPlanRoute,
} from '../src/application/slot-reset-command.js';
import {
  acceptsSlotResetArgv,
  parseSlotResetRequest,
  slotResetArgvFromRequest,
  slotResetFigmaUrlFileKeyFromArgv,
  slotResetPlanningArgvFromRequest,
} from '../src/application/slot-reset-request.js';

function fixture({ mode = 'apply', failFresh = false } = {}) {
  let calls = 0; let reads = 0;
  let children = [{ id: '3:1', type: 'TEXT' }];
  let violations = ['ABOVE_MAX'];
  const slot = {
    id: '2:1', name: 'Content', type: 'SLOT',
    get children() { return children; },
    get limitViolations() { return violations; },
    resetSlot() {
      calls += 1;
      if (mode !== 'no-effect') { children = [{ id: '3:2', type: 'RECTANGLE' }]; violations = []; }
      if (mode === 'throw-after-apply') throw new Error('reset failed');
    },
  };
  return {
    figma: {
      getNodeByIdAsync: async (id) => {
        reads += 1; if (failFresh && reads > 1) throw new Error('fresh read failed');
        return id === slot.id ? slot : null;
      },
    },
    calls: () => calls,
  };
}
const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Slot Reset closes one URL-targeted request', () => {
  const url = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=2-1';
  assert.deepEqual(parseSlotResetRequest(['slot', 'reset', url]), { nodeId: '2:1' });
  assert.equal(slotResetFigmaUrlFileKeyFromArgv(['slot', 'reset', url]), 'PLACEHOLDERFILEKEY');
  assert.deepEqual(slotResetArgvFromRequest({ nodeId: '2-1' }), ['slot', 'reset', '--', '2:1']);
  for (const args of [
    ['slot', 'reset'], ['slot', 'reset', '2:1', '3:1'],
    ['slot', 'reset', '--future', 'private-value'],
  ]) assert.equal(acceptsSlotResetArgv(args), false, args.join(' '));
});

test('Slot Reset reports a native-confirmed fresh before/after fact pair', async () => {
  const live = fixture();
  const result = await executeSlotReset({ nodeId: '2:1' }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'reset');
  assert.equal(result.result.outcome, 'native-confirmed');
  assert.equal(result.result.changed, true);
  assert.equal(result.result.before.childCount, 1);
  assert.deepEqual(result.result.before.limitViolations, ['ABOVE_MAX']);
  assert.deepEqual(result.result.after.limitViolations, []);
  assert.equal(live.calls(), 1);
});

test('Slot Reset never retries or guesses success after a dispatched error', async () => {
  for (const live of [fixture({ mode: 'throw-after-apply' }), fixture({ failFresh: true })]) {
    await assert.rejects(() => executeSlotReset({ nodeId: '2:1' }, {
      evaluate: evaluate(live.figma),
    }), (error) => error.mutationOutcome === 'verification-unavailable'
      && error.mutationReport.attempted === 1 && error.mutationReport.residueCount === 1);
    assert.equal(live.calls(), 1);
  }
});

test('Slot Reset uses one non-retrying canonical Plan in both Adapters', async () => {
  const url = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=2-1';
  const cli = planFigmaCommand(slotResetArgvFromRequest({ nodeId: url }), { adapter: 'cli' });
  const mcp = planFigmaCommand(slotResetPlanningArgvFromRequest({ nodeId: url }), { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.execution.retry, 'never');
  assert.equal(mcp.target.fileKey, 'PLACEHOLDERFILEKEY');
  assert.equal(slotResetPlanRoute(mcp), 'command-application');
  const live = fixture(); let evaluations = 0;
  await executeSlotResetPlan(mcp, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(evaluations, 1); assert.equal(live.calls(), 1);
});

test('Slot Reset rejects malformed Plugin results after dispatch', async () => {
  for (const payload of [null, {}, 'not-json', JSON.stringify({ status: 'reset' })]) {
    await assert.rejects(() => executeSlotReset({ nodeId: '2:1' }, {
      evaluate: async () => payload,
    }), /invalid/i);
  }
  assert.doesNotThrow(() => new Function('figma', `return ${slotResetCode({ nodeId: '2:1' })}`));
});
