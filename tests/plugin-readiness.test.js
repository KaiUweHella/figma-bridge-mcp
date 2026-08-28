import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePluginReadiness } from '../src/engine.js';
import { PLUGIN_BUILD_VERSION } from '../engine/src/lib/plugin-version.js';

const CURRENT_DAEMON = Object.freeze({ status: 'ok', bridgeBuildVersion: PLUGIN_BUILD_VERSION });

test('plugin readiness restarts one previously configured idle daemon inside the Plan budget', async () => {
  let currentTime = 100;
  let healthCalls = 0;
  const restartBudgets = [];

  const result = await ensurePluginReadiness({
    deadline: 1_100,
    maxWaitMs: 8_000,
    adapters: {
      now: () => currentTime,
      health: async () => {
        healthCalls += 1;
        return healthCalls === 1
          ? { ok: false, plugin: false, raw: null }
          : { ok: true, plugin: true, raw: CURRENT_DAEMON };
      },
      hasPriorSetup: () => true,
      restart: async ({ timeoutMs }) => {
        restartBudgets.push(timeoutMs);
        currentTime += 25;
      },
      wait: async (delayMs) => { currentTime += delayMs; },
    },
  });

  assert.deepEqual(result, { restarted: true });
  assert.equal(healthCalls, 2);
  assert.deepEqual(restartBudgets, [1_000]);
  assert.ok(currentTime <= 1_100);
});

test('plugin readiness keeps first-time setup explicit and never starts a fresh daemon', async () => {
  let restartCalls = 0;
  let waitCalls = 0;

  await assert.rejects(
    ensurePluginReadiness({
      deadline: 1_000,
      adapters: {
        now: () => 0,
        health: async () => ({ ok: false, plugin: false, raw: null }),
        hasPriorSetup: () => false,
        restart: async () => { restartCalls += 1; },
        wait: async () => { waitCalls += 1; },
      },
    }),
    (error) => {
      assert.equal(error.kind, 'plugin-unavailable');
      assert.equal(error.phase, 'target-resolution');
      assert.equal(error.outcome, 'not-dispatched');
      return true;
    },
  );

  assert.equal(restartCalls, 0);
  assert.equal(waitCalls, 0);
});

test('plugin readiness never waits beyond the owning Command Plan deadline', async () => {
  let currentTime = 0;
  const waits = [];

  await assert.rejects(ensurePluginReadiness({
    deadline: 450,
    maxWaitMs: 8_000,
    adapters: {
      now: () => currentTime,
      health: async () => ({ ok: true, plugin: false, raw: CURRENT_DAEMON }),
      hasPriorSetup: () => true,
      restart: async () => assert.fail('a running daemon must not be restarted'),
      wait: async (delayMs) => {
        waits.push(delayMs);
        currentTime += delayMs;
      },
    },
  }), { kind: 'plugin-unavailable', outcome: 'not-dispatched' });

  assert.deepEqual(waits, [200, 200, 50]);
  assert.equal(currentTime, 450);
});

test('plugin readiness does not launch after a health probe consumes the remaining Plan budget', async () => {
  let currentTime = 0;
  let restartCalls = 0;

  await assert.rejects(ensurePluginReadiness({
    deadline: 100,
    adapters: {
      now: () => currentTime,
      health: async () => {
        currentTime = 100;
        return { ok: false, plugin: false, raw: null };
      },
      hasPriorSetup: () => true,
      restart: async () => { restartCalls += 1; },
      wait: async () => assert.fail('the exhausted Plan must not wait'),
    },
  }), { kind: 'plugin-unavailable', outcome: 'not-dispatched' });

  assert.equal(restartCalls, 0);
});

test('plugin readiness never launches the daemon more than once per Command Plan', async () => {
  let currentTime = 0;
  let restartCalls = 0;

  await assert.rejects(ensurePluginReadiness({
    deadline: 450,
    adapters: {
      now: () => currentTime,
      health: async () => ({ ok: false, plugin: false, raw: null }),
      hasPriorSetup: () => true,
      restart: async () => { restartCalls += 1; },
      wait: async (delayMs) => { currentTime += delayMs; },
    },
  }), { kind: 'plugin-unavailable', outcome: 'not-dispatched' });

  assert.equal(restartCalls, 1);
  assert.equal(currentTime, 450);
});

