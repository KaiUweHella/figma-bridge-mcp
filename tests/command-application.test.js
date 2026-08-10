// In-process command execution keeps the same security/audit Interface as the
// legacy child-process adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'figma-command-application-'));
const auditFile = join(dir, 'audit.log');
process.env.AUDIT_LOG_PATH = auditFile;

test('in-process command uses one allowlist, targeting and audit lifecycle', async () => {
  const { runInProcessCommand } = await import('../src/engine.js');
  let context;
  const result = await runInProcessCommand(
    ['export', 'code-spec', '12:34'],
    { fileKey: 'FILE_A', label: 'direct spec' },
    async (value) => {
      context = value;
      return { stdout: 'result', stderr: 'notice' };
    },
  );
  assert.deepEqual(result, { stdout: 'result', stderr: 'notice', code: 0 });
  assert.equal(context.fileKey, 'FILE_A');
  assert.ok(context.deadline > Date.now());

  const entries = readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].args, ['export', 'code-spec', '12:34']);
  assert.deepEqual(entries[0].nodes, ['12:34']);
  assert.equal(entries[0].fileKey, 'FILE_A');
  assert.equal(entries[0].label, 'direct spec');
  assert.deepEqual(entries[1], {
    id: entries[0].id,
    ts: entries[1].ts,
    event: 'done',
    ok: true,
  });
});

test('in-process command refuses commands outside the existing allowlist before execution', async () => {
  const { runInProcessCommand } = await import('../src/engine.js');
  let called = false;
  await assert.rejects(
    () => runInProcessCommand(['connect', '--safe'], {}, async () => { called = true; }),
    /Command not allowed/,
  );
  assert.equal(called, false);
});

test('in-process execution never repeats an ambiguous daemon failure by default', async () => {
  const { runInProcessCommand } = await import('../src/engine.js');
  const { DaemonClientError } = await import('../engine/src/lib/daemon-client.js');
  let attempts = 0;
  await assert.rejects(
    () => runInProcessCommand(['node', 'tree', '12:34'], {}, async () => {
      attempts++;
      throw new DaemonClientError('connection dropped', { kind: 'unavailable' });
    }),
    /connection dropped/,
  );
  assert.equal(attempts, 1);
});
