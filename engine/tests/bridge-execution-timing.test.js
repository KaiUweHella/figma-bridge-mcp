import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeExecutionTiming } from '../src/lib/bridge-execution-timing.js';

test('Bridge timing attributes request, queue, Plugin round trip and remaining daemon work', () => {
  assert.deepEqual(createBridgeExecutionTiming({
    requestStartedAt: 10,
    laneQueuedAt: 14,
    laneStartedAt: 20,
    pluginStartedAt: 21,
    pluginFinishedAt: 51,
    preResponseAt: 55,
  }), {
    schema: 'figma-bridge/bridge-execution-timing',
    version: 1,
    requestPreparationMs: 4,
    writeLaneQueueMs: 6,
    pluginRoundTripMs: 30,
    daemonOtherMs: 5,
    preResponseMs: 45,
  });
});

test('Bridge timing never emits negative or unbounded duration evidence', () => {
  const timing = createBridgeExecutionTiming({
    requestStartedAt: 100,
    laneQueuedAt: 90,
    laneStartedAt: 80,
    pluginStartedAt: 70,
    pluginFinishedAt: 60,
    preResponseAt: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(timing.requestPreparationMs, 0);
  assert.equal(timing.writeLaneQueueMs, 0);
  assert.equal(timing.pluginRoundTripMs, 0);
  assert.equal(timing.preResponseMs, 130_000);
  assert.equal(timing.daemonOtherMs, 130_000);
});
