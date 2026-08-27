import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeFontVariableBinding, fontVariableBindingApplicationCode, fontVariableBindingPlanRoute,
} from '../src/application/font-variable-binding-command.js';
import {
  acceptsFontVariableBindingArgv, fontVariableBindingArgvFromRequest,
  fontVariableBindingFigmaUrlFileKeyFromArgv, parseFontVariableBindingRequest,
} from '../src/application/font-variable-binding-request.js';

const variable = (overrides = {}) => ({ id: 'V:1', name: 'type/size', resolvedType: 'FLOAT', remote: false, variableCollectionId: 'C:1', ...overrides });
function fixture({ setter = 'apply', rangeSetter = 'apply', variables = [variable()], priorId = null } = {}) {
  const calls = []; const vars = variables;
  const node = {
    id: '1:2', type: 'TEXT', name: 'Fixture', characters: 'Hello', fontName: { family: 'Inter', style: 'Regular' },
    boundVariables: priorId ? { fontSize: { type: 'VARIABLE_ALIAS', id: priorId } } : {}, rangeAlias: null,
    getRangeAllFontNames: () => [{ family: 'Inter', style: 'Regular' }],
    setBoundVariable(field, value) {
      calls.push(['whole', field, value?.id || null]);
      if (setter === 'throw' && value?.id === 'V:1') throw new Error('setter failed');
      if (setter === 'ignore' && value?.id === 'V:1') return;
      if (setter === 'wrong' && value?.id === 'V:1') this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: 'V:wrong' };
      else if (value) this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: value.id };
      else delete this.boundVariables[field];
    },
    setRangeBoundVariable(start, end, field, value) {
      calls.push(['range', start, end, field, value?.id || null]);
      if (rangeSetter === 'ignore' && value?.id === 'V:1') return;
      this.rangeAlias = value ? { type: 'VARIABLE_ALIAS', id: value.id } : null;
    },
    getRangeBoundVariable: () => node.rangeAlias,
  };
  const figma = {
    mixed: Symbol('mixed'), getNodeByIdAsync: async () => node,
    loadFontAsync: async (font) => calls.push(['font', font]),
    variables: {
      getVariableByIdAsync: async (id) => vars.find((item) => item.id === id) || null,
      getLocalVariablesAsync: async () => vars,
      getLocalVariableCollectionsAsync: async () => [{ id: 'C:1', name: 'Fixture collection' }],
    },
  };
  return { figma, node, calls };
}
const plugin = (request, figma) => new Function('figma', `return ${fontVariableBindingApplicationCode(request)}`)(figma);

test('Font binding closes grammar, normalizes fields, and projects URL file identity', () => {
  const url = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=1-2';
  assert.deepEqual(parseFontVariableBindingRequest(['font','bind','--start=1','-c','Fixture collection',url,'font-size','type/size','--end','4']),
    { action: 'bind', nodeId: '1:2', field: 'fontSize', variable: 'type/size', collection: 'Fixture collection', start: 1, end: 4 });
  assert.equal(fontVariableBindingFigmaUrlFileKeyFromArgv(['font','unbind',url,'fontSize']), 'PLACEHOLDERFILEKEY');
  assert.deepEqual(fontVariableBindingArgvFromRequest({ action: 'unbind', nodeId: '1:2', field: 'line-height', start: 0, end: 5 }),
    ['font','unbind','--start','0','--end','5','--','1:2','lineHeight']);
  for (const argv of [
    ['font','bind','1:2','fontSize'], ['font','unbind','--collection','C','1:2','fontSize'],
    ['font','bind','--start','1','--start','2','1:2','fontSize','V:1'], ['font','unbind','1:2','width'],
  ]) assert.equal(acceptsFontVariableBindingArgv(argv), false);
});

