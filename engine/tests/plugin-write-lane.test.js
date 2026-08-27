import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLUGIN_WRITE_QUEUE,
  PluginWriteLaneError,
  createPluginWriteLanes,
} from '../src/lib/plugin-write-lane.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('same-session writes are ordered while different sessions progress independently', async () => {
  const lanes = createPluginWriteLanes();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const deadlineAt = Date.now() + 2_000;

  const first = lanes.run({
    sessionKey: 'file:A', deadlineAt,
    operation: async () => { events.push('A1:start'); await firstGate; events.push('A1:end'); },
  });
  const second = lanes.run({
    sessionKey: 'file:A', deadlineAt,
    operation: () => { events.push('A2'); },
  });
  const other = lanes.run({
    sessionKey: 'file:B', deadlineAt,
    operation: () => { events.push('B1'); },
  });

  await other;
  assert.deepEqual(events, ['A1:start', 'B1']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['A1:start', 'B1', 'A1:end', 'A2']);
  assert.deepEqual(lanes.summary(), { active: 0, queued: 0, quarantined: 0 });
});

test('queued deadline and cancellation remove only their own command', async () => {
  const lanes = createPluginWriteLanes();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const first = lanes.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 2_000,
    operation: async () => { await gate; events.push('first'); },
  });
  const expired = lanes.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 25,
    operation: () => events.push('expired-must-not-run'),
  });
  const controller = new AbortController();
  const cancelled = lanes.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 2_000, signal: controller.signal,
    operation: () => events.push('cancelled-must-not-run'),
  });
  const survivor = lanes.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 2_000,
    operation: () => events.push('survivor'),
  });
  controller.abort();

  await assert.rejects(cancelled, (error) => error instanceof PluginWriteLaneError && error.code === 'cancelled');
  await assert.rejects(expired, (error) => error instanceof PluginWriteLaneError && error.code === 'deadline-elapsed');
  release();
  await Promise.all([first, survivor]);
  assert.deepEqual(events, ['first', 'survivor']);
});

test('unknown dispatch quarantines until the exact settlement token arrives', async () => {
  const lanes = createPluginWriteLanes({
    tokenMatches: (prepared, settled) => prepared?.id === settled?.id,
  });
  const deadlineAt = Date.now() + 2_000;
  const unknown = Object.assign(new Error('unknown'), {
    outcome: 'unknown-after-dispatch',
    dispatchState: 'unknown',
  });
  const first = lanes.run({
    sessionKey: 'file:A', deadlineAt,
    operation: ({ markDispatched }) => {
      markDispatched({ id: 'receipt-1' });
      throw unknown;
    },
  });
  await assert.rejects(first, (error) => error === unknown);
  assert.deepEqual(lanes.summary(), { active: 0, queued: 0, quarantined: 1 });

  let nextStarted = false;
  const next = lanes.run({
    sessionKey: 'file:A', deadlineAt,
    operation: () => { nextStarted = true; },
  });
  await wait(10);
  assert.equal(nextStarted, false);
  assert.equal(lanes.settle('file:A', { id: 'wrong' }), false);
  assert.equal(nextStarted, false);
  assert.equal(lanes.settle('file:A', { id: 'receipt-1' }), true);
  await next;
  assert.equal(nextStarted, true);
});

test('a retry that outlives unresolved write quarantine reports duplicate risk', async () => {
  const lanes = createPluginWriteLanes();
  const unknown = Object.assign(new Error('unknown'), {
    outcome: 'unknown-after-dispatch', dispatchState: 'unknown',
  });
  await assert.rejects(lanes.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: ({ markDispatched }) => { markDispatched('receipt'); throw unknown; },
  }));
  await assert.rejects(lanes.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 20,
    operation: () => 'must-not-run',
  }), (error) => error instanceof PluginWriteLaneError
    && error.code === 'prior-outcome-unknown'
    && /duplicate risk/i.test(error.message)
    && /inspect/i.test(error.message));
});

test('known failed receipts release, and read-after-write barriers wait in order', async () => {
  const lanes = createPluginWriteLanes();
  const failed = Object.assign(new Error('known failure'), {
    outcome: 'unknown-after-dispatch',
    dispatchState: 'failed',
  });
  await assert.rejects(lanes.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 1_000,
    operation: ({ markDispatched }) => { markDispatched('receipt'); throw failed; },
  }), (error) => error === failed);
  assert.deepEqual(lanes.summary(), { active: 0, queued: 0, quarantined: 0 });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const write = lanes.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 1_000,
    operation: async () => { events.push('write:start'); await gate; events.push('write:end'); },
  });
  const read = lanes.waitForPriorWrites({ sessionKey: 'file:A', deadlineAt: Date.now() + 1_000 })
    .then(() => events.push('read'));
  await wait(10);
  assert.deepEqual(events, ['write:start']);
  release();
  await Promise.all([write, read]);
  assert.deepEqual(events, ['write:start', 'write:end', 'read']);
});

test('queue length is bounded and recovery requires explicit runtime-stopped proof', async () => {
  const lanes = createPluginWriteLanes({ maxQueue: 2 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deadlineAt = Date.now() + 2_000;
  const active = lanes.run({ sessionKey: 'file:A', deadlineAt, operation: () => gate });
  const queuedOne = lanes.run({ sessionKey: 'file:A', deadlineAt, operation: () => undefined });
  const queuedTwo = lanes.run({ sessionKey: 'file:A', deadlineAt, operation: () => undefined });
  await assert.rejects(
    lanes.run({ sessionKey: 'file:A', deadlineAt, operation: () => undefined }),
    (error) => error instanceof PluginWriteLaneError && error.code === 'queue-full',
  );
  release();
  await Promise.all([active, queuedOne, queuedTwo]);

  const unknown = Object.assign(new Error('unknown'), {
    outcome: 'unknown-after-dispatch', dispatchState: 'unknown',
  });
  await assert.rejects(lanes.run({
    sessionKey: 'file:A', deadlineAt,
    operation: ({ markDispatched }) => { markDispatched('receipt'); throw unknown; },
  }));
  assert.throws(() => lanes.recoverStoppedRuntime('file:A'), /runtime-stopped proof/);
  assert.equal(lanes.recoverStoppedRuntime('file:A', { runtimeStopped: true }), true);
  assert.equal(MAX_PLUGIN_WRITE_QUEUE, 64);
});
