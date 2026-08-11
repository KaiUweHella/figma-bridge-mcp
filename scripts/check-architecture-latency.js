import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { measureArchitectureLatency } from './measure-architecture-budgets.js';

export const ARCHITECTURE_LATENCY_LIMITS_MS = Object.freeze({
  commandPlan: 250,
  yamlProjection: 300,
});

export function assertArchitectureLatency(latency) {
  assert.ok(
    latency.commandPlan.p95Ms < ARCHITECTURE_LATENCY_LIMITS_MS.commandPlan,
    JSON.stringify(latency),
  );
  assert.ok(
    latency.yamlProjection.p95Ms < ARCHITECTURE_LATENCY_LIMITS_MS.yamlProjection,
    JSON.stringify(latency),
  );
}

export function checkArchitectureLatency() {
  const latency = measureArchitectureLatency();
  assertArchitectureLatency(latency);
  return latency;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(checkArchitectureLatency(), null, 2) + '\n');
}
