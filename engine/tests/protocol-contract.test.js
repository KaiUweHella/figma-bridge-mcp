import assert from 'node:assert/strict';
import test from 'node:test';
import { validateExecPayload, validatePluginMessage } from '../src/lib/protocol-contract.js';

test('execution protocol accepts only one bounded eval shape', () => {
  assert.equal(validateExecPayload({ action: 'eval', code: '1+1', timeoutMs: 1000, fileKey: 'FILE' }), null);
  assert.match(validateExecPayload({ action: 'render', code: 'x' }), /action/);
  assert.match(validateExecPayload({ action: 'eval', code: '' }), /non-empty/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', fileKey: 'x'.repeat(65) }), /64/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', timeoutMs: Infinity }), /finite/);
});

test('plugin protocol has explicit pre-auth and authenticated message contracts', () => {
  const hello = { type: 'hello', proto: 2, nonce: 'n', version: '0.4.0', proof: 'p' };
  assert.equal(validatePluginMessage(hello), null);
  assert.match(validatePluginMessage({ type: 'ping' }), /expected hello/);
  assert.equal(validatePluginMessage({ type: 'result', id: 1, result: 'ok' }, { authenticated: true }), null);
  assert.equal(validatePluginMessage({ type: 'selection', selection: { nodes: [] } }, { authenticated: true }), null);
  assert.match(validatePluginMessage({ type: 'batch-result', id: 1 }, { authenticated: true }), /results/);
  assert.match(validatePluginMessage({ type: 'surprise' }, { authenticated: true }), /unknown/);
});

test('protocol contracts reject arrays, null and untyped messages', () => {
  for (const value of [null, [], 'hello', 42]) {
    assert.match(validatePluginMessage(value), /object/);
    assert.match(validateExecPayload(value), /object/);
  }
  assert.match(validatePluginMessage({}), /type/);
});
