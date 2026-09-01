import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceIOError,
  createWorkspaceIO,
  parseBoundedJson,
  parseBoundedYaml,
} from '../engine/src/lib/workspace-io.js';
import { planFigmaCommand } from '../src/capability-catalog.js';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'figma-bridge-workspace-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside-private');
  const extra = join(base, 'extra-project');
  mkdirSync(workspace);
  mkdirSync(outside);
  mkdirSync(extra);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, workspace, outside, extra };
}

test('workspace I/O accepts the launch project and explicit extra roots only', (t) => {
  const { workspace, outside, extra } = fixture(t);
  writeFileSync(join(workspace, 'tokens.json'), '{"ok":true}');
  writeFileSync(join(extra, 'shared.json'), '{"shared":true}');
  writeFileSync(join(outside, 'secret.json'), '{"secret":true}');
  const io = createWorkspaceIO({ root: workspace, extraRoots: [extra] });

  assert.deepEqual(io.readJson(join(workspace, 'tokens.json')), { ok: true });
  assert.deepEqual(io.readJson(join(extra, 'shared.json')), { shared: true });
  assert.throws(
    () => io.readJson(join(workspace, '..', 'outside-private', 'secret.json'), { role: 'token-file' }),
    (error) => error instanceof WorkspaceIOError
      && error.role === 'token-file'
      && !error.message.includes(outside)
      && !error.message.includes('secret.json'),
  );
});

test('workspace I/O rejects absolute and symlink escapes but permits contained symlinks', (t) => {
  const { workspace, outside } = fixture(t);
  writeFileSync(join(outside, 'secret.txt'), 'private');
  mkdirSync(join(workspace, 'real'));
  writeFileSync(join(workspace, 'real', 'safe.txt'), 'safe');
  symlinkSync(outside, join(workspace, 'escape'));
  symlinkSync(join(workspace, 'real'), join(workspace, 'contained'));
  const io = createWorkspaceIO({ root: workspace });

  assert.equal(io.readText(join(workspace, 'contained', 'safe.txt')), 'safe');
  assert.throws(() => io.readText(join(outside, 'secret.txt')), WorkspaceIOError);
  assert.throws(() => io.readText(join(workspace, 'escape', 'secret.txt')), WorkspaceIOError);
  assert.throws(() => io.write(join(workspace, 'escape', 'leak.txt'), 'secret'), WorkspaceIOError);
});

test('workspace existence probes distinguish missing files from policy failures', (t) => {
  const { workspace, outside } = fixture(t);
  writeFileSync(join(workspace, 'present.txt'), 'safe');
  writeFileSync(join(outside, 'secret.txt'), 'private');
  symlinkSync(outside, join(workspace, 'escape'));
  const io = createWorkspaceIO({ root: workspace });

  assert.equal(io.exists(join(workspace, 'present.txt'), { role: 'asset-manifest', kind: 'file' }), true);
  assert.equal(io.exists(join(workspace, 'missing.txt'), { role: 'asset-manifest', kind: 'file' }), false);
  assert.equal(
    io.exists(join(workspace, 'missing-parent', 'missing.txt'), { role: 'asset-manifest', kind: 'file' }),
    false,
  );
  assert.throws(
    () => io.exists(join(workspace, 'escape', 'secret.txt'), { role: 'exported-asset', kind: 'file' }),
    WorkspaceIOError,
  );
  assert.throws(
    () => io.exists(join(workspace, 'escape', 'missing.txt'), { role: 'exported-asset', kind: 'file' }),
    WorkspaceIOError,
  );
  assert.throws(
    () => io.exists(join(outside, 'secret.txt'), { role: 'exported-asset', kind: 'file' }),
    WorkspaceIOError,
  );
});

test('secure output detects a parent swap before bytes can escape', (t) => {
  const { workspace, outside } = fixture(t);
  const outputDir = join(workspace, 'output');
  const movedDir = join(workspace, 'output-safe');
  mkdirSync(outputDir);
  writeFileSync(join(outside, 'result.txt'), 'outside-original');
  let swapped = false;
  const io = createWorkspaceIO({
    root: workspace,
    testHooks: {
      beforeWriteOpen() {
        if (swapped) return;
        swapped = true;
        renameSync(outputDir, movedDir);
        symlinkSync(outside, outputDir);
      },
    },
  });

  assert.throws(
    () => io.write(join(outputDir, 'result.txt'), 'sensitive-render-output'),
    /changed|outside|safely/,
  );
  assert.equal(readFileSync(join(outside, 'result.txt'), 'utf8'), 'outside-original');
});

