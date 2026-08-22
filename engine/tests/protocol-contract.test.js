import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_EXEC_BODY_BYTES,
  MAX_PLUGIN_MESSAGE_BYTES,
  MAX_PROTOCOL_ERROR_BYTES,
  MAX_PROTOCOL_VALUE_BYTES,
  validateExecPayload,
  validatePluginMessage,
} from '../src/lib/protocol-contract.js';
import { FigmaClient } from '../src/lib/jsx-render.js';

test('execution protocol accepts bounded eval and Semantic Render Plan shapes', () => {
  const plan = new FigmaClient().planJSX('<Frame name="Card"><Text>Hello</Text></Frame>');
  assert.equal(validateExecPayload({ action: 'eval', code: '1+1', timeoutMs: 1000, fileKey: 'FILE', requireDocumentRevision: true }), null);
  assert.equal(validateExecPayload({ action: 'render-plan', plan, timeoutMs: 1000, fileKey: 'FILE' }), null);
  assert.equal(validateExecPayload({ action: 'render-plan-batch', plans: [plan, plan], options: { gap: 24, vertical: true } }), null);
  assert.match(validateExecPayload({ action: 'render', code: 'x' }), /eval.*render-plan.*render-plan-batch/);
  assert.match(validateExecPayload({ action: 'eval', code: '' }), /non-empty/);
  assert.match(validateExecPayload({ action: 'render-plan', plan: { version: 999 } }), /invalid/);
  assert.match(validateExecPayload({ action: 'render-plan-batch', plans: [] }), /1-100/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', fileKey: 'x'.repeat(65) }), /64/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', timeoutMs: Infinity }), /finite/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', requireDocumentRevision: 'yes' }), /boolean/);
  assert.match(validateExecPayload({ action: 'render-plan', plan, requireDocumentRevision: true }), /eval requests/);
});

test('execution limits are byte-based and leave room for the signed JSON envelope', () => {
  assert.ok(MAX_EXEC_BODY_BYTES > MAX_PROTOCOL_VALUE_BYTES);
  assert.ok(MAX_PLUGIN_MESSAGE_BYTES > MAX_PROTOCOL_VALUE_BYTES);
  assert.equal(
    validateExecPayload({ action: 'eval', code: 'x'.repeat(MAX_PROTOCOL_VALUE_BYTES) }),
    null,
  );
  assert.match(
    validateExecPayload({ action: 'eval', code: 'x'.repeat(MAX_PROTOCOL_VALUE_BYTES + 1) }),
    /5 MB protocol limit/,
  );
  assert.match(
    validateExecPayload({ action: 'eval', code: '€'.repeat(Math.floor(MAX_PROTOCOL_VALUE_BYTES / 3) + 1) }),
    /5 MB protocol limit/,
    'multi-byte input must not bypass a byte limit via String.length',
  );
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

test('plugin result, error, metadata, batch, token and selection payloads are bounded', () => {
  const authenticated = { authenticated: true };
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, result: 'x'.repeat(MAX_PROTOCOL_VALUE_BYTES + 1) }, authenticated),
    /result.*5 MB/i,
  );
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, error: 'x'.repeat(MAX_PROTOCOL_ERROR_BYTES + 1) }, authenticated),
    /error.*limit/i,
  );
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, metadata: [] }, authenticated),
    /metadata.*object/i,
  );
  assert.match(
    validatePluginMessage({ type: 'batch-result', id: 1, results: Array.from({ length: 101 }, () => ({})) }, authenticated),
    /at most 100/i,
  );
  assert.match(
    validatePluginMessage({ type: 'rest-token', value: 'x'.repeat(4097) }, authenticated),
    /4096 bytes/i,
  );
  assert.match(
    validatePluginMessage({
      type: 'selection',
      selection: { nodes: Array.from({ length: 51 }, () => ({ id: '1:1', name: 'x', type: 'FRAME' })) },
    }, authenticated),
    /at most 50 nodes/i,
  );
});

test('selection admission preserves the daemon whitelist and truncation contract', () => {
  const authenticated = { authenticated: true };
  assert.equal(
    validatePluginMessage({
      type: 'selection',
      selection: {
        page: 'Page',
        total: 1,
        nodes: [{ id: '1:1', name: 'Node', type: 'FRAME', componentKey: 'k'.repeat(1_000) }],
        fileKey: 'F'.repeat(1_000),
        fileName: 42,
        unknown: { droppedByProjection: true },
      },
    }, authenticated),
    null,
    'bounded fields are sanitized after admission instead of rejecting the whole selection push',
  );
  assert.match(
    validatePluginMessage({
      type: 'selection',
      selection: { nodes: [], unknown: 'x'.repeat(256 * 1024) },
    }, authenticated),
    /256 KiB/i,
    'the complete pre-sanitization envelope remains bounded',
  );
});

test('plugin handshake fields and capabilities are bounded before authentication', () => {
  const base = { type: 'hello', proto: 2, nonce: 'n', version: '0.5.2', proof: 'p' };
  assert.match(validatePluginMessage({ ...base, version: 'x'.repeat(129) }), /version.*128 bytes/i);
  assert.match(
    validatePluginMessage({ ...base, capabilities: Array.from({ length: 17 }, (_, index) => `cap-${index}`) }),
    /at most 16 capabilities/i,
  );
  assert.match(validatePluginMessage({ ...base, capabilities: [42] }), /capability.*string/i);
});

test('protocol contracts reject arrays, null and untyped messages', () => {
  for (const value of [null, [], 'hello', 42]) {
    assert.match(validatePluginMessage(value), /object/);
    assert.match(validateExecPayload(value), /object/);
  }
  assert.match(validatePluginMessage({}), /type/);
});
