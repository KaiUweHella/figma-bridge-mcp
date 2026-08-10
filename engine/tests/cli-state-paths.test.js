import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = join(HERE, '..');

test('CLI and daemon honor the same isolated token and PID paths', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'daemon-token');
  const pidFile = join(dir, 'daemon.pid');
  const script = [
    "import('./src/lib/cli-core.js').then((m) =>",
    "  console.log(JSON.stringify({ token: m.DAEMON_TOKEN_FILE, pid: m.DAEMON_PID_FILE })))",
  ].join(' ');

  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ENGINE_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DAEMON_TOKEN_FILE: tokenFile,
      DAEMON_PID_FILE: pidFile,
    },
  });

  assert.deepEqual(JSON.parse(output), { token: tokenFile, pid: pidFile });
});
