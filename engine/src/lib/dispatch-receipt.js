// Canonical Dispatch Receipt runtime. The pure functions inside the marked
// block are synchronized into plugin/code.js so the Bridge Daemon and Figma
// Plugin validate the same closed Interface without a second Implementation.

// BEGIN DISPATCH RECEIPT RUNTIME
export const DISPATCH_RECEIPT_SCHEMA = 'figma-bridge/dispatch-receipt';
export const DISPATCH_RECEIPT_CAPABILITY = 'dispatch-receipt-v1';
export const PLUGIN_WRITE_LANE_CAPABILITY = 'write-lane-v1';
export const PLUGIN_READ_LANE_CAPABILITY = 'read-lane-v1';
export const DISPATCH_OPERATION_CAPABILITIES = Object.freeze({
  eval: 'eval-v1',
  'typed-read': 'typed-read-v1',
  'render-plan': 'render-plan-v1',
  'render-plan-batch': 'render-plan-batch-v1',
  'reload-ui': 'reload-ui-v1',
});
export const KNOWN_PLUGIN_CAPABILITIES = Object.freeze([
  DISPATCH_RECEIPT_CAPABILITY,
  'eval-v1',
  'execution-deadline-v1',
  PLUGIN_READ_LANE_CAPABILITY,
  'reload-ui-v1',
  'render-plan-batch-v1',
  'render-plan-v1',
  'typed-read-v1',
  PLUGIN_WRITE_LANE_CAPABILITY,
]);

const DISPATCH_RECEIPT_FIELDS = Object.freeze([
  'capability',
  'connectionEpoch',
  'editorType',
  'reason',
  'requestId',
  'schema',
  'state',
  'target',
  'version',
]);
const DISPATCH_EDITOR_TYPES = Object.freeze(['figma', 'figjam', 'slides', 'dev']);
const DISPATCH_TERMINAL_REASONS = Object.freeze({
  'not-dispatched': Object.freeze([
    'capability-mismatch',
    'connection-mismatch',
    'deadline-elapsed',
    'editor-mismatch',
    'paused',
    'target-mismatch',
  ]),
  failed: Object.freeze(['execution-error']),
  unknown: Object.freeze(['execution-timeout']),
});
const DISPATCH_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dispatchRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function operationCapability(action) {
  const capability = DISPATCH_OPERATION_CAPABILITIES[action];
  if (!capability) throw new Error(`unsupported Plugin action for Dispatch Receipt: ${String(action)}`);
  return capability;
}

export function dispatchReceiptValidationError(receipt, { terminal = null } = {}) {
  if (!dispatchRecord(receipt)) return 'Dispatch Receipt must be an object';
  for (const field of Object.keys(receipt)) {
    if (!DISPATCH_RECEIPT_FIELDS.includes(field)) return `Dispatch Receipt has unknown field: ${field}`;
  }
  for (const field of ['schema', 'version', 'requestId', 'connectionEpoch', 'target', 'editorType', 'capability', 'state']) {
    if (!Object.hasOwn(receipt, field)) return `Dispatch Receipt is missing ${field}`;
  }
  if (receipt.schema !== DISPATCH_RECEIPT_SCHEMA || receipt.version !== 1) {
    return 'Dispatch Receipt schema/version is unsupported';
  }
  if (typeof receipt.requestId !== 'string' || !DISPATCH_UUID_RE.test(receipt.requestId)) {
    return 'Dispatch Receipt requestId must be a UUID';
  }
  if (typeof receipt.connectionEpoch !== 'string' || !DISPATCH_UUID_RE.test(receipt.connectionEpoch)) {
    return 'Dispatch Receipt connectionEpoch must be a UUID';
  }
  if (!dispatchRecord(receipt.target)) return 'Dispatch Receipt target must be an object';
  const targetFields = Object.keys(receipt.target).sort();
  if (targetFields.length !== 2 || targetFields[0] !== 'kind' || targetFields[1] !== 'value') {
    return 'Dispatch Receipt target must contain only kind and value';
  }
  if (!['file-key', 'connection'].includes(receipt.target.kind)) {
    return 'Dispatch Receipt target kind is unsupported';
  }
  if (typeof receipt.target.value !== 'string' || !receipt.target.value || receipt.target.value.length > 64) {
    return 'Dispatch Receipt target value must contain 1-64 characters';
  }
  if (receipt.target.kind === 'connection' && receipt.target.value !== receipt.connectionEpoch) {
    return 'Dispatch Receipt connection target must equal its connectionEpoch';
  }
  if (!DISPATCH_EDITOR_TYPES.includes(receipt.editorType)) {
    return 'Dispatch Receipt editorType is unsupported';
  }
  if (!Object.values(DISPATCH_OPERATION_CAPABILITIES).includes(receipt.capability)) {
    return 'Dispatch Receipt capability is unsupported';
  }

  const isTerminal = ['completed', 'not-dispatched', 'failed', 'unknown'].includes(receipt.state);
  if (terminal === false && receipt.state !== 'prepared') return 'Dispatch Receipt must be prepared';
  if (terminal === true && !isTerminal) return 'Dispatch Receipt must have a terminal state';
  if (terminal === null && receipt.state !== 'prepared' && !isTerminal) {
    return 'Dispatch Receipt state is unsupported';
  }

  if (receipt.state === 'prepared' || receipt.state === 'completed') {
    if (Object.hasOwn(receipt, 'reason')) return `Dispatch Receipt ${receipt.state} state must not have a reason`;
  } else if (isTerminal) {
    const reasons = DISPATCH_TERMINAL_REASONS[receipt.state];
    if (!reasons?.includes(receipt.reason)) return `Dispatch Receipt ${receipt.state} state has an invalid reason`;
  }
  return null;
}

