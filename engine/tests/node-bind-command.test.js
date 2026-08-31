import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeBind,
  executeNodeBindPlan,
  nodeBindPlanRoute,
  nodeBindPlanningArgvFromRequest,
} from '../src/application/node-bind-command.js';
import { parseNodeBindRequest } from '../src/application/node-bind-request.js';

const alias = (id) => ({ type: 'VARIABLE_ALIAS', id });

function fixture({ scalarMode = 'normal', paintMode = 'normal', duplicateVariable = false,
  duplicateCollection = false, readFailures = [] } = {}) {
  let reads = 0;
  const calls = [];
  const collections = [
    { id: 'CollectionID:1', name: 'Tokens', remote: false },
    { id: 'CollectionID:2', name: duplicateCollection ? 'Tokens copy' : 'Other', remote: false },
  ];
  const variables = [
    { id: 'VariableID:1', name: 'space/md', resolvedType: 'FLOAT', remote: false, variableCollectionId: 'CollectionID:1' },
    { id: 'VariableID:2', name: duplicateVariable ? 'space/md' : 'space/lg', resolvedType: 'FLOAT', remote: false, variableCollectionId: 'CollectionID:2' },
    { id: 'VariableID:3', name: 'brand/base', resolvedType: 'COLOR', remote: false, variableCollectionId: 'CollectionID:1' },
    { id: 'VariableID:4', name: 'old', resolvedType: 'FLOAT', remote: false, variableCollectionId: 'CollectionID:1' },
  ];
  let scalarFailureUsed = false;
  let paintAssignments = 0;
  const node = {
    id: '1:2', name: 'Card', type: 'FRAME', cornerRadius: 8,
    itemSpacing: 8, opacity: 1, strokeWeight: 1, width: 100, height: 80,
    paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8,
    boundVariables: {}, _fills: [
      { type: 'SOLID', color: { r: 1, g: 1, b: 1 } },
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 } },
    ], _strokes: [],
    get fills() { return this._fills; },
    set fills(value) {
      paintAssignments += 1;
      if (paintMode === 'ignore-request' && paintAssignments === 1) return;
      if (paintMode === 'wrong-and-ignore-rollback' && paintAssignments > 1) return;
      this._fills = value;
    },
    get strokes() { return this._strokes; },
    set strokes(value) { this._strokes = value; },
    setBoundVariable(field, variable) {
      calls.push({ field, id: variable?.id || null });
      if (scalarMode === 'fail-second' && field === 'paddingRight' && variable
        && variable.id === 'VariableID:1' && !scalarFailureUsed) {
        scalarFailureUsed = true; throw new Error('injected setter failure');
      }
      if (scalarMode === 'ignore-request' && variable?.id === 'VariableID:1') return;
      if (scalarMode === 'wrong-and-ignore-rollback') {
        if (variable?.id === 'VariableID:1') variable = variables.find(({ id }) => id === 'VariableID:2');
        else return;
      }
      if (field === 'cornerRadius') {
        delete this.boundVariables.cornerRadius;
        for (const corner of ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius']) {
          if (variable) this.boundVariables[corner] = alias(variable.id);
          else delete this.boundVariables[corner];
        }
      } else if (variable) this.boundVariables[field] = alias(variable.id);
      else delete this.boundVariables[field];
    },
  };
  const figma = {
    variables: {
      async getLocalVariableCollectionsAsync() { return collections; },
      async getLocalVariablesAsync() { return variables; },
      async getVariableByIdAsync(id) { return variables.find((variable) => variable.id === id) || null; },
      setBoundVariableForPaint(paint, _field, variable) {
        const id = paintMode === 'wrong-and-ignore-rollback' ? 'VariableID:3-wrong' : variable.id;
        return { ...paint, boundVariables: { ...(paint.boundVariables || {}), color: alias(id) } };
      },
    },
    async getNodeByIdAsync(id) {
      reads += 1;
      if (readFailures.includes(reads)) throw new Error('injected read failure');
      return id === node.id ? node : null;
    },
  };
  return { figma, node, calls, variables, collections, get paintAssignments() { return paintAssignments; } };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Node Bind closes one exact request, literal values and Figma URL targeting', () => {
  assert.deepEqual(parseNodeBindRequest([
    'node', 'bind', '--collection=Tokens', '1-2', 'padding', 'space/md',
  ]), { nodeId: '1:2', property: 'padding', variable: 'space/md', collection: 'Tokens' });
  assert.deepEqual(parseNodeBindRequest(['node', 'bind', '--', '1:2', 'gap', '-space']), {
    nodeId: '1:2', property: 'gap', variable: '-space', collection: null,
  });
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-2';
  assert.deepEqual(nodeBindPlanningArgvFromRequest({ nodeId: url, property: 'fill', variable: 'brand/base' }),
    ['node', 'bind', '--', url, 'fill', 'brand/base']);
  const plan = planFigmaCommand(['node', 'bind', url, 'fill', 'brand/base'], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['node', 'bind', '--', '1:2', 'fill', 'brand/base']);
  for (const args of [
    ['node', 'bind'], ['node', 'bind', '1:2', 'unknown', 'x'],
    ['node', 'bind', '1:2', 'gap', 'x', '--batch', '[]'],
    ['node', 'bind', 'bad', 'gap', 'x'],
  ]) assert.throws(() => parseNodeBindRequest(args));
});