test('plugin readiness tolerates a timed-out launcher when the detached daemon becomes healthy', async () => {
  let healthCalls = 0;
  let restartCalls = 0;

  const result = await ensurePluginReadiness({
    deadline: 1_000,
    adapters: {
      now: () => 0,
      health: async () => {
        healthCalls += 1;
        return healthCalls === 1
          ? { ok: false, plugin: false, raw: null }
          : { ok: true, plugin: true, raw: CURRENT_DAEMON };
      },
      hasPriorSetup: () => true,
      restart: async () => {
        restartCalls += 1;
        throw new Error('launcher timeout');
      },
      wait: async () => {},
    },
  });

  assert.deepEqual(result, { restarted: true });
  assert.equal(restartCalls, 1);
  assert.equal(healthCalls, 2);
});

test('plugin readiness replaces a stale daemon before accepting its Plugin socket', async () => {
  let healthCalls = 0;
  let restartCalls = 0;
  const result = await ensurePluginReadiness({
    deadline: 1_000,
    adapters: {
      now: () => 0,
      health: async () => {
        healthCalls++;
        return healthCalls === 1
          ? { ok: true, plugin: true, raw: { status: 'ok', bridgeBuildVersion: '3.3.6' } }
          : { ok: true, plugin: true, raw: CURRENT_DAEMON };
      },
      hasPriorSetup: () => true,
      restart: async () => { restartCalls++; },
      wait: async () => {},
    },
  });
  assert.deepEqual(result, { restarted: true });
  assert.equal(restartCalls, 1);
  assert.equal(healthCalls, 2);
});

test('plugin readiness binds an explicit target and editor to one responsive connection', async () => {
  const healthOptions = [];
  const result = await ensurePluginReadiness({
    deadline: 1_000,
    fileKey: 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME',
    expectedEditor: 'figma',
    adapters: {
      now: () => 0,
      health: async (options) => {
        healthOptions.push(options);
        return {
          ok: true,
          plugin: true,
          raw: {
            ...CURRENT_DAEMON,
            pluginResponsive: true,
            connections: [
              { fileKey: 'OTHERPLACEHOLDERKEY', editorType: 'figma', responsiveness: 'responsive' },
              { fileKey: 'TARGETPLACEHOLDERKEY', editorType: 'figma', responsiveness: 'responsive' },
            ],
          },
        };
      },
      hasPriorSetup: () => true,
      restart: async () => assert.fail('a current daemon must not restart'),
      wait: async () => assert.fail('the exact responsive target must be accepted immediately'),
    },
  });

  assert.deepEqual(result, { restarted: false });
  assert.deepEqual(healthOptions, [{ timeoutMs: 1000, fileKey: 'TARGETPLACEHOLDERKEY', probe: true }]);
});

test('plugin readiness does not accept a different responsive window for the explicit target', async () => {
  let currentTime = 0;
  await assert.rejects(ensurePluginReadiness({
    deadline: 250,
    fileKey: 'TARGETPLACEHOLDERKEY',
    expectedEditor: 'figma',
    adapters: {
      now: () => currentTime,
      health: async () => ({
        ok: true,
        plugin: true,
        raw: {
          ...CURRENT_DAEMON,
          pluginResponsive: false,
          connections: [
            { fileKey: 'OTHERPLACEHOLDERKEY', editorType: 'figma', responsiveness: 'responsive' },
          ],
        },
      }),
      hasPriorSetup: () => true,
      restart: async () => assert.fail('a current daemon must not restart'),
      wait: async (delayMs) => { currentTime += delayMs; },
    },
  }), { kind: 'plugin-unavailable', phase: 'target-resolution', outcome: 'not-dispatched' });
  assert.equal(currentTime, 250);
});
