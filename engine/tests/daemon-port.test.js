// Port resolution: env > port file > default, stale-file handling, range hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  PORT_RANGE,
  parsePortRange,
  readPortFile,
  getDaemonPort,
  writePortFile,
  clearPortFile,
} from '../src/lib/daemon-port.js';

// Every function takes an env object, so tests never touch process.env or the
// user's real ~/.figma-safe-mcp/daemon-port.
function scratchEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-safe-port-'));
  return { env: { DAEMON_PORT_FILE: join(dir, 'daemon-port'), ...extra }, dir };
}

test('default port is 3456 and the range matches the plugin manifest', () => {
  assert.equal(DEFAULT_PORT, 3456);
  assert.deepEqual(PORT_RANGE, [3456, 3457, 3458, 3459, 3460]);
});

test('precedence: DAEMON_PORT env beats port file beats default', () => {
  const { env } = scratchEnv();
  assert.equal(getDaemonPort(env), 3456); // nothing set

  writePortFile(3458, env);
  assert.equal(getDaemonPort(env), 3458); // port file

  env.DAEMON_PORT = '9999';
  assert.equal(getDaemonPort(env), 9999); // env wins, even off-range
});

test('garbage or out-of-range port file is ignored', () => {
  const { env } = scratchEnv();
  writeFileSync(env.DAEMON_PORT_FILE, 'not-a-port');
  assert.equal(readPortFile(env), null);
  assert.equal(getDaemonPort(env), 3456);

  writeFileSync(env.DAEMON_PORT_FILE, '34567'); // outside 3456-3460
  assert.equal(readPortFile(env), null);
  assert.equal(getDaemonPort(env), 3456);
});

test('invalid DAEMON_PORT env falls through to file/default', () => {
  const { env } = scratchEnv({ DAEMON_PORT: 'banana' });
  assert.equal(getDaemonPort(env), 3456);
  writePortFile(3457, env);
  assert.equal(getDaemonPort(env), 3457);
});

test('DAEMON_PORT_RANGE test hook replaces the range', () => {
  const { env } = scratchEnv({ DAEMON_PORT_RANGE: '4001, 4002,4003' });
  assert.deepEqual(parsePortRange(env), [4001, 4002, 4003]);
  // readPortFile validates against the hooked range
  writeFileSync(env.DAEMON_PORT_FILE, '4002');
  assert.equal(readPortFile(env), 4002);
  // and getDaemonPort defaults to the first hooked port
  clearPortFile(env);
  assert.equal(getDaemonPort(env), 4001);
  // a garbage hook falls back to the manifest range
  assert.deepEqual(parsePortRange({ DAEMON_PORT_RANGE: 'x,y' }), PORT_RANGE);
});

test('writePortFile / clearPortFile round-trip; guarded clear is a no-op on mismatch', () => {
  const { env } = scratchEnv();
  writePortFile(3459, env);
  assert.equal(readFileSync(env.DAEMON_PORT_FILE, 'utf8'), '3459');

  // A dying old daemon (port 3456) must not delete the newer daemon's file.
  clearPortFile(env, 3456);
  assert.ok(existsSync(env.DAEMON_PORT_FILE));

  clearPortFile(env, 3459);
  assert.ok(!existsSync(env.DAEMON_PORT_FILE));

  writePortFile(3459, env);
  clearPortFile(env); // unguarded clear always removes
  assert.ok(!existsSync(env.DAEMON_PORT_FILE));
});
