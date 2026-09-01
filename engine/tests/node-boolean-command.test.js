import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeBoolean,
  executeNodeBooleanPlan,
  nodeBooleanPlanRoute,
  nodeBooleanPlanningArgvFromRequest,
} from '../src/application/node-boolean-command.js';
import { parseNodeBooleanRequest } from '../src/application/node-boolean-request.js';

function fixture({ mode = 'normal', readFailures = [] } = {}) {
  let reads = 0;
  const calls = [];
  const source = parent('2:1', 'Source');
  const target = parent('4:1', 'Target');
  const first = node('3:1', 'One');
  const second = node('3:2', 'Two');
  const sourcePeer = node('3:3', 'Peer');
  const targetPeer = node('4:2', 'Target peer');
  attach(source, first); attach(source, second); attach(source, sourcePeer); attach(target, targetPeer);
  let boolean = null;

  function parent(id, name) {
    return { id, name, type: 'FRAME', children: [], parent: null,
      appendChild(child) { attach(this, child); },
      insertChild(index, child) { attach(this, child, index); } };
  }
  function node(id, name) { return { id, name, type: 'RECTANGLE', parent: null }; }
  function attach(destination, child, index = destination.children.length) {
    if (child.parent) {
      const oldIndex = child.parent.children.indexOf(child);
      if (oldIndex >= 0) child.parent.children.splice(oldIndex, 1);
    }
    destination.children.splice(Math.min(index, destination.children.length), 0, child);
    child.parent = destination;
  }
  const nodes = new Map([
    [source.id, source], [target.id, target], [first.id, first], [second.id, second],
  ]);
  function combine(operation, members, destination, index) {
    calls.push(operation);
    if (mode === 'throw') throw new Error('native failure');
    const firstSourceIndex = Math.min(...members.filter((member) => member.parent === destination)
      .map((member) => destination.children.indexOf(member)), destination.children.length);
    boolean = { id: '9:1', type: mode === 'wrong-type' ? 'GROUP' : 'BOOLEAN_OPERATION',
      booleanOperation: mode === 'wrong-operation' ? 'EXCLUDE' : operation,
      parent: null, children: [], _name: 'Boolean 1',
      get name() { return this._name; },
      set name(value) { if (mode !== 'name-no-effect') this._name = value; } };
    for (const member of members) attach(boolean, member);
    if (mode === 'wrong-membership') boolean.children.reverse();
    attach(destination, boolean, index === undefined ? firstSourceIndex : index);
    if (mode === 'wrong-index') attach(destination, boolean, destination.children.length);
    return boolean;
  }
  const figma = {
    async getNodeByIdAsync(id) {
      reads += 1;
      if (readFailures.includes(reads)) throw new Error('injected read failure');
      if (boolean && id === boolean.id && boolean.parent) return boolean;
      return nodes.get(id) || null;
    },
    union: (members, destination, index) => combine('UNION', members, destination, index),
    subtract: (members, destination, index) => combine('SUBTRACT', members, destination, index),
    intersect: (members, destination, index) => combine('INTERSECT', members, destination, index),
    exclude: (members, destination, index) => combine('EXCLUDE', members, destination, index),
  };
  return { figma, source, target, first, second, get boolean() { return boolean; }, calls };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Node Boolean closes operation, arity, options and URL targeting', () => {
  assert.deepEqual(parseNodeBooleanRequest([
    'node', 'boolean', 'UNION', '3-1', '3:2', '--index=0', '--name', 'Shape', '--json',
  ]), {
    operation: 'union', nodeIds: ['3:1', '3:2'], parentId: null, index: 0,
    name: 'Shape', json: true,
  });
  const one = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const two = 'https://www.figma.com/design/FILEA/Test?node-id=3-2';
  assert.deepEqual(nodeBooleanPlanningArgvFromRequest({ operation: 'subtract', nodeIds: [one, two] }),
    ['node', 'boolean', 'subtract', one, two]);
  const plan = planFigmaCommand(['node', 'boolean', 'union', one, two], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['node', 'boolean', 'union', '3:1', '3:2']);
  for (const args of [
    ['node', 'boolean'], ['node', 'boolean', 'merge', '3:1', '3:2'],
    ['node', 'boolean', 'union', '3:1'], ['node', 'boolean', 'union', '3:1', '3:1'],
    ['node', 'boolean', 'union', '3:1', '3:2', '--index', '-1'],
    ['node', 'boolean', 'union', 'bad', '3:2'],
  ]) assert.throws(() => parseNodeBooleanRequest(args));
  assert.throws(() => parseNodeBooleanRequest([
    'node', 'boolean', 'union', one,
    'https://www.figma.com/design/FILEB/Test?node-id=3-2',
  ]), /multiple Figma files/);
});

