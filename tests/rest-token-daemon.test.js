// REST-token flow through the daemon: the plugin UI sends {type:'rest-token'}
// over the AUTHENTICATED WebSocket; the daemon persists/clears the 0600 file
// and reports the configured flag in hello-ack and /health. An
// unauthenticated socket must never reach the handler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRequest } from '../engine/src/lib/daemon-auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, '..', 'engine', 'src', 'daemon.js');

const PORT = 34571; // scratch port, outside the plugin range and other suites
const TOKEN = 'test-daemon-token-rest';
const KEY = 'test-access-key-rest-0123456789';
const PAT = 'figd_test_token_value_never_logged';

let tmp;
let child;
let restTokenFile;

function health() {
  return fetch(`http://127.0.0.1:${PORT}/health`, {
    headers: signRequest(TOKEN, 'GET', '/health', ''),
  });
}

function waitForListen(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const res = await health();
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error('daemon did not start'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Open a socket, optionally authenticate, run `fn(ws, messages)`, then close.
// `messages` collects every parsed frame the daemon sends.
function withWs(authenticate, fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/plugin`);
    const messages = [];
    const finish = (err) => {
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(messages);
    };
    ws.on('error', () => {}); // close codes surface as errors; the tests assert on messages
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())); } catch {}
    });
    ws.on('open', async () => {
      try {
        if (authenticate) {
          ws.send(JSON.stringify({ type: 'hello', mode: 'plugin', version: 'test', key: KEY }));
          await waitFor(() => messages.some((m) => m.type === 'hello-ack'));
        }
        await fn(ws, messages);
        finish();
      } catch (err) {
        finish(err);
      }
    });
  });
}

function waitFor(cond, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('condition not met in time'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'figma-bridge-rest-'));
  const tokenFile = join(tmp, 'token');
  const keyFile = join(tmp, 'key');
  restTokenFile = join(tmp, 'rest-token');
  writeFileSync(tokenFile, TOKEN);
  writeFileSync(keyFile, KEY);

  child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      DAEMON_PORT: String(PORT),
      DAEMON_TOKEN_FILE: tokenFile,
      DAEMON_PID_FILE: join(tmp, 'pid'),
      DAEMON_PORT_FILE: join(tmp, 'port'),
      PLUGIN_KEY_FILE: keyFile,
      REST_TOKEN_FILE: restTokenFile,
      DAEMON_IDLE_TIMEOUT: '600000',
    },
    stdio: 'ignore',
  });
  await waitForListen();
});

after(() => {
  try { child.kill('SIGTERM'); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('unauthenticated socket cannot plant a REST token', async () => {
  await withWs(false, async (ws, messages) => {
    // First frame is NOT a hello — the daemon must reject and close.
    ws.send(JSON.stringify({ type: 'rest-token', value: 'evil-token' }));
    await waitFor(() => messages.some((m) => m.type === 'auth-error'));
  });
  assert.equal(existsSync(restTokenFile), false, 'no token file may exist');
});

test('authenticated save writes the file 0600 and acks configured:true', async () => {
  const messages = await withWs(true, async (ws, msgs) => {
    // hello-ack must report the pre-save state.
    const ack = msgs.find((m) => m.type === 'hello-ack');
    assert.equal(ack.restTokenConfigured, false);
    ws.send(JSON.stringify({ type: 'rest-token', value: PAT }));
    await waitFor(() => msgs.some((m) => m.type === 'rest-token-ack'));
  });
  const ack = messages.find((m) => m.type === 'rest-token-ack');
  assert.equal(ack.configured, true);
  assert.equal(readFileSync(restTokenFile, 'utf8'), PAT);
  const mode = statSync(restTokenFile).mode & 0o777;
  assert.equal(mode, 0o600, `rest-token file must be 0600, got ${mode.toString(8)}`);
});

test('/health and hello-ack report restTokenConfigured:true once saved', async () => {
  const res = await health();
  const body = await res.json();
  assert.equal(body.restTokenConfigured, true);
  const messages = await withWs(true, async () => {});
  const ack = messages.find((m) => m.type === 'hello-ack');
  assert.equal(ack.restTokenConfigured, true);
});

test('selection whitelist: fileKey/fileName pass through capped; junk is dropped', async () => {
  await withWs(true, async (ws) => {
    ws.send(JSON.stringify({
      type: 'selection',
      selection: {
        page: 'P', total: 1, nodes: [{ id: '1:2', name: 'n', type: 'FRAME' }],
        fileKey: 'K'.repeat(100),           // over the 64-char cap
        fileName: 'My File',
        evil: { nested: true },             // unknown field → dropped
      },
    }));
    // The daemon caches synchronously on receipt; give the event loop a beat.
    await new Promise((r) => setTimeout(r, 150));
  });
  const res = await fetch(`http://127.0.0.1:${PORT}/selection`, {
    headers: signRequest(TOKEN, 'GET', '/selection', ''),
  });
  const body = await res.json();
  assert.equal(body.selection.fileKey, 'K'.repeat(64), 'capped at 64 chars');
  assert.equal(body.selection.fileName, 'My File');
  assert.equal('evil' in body.selection, false, 'unknown fields are dropped');
});

test('selection whitelist: non-string fileKey is dropped, not coerced', async () => {
  await withWs(true, async (ws) => {
    ws.send(JSON.stringify({
      type: 'selection',
      selection: { page: 'P', total: 0, nodes: [], fileKey: 12345 },
    }));
    await new Promise((r) => setTimeout(r, 150));
  });
  const res = await fetch(`http://127.0.0.1:${PORT}/selection`, {
    headers: signRequest(TOKEN, 'GET', '/selection', ''),
  });
  const body = await res.json();
  assert.equal('fileKey' in body.selection, false);
});

test('empty value clears the token file and acks configured:false', async () => {
  const messages = await withWs(true, async (ws, msgs) => {
    ws.send(JSON.stringify({ type: 'rest-token', value: '' }));
    await waitFor(() => msgs.some((m) => m.type === 'rest-token-ack'));
  });
  const ack = messages.find((m) => m.type === 'rest-token-ack');
  assert.equal(ack.configured, false);
  assert.equal(existsSync(restTokenFile), false);
  const res = await health();
  const body = await res.json();
  assert.equal(body.restTokenConfigured, false);
});
