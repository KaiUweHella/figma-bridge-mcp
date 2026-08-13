import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { STATE_DIR } from '../engine/src/lib/state-dir.js';
import { getPluginKeyFile } from '../engine/src/lib/cli-core.js';

test('direct engine daemon starts reuse the shared plugin pairing key', () => {
  const previous = process.env.PLUGIN_KEY_FILE;
  try {
    delete process.env.PLUGIN_KEY_FILE;
    assert.equal(getPluginKeyFile(), join(STATE_DIR, 'plugin-key'));

    process.env.PLUGIN_KEY_FILE = '/tmp/isolated-figma-bridge-plugin-key';
    assert.equal(getPluginKeyFile(), '/tmp/isolated-figma-bridge-plugin-key');
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_KEY_FILE;
    else process.env.PLUGIN_KEY_FILE = previous;
  }
});
