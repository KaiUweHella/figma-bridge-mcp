import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { makeNonce, pluginTranscript, sign } from '../engine/src/lib/plugin-handshake.js';
import { PLUGIN_BUILD_VERSION } from '../engine/src/lib/plugin-version.js';
import { signRequest } from '../engine/src/lib/daemon-auth.js';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = join(ROOT, 'engine', 'src', 'daemon.js');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(Number.isInteger(port));
  return port;
}

async function waitForAuthenticatedPlugin(port, key) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`, {
      headers: { Origin: 'null' },
    });
    const timeout = setTimeout(() => reject(new Error('plugin authentication timed out')), 3000);
    ws.once('error', reject);
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'challenge') {
        const nonce = makeNonce();
        ws.send(JSON.stringify({
          type: 'hello',
          proto: message.proto,
          nonce,
          version: PLUGIN_BUILD_VERSION,
          capabilities: [],
          proof: sign(key, pluginTranscript({
            daemonNonce: message.nonce,
            pluginNonce: nonce,
            port: message.port,
            version: PLUGIN_BUILD_VERSION,
          })),
        }));
      } else if (message.type === 'hello-ack') {
        clearTimeout(timeout);
        resolve(ws);
      }
    });
  });
}

async function invokeConnect(env, options = {}) {
  const script = `
    const startedAt = Date.now();
    const { ensureSafeConnect } = await import('./src/engine.js');
    const result = await ensureSafeConnect(${JSON.stringify(options)});
    process.stdout.write(JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      code: result.code,
      stdout: result.stdout,
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env,
    timeout: 8_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function waitForHealth(port, tokenFile, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const token = readFileSync(tokenFile, 'utf8').trim();
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: signRequest(token, 'GET', '/health'),
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('daemon health timed out');
}

test('figma_connect returns setup instructions without waiting for the plugin', { timeout: 10_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'figma-bridge-connect-'));
  const pidFile = join(state, 'daemon.pid');
  const port = await freePort();
  writeFileSync(join(state, 'plugin-key'), 'latency-test-plugin-key', { mode: 0o600 });

  const script = `
    const startedAt = Date.now();
    const { ensureSafeConnect } = await import('./src/engine.js');
    const result = await ensureSafeConnect();
    process.stdout.write(JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      code: result.code,
      stdout: result.stdout,
    }));
  `;

  try {
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: {
        ...process.env,
        CONNECT_TIMEOUT_MS: '5000',
        DAEMON_PORT_RANGE: String(port),
        DAEMON_PORT_FILE: join(state, 'daemon-port'),
        DAEMON_PID_FILE: pidFile,
        DAEMON_TOKEN_FILE: join(state, '.daemon-token'),
        PLUGIN_KEY_FILE: join(state, 'plugin-key'),
        REST_TOKEN_FILE: join(state, 'rest-token'),
        AUDIT_LOG_PATH: join(state, 'audit.log'),
        PLUGIN_INSTALL_DIR: join(state, 'plugin'),
      },
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Daemon running in Safe Mode/);
    assert.ok(
      result.elapsedMs < 4_000,
      `figma_connect took ${result.elapsedMs}ms; it must return before waiting for a plugin`,
    );
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
    rmSync(state, { recursive: true, force: true });
  }
});

test('figma_connect reuses a healthy daemon without dropping the authenticated plugin', { timeout: 15_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'figma-bridge-reconnect-'));
  const pidFile = join(state, 'daemon.pid');
  const port = await freePort();
  const pluginKey = 'persistent-session-plugin-key';
  writeFileSync(join(state, 'plugin-key'), pluginKey, { mode: 0o600 });
  const env = {
    ...process.env,
    CONNECT_TIMEOUT_MS: '5000',
    DAEMON_PORT_RANGE: String(port),
    DAEMON_PORT_FILE: join(state, 'daemon-port'),
    DAEMON_PID_FILE: pidFile,
    DAEMON_TOKEN_FILE: join(state, '.daemon-token'),
    PLUGIN_KEY_FILE: join(state, 'plugin-key'),
    REST_TOKEN_FILE: join(state, 'rest-token'),
    AUDIT_LOG_PATH: join(state, 'audit.log'),
    PLUGIN_INSTALL_DIR: join(state, 'plugin'),
  };
  let ws = null;

  try {
    await invokeConnect(env);
    const firstPid = Number(readFileSync(pidFile, 'utf8').trim());
    ws = await waitForAuthenticatedPlugin(port, pluginKey);

    const closed = new Promise((resolve) => ws.once('close', () => resolve(true)));
    await invokeConnect(env);
    const disconnected = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);

    assert.equal(disconnected, false, 'a new session must not close the existing plugin socket');
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(Number(readFileSync(pidFile, 'utf8').trim()), firstPid, 'healthy daemon PID must be reused');

    await invokeConnect(env, { forceRestart: true });
    assert.equal(
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
      ]),
      true,
      'explicit pairing rotation must still close the old-key socket',
    );
    assert.notEqual(Number(readFileSync(pidFile, 'utf8').trim()), firstPid, 'forced restart must replace the daemon');
  } finally {
    try { ws?.close(); } catch {}
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
    rmSync(state, { recursive: true, force: true });
  }
});

