import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeGroup,
  executeNodeGroupPlan,
  nodeGroupArgvFromRequest,
  nodeGroupPlanRoute,
  nodeGroupPlanningArgvFromRequest,
} from '../src/application/node-group-command.js';
import { parseNodeGroupRequest } from '../src/application/node-group-request.js';

function fixture({ nameMode = 'normal', ungroupMode = 'normal', readFailures = [] } = {}) {
  let reads = 0; let groupCalls = 0; let ungroupCalls = 0;
  const source = parent('2:1', 'Source'); const target = parent('4:1', 'Target');
  const first = node('3:1', 'One', 10, 20); const second = node('3:2', 'Two', 30, 40);
  const sourcePeer = node('3:3', 'Peer', 0, 0); const targetPeer = node('4:2', 'Target peer', 0, 0);
  attach(source, first); attach(source, second); attach(source, sourcePeer); attach(target, targetPeer);
  let group = null;
  function parent(id, name) { return { id, name, type: 'FRAME', children: [], parent: null, appendChild(child) { attach(this, child); }, insertChild(index, child) { attach(this, child, index); } }; }
  function node(id, name, x, y) { return { id, name, type: 'RECTANGLE', x, y, parent: null }; }
  function attach(destination, child, index = destination.children.length) {
    if (child.parent) { const old = child.parent.children.indexOf(child); if (old >= 0) child.parent.children.splice(old, 1); }
    destination.children.splice(Math.min(index, destination.children.length), 0, child); child.parent = destination;
  }
  function remove(child) { if (!child.parent) return; const index = child.parent.children.indexOf(child); if (index >= 0) child.parent.children.splice(index, 1); child.parent = null; }
  const nodes = new Map([[source.id, source], [target.id, target], [first.id, first], [second.id, second]]);
  const figma = {
    async getNodeByIdAsync(id) {
      reads += 1; if (readFailures.includes(reads)) throw new Error('injected read failure');
      if (group && id === group.id && group.parent) return group;
      return nodes.get(id) || null;
    },
    group(members, destination, index) {
      groupCalls += 1;
      group = { id: '9:1', type: 'GROUP', parent: null, children: [], _name: 'Group 1',
        get name() { return this._name; }, set name(value) { if (nameMode !== 'no-effect') this._name = value; } };
      const defaultIndex = Math.min(...members.filter((item) => item.parent === destination).map((item) => destination.children.indexOf(item)), destination.children.length);
      for (const member of members) attach(group, member);
      attach(destination, group, index === undefined ? defaultIndex : index);
      return group;
    },
    ungroup(value) {
      ungroupCalls += 1; if (ungroupMode === 'no-effect') return value.children;
      const destination = value.parent; const index = destination.children.indexOf(value);
      const children = [...value.children]; remove(value);
      children.forEach((child, offset) => attach(destination, child, index + offset));
      return children;
    },
  };
  return { figma, source, target, first, second, get group() { return group; }, get groupCalls() { return groupCalls; }, get ungroupCalls() { return ungroupCalls; } };
}
const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Node Group closes variadic identity, options and URL targeting', () => {
  assert.deepEqual(parseNodeGroupRequest(['node', 'group', '3-1', '3:2', '--index=0', '--name', 'Pair', '--json']), {
    nodeIds: ['3:1', '3:2'], parentId: null, index: 0, name: 'Pair', json: true,
  });
  assert.deepEqual(nodeGroupArgvFromRequest({ nodeIds: ['3:1', '3:2'], parentId: '4:1' }), ['node', 'group', '3:1', '3:2', '--parent', '4:1']);
  const one = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const two = 'https://www.figma.com/design/FILEA/Test?node-id=3-2';
  assert.deepEqual(nodeGroupPlanningArgvFromRequest({ nodeIds: [one, two] }), ['node', 'group', one, two]);
  const plan = planFigmaCommand(['node', 'group', one, two, '--name', 'Pair'], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['node', 'group', '3:1', '3:2', '--name', 'Pair']);
  for (const args of [['node', 'group'], ['node', 'group', '3:1'], ['node', 'group', '3:1', '3:1'], ['node', 'group', '3:1', '3:2', '--index', '-1'], ['node', 'group', '3:1', '3:2', '--wat']]) assert.throws(() => parseNodeGroupRequest(args));
  assert.throws(() => parseNodeGroupRequest(['node', 'group', one, 'https://www.figma.com/design/FILEB/Test?node-id=3-2']), /multiple Figma files/);
});

test('same-parent grouping verifies replacement and exact membership', async () => {
  const live = fixture();
  const result = await executeNodeGroup({ nodeIds: ['3:1', '3:2'], name: 'Pair' }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(live.source.children.map(({ id }) => id), ['9:1', '3:3']);
  assert.deepEqual(live.group.children.map(({ id }) => id), ['3:1', '3:2']);
  assert.equal(result.result.group.name, 'Pair'); assert.equal(result.result.group.index, 0);
});

test('explicit parent and index verify all affected parent orders', async () => {
  const live = fixture();
  const result = await executeNodeGroup({ nodeIds: ['3:1', '3:2'], parentId: '4:1', index: 0 }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(live.source.children.map(({ id }) => id), ['3:3']);
  assert.deepEqual(live.target.children.map(({ id }) => id), ['9:1', '4:2']);
  assert.equal(result.result.group.parentId, '4:1'); assert.equal(result.result.group.index, 0);
});

test('postcondition mismatch restores original parents, order and position', async () => {
  const live = fixture({ nameMode: 'no-effect' });
  await assert.rejects(() => executeNodeGroup({ nodeIds: ['3:1', '3:2'], parentId: '4:1', name: 'Pair' }, { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back'); assert.equal(error.mutationReport.residueCount, 0); return true;
  });
  assert.deepEqual(live.source.children.map(({ id }) => id), ['3:1', '3:2', '3:3']);
  assert.deepEqual(live.target.children.map(({ id }) => id), ['4:2']);
  assert.deepEqual([live.first.x, live.first.y, live.second.x, live.second.y], [10, 20, 30, 40]);
});

test('failed rollback and unavailable verification remain explicit', async () => {
  const residue = fixture({ nameMode: 'no-effect', ungroupMode: 'no-effect' });
  await assert.rejects(() => executeNodeGroup({ nodeIds: ['3:1', '3:2'], parentId: '4:1', name: 'Pair' }, { evaluate: evaluate(residue.figma) }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount > 0);
  const unknown = fixture({ nameMode: 'no-effect', readFailures: [12] });
  await assert.rejects(() => executeNodeGroup({ nodeIds: ['3:1', '3:2'], name: 'Pair' }, { evaluate: evaluate(unknown.figma) }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('invalid parent relationship refuses before group mutation', async () => {
  const live = fixture(); live.second.parent = live.target;
  await assert.rejects(() => executeNodeGroup({ nodeIds: ['3:1', '3:2'] }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(live.groupCalls, 0);
});

test('one authentic non-retrying node.group plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand(['node', 'group', '3:1', '3:2'], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(plan.id, 'node.group'); assert.equal(plan.execution.retry, 'never'); assert.equal(nodeGroupPlanRoute(plan), 'command-application');
  assert.throws(() => nodeGroupPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture(); let evaluations = 0;
  const result = await executeNodeGroupPlan(plan, { evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); } });
  assert.equal(result.result.status, 'grouped'); assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful groups', async () => {
  for (const value of [null, {}, 'bad', JSON.stringify({ status: 'grouped' })]) {
    await assert.rejects(() => executeNodeGroup({ nodeIds: ['3:1', '3:2'] }, { evaluate: async () => value }), /invalid/i);
  }
});
