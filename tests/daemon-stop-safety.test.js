import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HAS_LSOF = process.platform !== 'win32' && !spawnSync('lsof', ['-v']).error;

function waitForLine(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('child did not become ready')), timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const line = output.split('\n').find(Boolean);
      if (!line) return;
      clearTimeout(timer);
      resolve(line.trim());
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`child exited early (${code})`)));
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopFromIsolatedCli(state, port) {
  const script = `
    const { stopDaemon } = await import('./engine/src/lib/cli-core.js');
    stopDaemon();
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: {
      ...process.env,
      DAEMON_PID_FILE: join(state, 'daemon.pid'),
      DAEMON_PORT_FILE: join(state, 'daemon-port'),
      DAEMON_PORT_RANGE: String(port),
      DAEMON_TOKEN_FILE: join(state, 'token'),
      PLUGIN_KEY_FILE: join(state, 'key'),
    },
    timeout: 5000,
  });
}

test('stopDaemon never signals a stale/reused PID that does not own the daemon listener', {
  skip: !HAS_LSOF,
}, async () => {
  const state = mkdtempSync(join(tmpdir(), 'figma-bridge-stop-stale-pid-'));
  const unrelated = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    await waitForLine(unrelated);
    const unusedPort = 49151;
    writeFileSync(join(state, 'daemon.pid'), String(unrelated.pid));
    writeFileSync(join(state, 'daemon-port'), String(unusedPort));

    await stopFromIsolatedCli(state, unusedPort);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(isAlive(unrelated.pid), true,
      'a stale daemon.pid must never let the bridge terminate an unrelated process');
  } finally {
    try { unrelated.kill('SIGKILL'); } catch {}
    rmSync(state, { recursive: true, force: true });
  }
});

test('stopDaemon force-kills only its verified hung listener and leaves connected clients alive', {
  skip: !HAS_LSOF,
}, async () => {
  const state = mkdtempSync(join(tmpdir(), 'figma-bridge-stop-owned-pid-'));
  const listener = spawn(process.execPath, ['-e', `
    const net = require('net');
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    process.on('SIGTERM', () => {});
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let client = null;
  try {
    const port = Number(await waitForLine(listener));
    assert.ok(Number.isInteger(port) && port > 0);
    client = spawn(process.execPath, ['-e', `
      const net = require('net');
      const socket = net.connect(${port}, '127.0.0.1', () => console.log('connected'));
      socket.on('error', () => {});
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'ignore'] });
    await waitForLine(client);

    writeFileSync(join(state, 'daemon.pid'), String(listener.pid));
    writeFileSync(join(state, 'daemon-port'), String(port));
    await stopFromIsolatedCli(state, port);
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(isAlive(listener.pid), false,
      'a verified daemon listener that ignores SIGTERM must not keep the port forever');
    assert.equal(isAlive(client.pid), true,
      'port cleanup must not kill Figma or any other connected client process');
  } finally {
    try { listener.kill('SIGKILL'); } catch {}
    try { client?.kill('SIGKILL'); } catch {}
    rmSync(state, { recursive: true, force: true });
  }
});
