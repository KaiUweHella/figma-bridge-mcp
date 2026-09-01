import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('starting an already configured MCP wakes its idle Bridge daemon end to end', {
  timeout: 15_000,
}, async () => {
  const state = mkdtempSync(join(tmpdir(), 'figma-bridge-mcp-startup-wake-'));
  const pidFile = join(state, 'daemon.pid');
  const portFile = join(state, 'daemon-port');
  const pluginKeyFile = join(state, 'plugin-key');
  const port = await freePort();
  writeFileSync(pluginKeyFile, 'startup-wake-plugin-key', { mode: 0o600 });
  // Idle auto-shutdown intentionally leaves this setup marker behind.
  writeFileSync(pidFile, '999999', { mode: 0o600 });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: state,
      USERPROFILE: state,
      CONNECT_TIMEOUT_MS: '5000',
      DAEMON_PORT_RANGE: String(port),
      DAEMON_PORT_FILE: portFile,
      DAEMON_PID_FILE: pidFile,
      DAEMON_TOKEN_FILE: join(state, '.daemon-token'),
      PLUGIN_KEY_FILE: pluginKeyFile,
      REST_TOKEN_FILE: join(state, 'rest-token'),
      AUDIT_LOG_PATH: join(state, 'audit.log'),
      PLUGIN_INSTALL_DIR: join(state, 'plugin'),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'startup-wake-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const daemonPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(daemonPid) && daemonPid > 1 && daemonPid !== 999999);
    process.kill(daemonPid, 0);
    assert.equal(Number(readFileSync(portFile, 'utf8').trim()), port);

    const discovery = await fetch(`http://127.0.0.1:${port}/plugin-ready`, {
      headers: { Origin: 'null' },
    });
    assert.equal(discovery.ok, true);
    assert.deepEqual(await discovery.json(), {
      bridge: 'figma-bridge-mcp', ready: true, port,
    });
  } finally {
    await client.close().catch(() => {});
    if (existsSync(pidFile)) {
      const daemonPid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(daemonPid) && daemonPid > 1 && daemonPid !== 999999) {
        try { process.kill(daemonPid, 'SIGTERM'); } catch {}
      }
    }
    rmSync(state, { recursive: true, force: true });
  }
});
