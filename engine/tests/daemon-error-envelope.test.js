import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_DAEMON_ERROR_SCHEMA,
  BridgeDaemonError,
  bridgeDaemonErrorBody,
  parseBridgeDaemonError,
  adaptLegacyDaemonError,
  permitsCompatibilityRedispatch,
} from '../src/lib/daemon-error-envelope.js';

test('Bridge Daemon errors expose one bounded versioned envelope plus the legacy string', () => {
  const body = bridgeDaemonErrorBody(new BridgeDaemonError('Plugin not connected', {
    kind: 'plugin-unavailable',
    phase: 'target-resolution',
    outcome: 'not-dispatched',
  }));

  assert.equal(body.error, 'Plugin not connected');
  assert.deepEqual(body.bridgeError, {
    schema: BRIDGE_DAEMON_ERROR_SCHEMA,
    kind: 'plugin-unavailable',
    phase: 'target-resolution',
    outcome: 'not-dispatched',
    message: 'Plugin not connected',
  });
  assert.deepEqual(parseBridgeDaemonError(body.bridgeError), body.bridgeError);
});

test('Bridge Daemon error parser rejects malformed or unknown structured facts', () => {
  const valid = {
    schema: BRIDGE_DAEMON_ERROR_SCHEMA,
    kind: 'execution',
    phase: 'plugin-execution',
    outcome: 'unknown-after-dispatch',
    message: 'Domain operation failed',
  };
  assert.equal(parseBridgeDaemonError({ ...valid, schema: 999 }), null);
  assert.equal(parseBridgeDaemonError({ ...valid, kind: 'made-up' }), null);
  assert.equal(parseBridgeDaemonError({ ...valid, message: 'x'.repeat(20_000) }), null);
});

test('bounded legacy adapter never treats a domain token error as authentication', () => {
  const domain = adaptLegacyDaemonError('Token alias could not be resolved', { status: 500 });
  assert.equal(domain.kind, 'execution');
  assert.equal(domain.phase, 'daemon-response');
  assert.equal(domain.outcome, 'unknown-after-dispatch');

  const auth = adaptLegacyDaemonError('Unauthorized: invalid request signature', { status: 403 });
  assert.equal(auth.kind, 'authentication');
  assert.equal(auth.outcome, 'not-dispatched');

  const oldAction = adaptLegacyDaemonError(
    'Invalid execution request: action must be “eval”',
    { status: 400 },
  );
  assert.equal(oldAction.kind, 'plugin-capability');
  assert.equal(oldAction.outcome, 'not-dispatched');

  const oversized = adaptLegacyDaemonError('x'.repeat(20_000), { status: 500 });
  assert.ok(Buffer.byteLength(oversized.message, 'utf8') <= 16 * 1024);
});

test('compatibility redispatch requires a capability rejection before dispatch', () => {
  assert.equal(permitsCompatibilityRedispatch({
    kind: 'plugin-capability',
    outcome: 'not-dispatched',
  }), true);
  assert.equal(permitsCompatibilityRedispatch({
    kind: 'plugin-capability',
    outcome: 'unknown-after-dispatch',
  }), false);
  assert.equal(permitsCompatibilityRedispatch({
    kind: 'execution',
    outcome: 'not-dispatched',
  }), false);
});
