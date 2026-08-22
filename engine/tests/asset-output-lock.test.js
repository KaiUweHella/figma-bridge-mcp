import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ASSET_OUTPUT_LOCK_DIRECTORY,
  withAssetOutputLock,
} from '../src/lib/asset-output-lock.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'asset-output-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, output: join(root, 'assets'), io: createWorkspaceIO({ root }) };
}

test('one output directory serializes concurrent publication transactions', async (t) => {
  const { output, io } = fixture(t);
  const events = [];
  let releaseFirst;
  const first = withAssetOutputLock(output, { io }, async () => {
    events.push('first:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push('first:end');
  });
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  const second = withAssetOutputLock(output, { io }, async () => {
    events.push('second:start');
    events.push('second:end');
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('a dead owner is recovered before the transaction starts', async (t) => {
  const { output, io } = fixture(t);
  const canonical = io.ensureDirectory(output, { role: 'asset-export-directory' });
  const lock = join(canonical, ASSET_OUTPUT_LOCK_DIRECTORY);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({
    token: 'orphan', pid: 2147483647, startedAt: 0,
  }));
  let ran = false;
  await withAssetOutputLock(output, { io }, async () => { ran = true; });
  assert.equal(ran, true);
});

test('acquisition revalidates the new lock and owner after a parent symlink swap', async (t) => {
  const { root, output } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'asset-output-lock-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideLock = join(outside, 'redirected-lock');
  mkdirSync(outsideLock);

  const baseIO = createWorkspaceIO({ root });
  let swapped = false;
  const io = {
    ...baseIO,
    ensureDirectory(input, options) {
      const canonical = baseIO.ensureDirectory(input, options);
      if (input.endsWith(ASSET_OUTPUT_LOCK_DIRECTORY) && !swapped) {
        swapped = true;
        renameSync(input, join(dirname(input), 'parked-lock'));
        symlinkSync(outsideLock, input, 'dir');
      }
      return canonical;
    },
  };

  let ran = false;
  await assert.rejects(
    withAssetOutputLock(output, { io }, async () => { ran = true; }),
    (error) => error.kind === 'workspace-policy',
  );
  assert.equal(swapped, true);
  assert.equal(ran, false);
  assert.equal(existsSync(join(outsideLock, 'owner.json')), false);
});

test('two recoverers tolerate the stale lock disappearing after inspection', async (t) => {
  const { output, io } = fixture(t);
  const canonical = io.ensureDirectory(output, { role: 'asset-export-directory' });
  const lock = join(canonical, ASSET_OUTPUT_LOCK_DIRECTORY);
  mkdirSync(lock);
  const lockMtime = statSync(lock).mtimeMs;
  let raced = false;
  let ran = false;

  await withAssetOutputLock(output, {
    io,
    now: () => {
      if (!raced) {
        raced = true;
        rmSync(lock, { recursive: true });
      }
      return lockMtime + 10_000;
    },
  }, async () => { ran = true; });

  assert.equal(raced, true);
  assert.equal(ran, true);
});

test('a delayed stale recoverer cannot remove a newly acquired owner', async (t) => {
  const { output, io } = fixture(t);
  const canonical = io.ensureDirectory(output, { role: 'asset-export-directory' });
  const lock = join(canonical, ASSET_OUTPUT_LOCK_DIRECTORY);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({
    token: 'shared-stale-owner', pid: 2147483647, startedAt: 0,
  }));

  let recoverers = 0;
  let releaseRecovery;
  const recoveryBarrier = new Promise((resolve) => { releaseRecovery = resolve; });
  const testHooks = {
    async beforeRecover() {
      recoverers++;
      if (recoverers === 2) releaseRecovery();
      await recoveryBarrier;
    },
  };
  let running = 0;
  let maximumRunning = 0;
  let releaseFirst;
  const operation = async () => {
    running++;
    maximumRunning = Math.max(maximumRunning, running);
    if (!releaseFirst) await new Promise((resolve) => { releaseFirst = resolve; });
    running--;
  };
  const options = {
    io,
    testHooks,
    wait: () => new Promise((resolve) => setImmediate(resolve)),
  };
  const first = withAssetOutputLock(output, options, operation);
  const second = withAssetOutputLock(output, options, operation);

  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumRunning, 1, 'only the new owner may publish while the delayed recovery resumes');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maximumRunning, 1);
});

for (const [label, initialOwner] of [
  ['empty', ''],
  ['partial', '{"token":'],
]) {
  test(`a fresh ${label} owner is creation-in-progress rather than a policy failure`, async (t) => {
    const { output, io } = fixture(t);
    const canonical = io.ensureDirectory(output, { role: 'asset-export-directory' });
    const lock = join(canonical, ASSET_OUTPUT_LOCK_DIRECTORY);
    const owner = join(lock, 'owner.json');
    mkdirSync(lock);
    writeFileSync(owner, initialOwner);
    const lockMtime = statSync(lock).mtimeMs;
    let waits = 0;
    let ran = false;

    await withAssetOutputLock(output, {
      io,
      now: () => lockMtime + 100,
      wait: async () => {
        waits++;
        writeFileSync(owner, JSON.stringify({
          token: 'finished-orphan', pid: 2147483647, startedAt: lockMtime,
        }));
      },
    }, async () => { ran = true; });

    assert.equal(waits, 1);
    assert.equal(ran, true);
  });
}

test('stale invalid owner metadata remains fail-closed', async (t) => {
  const { output, io } = fixture(t);
  const canonical = io.ensureDirectory(output, { role: 'asset-export-directory' });
  const lock = join(canonical, ASSET_OUTPUT_LOCK_DIRECTORY);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), '{"token":');
  const lockMtime = statSync(lock).mtimeMs;
  let ran = false;

  await assert.rejects(
    withAssetOutputLock(output, { io, now: () => lockMtime + 10_000 }, async () => { ran = true; }),
    (error) => error.kind === 'workspace-policy',
  );
  assert.equal(ran, false);
});

