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
process.env.PLUGIN_KEY_FILE = join(dir, 'plugin-key');
process.env.DAEMON_TOKEN_FILE = join(dir, 'daemon-token');
process.env.DAEMON_PORT_FILE = join(dir, 'daemon-port');
process.env.DAEMON_PID_FILE = join(dir, 'daemon.pid');

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
  assert.deepEqual(result, { stdout: 'result', stderr: 'notice', code: 0, audit: { status: 'healthy' } });
  assert.equal(context.fileKey, 'FILE_A');
  assert.ok(context.deadline > Date.now());

  const entries = readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].schema, 5);
  assert.equal(entries[0].event, 'start');
  assert.equal(entries[0].capability, 'export.code-spec');
  assert.equal(entries[0].operation, 'read');
  assert.equal(entries[0].target.kind, 'plugin-file');
  assert.equal(entries[0].data.arguments.count, 3);
  assert.equal(entries[0].data.nodeRefs.length, 1);
  assert.equal(entries[0].data.label.bytes, Buffer.byteLength('direct spec'));
  const serialized = JSON.stringify(entries.map(({ ts, ...entry }) => entry));
  assert.doesNotMatch(serialized, /12:34|FILE_A|direct spec/);
  assert.deepEqual(entries[1], {
    schema: 5,
    id: entries[0].id,
    ts: entries[1].ts,
    event: 'done',
    outcome: {
      ok: true,
      durationMs: entries[1].outcome.durationMs,
      code: 0,
    },
  });
});

