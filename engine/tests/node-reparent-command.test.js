import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeReparent,
  executeNodeReparentPlan,
  nodeReparentArgvFromRequest,
  nodeReparentPlanRoute,
  nodeReparentPlanningArgvFromRequest,
} from '../src/application/node-reparent-command.js';
import { parseNodeReparentRequest } from '../src/application/node-reparent-request.js';

function fixture({
  sameParent = false, destinationLayoutMode = 'NONE', mutationMode = 'normal',
  rollbackMode = 'normal', readFailures = [], cycle = false,
} = {}) {
  let reads = 0;
  let mutationCalls = 0;
  let rollbackCalls = 0;
  const source = parent('2:1', 'Source', [100, 50]);
  const destination = sameParent ? source : parent('4:1', 'Destination', [200, 100]);
  destination.layoutMode = destinationLayoutMode;
  const child = canvasNode('3:1', 'Card', 10, 20);
  const sibling = canvasNode('3:2', 'Sibling', 30, 40);
  const destinationSibling = canvasNode('4:2', 'Destination sibling', 0, 0);
  attach(source, child);
  attach(source, sibling);
  if (!sameParent) attach(destination, destinationSibling);
  if (cycle) destination.parent = child;

  function parent(id, name, [tx, ty]) {
    const value = {
      id, name, type: 'FRAME', layoutMode: 'NONE', children: [], parent: null,
      absoluteTransform: [[1, 0, tx], [0, 1, ty]],
      appendChild(node) { move(value.children.length, node, value); },
      insertChild(index, node) { move(index, node, value); },
    };
    return value;
  }
  function canvasNode(id, name, x, y) {
    return {
      id, name, type: 'RECTANGLE', x, y, parent: null,
      get absoluteTransform() {
        const transform = this.parent?.absoluteTransform || [[1, 0, 0], [0, 1, 0]];
        return [[1, 0, transform[0][2] + this.x], [0, 1, transform[1][2] + this.y]];
      },
    };
  }
  function attach(target, node, index = target.children.length) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    target.children.splice(index, 0, node);
    node.parent = target;
  }
  function move(index, node, target) {
    const isRollback = target === source && node === child && child.parent !== source;
    if (isRollback) rollbackCalls += 1;
    else mutationCalls += 1;
    if (isRollback && rollbackMode === 'no-effect') return;
    if (!isRollback && mutationMode === 'no-effect') return;
    const actualIndex = !isRollback && mutationMode === 'wrong-index' ? target.children.length : index;
    attach(target, node, actualIndex);
  }
  const nodes = new Map([[child.id, child], [source.id, source], [destination.id, destination]]);
  return {
    child, source, destination,
    get mutationCalls() { return mutationCalls; },
    get rollbackCalls() { return rollbackCalls; },
    figma: { async getNodeByIdAsync(id) {
      reads += 1;
      if (readFailures.includes(reads)) throw new Error('injected read failure');
      return nodes.get(id) || null;
    } },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Node Reparent closes options, arity and dual URL targeting', () => {
  assert.deepEqual(parseNodeReparentRequest([
    'node', 'reparent', '3-1', '4:1', '--index=0', '--no-preserve-position', '--json',
  ]), {
    nodeId: '3:1', parentId: '4:1', index: 0, preservePosition: false, json: true,
  });
  assert.deepEqual(nodeReparentArgvFromRequest({ nodeId: '3:1', parentId: '4:1' }), [
    'node', 'reparent', '3:1', '4:1',
  ]);
  const childUrl = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const parentUrl = 'https://www.figma.com/design/FILEA/Test?node-id=4-1';
  assert.deepEqual(nodeReparentPlanningArgvFromRequest({
    nodeId: childUrl, parentId: parentUrl, index: 0,
  }), ['node', 'reparent', childUrl, parentUrl, '--index', '0']);
  const plan = planFigmaCommand(['node', 'reparent', childUrl, parentUrl], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['node', 'reparent', '3:1', '4:1']);
  for (const args of [
    ['node', 'reparent'], ['node', 'reparent', '3:1'],
    ['node', 'reparent', '3:1', '4:1', 'extra'],
    ['node', 'reparent', '3:1', '4:1', '--index', '-1'],
    ['node', 'reparent', '3:1', '4:1', '--unknown'],
  ]) assert.throws(() => parseNodeReparentRequest(args));
  assert.throws(() => parseNodeReparentRequest([
    'node', 'reparent', childUrl,
    'https://www.figma.com/design/FILEB/Test?node-id=4-1',
  ]), /multiple Figma files/);
});