test('orphan recovery rejects unexpected lock entries without running the transaction', async (t) => {
  const { output, io } = fixture(t);
  const canonical = io.ensureDirectory(output, { role: 'asset-export-directory' });
  const lock = join(canonical, ASSET_OUTPUT_LOCK_DIRECTORY);
  mkdirSync(lock);
  writeFileSync(join(lock, 'unexpected'), 'reserved lock directory');
  const lockMtime = statSync(lock).mtimeMs;
  let ran = false;

  await assert.rejects(
    withAssetOutputLock(output, { io, now: () => lockMtime + 10_000 }, async () => { ran = true; }),
    (error) => error.kind === 'workspace-policy' && /unexpected recovery entry/.test(error.message),
  );
  assert.equal(ran, false);
});

test('orphan recovery bounds recovery-claim enumeration', async (t) => {
  const { output, io } = fixture(t);
  const canonical = io.ensureDirectory(output, { role: 'asset-export-directory' });
  const lock = join(canonical, ASSET_OUTPUT_LOCK_DIRECTORY);
  mkdirSync(lock);
  for (let index = 0; index < 17; index++) {
    const suffix = index.toString(16).padStart(12, '0');
    writeFileSync(
      join(lock, `.figma-bridge-recovery-00000000-0000-4000-8000-${suffix}.json`),
      '{}',
    );
  }
  const lockMtime = statSync(lock).mtimeMs;
  let ran = false;

  await assert.rejects(
    withAssetOutputLock(output, { io, now: () => lockMtime + 10_000 }, async () => { ran = true; }),
    (error) => error.kind === 'workspace-policy' && /too many recovery claims/.test(error.message),
  );
  assert.equal(ran, false);
});

test('owner metadata symlinks cannot escape the bounded WorkspaceIO read', async (t) => {
  const { output, io } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'asset-output-lock-owner-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const externalOwner = join(outside, 'owner.json');
  writeFileSync(externalOwner, JSON.stringify({
    token: 'outside', pid: 2147483647, startedAt: 0,
  }));
  const canonical = io.ensureDirectory(output, { role: 'asset-export-directory' });
  const lock = join(canonical, ASSET_OUTPUT_LOCK_DIRECTORY);
  mkdirSync(lock);
  symlinkSync(externalOwner, join(lock, 'owner.json'));
  let ran = false;

  await assert.rejects(
    withAssetOutputLock(output, { io }, async () => { ran = true; }),
    (error) => error.kind === 'workspace-policy',
  );
  assert.equal(ran, false);
  assert.equal(existsSync(externalOwner), true);
});

test('lock waiting observes the Command Plan deadline', async (t) => {
  const { output, io } = fixture(t);
  let releaseFirst;
  const first = withAssetOutputLock(output, { io }, () =>
    new Promise((resolve) => { releaseFirst = resolve; }));
  while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    withAssetOutputLock(output, { io, remainingMs: () => 0 }, async () => {}),
    (error) => error.kind === 'timeout',
  );
  releaseFirst();
  await first;
});
