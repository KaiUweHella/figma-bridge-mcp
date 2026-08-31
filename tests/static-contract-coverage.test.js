import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_CONFIG = JSON.parse(readFileSync(join(ROOT, 'jsconfig.contracts.host.json'), 'utf8'));
const PLUGIN_CONFIG = JSON.parse(readFileSync(join(ROOT, 'jsconfig.contracts.plugin.json'), 'utf8'));
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PROTOCOL_SOURCE = readFileSync(join(ROOT, 'engine/src/lib/protocol-contract.js'), 'utf8');
const EXEC_PROTOCOL_ACTIONS = Object.freeze([
  'asset-stream', 'eval', 'typed-read', 'render-plan', 'render-plan-batch',
]);
const PRE_AUTH_PLUGIN_MESSAGE_TYPES = Object.freeze(['hello']);
const AUTHENTICATED_PLUGIN_MESSAGE_TYPES = Object.freeze([
  'asset-stream-start', 'asset-stream-chunk', 'asset-stream-end', 'result',
  'lane-settled', 'ping', 'rest-token', 'selection',
]);

const ACCEPTED_HOST_CONTRACT_FILES = Object.freeze([
  'engine/src/application/asset-export-command.js',
  'engine/src/application/asset-export-request.js',
  'engine/src/application/code-spec-command.js',
  'engine/src/application/code-spec-request.js',
  'engine/src/application/design-capture.js',
  'engine/src/application/inspect-command.js',
  'engine/src/application/inspect-request.js',
  'engine/src/application/legacy-raster-export-request.js',
  'engine/src/application/create-frame-command.js',
  'engine/src/application/create-frame-request.js',
  'engine/src/application/create-shape-command.js',
  'engine/src/application/create-shape-request.js',
  'engine/src/application/create-canvas-node-command.js',
  'engine/src/application/create-canvas-node-request.js',
  'engine/src/application/create-line-command.js',
  'engine/src/application/create-line-request.js',
  'engine/src/application/create-auto-layout-command.js',
  'engine/src/application/create-auto-layout-request.js',
  'engine/src/application/create-text-command.js',
  'engine/src/application/create-text-request.js',
  'engine/src/application/measurement-mutation-command.js',
  'engine/src/application/measurement-mutation-request.js',
  'engine/src/application/library-import-command.js',
  'engine/src/application/library-import-request.js',
  'engine/src/application/shader-mutation-command.js',
  'engine/src/application/shader-mutation-request.js',
  'engine/src/application/slot-configuration-command.js',
  'engine/src/application/slot-configuration-request.js',
  'engine/src/application/slot-reset-command.js',
  'engine/src/application/slot-reset-request.js',
  'engine/src/application/prototype-mutation-command.js',
  'engine/src/application/prototype-mutation-request.js',
  'engine/src/application/node-text-command.js',
  'engine/src/application/node-text-request.js',
  'engine/src/application/node-duplicate-command.js',
  'engine/src/application/node-duplicate-request.js',
  'engine/src/application/node-rename-command.js',
  'engine/src/application/node-rename-request.js',
  'engine/src/application/node-resize-command.js',
  'engine/src/application/node-resize-request.js',
  'engine/src/application/node-reparent-command.js',
  'engine/src/application/node-reparent-request.js',
  'engine/src/application/node-group-command.js',
  'engine/src/application/node-group-request.js',
  'engine/src/application/node-ungroup-command.js',
  'engine/src/application/node-ungroup-request.js',
  'engine/src/application/node-boolean-command.js',
  'engine/src/application/node-boolean-request.js',
  'engine/src/application/node-bind-command.js',
  'engine/src/application/node-bind-request.js',
  'engine/src/application/node-set-fill-command.js',
  'engine/src/application/node-set-fill-request.js',
  'engine/src/application/node-set-image-command.js',
  'engine/src/application/node-set-image-request.js',
  'engine/src/application/node-set-command.js',
  'engine/src/application/node-set-request.js',
  'engine/src/application/node-flatten-command.js',
  'engine/src/application/node-flatten-request.js',
  'engine/src/application/node-to-component-command.js',
  'engine/src/application/node-to-component-request.js',
  'engine/src/application/screenshot-command.js',
  'engine/src/application/screenshot-request.js',
  'engine/src/application/semantic-render-command.js',
  'engine/src/application/semantic-render-request.js',
  'engine/src/application/verification-artifact.js',
  'engine/src/lib/asset-output-lock.js',
  'engine/src/lib/asset-policy.js',
  'engine/src/lib/daemon-client.js',
  'engine/src/lib/dispatch-receipt.js',
  'engine/src/lib/plugin-write-lane.js',
  'engine/src/lib/protocol-contract.js',
  'engine/src/lib/revision-context.js',
  'engine/src/lib/semantic-render-outcome.js',
  'engine/src/lib/spec-format.js',
  'src/capability-catalog.js',
  'src/figma-target.js',
  'src/tracked-job-registry.js',
]);

test('host and Plugin static contracts use disjoint global environments', () => {
  assert.deepEqual(HOST_CONFIG.compilerOptions.types, ['node']);
  assert.deepEqual(PLUGIN_CONFIG.compilerOptions.types, ['@figma/plugin-typings']);
  assert.deepEqual(PLUGIN_CONFIG.files, ['plugin/code.js']);
  assert.equal(HOST_CONFIG.files.some((file) => file.startsWith('plugin/')), false);
  assert.equal(PLUGIN_CONFIG.files.some((file) => file.startsWith('engine/') || file.startsWith('src/')), false);
  assert.deepEqual(
    HOST_CONFIG.files.filter((file) => PLUGIN_CONFIG.files.includes(file)),
    [],
  );
});

test('accepted host seam coverage cannot shrink silently', () => {
  const actual = [...HOST_CONFIG.files].sort();
  assert.deepEqual(actual, [...ACCEPTED_HOST_CONTRACT_FILES].sort());
  for (const file of actual) {
    assert.doesNotThrow(() => readFileSync(join(ROOT, file)));
  }
});

test('contract script names the failing host or Plugin seam', () => {
  assert.equal(PACKAGE.scripts['check:contracts:host'], 'tsc -p jsconfig.contracts.host.json');
  assert.equal(PACKAGE.scripts['check:contracts:plugin'], 'tsc -p jsconfig.contracts.plugin.json');
  assert.equal(
    PACKAGE.scripts['check:contracts'],
    'npm run check:contracts:host && npm run check:contracts:plugin',
  );
});

test('protocol request and response discriminants have exhaustive source branches', () => {
  assert.deepEqual(PRE_AUTH_PLUGIN_MESSAGE_TYPES, ['hello']);
  assert.match(PROTOCOL_SOURCE, /value\.type !== 'hello'/);

  for (const action of EXEC_PROTOCOL_ACTIONS) {
    assert.match(
      PROTOCOL_SOURCE,
      new RegExp(`value\\.action === '${action}'`),
      `execution protocol action ${action} needs an explicit validation branch`,
    );
  }

  const responseCases = [...PROTOCOL_SOURCE.matchAll(/^\s+case '([^']+)':/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    [...new Set(responseCases)].sort(),
    [...AUTHENTICATED_PLUGIN_MESSAGE_TYPES].sort(),
  );
});