test('Font binding proves node-wide and range writes with fresh exact readback', async () => {
  const request = { action: 'bind', nodeId: '1:2', field: 'fontSize', variable: 'V:1' };
  const whole = fixture(); const serialized = await plugin(request, whole.figma);
  const result = await executeFontVariableBinding(request, { evaluate: async () => serialized });
  assert.equal(result.result.status, 'applied'); assert.equal(result.result.observedVariableId, 'V:1');
  const ranged = fixture(); const rangedRequest = { ...request, start: 1, end: 4 };
  const rangeResult = await executeFontVariableBinding(rangedRequest, { evaluate: async () => plugin(rangedRequest, ranged.figma) });
  assert.deepEqual(rangeResult.result.range, { start: 1, end: 4 });
  assert.deepEqual(ranged.calls.find(([kind]) => kind === 'range'), ['range', 1, 4, 'fontSize', 'V:1']);
});

test('Font binding preserves imported Variables by exact id and legacy result facts', async () => {
  const remote = variable({ remote: true }); const source = fixture({ variables: [remote] });
  const request = { action: 'bind', nodeId: '1:2', field: 'fontWeight', variable: 'V:1' };
  const result = await executeFontVariableBinding(request, {
    evaluate: async () => plugin(request, source.figma),
  });
  assert.equal(result.result.variable.remote, true);
  assert.equal(result.result.variable.type, 'FLOAT');
  assert.deepEqual(result.result.alias, { type: 'VARIABLE_ALIAS', id: 'V:1' });
  assert.equal(result.result.unbound, false);
  assert.match(result.result.note, /not a general variable-axis setter/);
});

test('Font binding falls back to local name resolution when direct id lookup rejects', async () => {
  const source = fixture();
  const original = source.figma.variables.getVariableByIdAsync;
  source.figma.variables.getVariableByIdAsync = async (id) => {
    if (id === 'size') throw new Error('not an id');
    return original(id);
  };
  const request = { action: 'bind', nodeId: '1:2', field: 'fontSize', variable: 'size' };
  const result = await executeFontVariableBinding(request, {
    evaluate: async () => plugin(request, source.figma),
  });
  assert.equal(result.result.observedVariableId, 'V:1');
});

test('Font binding treats a silent setter no-op as failure and proves restoration', async () => {
  const request = { action: 'bind', nodeId: '1:2', field: 'fontSize', variable: 'V:1' };
  const source = fixture({ setter: 'ignore' }); const serialized = await plugin(request, source.figma);
  const payload = JSON.parse(serialized);
  assert.equal(payload.status, 'failed'); assert.equal(payload.restored, true); assert.deepEqual(payload.residue, []);
  await assert.rejects(() => executeFontVariableBinding(request, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'rolled-back' && error.dispatchState === 'failed');
});

test('Font binding rejects wrong readback and reports exact residue when rollback cannot be proven', async () => {
  const request = { action: 'bind', nodeId: '1:2', field: 'fontSize', variable: 'V:1' };
  const source = fixture({ setter: 'wrong' });
  source.node.setBoundVariable = function setBoundVariable(field, value) {
    if (value?.id === 'V:1') this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: 'V:wrong' };
    // Also ignore restoration to the prior unbound state.
  };
  const serialized = await plugin(request, source.figma); const payload = JSON.parse(serialized);
  assert.equal(payload.status, 'failed'); assert.equal(payload.restored, false); assert.equal(payload.residue[0].observedVariableId, 'V:wrong');
  await assert.rejects(() => executeFontVariableBinding(request, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'partial-residue');
});

test('Font binding rejects ambiguous collections before the first write', async () => {
  const source = fixture(); let writes = 0; source.node.setBoundVariable = () => { writes++; };
  source.figma.variables.getVariableByIdAsync = async () => null;
  source.figma.variables.getLocalVariableCollectionsAsync = async () => [{ id: 'C:1', name: 'Fixture alpha' }, { id: 'C:2', name: 'Fixture beta' }];
  await assert.rejects(() => plugin({ action: 'bind', nodeId: '1:2', field: 'fontSize', variable: 'size', collection: 'Fixture' }, source.figma), /ambiguous/);
  assert.equal(writes, 0);
});

test('Font bind and unbind own non-retrying Command Plans', () => {
  for (const argv of [['font','bind','1:2','fontSize','V:1'], ['font','unbind','1:2','fontSize']]) {
    const plan = planFigmaCommand(argv, { adapter: 'cli' });
    assert.equal(plan.allowed, true); assert.equal(plan.execution.retry, 'never');
    assert.equal(fontVariableBindingPlanRoute(plan), 'command-application');
  }
});
