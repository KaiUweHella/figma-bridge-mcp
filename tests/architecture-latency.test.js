import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHITECTURE_LATENCY_LIMITS_MS,
  assertArchitectureLatency,
} from '../scripts/check-architecture-latency.js';
import { measureBatchTimings } from '../scripts/measure-architecture-budgets.js';

test('latency sampling warms operations before recording batches', () => {
  let calls = 0;
  const result = measureBatchTimings(
    () => { calls += 1; },
    { batches: 3, iterations: 4, warmupBatches: 2 },
  );

  assert.equal(calls, 20);
  assert.equal(result.iterations, 4);
});

test('architecture latency limits are checked without running a benchmark', () => {
  const passing = {
    commandPlan: {
      p50Ms: ARCHITECTURE_LATENCY_LIMITS_MS.commandPlan.p50Ms - 1,
      p95Ms: ARCHITECTURE_LATENCY_LIMITS_MS.commandPlan.p95Ms - 1,
    },
    yamlProjection: {
      p50Ms: ARCHITECTURE_LATENCY_LIMITS_MS.yamlProjection.p50Ms - 1,
      p95Ms: ARCHITECTURE_LATENCY_LIMITS_MS.yamlProjection.p95Ms - 1,
    },
  };
  assert.doesNotThrow(() => assertArchitectureLatency(passing));

  const sustainedRegression = {
    ...passing,
    yamlProjection: {
      ...passing.yamlProjection,
      p50Ms: ARCHITECTURE_LATENCY_LIMITS_MS.yamlProjection.p50Ms,
    },
  };
  assert.throws(() => assertArchitectureLatency(sustainedRegression), /yamlProjection\.p50Ms/);

  const tailRegression = {
    ...passing,
    yamlProjection: {
      ...passing.yamlProjection,
      p95Ms: ARCHITECTURE_LATENCY_LIMITS_MS.yamlProjection.p95Ms,
    },
  };
  assert.throws(() => assertArchitectureLatency(tailRegression), /yamlProjection\.p95Ms/);
});
