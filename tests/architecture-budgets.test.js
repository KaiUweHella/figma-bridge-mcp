import assert from 'node:assert/strict';
import test from 'node:test';
import { measureStaticArchitectureBudgets } from '../scripts/measure-architecture-budgets.js';

test('architecture interfaces stay inside deterministic context and payload budgets', () => {
  const result = measureStaticArchitectureBudgets();
  assert.ok(result.metadata.chars < 10_800, JSON.stringify(result.metadata));
  assert.ok(result.metadata.estimatedTokens < 4_250, JSON.stringify(result.metadata));
  assert.ok(result.spec.ratio < 0.65, JSON.stringify(result.spec));
  assert.ok(result.spec.yamlEstimatedTokens < 4_250, JSON.stringify(result.spec));
  assert.ok(result.pluginPayload.assetPolicyChars < 4_000, JSON.stringify(result.pluginPayload));
  assert.ok(result.pluginPayload.inspectChars < 15_000, JSON.stringify(result.pluginPayload));
  assert.ok(result.pluginPayload.screenshotChars < 7_500, JSON.stringify(result.pluginPayload));
});
