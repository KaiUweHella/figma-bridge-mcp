// MCP-layer tests: allowlist enforcement, engine-entry resolution, key pairing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the pairing key file so tests never touch the user's real
// ~/.figma-safe-mcp/plugin-key. Must be set BEFORE importing config.js/pairing.js.
process.env.PLUGIN_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'figma-safe-key-')), 'plugin-key');

test('buildArgv resolves to the vendored engine entry with the current node', async () => {
  const { buildArgv, ENGINE_ENTRY } = await import('../src/config.js');
  const { cmd, argv } = buildArgv(['canvas', 'info']);
  assert.equal(cmd, process.execPath);
  assert.equal(argv[0], ENGINE_ENTRY);
  assert.deepEqual(argv.slice(1), ['canvas', 'info']);
  assert.ok(existsSync(ENGINE_ENTRY), 'engine entry file must exist');
});

test('connect is NOT in the command allowlist (Yolo unreachable via figma_run)', async () => {
  const { ALLOWED_COMMANDS, runCli } = await import('../src/figma-cli.js');
  assert.equal(ALLOWED_COMMANDS.has('connect'), false);
  await assert.rejects(() => runCli(['connect', '--safe']), /Command not allowed: connect/);
});

test('runCli rejects non-array / empty / non-string args', async () => {
  const { runCli } = await import('../src/figma-cli.js');
  await assert.rejects(() => runCli([]), /non-empty array/);
  await assert.rejects(() => runCli('canvas'), /non-empty array/);
  await assert.rejects(() => runCli([123]), /must be strings/);
});

test('pairing: ensureKey persists a stable base64url key, rotate changes it', async () => {
  const { ensureKey, readKey, rotateKey } = await import('../src/pairing.js');
  const first = ensureKey();
  assert.equal(typeof first.key, 'string');
  assert.match(first.key, /^[A-Za-z0-9_-]+$/); // base64url alphabet
  assert.equal(readKey(), first.key);

  const second = ensureKey();
  assert.equal(second.created, false);
  assert.equal(second.key, first.key); // stable across calls

  const rotated = rotateKey();
  assert.notEqual(rotated, first.key);
  assert.equal(readKey(), rotated);
});
