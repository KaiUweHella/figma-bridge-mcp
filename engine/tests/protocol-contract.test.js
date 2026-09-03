import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_EXEC_BODY_BYTES,
  MAX_PLUGIN_MESSAGE_BYTES,
  MAX_PROTOCOL_ERROR_BYTES,
  MAX_PROTOCOL_VALUE_BYTES,
  evalTransportEnvelopeError,
  validateExecPayload,
  validatePluginMessage,
} from '../src/lib/protocol-contract.js';
import { FigmaClient } from '../src/lib/jsx-render.js';
import { HANDSHAKE_PROTO } from '../src/lib/plugin-handshake.js';
import {
  createPreparedDispatchReceipt,
  terminalDispatchReceipt,
} from '../src/lib/dispatch-receipt.js';

const PREPARED_RECEIPT = createPreparedDispatchReceipt({
  requestId: '11111111-1111-4111-8111-111111111111',
  connectionEpoch: '22222222-2222-4222-8222-222222222222',
  fileKey: 'FILE',
  editorType: 'figma',
  action: 'eval',
});
const COMPLETED_RECEIPT = terminalDispatchReceipt(PREPARED_RECEIPT, 'completed');
const FAILED_RECEIPT = terminalDispatchReceipt(PREPARED_RECEIPT, 'failed', 'execution-error');
const ASSET_PREPARED_RECEIPT = createPreparedDispatchReceipt({
  requestId: '33333333-3333-4333-8333-333333333333',
  connectionEpoch: '22222222-2222-4222-8222-222222222222',
  fileKey: 'FILE',
  editorType: 'figma',
  action: 'asset-stream',
});
const ASSET_COMPLETED_RECEIPT = terminalDispatchReceipt(ASSET_PREPARED_RECEIPT, 'completed');

