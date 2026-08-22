import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackedJobRegistry } from '../src/tracked-job-registry.js';

test('tracked jobs attach concurrent polls to one operation and separate keys', async () => {
  const registry = createTrackedJobRegistry();
  let starts = 0;
  let release;
  const operation = () => {
    starts++;
    return new Promise((resolve) => { release = resolve; });
  };
  const first = registry.attach('FILE_A\0export.assets', operation);
  const poll = registry.attach('FILE_A\0export.assets', operation);
  const other = registry.attach('FILE_B\0export.assets', async () => 'other');
  assert.equal(first.started, true);
  assert.equal(poll.started, false);
  assert.equal(poll.job, first.job);
  assert.equal(other.started, true);
  assert.equal(starts, 0, 'operations start on the next microtask');
  await Promise.resolve();
  assert.equal(starts, 1);
  release('done');
  await Promise.all([first.job.promise, poll.job.promise, other.job.promise]);
  assert.equal(first.job.result, 'done');
  assert.equal(other.job.result, 'other');
});

test('tracked jobs cache success briefly but permit retry after a discarded failure', async () => {
  const timers = [];
  const registry = createTrackedJobRegistry({
    resultCacheMs: 50,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return { unref() {} };
    },
  });
  let successes = 0;
  const first = registry.attach('success', async () => ++successes);
  await first.job.promise;
  registry.cacheSuccess('success', first.job);
  assert.equal(registry.attach('success', async () => ++successes).started, false);
  assert.equal(successes, 1);
  assert.equal(timers[0].delay, 50);
  timers[0].callback();
  assert.equal(registry.attach('success', async () => ++successes).started, true);

  let failures = 0;
  const failed = registry.attach('failure', async () => {
    failures++;
    throw new Error('failed');
  });
  await failed.job.promise;
  assert.match(failed.job.error.message, /failed/);
  registry.discard('failure', failed.job);
  const retry = registry.attach('failure', async () => {
    failures++;
    return 'recovered';
  });
  await retry.job.promise;
  assert.equal(retry.job.result, 'recovered');
  assert.equal(failures, 2);
});

test('tracked jobs evict terminal success and failure even when nobody polls again', async () => {
  const timers = [];
  const registry = createTrackedJobRegistry({
    resultCacheMs: 25,
    terminalRetentionMs: 100,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return 1;
    },
  });
  const success = registry.attach('unobserved-success', async () => 'done');
  const failure = registry.attach('unobserved-failure', async () => {
    throw new Error('failed');
  });
  await Promise.all([success.job.promise, failure.job.promise]);

  assert.equal(registry.size(), 2);
  assert.deepEqual(timers.map(({ delay }) => delay), [100, 100]);
  for (const timer of timers) timer.callback();
  assert.equal(registry.size(), 0);
});

test('observing a cached success can shorten but never extend terminal retention', async () => {
  let currentTime = 0;
  const timers = [];
  const registry = createTrackedJobRegistry({
    resultCacheMs: 50,
    terminalRetentionMs: 500,
    now: () => currentTime,
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return { unref() {} };
    },
  });
  const first = registry.attach('success', async () => 'done');
  await first.job.promise;
  assert.equal(first.job.terminalEvictAt, 500);
  assert.equal(first.job.evictAt, 500);

  currentTime = 20;
  registry.cacheSuccess('success', first.job);
  assert.equal(first.job.evictAt, 70);
  assert.deepEqual(timers.map(({ delay }) => delay), [500, 50]);

  currentTime = 40;
  registry.cacheSuccess('success', first.job);
  assert.equal(first.job.evictAt, 70);
  assert.equal(timers.length, 2, 'a repeated poll must not extend or reschedule retention');

  timers[1].callback();
  const retry = registry.attach('success', async () => 'new result');
  assert.equal(retry.started, true);
  await retry.job.promise;

  timers[0].callback();
  assert.equal(registry.size(), 1, 'the old hard deadline cannot discard a replacement job');
});

test('tracked job retention options reject invalid values', () => {
  assert.throws(
    () => createTrackedJobRegistry({ terminalRetentionMs: Number.POSITIVE_INFINITY }),
    /terminalRetentionMs/,
  );
  assert.throws(
    () => createTrackedJobRegistry({ resultCacheMs: -1 }),
    /resultCacheMs/,
  );
});