test('scalar and radius binding require fresh exact alias readback', async () => {
  const scalar = fixture();
  const gap = await executeNodeBind({ nodeId: '1:2', property: 'gap', variable: 'space/md' },
    { evaluate: evaluate(scalar.figma) });
  assert.deepEqual(gap.result.fields, ['itemSpacing']);
  assert.deepEqual(gap.result.observedVariableIds, ['VariableID:1']);
  assert.equal(gap.result.attempted, 1);

  const radius = fixture();
  const result = await executeNodeBind({ nodeId: '1:2', property: 'radius', variable: 'space/md' },
    { evaluate: evaluate(radius.figma) });
  assert.deepEqual(result.result.fields,
    ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius']);
  assert.deepEqual(result.result.observedVariableIds, Array(4).fill('VariableID:1'));
});

test('an already exact binding is a verified no-op', async () => {
  const live = fixture();
  live.node.boundVariables.itemSpacing = alias('VariableID:1');
  const result = await executeNodeBind({ nodeId: '1:2', property: 'gap', variable: 'space/md' },
    { evaluate: evaluate(live.figma) });
  assert.equal(result.result.attempted, 0);
  assert.deepEqual(live.calls, []);
});

test('padding setter failure restores the complete prior binding topology', async () => {
  const live = fixture({ scalarMode: 'fail-second' });
  for (const field of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
    live.node.boundVariables[field] = alias('VariableID:4');
  }
  await assert.rejects(() => executeNodeBind({ nodeId: '1:2', property: 'padding', variable: 'space/md' },
    { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
  assert.deepEqual(['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
    .map((field) => live.node.boundVariables[field].id), Array(4).fill('VariableID:4'));
});

test('paint binding verifies the one-paint compatibility outcome and restores the exact list', async () => {
  const success = fixture();
  const result = await executeNodeBind({ nodeId: '1:2', property: 'fill', variable: 'brand/base' },
    { evaluate: evaluate(success.figma) });
  assert.equal(success.node.fills.length, 1);
  assert.equal(success.node.fills[0].boundVariables.color.id, 'VariableID:3');
  assert.deepEqual(result.result.observedVariableIds, ['VariableID:3']);

  const restored = fixture({ paintMode: 'ignore-request' });
  const before = JSON.stringify(restored.node.fills);
  await assert.rejects(() => executeNodeBind({ nodeId: '1:2', property: 'fill', variable: 'brand/base' },
    { evaluate: evaluate(restored.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  assert.equal(JSON.stringify(restored.node.fills), before);

  const residue = fixture({ paintMode: 'wrong-and-ignore-rollback' });
  await assert.rejects(() => executeNodeBind({ nodeId: '1:2', property: 'fill', variable: 'brand/base' },
    { evaluate: evaluate(residue.figma) }), (error) => error.mutationOutcome === 'partial-residue');
});

test('resource ambiguity, type mismatch and unsupported targets refuse before mutation', async () => {
  const ambiguousVariable = fixture({ duplicateVariable: true });
  await assert.rejects(() => executeNodeBind({ nodeId: '1:2', property: 'gap', variable: 'space/md' },
    { evaluate: evaluate(ambiguousVariable.figma) }), (error) => error.mutationOutcome === 'no-mutation');
  assert.deepEqual(ambiguousVariable.calls, []);

  const ambiguousCollection = fixture({ duplicateCollection: true });
  await assert.rejects(() => executeNodeBind({
    nodeId: '1:2', property: 'gap', variable: 'space/md', collection: 'Token',
  }, { evaluate: evaluate(ambiguousCollection.figma) }), (error) => error.mutationOutcome === 'no-mutation');

  const mismatch = fixture();
  await assert.rejects(() => executeNodeBind({ nodeId: '1:2', property: 'gap', variable: 'brand/base' },
    { evaluate: evaluate(mismatch.figma) }), (error) => error.mutationOutcome === 'no-mutation');
});

test('failed rollback and unavailable verification remain explicit', async () => {
  const residue = fixture({ scalarMode: 'wrong-and-ignore-rollback' });
  residue.node.boundVariables.itemSpacing = alias('VariableID:4');
  await assert.rejects(() => executeNodeBind({ nodeId: '1:2', property: 'gap', variable: 'space/md' },
    { evaluate: evaluate(residue.figma) }), (error) => error.mutationOutcome === 'partial-residue');

  const unknown = fixture({ scalarMode: 'ignore-request', readFailures: [3] });
  await assert.rejects(() => executeNodeBind({ nodeId: '1:2', property: 'gap', variable: 'space/md' },
    { evaluate: evaluate(unknown.figma) }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('one authentic non-retrying Plan dispatches once and forged results fail closed', async () => {
  const plan = planFigmaCommand(['node', 'bind', '1:2', 'gap', 'space/md'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'node.bind');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(nodeBindPlanRoute(plan), 'command-application');
  assert.throws(() => nodeBindPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture(); let evaluations = 0;
  const result = await executeNodeBindPlan(plan, { evaluate: async (code) => {
    evaluations += 1; return evaluate(live.figma)(code);
  } });
  assert.equal(result.result.status, 'applied'); assert.equal(evaluations, 1);

  for (const value of [null, {}, 'bad', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(() => executeNodeBind({ nodeId: '1:2', property: 'gap', variable: 'space/md' },
      { evaluate: async () => value }), /invalid/i);
  }
});