test('cross-parent success verifies exact membership and preserves canvas position', async () => {
  const live = fixture();
  const result = await executeNodeReparent({ nodeId: '3:1', parentId: '4:1' }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(live.source.children.map(({ id }) => id), ['3:2']);
  assert.deepEqual(live.destination.children.map(({ id }) => id), ['4:2', '3:1']);
  assert.equal(result.result.to.index, 1);
  assert.equal(result.result.positionPreserved, true);
  assert.deepEqual([live.child.x, live.child.y], [-90, -30]);
});

test('same-parent append is an explicit no-op while an index reorders exactly', async () => {
  const unchanged = fixture({ sameParent: true });
  const noOp = await executeNodeReparent({ nodeId: '3:1', parentId: '2:1' }, {
    evaluate: evaluate(unchanged.figma),
  });
  assert.equal(noOp.result.attempted, 0);
  assert.equal(unchanged.mutationCalls, 0);

  const reordered = fixture({ sameParent: true });
  const result = await executeNodeReparent({ nodeId: '3:1', parentId: '2:1', index: 1 }, {
    evaluate: evaluate(reordered.figma),
  });
  assert.deepEqual(reordered.source.children.map(({ id }) => id), ['3:2', '3:1']);
  assert.equal(result.result.to.index, 1);
  assert.equal(result.result.attempted, 1);
});

test('auto-layout destination reports that canvas position was not preserved', async () => {
  const live = fixture({ destinationLayoutMode: 'VERTICAL' });
  const result = await executeNodeReparent({ nodeId: '3:1', parentId: '4:1' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.positionPreserved, false);
  assert.deepEqual([live.child.x, live.child.y], [10, 20]);
});

test('mismatched hierarchy is rolled back and freshly verified', async () => {
  const live = fixture({ mutationMode: 'wrong-index' });
  await assert.rejects(() => executeNodeReparent({
    nodeId: '3:1', parentId: '4:1', index: 0,
  }, { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
    });
    return true;
  });
  assert.deepEqual(live.source.children.map(({ id }) => id), ['3:1', '3:2']);
  assert.deepEqual(live.destination.children.map(({ id }) => id), ['4:2']);
  assert.equal(live.rollbackCalls, 1);
});

test('rollback residue and unavailable verification remain distinct outcomes', async () => {
  const residue = fixture({ mutationMode: 'wrong-index', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeNodeReparent({
    nodeId: '3:1', parentId: '4:1', index: 0,
  }, { evaluate: evaluate(residue.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.ok(error.mutationReport.residueCount > 0);
    return true;
  });

  const unknown = fixture({ mutationMode: 'wrong-index', readFailures: [9] });
  await assert.rejects(() => executeNodeReparent({
    nodeId: '3:1', parentId: '4:1', index: 0,
  }, { evaluate: evaluate(unknown.figma) }),
  (error) => error.mutationOutcome === 'verification-unavailable');
});

test('invalid hierarchy and index refuse before mutation', async () => {
  for (const [request, live] of [
    [{ nodeId: '3:1', parentId: '4:1', index: 2 }, fixture()],
    [{ nodeId: '3:1', parentId: '4:1' }, fixture({ cycle: true })],
    [{ nodeId: '9:9', parentId: '4:1' }, fixture()],
  ]) {
    await assert.rejects(() => executeNodeReparent(request, { evaluate: evaluate(live.figma) }),
      (error) => error.mutationOutcome === 'no-mutation');
    assert.equal(live.mutationCalls, 0);
  }
});

test('one authentic non-retrying node.reparent plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand(['node', 'reparent', '3:1', '4:1'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'node.reparent');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(nodeReparentPlanRoute(plan), 'command-application');
  assert.throws(() => nodeReparentPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeNodeReparentPlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'reparented');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful reparents', async () => {
  const forged = JSON.stringify({
    schemaVersion: 1, status: 'reparented',
    node: { id: '3:1', name: 'Card', type: 'RECTANGLE' },
    from: { parentId: '2:1', index: 0 }, to: { parentId: '4:1', index: 0 },
    requested: { parentId: '4:1', index: 1, preservePosition: true },
    positionPreserved: true, attempted: 1, residue: [],
  });
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'reparented' }), forged]) {
    await assert.rejects(() => executeNodeReparent({
      nodeId: '3:1', parentId: '4:1', index: 1,
    }, { evaluate: async () => value }), /invalid/i);
  }
});