test('each closed operation maps to its native method and official result enum', async () => {
  for (const [operation, expected] of Object.entries({
    union: 'UNION', subtract: 'SUBTRACT', intersect: 'INTERSECT', exclude: 'EXCLUDE',
  })) {
    const live = fixture();
    const response = await executeNodeBoolean({ operation, nodeIds: ['3:1', '3:2'] },
      { evaluate: evaluate(live.figma) });
    assert.deepEqual(live.calls, [expected]);
    assert.equal(response.result.boolean.operation, expected);
    assert.equal(response.result.boolean.type, 'BOOLEAN_OPERATION');
  }
});

test('same-parent Boolean verifies exact replacement and ordered membership', async () => {
  const live = fixture();
  const response = await executeNodeBoolean({ operation: 'union', nodeIds: ['3:1', '3:2'], name: 'Shape' },
    { evaluate: evaluate(live.figma) });
  assert.deepEqual(live.source.children.map(({ id }) => id), ['9:1', '3:3']);
  assert.deepEqual(live.boolean.children.map(({ id }) => id), ['3:1', '3:2']);
  assert.equal(response.result.boolean.name, 'Shape');
  assert.equal(response.result.boolean.index, 0);
});

test('explicit parent and index verify every affected parent order', async () => {
  const live = fixture();
  const response = await executeNodeBoolean({
    operation: 'intersect', nodeIds: ['3:1', '3:2'], parentId: '4:1', index: 0,
  }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(live.source.children.map(({ id }) => id), ['3:3']);
  assert.deepEqual(live.target.children.map(({ id }) => id), ['9:1', '4:2']);
  assert.equal(response.result.boolean.parentId, '4:1');
});

test('unchanged native failure and irreversible residue stay distinct', async () => {
  const unchanged = fixture({ mode: 'throw' });
  await assert.rejects(() => executeNodeBoolean({ operation: 'union', nodeIds: ['3:1', '3:2'] },
    { evaluate: evaluate(unchanged.figma) }),
  (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);

  for (const mode of ['wrong-type', 'wrong-operation', 'wrong-membership', 'name-no-effect']) {
    const residue = fixture({ mode });
    await assert.rejects(() => executeNodeBoolean({
      operation: 'union', nodeIds: ['3:1', '3:2'], name: mode === 'name-no-effect' ? 'Shape' : null,
    }, { evaluate: evaluate(residue.figma) }),
    (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount > 0);
  }
});

test('failed postcondition read reports verification unavailable', async () => {
  const live = fixture({ mode: 'name-no-effect', readFailures: [7] });
  await assert.rejects(() => executeNodeBoolean({
    operation: 'union', nodeIds: ['3:1', '3:2'], name: 'Shape',
  }, { evaluate: evaluate(live.figma) }),
  (error) => error.mutationOutcome === 'verification-unavailable');
});

test('invalid hierarchy refuses before native mutation', async () => {
  const split = fixture();
  split.target.appendChild(split.second);
  await assert.rejects(() => executeNodeBoolean({ operation: 'union', nodeIds: ['3:1', '3:2'] },
    { evaluate: evaluate(split.figma) }), (error) => error.mutationOutcome === 'no-mutation');
  assert.deepEqual(split.calls, []);

  const cycle = fixture();
  await assert.rejects(() => executeNodeBoolean({
    operation: 'union', nodeIds: ['3:1', '3:2'], parentId: '3:1',
  }, { evaluate: evaluate(cycle.figma) }), (error) => error.mutationOutcome === 'no-mutation');
  assert.deepEqual(cycle.calls, []);
});

test('one authentic non-retrying Plan dispatches exactly once', async () => {
  const plan = planFigmaCommand(['node', 'boolean', 'exclude', '3:1', '3:2'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'node.boolean');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(nodeBooleanPlanRoute(plan), 'command-application');
  assert.throws(() => nodeBooleanPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const response = await executeNodeBooleanPlan(plan, { evaluate: async (code) => {
    evaluations += 1; return evaluate(live.figma)(code);
  } });
  assert.equal(response.result.status, 'combined');
  assert.equal(evaluations, 1);
});

test('malformed or forged Plugin responses cannot become successful Boolean operations', async () => {
  for (const value of [null, {}, 'bad', JSON.stringify({ status: 'combined' }), JSON.stringify({
    schemaVersion: 1, status: 'combined',
    boolean: { id: '9:1', name: 'Shape', type: 'BOOLEAN_OPERATION', operation: 'EXCLUDE', parentId: '2:1', index: 0 },
    childIds: ['3:1', '3:2'], requested: { operation: 'union', nodeIds: ['3:1', '3:2'], parentId: null, index: null, name: null }, attempted: 1, residue: [],
  })]) {
    await assert.rejects(() => executeNodeBoolean({ operation: 'union', nodeIds: ['3:1', '3:2'] },
      { evaluate: async () => value }), /invalid/i);
  }
});