test('atomic replacement preserves prior bytes and removes its stage when commit fails', (t) => {
  const { workspace } = fixture(t);
  const target = join(workspace, 'figma-tokens.lock.json');
  const prior = '{"version":1,"prior":true}\n';
  writeFileSync(target, prior);
  const io = createWorkspaceIO({
    root: workspace,
    testHooks: {
      beforeReplaceCommit() { throw new Error('injected pre-commit failure'); },
    },
  });

  assert.throws(
    () => io.replace(target, '{"version":1,"prior":false}\n', { role: 'token-lockfile' }),
    /atomic replacement failed/,
  );
  assert.equal(readFileSync(target, 'utf8'), prior);
  assert.deepEqual(readdirSync(workspace), ['figma-tokens.lock.json']);
});

test('atomic replacement validates its opened stage before any bytes cross a swapped parent', (t) => {
  const { workspace, outside } = fixture(t);
  const outputDir = join(workspace, 'output');
  const movedDir = join(workspace, 'output-safe');
  const target = join(outputDir, 'figma-tokens.lock.json');
  mkdirSync(outputDir);
  writeFileSync(target, 'prior\n');
  const io = createWorkspaceIO({
    root: workspace,
    testHooks: {
      beforeReplaceOpen() {
        renameSync(outputDir, movedDir);
        symlinkSync(outside, outputDir);
      },
    },
  });

  assert.throws(
    () => io.replace(target, 'sensitive-next-state\n', { role: 'token-lockfile' }),
    /outside|atomic replacement failed/,
  );
  assert.equal(readFileSync(join(movedDir, 'figma-tokens.lock.json'), 'utf8'), 'prior\n');
  assert.deepEqual(readdirSync(outside), []);
});

test('atomic replacement commits one complete sibling file', (t) => {
  const { workspace } = fixture(t);
  const target = join(workspace, 'figma-tokens.lock.json');
  writeFileSync(target, 'prior\n');
  const io = createWorkspaceIO({ root: workspace });

  assert.equal(io.replace(target, 'next\n', { role: 'token-lockfile' }), realpathSync.native(target));
  assert.equal(readFileSync(target, 'utf8'), 'next\n');
  assert.deepEqual(readdirSync(workspace), ['figma-tokens.lock.json']);
});

test('whole-file reads enforce byte limits before retaining content', (t) => {
  const { workspace } = fixture(t);
  const file = join(workspace, 'large.json');
  writeFileSync(file, '{"payload":"1234567890"}');
  const io = createWorkspaceIO({ root: workspace, limits: { jsonBytes: 12 } });
  assert.throws(
    () => io.readJson(file, { role: 'token-file' }),
    (error) => error.code === 'WORKSPACE_BYTE_LIMIT' && error.role === 'token-file',
  );
});

test('bounded structured parsers reject deep JSON and YAML alias amplification', () => {
  assert.throws(
    () => parseBoundedJson(`${'['.repeat(8)}0${']'.repeat(8)}`, {
      limits: { jsonBytes: 1024, nestingDepth: 4, collectionEntries: 100, yamlAliases: 5, textBytes: 1024 },
    }),
    (error) => error.code === 'WORKSPACE_PARSE_LIMIT',
  );
  const yaml = 'base: &base [one, two, three]\nexpanded: [*base, *base, *base, *base]\n';
  assert.throws(
    () => parseBoundedYaml(yaml, {
      limits: { jsonBytes: 1024, nestingDepth: 16, collectionEntries: 100, yamlAliases: 2, textBytes: 1024 },
    }),
    /Excessive alias count|aliases|alias/i,
  );
});

test('Command Capabilities enforce roles without disclosing rejected absolute paths', (t) => {
  const { workspace, outside, extra } = fixture(t);
  writeFileSync(join(workspace, 'capture.json'), '{"version":2}');
  writeFileSync(join(extra, 'tokens.json'), '{}');
  writeFileSync(join(outside, 'private.json'), '{}');
  const io = createWorkspaceIO({ root: workspace, extraRoots: [extra] });

  assert.equal(planFigmaCommand(['render', '--dom-capture', 'capture.json'], {
    workspaceDir: workspace,
    workspaceIO: io,
  }).allowed, true);
  assert.equal(planFigmaCommand(['tokens', 'sync', join(extra, 'tokens.json')], {
    workspaceDir: workspace,
    workspaceIO: io,
  }).effects.workspace, 'read');

  assert.throws(
    () => planFigmaCommand(['motion', 'apply', join(outside, 'private.json')], {
      workspaceDir: workspace,
      workspaceIO: io,
    }),
    (error) => error.role === 'motion-file'
      && !error.message.includes(outside)
      && !error.message.includes('private.json'),
  );
});
