import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
