import assert from 'node:assert/strict';
import test from 'node:test';
import {
  measureRuntimeWorkload,
  runRuntimeWorkloadSeries,
  summarizeRuntimeSamples,
} from '../scripts/lib/runtime-workload-harness.js';

test('runtime workload evidence separates planning, Plugin execution and Bridge overhead', async () => {
  const ticks = [0, 2, 17];
  const heaps = [1000, 1300];
  const sample = await measureRuntimeWorkload({
    id: 'read.fixture',
    kind: 'read',
    now: () => ticks.shift(),
    heapUsed: () => heaps.shift(),
    plan: () => ({ id: 'fixture-plan' }),
    execute: async (plan, { observe }) => {
      assert.equal(plan.id, 'fixture-plan');
      observe({
        pluginExecutionTiming: {
          schema: 'figma-bridge/plugin-execution-timing', version: 1, queuedMs: 1, executionMs: 9, totalMs: 10,
        },
        bridgeExecutionTiming: {
          schema: 'figma-bridge/bridge-execution-timing', version: 1,
          requestPreparationMs: 1, writeLaneQueueMs: 1, pluginRoundTripMs: 11,
          daemonOtherMs: 1, preResponseMs: 14,
        },
      });
      return { stdout: 'ok', stderr: '', result: { ok: true } };
    },
  });
  assert.deepEqual(sample, {
    schema: 'figma-bridge/runtime-workload-sample',
    version: 1,
    id: 'read.fixture',
    kind: 'read',
    planningMs: 2,
    executionMs: 15,
    totalMs: 17,
    outcomeBytes: Buffer.byteLength(JSON.stringify({ stdout: 'ok', stderr: '', result: { ok: true } })),
    heapDeltaBytes: 300,
    pluginExecutionTiming: {
      schema: 'figma-bridge/plugin-execution-timing', version: 1, queuedMs: 1, executionMs: 9, totalMs: 10,
    },
    bridgeExecutionTiming: {
      schema: 'figma-bridge/bridge-execution-timing', version: 1,
      requestPreparationMs: 1, writeLaneQueueMs: 1, pluginRoundTripMs: 11,
      daemonOtherMs: 1, preResponseMs: 14,
    },
    bridgeOutsidePluginMs: 5,
    clientOutsideDaemonMs: 1,
  });
});

test('runtime workload series reports first and warm samples without pretending they are process-cold', async () => {
  let time = 0;
  const report = await runRuntimeWorkloadSeries({
    id: 'read.fixture',
    kind: 'read',
    now: () => time++,
    heapUsed: () => 100,
    plan: () => ({}),
    execute: async () => ({ stdout: '', stderr: '', result: null }),
  }, { iterations: 3 });
  assert.equal(report.first.id, 'read.fixture');
  assert.equal(report.warm.length, 2);
  assert.equal(report.summary.totalMs.p50, 2);
  await assert.rejects(() => runRuntimeWorkloadSeries({}, { iterations: 21 }), /1-20/);
});

test('runtime summaries retain signed heap deltas and deterministic percentiles', () => {
  const summary = summarizeRuntimeSamples([
    { planningMs: 1, executionMs: 8, totalMs: 9, outcomeBytes: 20, heapDeltaBytes: -4 },
    { planningMs: 2, executionMs: 9, totalMs: 11, outcomeBytes: 30, heapDeltaBytes: 8 },
    { planningMs: 3, executionMs: 10, totalMs: 13, outcomeBytes: 40, heapDeltaBytes: 2 },
  ]);
  assert.deepEqual(summary.totalMs, { min: 9, p50: 11, p95: 13, max: 13 });
  assert.deepEqual(summary.heapDeltaBytes, { min: -4, p50: 2, p95: 8, max: 8 });
});
