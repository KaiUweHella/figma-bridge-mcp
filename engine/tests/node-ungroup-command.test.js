import assert from 'node:assert/strict'; import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import { executeNodeUngroup, executeNodeUngroupPlan, nodeUngroupPlanRoute, nodeUngroupPlanningArgvFromRequest } from '../src/application/node-ungroup-command.js';
import { parseNodeUngroupRequest } from '../src/application/node-ungroup-request.js';

function fixture({ mode = 'normal', readFailures = [] } = {}) {
  let reads = 0; let calls = 0;
  const parent = { id: '2:1', type: 'FRAME', children: [] };
  const group = { id: '3:1', name: 'Pair', type: 'GROUP', parent, children: [] };
  const one = { id: '4:1', parent: group }; const two = { id: '4:2', parent: group }; const peer = { id: '2:2', parent };
  group.children.push(one, two); parent.children.push(group, peer);
  const nodes = new Map([[parent.id, parent], [group.id, group], [one.id, one], [two.id, two]]);
  const figma = { async getNodeByIdAsync(id) { reads++; if (readFailures.includes(reads)) throw new Error('read failure'); return nodes.get(id) || null; }, ungroup(target) { calls++; if (mode === 'throw') throw new Error('native failure'); parent.children.splice(0, 1, one, two); one.parent = parent; two.parent = parent; target.parent = null; nodes.delete(target.id); if (mode === 'wrong-order') parent.children.reverse(); return [one, two]; } };
  return { figma, parent, group, get calls() { return calls; } };
}
const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Node Ungroup closes one URL target and JSON option', () => {
  assert.deepEqual(parseNodeUngroupRequest(['node', 'ungroup', '3-1', '--json']), { nodeId: '3:1', json: true });
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  assert.deepEqual(nodeUngroupPlanningArgvFromRequest({ nodeId: url }), ['node', 'ungroup', url]);
  const plan = planFigmaCommand(['node', 'ungroup', url], { adapter: 'mcp' }); assert.equal(plan.target.fileKey, 'FILEA'); assert.deepEqual(plan.argv, ['node', 'ungroup', '3:1']);
  for (const args of [['node', 'ungroup'], ['node', 'ungroup', '3:1', '4:1'], ['node', 'ungroup', 'bad'], ['node', 'ungroup', '3:1', '--wat']]) assert.throws(() => parseNodeUngroupRequest(args));
});
test('success verifies exact parent replacement and child attachment', async () => {
  const live = fixture(); const result = await executeNodeUngroup({ nodeId: '3:1' }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(live.parent.children.map(({ id }) => id), ['4:1', '4:2', '2:2']); assert.deepEqual(result.result.children, ['4:1', '4:2']); assert.equal(live.calls, 1);
});
test('verified native refusal and partial residue stay distinct', async () => {
  const unchanged = fixture({ mode: 'throw' }); await assert.rejects(() => executeNodeUngroup({ nodeId: '3:1' }, { evaluate: evaluate(unchanged.figma) }), (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  const residue = fixture({ mode: 'wrong-order' }); await assert.rejects(() => executeNodeUngroup({ nodeId: '3:1' }, { evaluate: evaluate(residue.figma) }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount > 0);
});
test('preflight refusal makes no native call and unavailable reads stay explicit', async () => {
  const wrong = fixture(); wrong.group.type = 'FRAME'; await assert.rejects(() => executeNodeUngroup({ nodeId: '3:1' }, { evaluate: evaluate(wrong.figma) }), (error) => error.mutationOutcome === 'no-mutation'); assert.equal(wrong.calls, 0);
  const unknown = fixture({ mode: 'wrong-order', readFailures: [7] }); await assert.rejects(() => executeNodeUngroup({ nodeId: '3:1' }, { evaluate: evaluate(unknown.figma) }), (error) => error.mutationOutcome === 'verification-unavailable');
});
test('authentic node.ungroup Plan dispatches exactly once', async () => {
  const plan = planFigmaCommand(['node', 'ungroup', '3:1'], { adapter: 'mcp', fileKey: 'FILEA' }); assert.equal(nodeUngroupPlanRoute(plan), 'command-application'); assert.throws(() => nodeUngroupPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture(); let calls = 0; const result = await executeNodeUngroupPlan(plan, { evaluate: async (code) => { calls++; return evaluate(live.figma)(code); } }); assert.equal(result.result.status, 'ungrouped'); assert.equal(calls, 1);
});
test('malformed Plugin results cannot become success', async () => { for (const value of [null, {}, 'bad', JSON.stringify({ status: 'ungrouped' })]) await assert.rejects(() => executeNodeUngroup({ nodeId: '3:1' }, { evaluate: async () => value }), /invalid/i); });
