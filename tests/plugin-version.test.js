import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_BUILD_VERSION,
  pluginUpdateAvailable,
} from '../engine/src/lib/plugin-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI = readFileSync(join(ROOT, 'plugin', 'ui.html'), 'utf8');

test('plugin UI and daemon advertise the same build version', () => {
  assert.match(UI, new RegExp(`const PLUGIN_VERSION = '${PLUGIN_BUILD_VERSION}';`));
});

test('only an older or unknown imported plugin is reported stale', () => {
  assert.equal(pluginUpdateAvailable(PLUGIN_BUILD_VERSION), false);
  assert.equal(pluginUpdateAvailable('3.0.0'), true);
  assert.equal(pluginUpdateAvailable('2.99.99'), true);
  assert.equal(pluginUpdateAvailable('99.0.0'), false, 'an older daemon must not nag a newer plugin');
  assert.equal(pluginUpdateAvailable(null), true);
  assert.equal(pluginUpdateAvailable('not-semver'), true);
});
