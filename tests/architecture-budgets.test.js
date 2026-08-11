import assert from 'node:assert/strict';
import test from 'node:test';
import { measureArchitectureBudgets } from '../scripts/measure-architecture-budgets.js';

test('architecture interfaces stay inside context, payload and latency budgets', () => {
  const result = measureArchitectureBudgets();
  assert.ok(result.metadata.chars < 10_800, JSON.stringify(result.metadata));
  assert.ok(result.metadata.estimatedTokens < 4_250, JSON.stringify(result.metadata));
  assert.ok(result.spec.ratio < 0.65, JSON.stringify(result.spec));
  assert.ok(result.spec.yamlEstimatedTokens < 4_250, JSON.stringify(result.spec));
  assert.ok(result.pluginPayload.assetPolicyChars < 4_000, JSON.stringify(result.pluginPayload));
  assert.ok(result.pluginPayload.inspectChars < 15_000, JSON.stringify(result.pluginPayload));
  assert.ok(result.pluginPayload.screenshotChars < 7_500, JSON.stringify(result.pluginPayload));
  // Command planning measures 1,000 operations per batch; YAML projection
  // measures 100 complete documents because serialization is intentionally
  // richer. Thresholds catch order-of-magnitude regressions across platforms.
  assert.ok(result.latency.commandPlan.p95Ms < 250, JSON.stringify(result.latency));
  assert.ok(result.latency.yamlProjection.p95Ms < 300, JSON.stringify(result.latency));
});
