import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginReadLane, PluginReadLaneError } from '../src/lib/plugin-read-lane.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('read lane bounds concurrency without serializing independent reads', async () => {
  const lane = createPluginReadLane({ maxActive: 2 });
  const first = deferred(); const second = deferred(); const events = [];
  const a = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: async () => { events.push('a'); await first.promise; return 'a'; } });
  const b = lane.run({ sessionKey: 'file:B', deadlineAt: Date.now() + 1000,
    operation: async () => { events.push('b'); await second.promise; return 'b'; } });
  const c = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: async () => { events.push('c'); return 'c'; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['a', 'b']);
  first.resolve();
  assert.equal(await a, 'a');
  assert.equal(await c, 'c');
  second.resolve();
  assert.equal(await b, 'b');
});

test('read lane limits each target session while retaining global concurrency', async () => {
  const lane = createPluginReadLane({ maxActive: 2, maxActivePerSession: 1 });
  const gate = deferred(); const events = [];
  const first = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: async () => { events.push('a1'); await gate.promise; return 'a1'; } });
  const second = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: () => { events.push('a2'); return 'a2'; } });
  const independent = lane.run({ sessionKey: 'file:B', deadlineAt: Date.now() + 1000,
    operation: () => { events.push('b1'); return 'b1'; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['a1', 'b1']);
  assert.equal(await independent, 'b1');
  assert.deepEqual(lane.summary(), {
    active: 1, queued: 1, quarantined: 0, sessions: 1,
    maxActive: 2, maxActivePerSession: 1, maxQueue: 64, maxQueuePerSession: 16,
  });
  gate.resolve();
  assert.equal(await first, 'a1');
  assert.equal(await second, 'a2');
});

test('unknown typed read holds its slot until the exact receipt settles', async () => {
  const lane = createPluginReadLane({ maxActive: 1, tokenMatches: (a, b) => a.id === b.id });
  const unknown = Object.assign(new Error('timeout'), { outcome: 'unknown-after-dispatch', dispatchState: 'unknown' });
  await assert.rejects(lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: ({ markDispatched }) => { markDispatched({ id: 'receipt-1' }); throw unknown; } }), /timeout/);
  let ran = false;
  const next = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: () => { ran = true; return 'ok'; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  assert.equal(lane.settle({ id: 'wrong' }), false);
  assert.equal(lane.settle({ id: 'receipt-1' }), true);
  assert.equal(await next, 'ok');
});

test('a responsive new connection epoch releases only stale reads for its target', async () => {
  const lane = createPluginReadLane({ maxActive: 2, maxActivePerSession: 1 });
  const unknown = Object.assign(new Error('disconnect'), {
    outcome: 'unknown-after-dispatch', dispatchState: 'unknown',
  });
  await assert.rejects(lane.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: ({ markDispatched }) => {
      markDispatched({ connectionEpoch: 'old-A', requestId: 'read-A' });
      throw unknown;
    },
  }), /disconnect/);
  await assert.rejects(lane.run({
    sessionKey: 'file:B', deadlineAt: Date.now() + 1000,
    operation: ({ markDispatched }) => {
      markDispatched({ connectionEpoch: 'old-B', requestId: 'read-B' });
      throw unknown;
    },
  }), /disconnect/);

  assert.equal(lane.recoverReconnectedSession('file:A', { connectionEpoch: 'old-A' }), 0);
  assert.equal(lane.recoverReconnectedSession('file:A', { connectionEpoch: 'new-A' }), 1);
  assert.deepEqual(lane.summary(), {
    active: 1, queued: 0, quarantined: 1, sessions: 1,
    maxActive: 2, maxActivePerSession: 1, maxQueue: 64, maxQueuePerSession: 16,
  });
  assert.equal(await lane.run({
    sessionKey: 'file:A', deadlineAt: Date.now() + 1000, operation: () => 'recovered',
  }), 'recovered');
});

test('queued read observes deadline and cancellation before dispatch', async () => {
  const lane = createPluginReadLane({ maxActive: 1 });
  const gate = deferred();
  const active = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: () => gate.promise });
  const expired = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 15,
    operation: () => 'never' });
  await assert.rejects(expired, (error) => error instanceof PluginReadLaneError
    && error.code === 'deadline-elapsed');
  gate.resolve('done');
  assert.equal(await active, 'done');
});

test('read lane bounds both the global and per-session queues', async () => {
  const lane = createPluginReadLane({
    maxActive: 1, maxActivePerSession: 1, maxQueue: 3, maxQueuePerSession: 2,
  });
  const gate = deferred();
  const active = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: () => gate.promise });
  const a2 = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: () => 'a2' });
  const a3 = lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: () => 'a3' });
  await assert.rejects(lane.run({ sessionKey: 'file:A', deadlineAt: Date.now() + 1000,
    operation: () => 'never' }), (error) => error instanceof PluginReadLaneError
      && error.code === 'queue-full');
  const b1 = lane.run({ sessionKey: 'file:B', deadlineAt: Date.now() + 1000,
    operation: () => 'b1' });
  await assert.rejects(lane.run({ sessionKey: 'file:C', deadlineAt: Date.now() + 1000,
    operation: () => 'never' }), (error) => error instanceof PluginReadLaneError
      && error.code === 'queue-full');
  gate.resolve('a1');
  assert.deepEqual(await Promise.all([active, a2, a3, b1]), ['a1', 'a2', 'a3', 'b1']);
});
