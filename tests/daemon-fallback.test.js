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

// Scratch port ranges far away from the real 3456-3460, one per test.
const BASE = 34620 + Math.floor(Math.random() * 200) * 10;
const rangeFor = (n) => [BASE + n * 3, BASE + n * 3 + 1, BASE + n * 3 + 2];

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

function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => {
      cleanups.push(() => srv.close());
      resolve(srv);
    });
  });
}

// Mimics OUR daemon's unauthenticated /health signature (403 + Unauthorized).
function fakeOurDaemon(port) {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer((req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token' }));
    });
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => {
      cleanups.push(() => srv.close());
      resolve(srv);
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
  const range = rangeFor(0);
  const tmp = makeState();
  await occupyPort(range[0]); // plain TCP squatter, no HTTP answer
  const child = spawnDaemon(tmp, range);

  assert.ok(await waitForHealth(range[1]), `daemon should answer on fallback port ${range[1]}`);
  assert.equal(readFileSync(join(tmp, 'port'), 'utf8').trim(), String(range[1]));

  child.kill('SIGTERM');
  await waitForExit(child);
});

test('our own daemon on a range port → second daemon exits 0 (singleton, split-brain guard)', async () => {
  const range = rangeFor(1);
  const tmp = makeState();
  // "Our" daemon sits on the SECOND port (as after an earlier fallback) — the
  // pre-bind range scan must find it there and exit before binding port one.
  await fakeOurDaemon(range[1]);
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
  const range = rangeFor(2);
  const tmp = makeState();
  for (const port of range) await occupyPort(port);
  const child = spawnDaemon(tmp, range);
  const code = await waitForExit(child);
  assert.equal(code, 1);
});