test('execution protocol accepts bounded eval and Semantic Render Plan shapes', () => {
  const plan = new FigmaClient().planJSX('<Frame name="Card"><Text>Hello</Text></Frame>');
  assert.equal(validateExecPayload({ action: 'eval', code: '1+1', expectedEditor: 'figma', timeoutMs: 1000, deadlineAt: Date.now() + 1000, fileKey: 'FILE', requireDocumentRevision: true }), null);
  assert.equal(validateExecPayload({
    action: 'eval', code: 'capture()', expectedEditor: 'figma', requireDocumentRevision: true,
    revisionObservation: { scope: 'page', nodeId: 'I12:34;56:78' },
  }), null);
  assert.equal(validateExecPayload({ action: 'typed-read', operation: 'style-consumers-v1', request: {
    style: 'Surface', type: 'PAINT', limit: 100, after: null,
  }, expectedEditor: 'figma', timeoutMs: 1000 }), null);
  assert.equal(validateExecPayload({
    action: 'asset-stream', asset: { kind: 'svg', ref: '1:2' },
    expectedEditor: 'figma', requireDocumentRevision: true,
    revisionObservation: { scope: 'page', nodeId: '1:2' },
  }), null);
  assert.equal(validateExecPayload({ action: 'typed-read', operation: 'token-overlap-v1', request: {
    queries: ['Alpha', 'Beta'], limit: 200,
  }, expectedEditor: 'figma', timeoutMs: 1000 }), null);
  assert.equal(validateExecPayload({
    action: 'render-plan', plan,
    options: { smart: false, x: -10, y: 20, materializeResources: true },
    expectedEditor: 'figma', timeoutMs: 1000, fileKey: 'FILE',
  }), null);
  assert.equal(validateExecPayload({
    action: 'render-plan-batch', plans: [plan, plan],
    options: { gap: 24, vertical: true, smart: false, x: 10, y: 20 },
    expectedEditor: 'figma', timeoutMs: 1000,
  }), null);
  assert.match(validateExecPayload({ action: 'render', code: 'x' }), /eval.*typed-read.*render-plan.*render-plan-batch/);
  assert.match(validateExecPayload({ action: 'typed-read', operation: 'future', request: {} }), /unsupported/);
  assert.match(validateExecPayload({ action: 'typed-read', operation: 'style-consumers-v1', request: {
    style: 'Surface', type: null, limit: 100, after: null,
  }, code: 'figma.createFrame()' }), /must not contain JavaScript/);
  assert.match(validateExecPayload({ action: 'eval', code: '' }), /non-empty/);
  assert.match(validateExecPayload({ action: 'render-plan', plan: { version: 999 } }), /invalid/);
  assert.match(validateExecPayload({ action: 'render-plan', plan, options: { future: true } }), /unknown/);
  assert.match(validateExecPayload({ action: 'render-plan', plan, options: { smart: 'no' } }), /boolean/);
  assert.match(validateExecPayload({ action: 'render-plan', plan, options: { materializeResources: 'yes' } }), /boolean/);
  assert.match(validateExecPayload({ action: 'render-plan', plan, options: { x: Infinity } }), /finite/);
  // One explicit target slide is accepted on a single plan; shape only.
  assert.equal(validateExecPayload({
    action: 'render-plan', plan, options: { slide: '12:34' },
    expectedEditor: 'slides', timeoutMs: 1000, fileKey: 'FILE',
  }), null);
  assert.equal(validateExecPayload({
    action: 'render-plan', plan, options: { slide: 'I12:34;56:78' },
    expectedEditor: 'slides', timeoutMs: 1000, fileKey: 'FILE',
  }), null);
  for (const slide of ['', 'label:Cover', '12-34', 12, {}, 'x'.repeat(5000)]) {
    assert.match(
      validateExecPayload({ action: 'render-plan', plan, options: { slide } }),
      /slide must be a Figma node id/,
      `slide target ${JSON.stringify(slide)} must be refused`,
    );
  }
  // A batch spreads roots across a canvas, so it takes no slide target at all.
  assert.match(
    validateExecPayload({ action: 'render-plan-batch', plans: [plan], options: { slide: '12:34' } }),
    /unknown/,
  );
  assert.match(validateExecPayload({ action: 'render-plan-batch', plans: [] }), /1-100/);
  assert.match(validateExecPayload({ action: 'render-plan-batch', plans: [plan], options: { future: true } }), /unknown/);
  assert.match(validateExecPayload({ action: 'render-plan-batch', plans: [plan], options: { x: Infinity } }), /finite/);
  assert.match(validateExecPayload({ action: 'render-plan-batch', plans: [plan], options: { materializeResources: 1 } }), /boolean/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', fileKey: 'x'.repeat(65) }), /64/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', expectedEditor: 'figma', timeoutMs: Infinity }), /finite/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', expectedEditor: 'figma', deadlineAt: Infinity }), /timestamp/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', expectedEditor: 'figma', requireDocumentRevision: 'yes' }), /boolean/);
  assert.match(validateExecPayload({ action: 'render-plan', plan, expectedEditor: 'figma', requireDocumentRevision: true }), /eval or asset-stream requests/);
  assert.match(validateExecPayload({
    action: 'eval', code: 'x', expectedEditor: 'figma',
    revisionObservation: { scope: 'page', nodeId: '1:2' },
  }), /compatibility document-revision flag/);
  assert.match(validateExecPayload({
    action: 'eval', code: 'x', expectedEditor: 'figma', requireDocumentRevision: true,
    revisionObservation: { scope: 'page', nodeId: 'not-a-node' },
  }), /canonical bounded Figma node id/);
  assert.match(validateExecPayload({
    action: 'eval', code: 'x', expectedEditor: 'figma', requireDocumentRevision: true,
    revisionObservation: { scope: 'document', nodeId: '1:2' },
  }), /unknown or missing fields/);
  assert.match(validateExecPayload({
    action: 'typed-read', operation: 'token-overlap-v1',
    request: { queries: ['Alpha', 'Beta'], limit: 1 }, expectedEditor: 'figma',
    revisionObservation: { scope: 'document' },
  }), /only on eval or asset-stream requests/);
  assert.match(validateExecPayload({ action: 'eval', code: 'x', expectedEditor: 'unknown' }), /expectedEditor/);
});

