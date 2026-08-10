import assert from 'node:assert/strict';
import test from 'node:test';
import { executeScreenshot, screenshotCode } from '../src/application/screenshot-command.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('screenshot Command Application captures and persists through adapters', async () => {
  let saved = null;
  let code = '';
  const result = await executeScreenshot({ nodeId: '1-2', scale: 1, savePath: '/tmp/card.png' }, {
    evaluate: async (value) => {
      code = value;
      return { name: 'Card', id: '1:2', width: 320, height: 180, scale: 1, base64: PNG.toString('base64') };
    },
    save: async (path, bytes) => { saved = { path, bytes }; },
  });
  assert.match(code, /getNodeByIdAsync\("1:2"\)/);
  assert.equal(saved.path, '/tmp/card.png');
  assert.deepEqual(saved.bytes, PNG);
  assert.deepEqual(JSON.parse(result.stdout), {
    name: 'Card', id: '1:2', width: 320, height: 180, scale: 1, saved: '/tmp/card.png',
  });
});

test('default persistence and base64 are explicit Interface choices', async () => {
  const capture = { name: 'Hero', id: '9:8', width: 100, height: 50, scale: 0.5, base64: PNG.toString('base64') };
  let path = '';
  const saved = await executeScreenshot({ nodeId: '9:8', saveDefault: true }, {
    evaluate: async () => capture,
    save: async (value) => { path = value; },
    defaultSavePath: (value) => `/tmp/${value.id.replace(':', '-')}.png`,
  });
  assert.equal(path, '/tmp/9-8.png');
  assert.equal(JSON.parse(saved.stdout).base64, undefined);
  const inline = await executeScreenshot({ nodeId: '9:8', includeBase64: true }, { evaluate: async () => capture });
  assert.equal(JSON.parse(inline.stdout).base64, capture.base64);
});

test('screenshot validates deterministically and generated plugin code parses', async () => {
  await assert.rejects(() => executeScreenshot({ nodeId: '1:2', scale: 0 }, { evaluate: async () => ({}) }), /greater than 0/);
  await assert.rejects(() => executeScreenshot({ nodeId: '1:2' }, { evaluate: async () => ({ error: 'Node not found' }) }), /Node not found/);
  assert.doesNotThrow(() => new Function(`return ${screenshotCode({ nodeId: '1:2', scale: 0.5, maxDimension: 2000, measure: false })};`));
});
