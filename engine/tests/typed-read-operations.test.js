import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeTypedReadOperation,
  STYLE_CONSUMERS_TYPED_READ,
  typedReadRequestValidationError,
} from '../src/lib/typed-read-operations.js';

const consumer = (id) => ({ node: { id, name: `Node ${id}`, type: 'FRAME' }, fields: ['fillStyleId'] });
function figmaFor(consumers = []) {
  const style = {
    id: 'S:1', key: 'KEY', name: 'Surface', type: 'PAINT', remote: false,
    getStyleConsumersAsync: async () => consumers,
  };
  return {
    getStyleByIdAsync: async (id) => id === style.id ? style : null,
    getLocalPaintStylesAsync: async () => [style],
    getLocalTextStylesAsync: async () => [],
    getLocalEffectStylesAsync: async () => [],
    getLocalGridStylesAsync: async () => [],
  };
}

test('typed-read contract accepts only the closed Style Consumer request', () => {
  const request = { style: 'Surface', type: 'PAINT', limit: 2, after: null };
  assert.equal(typedReadRequestValidationError(STYLE_CONSUMERS_TYPED_READ, request), null);
  assert.match(typedReadRequestValidationError('future', request), /unsupported/);
  assert.match(typedReadRequestValidationError(STYLE_CONSUMERS_TYPED_READ, { ...request, code: 'write()' }), /unknown/);
  assert.match(typedReadRequestValidationError(STYLE_CONSUMERS_TYPED_READ, { ...request, limit: 501 }), /1-500/);
});

test('typed Style Consumer returns one bounded deterministic page', async () => {
  const request = { style: 'Surface', type: 'PAINT', limit: 1, after: null };
  const serialized = await executeTypedReadOperation(figmaFor([consumer('2:1'), consumer('1:1')]),
    STYLE_CONSUMERS_TYPED_READ, request);
  const result = JSON.parse(serialized);
  assert.deepEqual(result.consumers.map((item) => item.node.id), ['1:1']);
  assert.equal(result.total, 2);
  assert.equal(result.omittedAfter, 1);
  assert.deepEqual(result.nextAnchor, { nodeId: '1:1', fields: ['fillStyleId'] });
});

test('typed Style Consumer rejects malformed native facts before projection', async () => {
  const request = { style: 'S:1', type: null, limit: 10, after: null };
  await assert.rejects(() => executeTypedReadOperation(figmaFor([
    { node: { id: '1:1', name: 'Node', type: 'FRAME' }, fields: ['futureStyleId'] },
  ]), STYLE_CONSUMERS_TYPED_READ, request), /incompatible inherited style field/);
});
