import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VARIABLE_SCOPES_BY_TYPE,
  applyVariableScopePolicy,
  variableScopeDecision,
  variableScopeOptionsForType,
  variableScopePolicyCode,
  variableScopeQuestions,
  variableScopesForToken,
} from '../src/lib/variable-scope-policy.js';
import { FigmaClient } from '../src/lib/jsx-render.js';

test('spacing and radius FLOAT namespaces receive narrow Figma scopes', () => {
  assert.deepEqual(variableScopesForToken('spacing/md', 'FLOAT'), ['GAP']);
  assert.deepEqual(variableScopesForToken('space/17px', 'FLOAT'), ['GAP']);
  assert.deepEqual(variableScopesForToken('radius/lg', 'FLOAT'), ['CORNER_RADIUS']);
  assert.deepEqual(variableScopesForToken('radii/full', 'FLOAT'), ['CORNER_RADIUS']);
});

test('scope inference refuses substring and non-FLOAT guesses', () => {
  assert.equal(variableScopesForToken('spacingFactor', 'FLOAT'), null);
  assert.equal(variableScopesForToken('brandRadiusColor', 'FLOAT'), null);
  assert.equal(variableScopesForToken('spacing/md', 'COLOR'), null);
  assert.equal(variableScopesForToken('size/md', 'FLOAT'), null);
});

test('host and generated-plugin policies apply the same scopes', () => {
  const hostVariable = { name: 'radius/md', resolvedType: 'FLOAT', scopes: ['ALL_SCOPES'] };
  applyVariableScopePolicy(hostVariable);
  assert.deepEqual(hostVariable.scopes, ['CORNER_RADIUS']);

  const generated = variableScopePolicyCode();
  const run = new Function(`${generated}; return __scopeTokenVariable;`)();
  const pluginVariable = { scopes: ['ALL_SCOPES'] };
  run(pluginVariable, 'spacing/md', 'FLOAT');
  assert.deepEqual(pluginVariable.scopes, ['GAP']);
});

test('scope options are complete and type-compatible', () => {
  assert.deepEqual(variableScopeOptionsForType('STRING'), [
    'ALL_SCOPES', 'TEXT_CONTENT', 'FONT_FAMILY', 'FONT_STYLE',
  ]);
  assert.ok(VARIABLE_SCOPES_BY_TYPE.COLOR.includes('TEXT_FILL'));
  assert.ok(VARIABLE_SCOPES_BY_TYPE.COLOR.includes('EFFECT_COLOR'));
  assert.ok(VARIABLE_SCOPES_BY_TYPE.FLOAT.includes('WIDTH_HEIGHT'));
  assert.ok(VARIABLE_SCOPES_BY_TYPE.FLOAT.includes('PARAGRAPH_INDENT'));
  assert.deepEqual(variableScopeOptionsForType('BOOLEAN'), ['ALL_SCOPES']);
});

test('ambiguous new variables require a user scope decision', () => {
  const decision = variableScopeDecision('brand/primary', 'COLOR', 'Brand');
  assert.equal(decision.status, 'USER_DECISION_REQUIRED');
  assert.deepEqual(decision.currentScopes, ['ALL_SCOPES']);
  assert.ok(decision.allowedScopes.includes('ALL_FILLS'));
  assert.match(decision.question, /remain unrestricted/);

  assert.equal(variableScopeDecision('enabled', 'BOOLEAN'), null);
  assert.equal(variableScopeDecision('spacing/md', 'FLOAT').status, 'AUTO_SCOPED');
  assert.deepEqual(variableScopeQuestions([
    { name: 'spacing/md', type: 'FLOAT' },
    { name: 'type/body', type: 'STRING' },
  ]).map((item) => item.name), ['type/body']);
});

test('the compatibility adapter scopes only newly created exact namespaces', () => {
  const code = new FigmaClient().generateSpacingHelperCode();
  assert.match(code, /if \(!isNew\) return variable/);
  assert.match(code, /__scopeSpaceVar\(v, kind, true\)/);
  assert.doesNotMatch(code, /head\.includes/);
  assert.match(code, /head === 'space'/);
  assert.match(code, /head === 'radius'/);
});
