import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureCurrentDaemonReady } from '../engine/src/commands/setup.js';

test('connect replaces one stale daemon that wins the first upgrade race', async () => {
  let now = 0;
  let generation = 0;
  const starts = [];
  const result = await ensureCurrentDaemonReady({
    maxAttempts: 2,
    waitPerAttemptMs: 100,
    adapters: {
      now: () => now,
      wait: async (delay) => { now += delay; },
      running: async () => true,
      matches: async () => generation >= 2,
      start: async (forceRestart, mode, knownState) => {
        starts.push({ forceRestart, mode, knownState });
        generation += 1;
      },
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.daemonWasRunning, true);
  assert.equal(result.daemonWasReusable, false);
  assert.deepEqual(starts, [
    { forceRestart: false, mode: 'plugin', knownState: { running: true, buildMatches: false } },
    { forceRestart: false, mode: 'plugin', knownState: { running: true, buildMatches: false } },
  ]);
});
