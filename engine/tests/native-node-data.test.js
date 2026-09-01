import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatNodeCss,
  nodeCssCode,
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

test('native CSS text neutralizes comment, control, and Bidi injection', () => {
  const result = {
    id: '1:2',
    name: '*/\nPrivate\u202e',
    type: 'FRAME',
    css: { display: 'flex\nposition: fixed\u0000' },
  };
  const text = formatNodeCss(result);
  assert.match(text, /^\/\* \* \/ Private /);
  assert.match(text, /display: flex position: fixed ;$/);
  for (const line of text.split('\n')) {
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  }
  assert.equal(JSON.parse(formatNodeCss(result, { json: true })).css.display,
    'flex\nposition: fixed\u0000');
  assert.throws(
    () => formatNodeCss({ ...result, css: { 'display\nposition': 'fixed' } }),
    /invalid or unbounded/,
  );
});

test('native CSS rejects a missing node clearly', async () => {
  const figma = { getNodeByIdAsync: async () => null };
  await assert.rejects(new Function('figma', `return ${nodeCssCode('9:9')}`)(figma), /Node not found/);
});
