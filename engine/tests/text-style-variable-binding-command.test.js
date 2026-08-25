import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import { executeTextStyleVariableBinding, textStyleVariableBindingCode, textStyleVariableBindingPlanRoute } from '../src/application/text-style-variable-binding-command.js';
import { acceptsTextStyleVariableBindingArgv, parseTextStyleVariableBindingRequest, textStyleVariableBindingArgvFromRequest } from '../src/application/text-style-variable-binding-request.js';

const style = (setBoundVariable, overrides = {}) => ({ id: 'S:1', key: 'K', name: 'Body', type: 'TEXT', remote: false, boundVariables: {}, setBoundVariable, ...overrides });
const variable = (overrides = {}) => ({ id: 'V:1', name: 'size/body', resolvedType: 'FLOAT', remote: false, ...overrides });
const figmaFor = (target, vars) => ({ getStyleByIdAsync: async () => target, getLocalTextStylesAsync: async () => [target], variables: { getVariableByIdAsync: async (id) => vars.find((v) => v.id === id) || null, getLocalVariablesAsync: async () => vars } });
const plugin = (request, figma) => new Function('figma', `return ${textStyleVariableBindingCode(request)}`)(figma);

test('Text Style binding closes bind and unbind grammar', () => {
  assert.deepEqual(parseTextStyleVariableBindingRequest(['style','bind-font','--variable','size/body','--','Body','fontSize']), { action: 'bind', style: 'Body', field: 'fontSize', variable: 'size/body' });
  assert.deepEqual(textStyleVariableBindingArgvFromRequest({ action: 'unbind', style: 'Body', field: 'fontSize' }), ['style','unbind-font','--','Body','fontSize']);
  for (const argv of [['style','bind-font','Body','fontSize'], ['style','unbind-font','Body','width'], ['style','unbind-font','Body','fontSize','--variable','V:1']]) assert.equal(acceptsTextStyleVariableBindingArgv(argv), false);
});

test('Text Style binding preflights type and returns compact identity', async () => {
  const calls = []; const target = style((field, value) => calls.push([field, value])); const v = variable();
  const request = { action: 'bind', style: 'S:1', field: 'fontSize', variable: 'V:1' };
  const serialized = await plugin(request, figmaFor(target, [v]));
  const result = await executeTextStyleVariableBinding(request, { evaluate: async () => serialized });
  assert.deepEqual(calls, [['fontSize', v]]); assert.equal(result.result.status, 'applied'); assert.equal(result.result.variable.id, 'V:1'); assert.equal(Object.hasOwn(result.result.style, 'fontName'), false);
  await assert.rejects(() => plugin({ ...request, field: 'fontFamily' }, figmaFor(target, [v])), /incompatible/);
});

test('Text Style unbinding reports applied with a null variable', async () => {
  const calls = []; const target = style((field, value) => calls.push([field, value]));
  const request = { action: 'unbind', style: 'S:1', field: 'fontSize' };
  const serialized = await plugin(request, figmaFor(target, []));
  const result = await executeTextStyleVariableBinding(request, { evaluate: async () => serialized });
  assert.deepEqual(calls, [['fontSize', null]]); assert.equal(result.result.status, 'applied'); assert.equal(result.result.variable, null);
});

test('Text Style binding rejects incompatible metadata before mutation', async () => {
  let writes = 0; const request = { action: 'bind', style: 'S:1', field: 'fontSize', variable: 'V:1' };
  await assert.rejects(() => plugin(request, figmaFor(style(() => { writes++; }, { remote: true }), [variable()])), /mutable local/);
  await assert.rejects(() => plugin(request, figmaFor(style(() => { writes++; }), [variable({ remote: true })])), /Variable (?:not found|is incompatible)/);
  assert.equal(writes, 0);
});

test('Text Style binding restores the previous binding after setter failure', async () => {
  const prior = variable({ id: 'V:old', name: 'size/old' }); const next = variable(); const calls = [];
  const target = style((field, value) => { calls.push(value?.id || null); if (value?.id === 'V:1') throw new Error('failed'); }, { boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'V:old' } } });
  const request = { action: 'bind', style: 'S:1', field: 'fontSize', variable: 'V:1' };
  const serialized = await plugin(request, figmaFor(target, [prior, next]));
  await assert.rejects(() => executeTextStyleVariableBinding(request, { evaluate: async () => serialized }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(calls, ['V:1', 'V:old']);
});

test('Text Style bind and unbind own non-retrying Plans', () => {
  for (const argv of [['style','bind-font','Body','fontSize','--variable','V:1'], ['style','unbind-font','Body','fontSize']]) {
    const plan = planFigmaCommand(argv, { adapter: 'cli' }); assert.equal(plan.allowed, true); assert.equal(plan.execution.retry, 'never'); assert.equal(textStyleVariableBindingPlanRoute(plan), 'command-application');
  }
});
