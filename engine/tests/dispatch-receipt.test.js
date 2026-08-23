import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISPATCH_RECEIPT_CAPABILITY,
  DISPATCH_RECEIPT_SCHEMA,
  KNOWN_PLUGIN_CAPABILITIES,
  PLUGIN_WRITE_LANE_CAPABILITY,
  createPreparedDispatchReceipt,
  dispatchReceiptIdentityMatches,
  dispatchReceiptValidationError,
  operationCapability,
  terminalDispatchReceipt,
  validatePreparedDispatchContext,
} from '../src/lib/dispatch-receipt.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_EPOCH = '22222222-2222-4222-8222-222222222222';

function prepared(overrides = {}) {
  return createPreparedDispatchReceipt({
    requestId: REQUEST_ID,
    connectionEpoch: CONNECTION_EPOCH,
    fileKey: 'FILE_A',
    editorType: 'figma',
    action: 'render-plan',
    ...overrides,
  });
}

test('prepared dispatch receipts bind one request, connection, target, editor, and advertised operation', () => {
  assert.deepEqual(prepared(), {
    schema: DISPATCH_RECEIPT_SCHEMA,
    version: 1,
    requestId: REQUEST_ID,
    connectionEpoch: CONNECTION_EPOCH,
    target: { kind: 'file-key', value: 'FILE_A' },
    editorType: 'figma',
    capability: 'render-plan-v1',
    state: 'prepared',
  });
  assert.equal(KNOWN_PLUGIN_CAPABILITIES.includes(DISPATCH_RECEIPT_CAPABILITY), true);
  assert.equal(KNOWN_PLUGIN_CAPABILITIES.includes(PLUGIN_WRITE_LANE_CAPABILITY), true);
  assert.equal(operationCapability('eval'), 'eval-v1');
  assert.equal(operationCapability('render-plan-batch'), 'render-plan-batch-v1');
  assert.equal(operationCapability('reload-ui'), 'reload-ui-v1');
  assert.throws(() => operationCapability('unknown'), /unsupported Plugin action/);
});

test('draft receipts use only their authenticated connection epoch as document-session identity', () => {
  const receipt = prepared({ fileKey: null, action: 'eval', editorType: 'dev' });
  assert.deepEqual(receipt.target, { kind: 'connection', value: CONNECTION_EPOCH });
  assert.equal(receipt.capability, 'eval-v1');
  assert.equal(dispatchReceiptValidationError(receipt, { terminal: false }), null);
});

test('receipt validation is closed, bounded, and state-aware', () => {
  const receipt = prepared();
  assert.equal(dispatchReceiptValidationError(receipt, { terminal: false }), null);
  assert.match(dispatchReceiptValidationError({ ...receipt, extra: true }, { terminal: false }), /unknown field/);
  assert.match(dispatchReceiptValidationError({ ...receipt, requestId: 'short' }, { terminal: false }), /requestId/);
  assert.match(dispatchReceiptValidationError({ ...receipt, editorType: 'buzz' }, { terminal: false }), /editorType/);
  assert.match(dispatchReceiptValidationError({ ...receipt, state: 'completed' }, { terminal: false }), /prepared/);
  assert.match(dispatchReceiptValidationError(receipt, { terminal: true }), /terminal/);
  assert.match(
    dispatchReceiptValidationError({ ...receipt, target: { kind: 'file-key', value: 'x'.repeat(65) } }, { terminal: false }),
    /target value/,
  );
});

test('terminal receipts preserve identity and use closed state/reason pairs', () => {
  const receipt = prepared();
  const completed = terminalDispatchReceipt(receipt, 'completed');
  const rejected = terminalDispatchReceipt(receipt, 'not-dispatched', 'editor-mismatch');
  const failed = terminalDispatchReceipt(receipt, 'failed', 'execution-error');
  const unknown = terminalDispatchReceipt(receipt, 'unknown', 'execution-timeout');

  for (const terminal of [completed, rejected, failed, unknown]) {
    assert.equal(dispatchReceiptValidationError(terminal, { terminal: true }), null);
    assert.equal(dispatchReceiptIdentityMatches(receipt, terminal), true);
  }
  assert.throws(() => terminalDispatchReceipt(receipt, 'not-dispatched'), /reason/);
  assert.throws(() => terminalDispatchReceipt(receipt, 'completed', 'execution-error'), /reason/);
  assert.equal(dispatchReceiptIdentityMatches(receipt, { ...completed, requestId: CONNECTION_EPOCH }), false);
  assert.equal(dispatchReceiptIdentityMatches(receipt, { ...completed, target: { kind: 'file-key', value: 'FILE_B' } }), false);
});

test('Plugin preflight rejects stale connection, target, editor, and capability before execution', () => {
  const receipt = prepared();
  const actual = {
    action: 'render-plan',
    connectionEpoch: CONNECTION_EPOCH,
    fileKey: 'FILE_A',
    editorType: 'figma',
  };
  assert.deepEqual(validatePreparedDispatchContext(receipt, actual), { ok: true });
  assert.equal(validatePreparedDispatchContext(receipt, { ...actual, connectionEpoch: REQUEST_ID }).reason, 'connection-mismatch');
  assert.equal(validatePreparedDispatchContext(receipt, { ...actual, fileKey: 'FILE_B' }).reason, 'target-mismatch');
  assert.equal(validatePreparedDispatchContext(receipt, { ...actual, editorType: 'figjam' }).reason, 'editor-mismatch');
  assert.equal(validatePreparedDispatchContext(receipt, { ...actual, action: 'render-plan-batch' }).reason, 'capability-mismatch');
  assert.equal(validatePreparedDispatchContext(receipt, { ...actual, editorType: 'dev' }).reason, 'editor-mismatch');
});

test('Design render operations reject every non-Design editor while eval and reload remain editor-bound', () => {
  for (const editorType of ['figjam', 'slides', 'dev']) {
    const receipt = prepared({ editorType });
    const result = validatePreparedDispatchContext(receipt, {
      action: 'render-plan', connectionEpoch: CONNECTION_EPOCH, fileKey: 'FILE_A', editorType,
    });
    assert.equal(result.reason, 'editor-mismatch');
  }
  for (const editorType of ['figma', 'figjam', 'slides', 'dev']) {
    const receipt = prepared({ action: 'eval', editorType });
    assert.deepEqual(validatePreparedDispatchContext(receipt, {
      action: 'eval', connectionEpoch: CONNECTION_EPOCH, fileKey: 'FILE_A', editorType,
    }), { ok: true });
  }
});
