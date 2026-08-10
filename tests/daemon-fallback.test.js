// Daemon port fallback: foreign squatter → next range port; our daemon →
// singleton exit; all busy → exit 1. Runs the REAL daemon on scratch ports via
// the DAEMON_PORT_RANGE hook, with all state files isolated in a temp dir.
// Each test gets its own port range so lingering squatters can't interfere.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRequest } from '../engine/src/lib/daemon-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(__dirname, '..', 'engine', 'src', 'daemon.js');
const TOKEN = 'fallback-test-token';

const cleanups = [];
after(() => { for (const fn of cleanups) { try { fn(); } catch {} } });

function makeState() {
  const tmp = mkdtempSync(join(tmpdir(), 'figma-bridge-fallback-'));
  writeFileSync(join(tmp, 'token'), TOKEN);
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function spawnDaemon(tmp, range) {
  const env = {
    ...process.env,
    DAEMON_PORT_RANGE: range.join(','),
    DAEMON_TOKEN_FILE: join(tmp, 'token'),
    DAEMON_PID_FILE: join(tmp, 'pid'),
    DAEMON_PORT_FILE: join(tmp, 'port'),
    PLUGIN_KEY_FILE: join(tmp, 'key'),
    DAEMON_IDLE_TIMEOUT: '600000',
  };
  delete env.DAEMON_PORT; // fallback only engages without an explicit port
  const child = spawn(process.execPath, [DAEMON], { env, stdio: 'ignore' });
  cleanups.push(() => child.kill('SIGKILL'));
  return child;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      cleanups.push(() => srv.close());
      resolve({ server: srv, port: srv.address().port });
    });
  });
}

async function reserveRange() {
  return Promise.all([reservePort(), reservePort(), reservePort()]);
}

function releasePort(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Mimics OUR daemon's unauthenticated /health signature (403 + Unauthorized).
function fakeOurDaemon() {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer((req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token' }));
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      cleanups.push(() => srv.close());
      resolve({ server: srv, port: srv.address().port });
    });
  });
}

async function waitForHealth(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: signRequest(TOKEN, 'GET', '/health'),
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function waitForExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon did not exit')), timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

test('foreign process on first port → daemon binds the next one and publishes it', async () => {
  const reservations = await reserveRange();
  const range = reservations.map(({ port }) => port);
  const tmp = makeState();
  // Keep the first port occupied; release the fallback candidates immediately
  // before the daemon starts. No other test can guess these OS-assigned ports.
  await releasePort(reservations[1].server);
  await releasePort(reservations[2].server);
  const child = spawnDaemon(tmp, range);

  assert.ok(await waitForHealth(range[1]), `daemon should answer on fallback port ${range[1]}`);
  assert.equal(readFileSync(join(tmp, 'port'), 'utf8').trim(), String(range[1]));

  child.kill('SIGTERM');
  await waitForExit(child);
});

test('our own daemon on a range port → second daemon exits 0 (singleton, split-brain guard)', async () => {
  const reservations = await reserveRange();
  await Promise.all(reservations.map(({ server }) => releasePort(server)));
  const ours = await fakeOurDaemon();
  const range = [reservations[0].port, ours.port, reservations[2].port];
  const tmp = makeState();
  // "Our" daemon sits on the SECOND port (as after an earlier fallback) — the
  // pre-bind range scan must find it there and exit before binding port one.
  const child = spawnDaemon(tmp, range);
  const code = await waitForExit(child);
  assert.equal(code, 0);
  // It must not have bound the free first port on the way out.
  const res = await fetch(`http://127.0.0.1:${range[0]}/health`, {
    signal: AbortSignal.timeout(300),
  }).catch(() => null);
  assert.equal(res, null, 'no daemon may be listening on the first port');
});

test('all range ports held by foreign processes → daemon exits 1', async () => {
  const reservations = await reserveRange();
  const range = reservations.map(({ port }) => port);
  const tmp = makeState();
  const child = spawnDaemon(tmp, range);
  const code = await waitForExit(child);
  assert.equal(code, 1);
});