export function createPreparedDispatchReceipt({
  requestId,
  connectionEpoch,
  fileKey = null,
  editorType,
  action,
}) {
  const receipt = {
    schema: DISPATCH_RECEIPT_SCHEMA,
    version: 1,
    requestId,
    connectionEpoch,
    target: fileKey
      ? { kind: 'file-key', value: fileKey }
      : { kind: 'connection', value: connectionEpoch },
    editorType,
    capability: operationCapability(action),
    state: 'prepared',
  };
  const error = dispatchReceiptValidationError(receipt, { terminal: false });
  if (error) throw new Error(error);
  return receipt;
}

export function terminalDispatchReceipt(receipt, state, reason = null) {
  const preparedError = dispatchReceiptValidationError(receipt, { terminal: false });
  if (preparedError) throw new Error(preparedError);
  const terminal = {
    ...receipt,
    state,
    ...(reason == null ? {} : { reason }),
  };
  const terminalError = dispatchReceiptValidationError(terminal, { terminal: true });
  if (terminalError) throw new Error(terminalError);
  return terminal;
}

export function dispatchReceiptIdentityMatches(prepared, terminal) {
  if (dispatchReceiptValidationError(prepared, { terminal: false })) return false;
  if (dispatchReceiptValidationError(terminal, { terminal: true })) return false;
  return prepared.schema === terminal.schema
    && prepared.version === terminal.version
    && prepared.requestId === terminal.requestId
    && prepared.connectionEpoch === terminal.connectionEpoch
    && prepared.target.kind === terminal.target.kind
    && prepared.target.value === terminal.target.value
    && prepared.editorType === terminal.editorType
    && prepared.capability === terminal.capability;
}

function dispatchContextFailure(reason, message) {
  return { ok: false, reason, message };
}

export function validatePreparedDispatchContext(receipt, {
  action,
  connectionEpoch,
  fileKey = null,
  editorType,
}) {
  const receiptError = dispatchReceiptValidationError(receipt, { terminal: false });
  if (receiptError) return dispatchContextFailure('malformed-receipt', receiptError);
  if (receipt.connectionEpoch !== connectionEpoch) {
    return dispatchContextFailure('connection-mismatch', 'Dispatch Receipt connection epoch is stale');
  }
  let expectedCapability;
  try { expectedCapability = operationCapability(action); }
  catch (error) { return dispatchContextFailure('capability-mismatch', error.message); }
  if (receipt.capability !== expectedCapability) {
    return dispatchContextFailure('capability-mismatch', 'Dispatch Receipt operation capability does not match the request');
  }
  if (receipt.editorType !== editorType) {
    return dispatchContextFailure('editor-mismatch', 'Dispatch Receipt editor does not match the active Figma editor');
  }
  if (['render-plan', 'render-plan-batch'].includes(action) && editorType !== 'figma') {
    return dispatchContextFailure('editor-mismatch', 'Semantic Render Plans require Figma Design');
  }
  if (fileKey) {
    if (receipt.target.kind !== 'file-key' || receipt.target.value !== fileKey) {
      return dispatchContextFailure('target-mismatch', 'Dispatch Receipt file does not match the active Figma file');
    }
  } else if (receipt.target.kind !== 'connection' || receipt.target.value !== connectionEpoch) {
    return dispatchContextFailure('target-mismatch', 'Dispatch Receipt draft session does not match the active Figma connection');
  }
  return { ok: true };
}
// END DISPATCH RECEIPT RUNTIME
