import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { signRequest } from '../engine/src/lib/daemon-auth.js';
import {
  HANDSHAKE_PROTO,
  makeNonce,
  pluginTranscript,
  sign,
} from '../engine/src/lib/plugin-handshake.js';
import { PLUGIN_BUILD_VERSION } from '../engine/src/lib/plugin-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = join(ROOT, 'engine', 'src', 'daemon.js');
const TOKEN = 'idle-wake-daemon-token';
const KEY = 'idle-wake-plugin-key';
const IDLE_TIMEOUT_MS = 300;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!Number.isInteger(port)) throw new Error('Could not allocate idle-wake test port');
  return port;
}

async function waitForHealth(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const headers = signRequest(TOKEN, 'GET', '/health', '');
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers });
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Idle-wake test daemon did not become healthy');
}

function connectPlugin(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`, { origin: 'null' });
    const timeout = setTimeout(() => reject(new Error('Plugin handshake timed out')), 3000);
    ws.once('error', reject);
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'challenge') {
        const nonce = makeNonce();
        const capabilities = [];
        ws.send(JSON.stringify({
          type: 'hello',
          proto: HANDSHAKE_PROTO,
          nonce,
          version: PLUGIN_BUILD_VERSION,
          capabilities,
          proof: sign(KEY, pluginTranscript({
            daemonNonce: message.nonce,
            pluginNonce: nonce,
            port: message.port,
            version: PLUGIN_BUILD_VERSION,
            capabilities,
          })),
        }));
      } else if (message.type === 'hello-ack') {
        clearTimeout(timeout);
        resolve(ws);
      }
    });
  });
}

function ping(ws, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Plugin ping timed out')), timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type !== 'pong') return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve();
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'ping' }));
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

test('an authenticated Plugin gets a wake grace before idle shutdown', { timeout: 5000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'figma-bridge-idle-wake-'));
  const port = await freePort();
  const tokenFile = join(state, 'token');
  const keyFile = join(state, 'key');
  writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  writeFileSync(keyFile, KEY, { mode: 0o600 });
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      DAEMON_PORT: String(port),
      DAEMON_TOKEN_FILE: tokenFile,
      DAEMON_PID_FILE: join(state, 'pid'),
      DAEMON_PORT_FILE: join(state, 'port'),
      PLUGIN_KEY_FILE: keyFile,
      DAEMON_IDLE_TIMEOUT: String(IDLE_TIMEOUT_MS),
    },
    stdio: 'ignore',
  });
  let ws;
  try {
    await waitForHealth(port);
    ws = await connectPlugin(port);

    // Simulate both event loops being suspended: the next Plugin keepalive is
    // delivered just after the Daemon's nominal idle deadline.
    await new Promise((resolve) => setTimeout(resolve, IDLE_TIMEOUT_MS + 35));
    assert.equal(ws.readyState, WebSocket.OPEN);
    await ping(ws);

    const health = await waitForHealth(port, 500);
    assert.equal(health.plugin, true);

    // The grace is recovery-only. Without a resumed keepalive, even an open
    // authenticated socket must not turn the Daemon into a permanent process.
    const exited = await waitForExit(child, IDLE_TIMEOUT_MS + 500);
    assert.equal(exited, true);
  } finally {
    try { ws?.close(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    try { rmSync(state, { recursive: true, force: true }); } catch {}
  }
});
