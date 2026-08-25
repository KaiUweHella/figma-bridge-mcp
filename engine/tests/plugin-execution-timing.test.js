import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PLUGIN_EXECUTION_TIMING_MS,
  createPluginExecutionTiming,
  parsePluginExecutionTiming,
  pluginExecutionTimingValidationError,
} from '../src/lib/plugin-execution-timing.js';

test('Plugin execution timing preserves closed queue and execution segments', () => {
  const timing = createPluginExecutionTiming({ queuedAt: 100, startedAt: 112, finishedAt: 180 });
  assert.deepEqual(timing, {
    schema: 'figma-bridge/plugin-execution-timing',
    version: 1,
    queuedMs: 12,
    executionMs: 68,
    totalMs: 80,
  });
  assert.deepEqual(parsePluginExecutionTiming(timing), timing);
  assert.equal(Object.isFrozen(timing), true);
});

test('Plugin execution timing is bounded and rejects drift or inconsistent totals', () => {
  const bounded = createPluginExecutionTiming({
    queuedAt: 0,
    startedAt: MAX_PLUGIN_EXECUTION_TIMING_MS + 1,
    finishedAt: (MAX_PLUGIN_EXECUTION_TIMING_MS * 3) + 1,
  });
  assert.deepEqual(
    { queuedMs: bounded.queuedMs, executionMs: bounded.executionMs, totalMs: bounded.totalMs },
    {
      queuedMs: MAX_PLUGIN_EXECUTION_TIMING_MS,
      executionMs: MAX_PLUGIN_EXECUTION_TIMING_MS,
      totalMs: MAX_PLUGIN_EXECUTION_TIMING_MS,
    },
  );

  const extra = { ...bounded, fileKey: 'must-not-cross' };
  assert.match(pluginExecutionTimingValidationError(extra), /unknown or missing/);
  assert.equal(parsePluginExecutionTiming(extra), null);
  assert.match(
    pluginExecutionTimingValidationError({ ...bounded, totalMs: bounded.totalMs - 1 }),
    /total does not match/,
  );
});