test('execution limits are byte-based and leave room for the signed JSON envelope', () => {
  assert.ok(MAX_EXEC_BODY_BYTES > MAX_PROTOCOL_VALUE_BYTES);
  assert.ok(MAX_PLUGIN_MESSAGE_BYTES > MAX_PROTOCOL_VALUE_BYTES);
  assert.equal(
    validateExecPayload({ action: 'eval', code: 'x'.repeat(MAX_PROTOCOL_VALUE_BYTES), expectedEditor: 'figma' }),
    null,
  );
  assert.match(
    validateExecPayload({ action: 'eval', code: 'x'.repeat(MAX_PROTOCOL_VALUE_BYTES + 1), expectedEditor: 'figma' }),
    /5 MB protocol limit/,
  );
  assert.match(
    validateExecPayload({ action: 'eval', code: '€'.repeat(Math.floor(MAX_PROTOCOL_VALUE_BYTES / 3) + 1), expectedEditor: 'figma' }),
    /5 MB protocol limit/,
    'multi-byte input must not bypass a byte limit via String.length',
  );
});

test('eval transport preflight includes HTTP and Plugin JSON escaping', () => {
  assert.equal(evalTransportEnvelopeError('1+1'), null);
  const rawUnderLimitButEncodedOverLimit = '"'.repeat(2_700_000);
  assert.ok(Buffer.byteLength(rawUnderLimitButEncodedOverLimit, 'utf8') < MAX_PROTOCOL_VALUE_BYTES);
  assert.match(evalTransportEnvelopeError(rawUnderLimitButEncodedOverLimit), /5 MiB HTTP body/);
});

test('plugin protocol has explicit pre-auth and authenticated message contracts', () => {
  const hello = { type: 'hello', proto: HANDSHAKE_PROTO, nonce: 'n', version: '0.4.0', proof: 'p' };
  assert.equal(validatePluginMessage(hello), null);
  assert.match(validatePluginMessage({ type: 'ping' }), /expected hello/);
  assert.equal(validatePluginMessage({
    type: 'result', id: 1, result: 'ok', dispatchReceipt: COMPLETED_RECEIPT,
  }, { authenticated: true }), null);
  assert.equal(validatePluginMessage({
    type: 'lane-settled', dispatchReceipt: COMPLETED_RECEIPT,
  }, { authenticated: true }), null);
  assert.equal(validatePluginMessage({
    type: 'asset-stream-start', id: 2, totalBytes: 3,
    sha256: 'a'.repeat(64), details: { kind: 'svg' },
    dispatchReceipt: ASSET_PREPARED_RECEIPT,
  }, { authenticated: true }), null);
  assert.equal(validatePluginMessage({
    type: 'asset-stream-chunk', id: 2, sequence: 0, base64: 'YWJj',
  }, { authenticated: true }), null);
  assert.equal(validatePluginMessage({
    type: 'asset-stream-end', id: 2, chunks: 1,
    dispatchReceipt: ASSET_COMPLETED_RECEIPT,
  }, { authenticated: true }), null);
  assert.match(validatePluginMessage({
    type: 'lane-settled', dispatchReceipt: PREPARED_RECEIPT,
  }, { authenticated: true }), /terminal state/);
  assert.equal(validatePluginMessage({ type: 'selection', selection: { nodes: [] } }, { authenticated: true }), null);
  assert.match(validatePluginMessage({ type: 'batch-result', id: 1, results: [] }, { authenticated: true }), /unknown/);
  assert.match(validatePluginMessage({ type: 'surprise' }, { authenticated: true }), /unknown/);
});

test('plugin result, error, metadata, token and selection payloads are bounded', () => {
  const authenticated = { authenticated: true };
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, result: 'x'.repeat(MAX_PROTOCOL_VALUE_BYTES + 1), dispatchReceipt: COMPLETED_RECEIPT }, authenticated),
    /result.*5 MB/i,
  );
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, error: 'x'.repeat(MAX_PROTOCOL_ERROR_BYTES + 1), dispatchReceipt: FAILED_RECEIPT }, authenticated),
    /error.*limit/i,
  );
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, metadata: [], dispatchReceipt: COMPLETED_RECEIPT }, authenticated),
    /metadata.*object/i,
  );
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, result: 'ok' }, authenticated),
    /Dispatch Receipt/,
  );
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, error: 'failed', dispatchReceipt: COMPLETED_RECEIPT }, authenticated),
    /completed Dispatch Receipt/,
  );
  assert.match(
    validatePluginMessage({ type: 'result', id: 1, result: 'ok', dispatchReceipt: FAILED_RECEIPT }, authenticated),
    /non-completed Dispatch Receipt/,
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
  const base = { type: 'hello', proto: HANDSHAKE_PROTO, nonce: 'n', version: '0.5.2', proof: 'p' };
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