test('a pre-resolved Command Plan preserves its registry target through the Command Application', async () => {
  const { runInProcessCommandPlan } = await import('../src/engine.js');
  const { planFigmaCommand } = await import('../src/capability-catalog.js');
  const plan = planFigmaCommand(['link', 'context', 'screen.settings'], {
    registryFileKey: () => 'REGISTRYPLACEHOLDERKEY',
  });
  let applicationContext;
  const result = await runInProcessCommandPlan(plan, { label: 'registry target' }, async (context) => {
    applicationContext = context;
    return { stdout: 'registry result', stderr: '' };
  });

  assert.equal(result.stdout, 'registry result');
  assert.equal(applicationContext.plan, plan);
  assert.equal(applicationContext.target, plan.target);
  assert.equal(applicationContext.fileKey, 'REGISTRYPLACEHOLDERKEY');
  assert.equal(applicationContext.target.source, 'design-link-registry');

  await assert.rejects(
    () => runInProcessCommandPlan({ ...plan }, {}, async () => ({ stdout: '', stderr: '' })),
    /requires a Command Plan created by the Capability Catalog/,
  );
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

test('in-process command denies unknown nested actions before audit or Adapter dispatch', async () => {
  const { runInProcessCommand } = await import('../src/engine.js');
  const before = readFileSync(auditFile, 'utf8');
  let called = false;
  await assert.rejects(
    () => runInProcessCommand(['node', 'future-action', 'private-value'], {}, async () => { called = true; }),
    /Command not allowed/,
  );
  assert.equal(called, false);
  assert.equal(readFileSync(auditFile, 'utf8'), before, 'denial must happen before the Audit Trail');
});

test('in-process mutation never repeats an outcome-unknown daemon failure', async () => {
  const { runInProcessCommand } = await import('../src/engine.js');
  const { DaemonClientError } = await import('../engine/src/lib/daemon-client.js');
  let attempts = 0;
  await assert.rejects(
    () => runInProcessCommand(['node', 'set-fill', '12:34', '#ffffff'], {}, async () => {
      attempts++;
      throw new DaemonClientError('connection dropped', {
        kind: 'unavailable',
        phase: 'daemon-request',
        outcome: 'unknown-after-dispatch',
      });
    }),
    /connection dropped/,
  );
  assert.equal(attempts, 1);
});

test('in-process safe reads retry one normalized plugin disconnect internally', async () => {
  const { runInProcessCommand } = await import('../src/engine.js');
  const { DaemonClientError } = await import('../engine/src/lib/daemon-client.js');
  let attempts = 0;
  let waits = 0;
  const result = await runInProcessCommand(
    ['export', 'code-spec', '12:34'],
    { waitUntilReady: async () => { waits++; return true; } },
    async () => {
      attempts++;
      if (attempts === 1) {
        throw new DaemonClientError('Plugin disconnected', { kind: 'plugin-unavailable' });
      }
      return { stdout: 'reconnected', stderr: '' };
    },
  );
  assert.equal(result.stdout, 'reconnected');
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test('migrated link inspect retries the same Implementation without Commander fallback', async () => {
  const { runInProcessCommandPlan } = await import('../src/engine.js');
  const { planFigmaCommand } = await import('../src/capability-catalog.js');
  const { DaemonClientError } = await import('../engine/src/lib/daemon-client.js');
  const plan = planFigmaCommand(['link', 'inspect', '1:2'], { fileKey: 'FILE_A' });
  let attempts = 0;
  let waits = 0;
  await assert.rejects(
    () => runInProcessCommandPlan(
      plan,
      {
        compatibilityFallback: false,
        waitUntilReady: async () => { waits++; return true; },
      },
      async () => {
        attempts++;
        throw new DaemonClientError('Plugin unavailable', { kind: 'plugin-unavailable' });
      },
    ),
    /Plugin unavailable/,
  );
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test('migrated link set has one attempt and no retry policy', async () => {
  const { runInProcessCommandPlan } = await import('../src/engine.js');
  const { planFigmaCommand } = await import('../src/capability-catalog.js');
  const { DaemonClientError } = await import('../engine/src/lib/daemon-client.js');
  const plan = planFigmaCommand(['link', 'set', '1:2', 'ui.button'], { fileKey: 'FILE_A' });
  let attempts = 0;
  await assert.rejects(
    () => runInProcessCommandPlan(plan, { compatibilityFallback: false }, async () => {
      attempts++;
      throw new DaemonClientError('Write outcome unknown', {
        kind: 'unavailable', outcome: 'unknown-after-dispatch',
      });
    }),
    /Write outcome unknown/,
  );
  assert.equal(plan.execution.retry, 'never');
  assert.equal(attempts, 1);
});

test('in-process results preserve only Command Plan-accepted domain outcome codes', async () => {
  const { runInProcessCommandPlan } = await import('../src/engine.js');
  const { planFigmaCommand } = await import('../src/capability-catalog.js');
  const plan = planFigmaCommand(['contract', 'check', 'ui.button'], { fileKey: 'FILE_A' });
  const drift = await runInProcessCommandPlan(plan, { compatibilityFallback: false }, async () => ({
    stdout: 'canonical drift', stderr: '', code: 1,
  }));
  assert.equal(drift.code, 1);
  assert.equal(drift.stdout, 'canonical drift');

  await assert.rejects(
    () => runInProcessCommandPlan(plan, { compatibilityFallback: false }, async () => ({
      stdout: '', stderr: '', code: 2,
    })),
    /unsupported outcome code 2/,
  );
});

test('Semantic Render findings project the same Outcome into process and Audit codes', async () => {
  const { runInProcessCommandPlan } = await import('../src/engine.js');
  const { planFigmaCommand } = await import('../src/capability-catalog.js');
  const { createWorkspaceIO } = await import('../engine/src/lib/workspace-io.js');
  const {
    projectSemanticRenderOutcome,
    semanticRenderOutcomeCode,
  } = await import('../engine/src/lib/semantic-render-outcome.js');
  const io = createWorkspaceIO({ root: dir });
  const plan = planFigmaCommand(['render', '<Frame name="Audit" />'], {
    fileKey: 'FILE_A', workspaceDir: dir, workspaceIO: io,
  });
  const outcome = projectSemanticRenderOutcome({
    id: '7:8',
    name: 'Audit',
    executor: 'structured-v1',
    structuralReport: {
      version: 1,
      passed: false,
      summary: {
        nodes: 1, grids: 0, autoLayouts: 0, freeLayouts: 1,
        instances: 0, absoluteNodes: 0,
      },
      mismatchCount: 1,
      mismatches: [{ path: 'root', fact: 'layout', expected: 'AUTO_LAYOUT', actual: 'FREE' }],
    },
    mutationOutcome: 'completed',
    mutationReport: {
      version: 1, outcome: 'completed', created: 1, removed: 0,
      residueCount: 0, residue: [], residueTruncated: false,
    },
  }, {
    executor: 'structured-v1',
    structure: { grid: 0, flex: 0, free: 1, absolute: 0 },
  });

  const result = await runInProcessCommandPlan(
    plan,
    { compatibilityFallback: false },
    async () => ({ stdout: 'finding', stderr: '', code: semanticRenderOutcomeCode(outcome) }),
  );
  assert.equal(outcome.status, 'completed-with-findings');
  assert.equal(result.code, 1);
  const entries = readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.at(-1).outcome, {
    ok: true,
    durationMs: entries.at(-1).outcome.durationMs,
    code: 1,
  });
});

test('callers cannot replace timeout, target, or accepted outcomes after planning', async () => {
  const { runCliPlan, runInProcessCommand, runInProcessCommandPlan } = await import('../src/engine.js');
  const { planFigmaCommand } = await import('../src/capability-catalog.js');
  const plan = planFigmaCommand(['contract', 'check', 'ui.button'], { fileKey: 'FILE_A' });
  let called = false;
  for (const override of [
    { timeoutMs: 1 },
    { okExitCodes: [0, 2] },
    { fileKey: 'FILE_B' },
    { registryFileKey: 'FILE_B' },
  ]) {
    await assert.rejects(
      () => runInProcessCommandPlan(plan, override, async () => { called = true; }),
      /Command Capability owns .*after planning/,
    );
  }
  await assert.rejects(
    () => runCliPlan(plan, { okExitCodes: [0, 2] }),
    /Command Capability owns okExitCodes; callers may not override it after planning/,
  );
  await assert.rejects(
    () => runInProcessCommand(['inspect', '1:2'], { timeoutMs: 1 }, async () => { called = true; }),
    /Command Capability owns timeoutMs/,
  );
  await assert.rejects(
    () => runInProcessCommand(['inspect', '1:2'], { okExitCodes: [0, 2] }, async () => { called = true; }),
    /Command Capability owns okExitCodes/,
  );
  assert.equal(called, false);
});

test('safe-read retries share one decreasing deadline budget', async () => {
  const { runInProcessCommand } = await import('../src/engine.js');
  const { DaemonClientError } = await import('../engine/src/lib/daemon-client.js');
  const contexts = [];
  await runInProcessCommand(
    ['export', 'code-spec', '12:34'],
    { waitUntilReady: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return true;
    } },
    async (context) => {
      contexts.push(context);
      if (contexts.length === 1) throw new DaemonClientError('disconnected', { kind: 'plugin-unavailable' });
      return { stdout: 'ok', stderr: '' };
    },
  );
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].deadline, contexts[1].deadline);
  assert.ok(contexts[1].timeoutMs < contexts[0].timeoutMs);
});

test('missing daemon token does not spend time in readiness wait', async () => {
  const { runInProcessCommand } = await import('../src/engine.js');
  const { DaemonClientError } = await import('../engine/src/lib/daemon-client.js');
  let waits = 0;
  await assert.rejects(
    () => runInProcessCommand(
      ['export', 'code-spec', '12:34'],
      {
        compatibilityFallback: false,
        waitUntilReady: async () => { waits++; return true; },
      },
      async () => { throw new DaemonClientError('token missing', { kind: 'missing-token' }); },
    ),
  );
  assert.equal(waits, 0);
});

test('read-only fallback recognizes daemon and plugin disconnect/timeout kinds', async () => {
  const { isDaemonUnavailable } = await import('../src/engine.js');
  const { DaemonClientError } = await import('../engine/src/lib/daemon-client.js');
  for (const kind of ['missing-token', 'unavailable', 'timeout', 'plugin-unavailable', 'plugin-timeout']) {
    assert.equal(isDaemonUnavailable(new DaemonClientError(kind, { kind })), true, kind);
  }
  assert.equal(isDaemonUnavailable(new DaemonClientError('write result unknown', { kind: 'response' })), false);
  assert.equal(isDaemonUnavailable(new Error('timeout')), false, 'only normalized bridge failures retry');
});
