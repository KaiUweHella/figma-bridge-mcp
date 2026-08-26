import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLUGIN_COMPATIBILITY_FILES,
  pluginUiVersion,
  validateCompatibilityHistory,
  validatePluginCompatibilityState,
} from '../scripts/check-plugin-compatibility.js';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;

function history(entries = [{ version: '3.3.13', fingerprint: A, previousFingerprint: null }]) {
  return { schemaVersion: 1, entries };
}

test('Plugin compatibility history is append-only, chained, and strictly versioned', () => {
  assert.deepEqual(validateCompatibilityHistory(history()), history().entries[0]);
  const advanced = history([
    { version: '3.3.13', fingerprint: A, previousFingerprint: null },
    { version: '3.3.14', fingerprint: B, previousFingerprint: A },
  ]);
  assert.deepEqual(validateCompatibilityHistory(advanced), advanced.entries[1]);
  assert.throws(() => validateCompatibilityHistory(history([
    { version: '3.3.13', fingerprint: A, previousFingerprint: null },
    { version: '3.3.13', fingerprint: B, previousFingerprint: A },
  ])), /increase strictly/);
  assert.throws(() => validateCompatibilityHistory(history([
    { version: '3.3.13', fingerprint: A, previousFingerprint: null },
    { version: '3.3.14', fingerprint: B, previousFingerprint: null },
  ])), /append-only chain/);
});

test('same-version behavior drift and UI/daemon version drift fail closed', () => {
  assert.doesNotThrow(() => validatePluginCompatibilityState({
    history: history(), version: '3.3.13', uiVersion: '3.3.13', fingerprint: A,
  }));
  assert.throws(() => validatePluginCompatibilityState({
    history: history(), version: '3.3.13', uiVersion: '3.3.13', fingerprint: B,
  }), /without advancing/);
  assert.throws(() => validatePluginCompatibilityState({
    history: history(), version: '3.3.14', uiVersion: '3.3.13', fingerprint: B,
  }), /does not match/);
  assert.throws(() => validatePluginCompatibilityState({
    history: history(), version: '3.3.14', uiVersion: '3.3.14', fingerprint: B,
  }), /history ends at/);
});

test('compatibility scope includes shipped Plugin and protocol code but excludes server-only code', () => {
  for (const file of [
    'plugin/code.js', 'plugin/ui.html', 'plugin/manifest.json',
    'engine/src/lib/protocol-contract.js', 'engine/src/lib/structured-render-executor.js',
  ]) assert.ok(PLUGIN_COMPATIBILITY_FILES.includes(file), file);
  assert.equal(PLUGIN_COMPATIBILITY_FILES.includes('src/server.js'), false);
  assert.equal(pluginUiVersion("const PLUGIN_VERSION = '3.3.13';"), '3.3.13');
  assert.throws(() => pluginUiVersion("const PLUGIN_VERSION = 'broken';"), /exactly one/);
});