test('figma_connect replaces an older detached daemon build exactly once', { timeout: 15_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'figma-bridge-upgrade-'));
  const port = await freePort();
  const tokenFile = join(state, '.daemon-token');
  const pidFile = join(state, 'daemon.pid');
  writeFileSync(tokenFile, 'old-daemon-token', { mode: 0o600 });
  writeFileSync(join(state, 'plugin-key'), 'upgrade-plugin-key', { mode: 0o600 });
  const env = {
    ...process.env,
    CONNECT_TIMEOUT_MS: '5000',
    DAEMON_PORT_RANGE: String(port),
    DAEMON_PORT_FILE: join(state, 'daemon-port'),
    DAEMON_PID_FILE: pidFile,
    DAEMON_TOKEN_FILE: tokenFile,
    PLUGIN_KEY_FILE: join(state, 'plugin-key'),
    REST_TOKEN_FILE: join(state, 'rest-token'),
    AUDIT_LOG_PATH: join(state, 'audit.log'),
    PLUGIN_INSTALL_DIR: join(state, 'plugin'),
    DAEMON_IDLE_TIMEOUT: '600000',
  };
  const old = spawn(process.execPath, [DAEMON], {
    env: {
      ...env,
      DAEMON_PORT: String(port),
      DAEMON_BRIDGE_BUILD_VERSION: 'older-test-build',
    },
    stdio: 'ignore',
  });
  try {
    const before = await waitForHealth(port, tokenFile);
    assert.equal(before.bridgeBuildVersion, 'older-test-build');
    const oldPid = Number(readFileSync(pidFile, 'utf8').trim());

    const result = await invokeConnect(env);
    assert.match(result.stdout, /Daemon upgraded in Safe Mode/);
    const after = await waitForHealth(port, tokenFile);
    assert.equal(after.bridgeBuildVersion, PLUGIN_BUILD_VERSION);
    assert.notEqual(Number(readFileSync(pidFile, 'utf8').trim()), oldPid);
  } finally {
    try { old.kill('SIGKILL'); } catch {}
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 1) {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
    rmSync(state, { recursive: true, force: true });
  }
});

test('figma_connect fails loudly when no daemon can bind', { timeout: 15_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'figma-bridge-connect-failure-'));
  const port = await freePort();
  const blockerSockets = new Set();
  const blocker = createServer((socket) => {
    blockerSockets.add(socket);
    socket.once('close', () => blockerSockets.delete(socket));
    socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
  writeFileSync(join(state, 'plugin-key'), 'connect-failure-plugin-key', { mode: 0o600 });

  try {
    await assert.rejects(
      invokeConnect({
        ...process.env,
        CONNECT_TIMEOUT_MS: '5000',
        DAEMON_PORT_RANGE: String(port),
        DAEMON_PORT_FILE: join(state, 'daemon-port'),
        DAEMON_PID_FILE: join(state, 'daemon.pid'),
        DAEMON_TOKEN_FILE: join(state, '.daemon-token'),
        PLUGIN_KEY_FILE: join(state, 'plugin-key'),
        REST_TOKEN_FILE: join(state, 'rest-token'),
        AUDIT_LOG_PATH: join(state, 'audit.log'),
        PLUGIN_INSTALL_DIR: join(state, 'plugin'),
      }),
      /connect failed|Daemon failed to start/,
    );
  } finally {
    for (const socket of blockerSockets) socket.destroy();
    await new Promise((resolve) => blocker.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});
