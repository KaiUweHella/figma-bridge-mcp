import assert from 'node:assert/strict';
import test from 'node:test';
import { measureArchitectureBudgets } from '../scripts/measure-architecture-budgets.js';

test('architecture interfaces stay inside context, payload and latency budgets', () => {
  const result = measureArchitectureBudgets();
  assert.ok(result.metadata.chars < 10_800, JSON.stringify(result.metadata));
  assert.ok(result.metadata.estimatedTokens < 4_250, JSON.stringify(result.metadata));
  assert.ok(result.spec.ratio < 0.65, JSON.stringify(result.spec));
  assert.ok(result.spec.compactEstimatedTokens < 4_250, JSON.stringify(result.spec));
  assert.ok(result.pluginPayload.assetPolicyChars < 4_000, JSON.stringify(result.pluginPayload));
  assert.ok(result.pluginPayload.inspectChars < 15_000, JSON.stringify(result.pluginPayload));
  assert.ok(result.pluginPayload.screenshotChars < 7_500, JSON.stringify(result.pluginPayload));
  // 1,000 pure operations per batch. Thresholds are intentionally generous
  // across the Node 18/20/22 + three-OS CI matrix but catch order-of-magnitude regressions.
  assert.ok(result.latency.commandPlan.p95Ms < 250, JSON.stringify(result.latency));
  assert.ok(result.latency.compactProjection.p95Ms < 150, JSON.stringify(result.latency));
});
