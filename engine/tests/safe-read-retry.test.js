import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientReadFailure, retrySafeRead } from '../src/lib/safe-read-retry.js';

test('safe reads retry one transient plugin disconnect after readiness returns', async () => {
  let attempts = 0;
  let waits = 0;
  const value = await retrySafeRead(async () => {
    attempts++;
    if (attempts === 1) throw new Error('Plugin disconnected');
    return 'connected result';
  }, {
    waitUntilReady: async () => { waits++; return true; },
  });
  assert.equal(value, 'connected result');
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test('safe reads do not retry an ambiguous non-transport failure', async () => {
  let attempts = 0;
  await assert.rejects(() => retrySafeRead(async () => {
    attempts++;
    throw new Error('Figma node was deleted');
  }), /node was deleted/);
  assert.equal(attempts, 1);
});

test('safe reads stop when the bridge does not become ready again', async () => {
  let attempts = 0;
  await assert.rejects(() => retrySafeRead(async () => {
    attempts++;
    throw new Error('Plugin disconnected');
  }, { waitUntilReady: async () => false }), /Plugin disconnected/);
  assert.equal(attempts, 1);
});

test('transient classifier recognizes normalized plugin and daemon failures', () => {
  assert.equal(isTransientReadFailure({ kind: 'plugin-unavailable' }), true);
  assert.equal(isTransientReadFailure(new Error('Plugin execution timeout (25s)')), true);
  assert.equal(isTransientReadFailure(new Error('Validation failed')), false);
});
