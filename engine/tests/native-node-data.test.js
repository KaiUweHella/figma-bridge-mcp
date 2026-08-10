import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatNodeCss,
  nodeCssCode,
  nodeRestJsonCode,
} from '../src/lib/native-node-data.js';

test('native CSS reads the same property map exposed by getCSSAsync', async () => {
  const node = {
    id: '1:2', name: 'Card', type: 'FRAME',
    getCSSAsync: async () => ({ display: 'flex', 'border-radius': '12px' }),
  };
  const figma = { getNodeByIdAsync: async () => node };
  const result = await new Function('figma', `return ${nodeCssCode(node.id)}`)(figma);
  assert.deepEqual(result.css, { display: 'flex', 'border-radius': '12px' });
  assert.equal(formatNodeCss(result), '/* Card (1:2) — FRAME */\ndisplay: flex;\nborder-radius: 12px;');
  assert.deepEqual(JSON.parse(formatNodeCss(result, { json: true })), result);
});

test('JSON_REST_V1 is exported locally through the plugin', async () => {
  const expected = { id: '1:2', name: 'Card', type: 'FRAME', children: [] };
  let settings = null;
  const node = {
    id: '1:2', type: 'FRAME',
    exportAsync: async (value) => { settings = value; return expected; },
  };
  const figma = { getNodeByIdAsync: async () => node };
  const result = await new Function('figma', `return ${nodeRestJsonCode(node.id)}`)(figma);
  assert.deepEqual(settings, { format: 'JSON_REST_V1' });
  assert.deepEqual(result, expected);
});

test('native node readers reject unsupported or missing nodes clearly', async () => {
  const figma = { getNodeByIdAsync: async () => null };
  await assert.rejects(new Function('figma', `return ${nodeCssCode('9:9')}`)(figma), /Node not found/);
  const unsupported = { id: '1:3', type: 'DOCUMENT' };
  await assert.rejects(
    new Function('figma', `return ${nodeRestJsonCode('1:3')}`)({ getNodeByIdAsync: async () => unsupported }),
    /cannot be exported/,
  );
});
