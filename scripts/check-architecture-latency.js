import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { measureArchitectureLatency } from './measure-architecture-budgets.js';

export const ARCHITECTURE_LATENCY_LIMITS_MS = Object.freeze({
  commandPlan: Object.freeze({ p50Ms: 125, p95Ms: 250 }),
  // Shared CI runners occasionally pause batches for scheduling or GC.
  // Keep the median strict enough to catch sustained serializer regressions,
  // while the separate tail ceiling still catches repeated long pauses.
  yamlProjection: Object.freeze({ p50Ms: 250, p95Ms: 450 }),
});

export function assertArchitectureLatency(latency) {
  for (const [operation, limits] of Object.entries(ARCHITECTURE_LATENCY_LIMITS_MS)) {
    for (const [metric, limit] of Object.entries(limits)) {
      const measured = latency[operation]?.[metric];
      assert.ok(
        Number.isFinite(measured) && measured < limit,
        `${operation}.${metric} (${measured}ms) must stay below ${limit}ms; ${JSON.stringify(latency)}`,
      );
    }
  }
}

export function checkArchitectureLatency() {
  const latency = measureArchitectureLatency();
  assertArchitectureLatency(latency);
  return latency;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(checkArchitectureLatency(), null, 2) + '\n');
}
