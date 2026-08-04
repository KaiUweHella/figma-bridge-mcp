// The plugin and the daemon agree on three things that live in three different
// files and are enforced by two different systems:
//
//   engine/src/lib/daemon-port.js  PORT_RANGE   — where the daemon may bind
//   plugin/ui.html                 PORTS        — where the panel scans
//   plugin/manifest.json           allowedDomains — what Figma will PERMIT
//
// The manifest is the hard one: Figma enforces it, so a port the daemon binds
// but the manifest omits is simply unreachable — and the symptom is an endless
// "Scanning…", not an error anyone can act on. Nothing at runtime notices the
// mismatch, so it is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_RANGE, DEFAULT_PORT } from '../engine/src/lib/daemon-port.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', 'manifest.json'), 'utf8'));
const UI = readFileSync(join(ROOT, 'plugin', 'ui.html'), 'utf8');

function uiPorts() {
  const m = UI.match(/const PORTS = \[([^\]]+)\]/);
  assert.ok(m, 'ui.html must declare a PORTS array');
  return m[1].split(',').map((s) => parseInt(s.trim(), 10));
}

test('the panel scans exactly the ports the daemon may bind', () => {
  assert.deepEqual(uiPorts(), [...PORT_RANGE]);
  assert.equal(PORT_RANGE[0], DEFAULT_PORT, 'the default port must lead the range');
});

test('the manifest permits every port in the range and nothing beyond loopback', () => {
  for (const list of [
    manifest.networkAccess.allowedDomains,
    manifest.networkAccess.devAllowedDomains,
  ]) {
    assert.ok(Array.isArray(list), 'both allowedDomains lists must exist');
    for (const port of PORT_RANGE) {
      assert.ok(
        list.includes(`ws://localhost:${port}`),
        `manifest is missing ws://localhost:${port} — the daemon could bind a port Figma blocks`,
      );
    }
    // The whole security claim of the manifest is that the plugin cannot reach
    // anything but our loopback daemon. A wildcard or any external host here
    // would silently reopen exfiltration.
    for (const entry of list) {
      assert.match(
        entry,
        /^ws:\/\/localhost(:\d+)?$/,
        `manifest entry "${entry}" is not a loopback WebSocket origin`,
      );
    }
  }
});

test('the manifest keeps the plugin scoped to Figma design files', () => {
  assert.deepEqual(manifest.editorType, ['figma']);
  assert.equal(manifest.documentAccess, 'dynamic-page');
  assert.equal(manifest.enableProposedApi, false);
  assert.equal(manifest.main, 'code.js');
  assert.equal(manifest.ui, 'ui.html');
});
