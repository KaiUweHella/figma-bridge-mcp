import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Figma reloads a development plugin in every window whenever its files change
// on disk, and `connect` runs at every MCP server start. A copy that rewrites
// identical bytes therefore reloads the plugin -- and kills any eval in flight
// -- on every server start. The bundle must only be written when it changed.
test('installing the plugin bundle twice does not rewrite identical files', async (t) => {
  const dest = mkdtempSync(join(tmpdir(), 'plugin-bundle-copy-'));
  t.after(() => rmSync(dest, { recursive: true, force: true }));
  process.env.PLUGIN_INSTALL_DIR = dest;
  t.after(() => { delete process.env.PLUGIN_INSTALL_DIR; });
  const { installPluginFiles } = await import('../src/commands/setup.js');

  installPluginFiles();
  const code = join(dest, 'code.js');
  const past = new Date(Date.now() - 60_000);
  utimesSync(code, past, past);
  const before = statSync(code).mtimeMs;

  installPluginFiles();
  assert.equal(statSync(code).mtimeMs, before, 'identical bytes must not be rewritten');

  writeFileSync(code, 'tampered');
  installPluginFiles();
  assert.notEqual(readFileSync(code, 'utf8'), 'tampered', 'changed bytes are restored');
});
