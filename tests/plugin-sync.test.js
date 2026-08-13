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
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_RANGE, DEFAULT_PORT } from '../engine/src/lib/daemon-port.js';
import { DESIGN_ENTITY_PLUGIN_DATA_KEY } from '../engine/src/lib/design-link-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', 'manifest.json'), 'utf8'));
const UI = readFileSync(join(ROOT, 'plugin', 'ui.html'), 'utf8');
const PLUGIN_CODE = readFileSync(join(ROOT, 'plugin', 'code.js'), 'utf8');

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

test('the manifest keeps the plugin scoped to the editors we actually support', () => {
  // Every non-Design editor listed here has a guarded command group. "dev"
  // remains absent: an editorType we do not handle would offer a dead plugin.
  assert.deepEqual(manifest.editorType, ['figma', 'figjam', 'slides']);
  assert.equal(manifest.documentAccess, 'dynamic-page');
  assert.equal(manifest.enableProposedApi, false);
  assert.equal(manifest.main, 'code.js');
  assert.equal(manifest.ui, 'ui.html');
  assert.equal(manifest.id, 'figma-bridge-mcp');
});

test('Dev Mode exposes a connectable read-only Inspect adapter', () => {
  const devManifestPath = join(ROOT, 'plugin', 'manifest.dev.json');
  assert.ok(existsSync(devManifestPath), 'plugin/manifest.dev.json must ship for the connected Dev Mode workflow');
  const devManifest = JSON.parse(readFileSync(devManifestPath, 'utf8'));
  assert.deepEqual(devManifest.editorType, ['dev']);
  assert.deepEqual(devManifest.capabilities, ['inspect']);
  assert.equal(devManifest.main, 'code.js');
  assert.equal(devManifest.ui, 'ui.html');
  assert.equal(devManifest.id, 'figma-bridge-mcp-dev');
  assert.deepEqual(devManifest.networkAccess.allowedDomains, manifest.networkAccess.allowedDomains);
  assert.deepEqual(devManifest.networkAccess.devAllowedDomains, manifest.networkAccess.devAllowedDomains);
  assert.match(PLUGIN_CODE, /Figma Dev Mode is read-only\. Switch this file to Design mode/);
});

test('selection snapshots expose the shared Design Entity identity', () => {
  assert.match(PLUGIN_CODE, new RegExp(`DESIGN_ENTITY_STORAGE = '${DESIGN_ENTITY_PLUGIN_DATA_KEY}'`));
  assert.match(PLUGIN_CODE, /getPluginData\(DESIGN_ENTITY_STORAGE\)/);
  assert.match(PLUGIN_CODE, /entry\.entityId = link\.id/);
  assert.match(PLUGIN_CODE, /entry\.entityKind = link\.kind/);
});

test('Semantic Render Plans cross UI and main plugin threads without becoming code', () => {
  assert.match(UI, /msg\.action === 'render-plan'/);
  assert.match(UI, /type: 'render-plan', id: msg\.id, plan: msg\.plan/);
  assert.match(PLUGIN_CODE, /msg\.type === 'render-plan'/);
  assert.match(PLUGIN_CODE, /executeStructuredRenderPlan\(figma, plan\)/);
  assert.doesNotMatch(UI, /type: 'render-plan'[^\n]+code:/);
});
