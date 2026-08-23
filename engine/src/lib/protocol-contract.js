// Runtime contracts for the authenticated execution and plugin-message seams.
//
// Cryptographic verification remains in daemon-auth/plugin-handshake. This
// module owns message shape, size and required-field validation before the
// daemon interprets any caller-controlled value.

import { assertSemanticRenderPlan } from './semantic-render-plan.js';
import { dispatchReceiptValidationError } from './dispatch-receipt.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The semantic value limit stays decimal because it is part of existing user-
// facing errors. The transport envelopes use a slightly larger binary limit so
// a maximum-size value still has room for JSON keys, targeting and timeouts.
export const MAX_PROTOCOL_VALUE_BYTES = 5_000_000;
export const MAX_EXEC_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_PLUGIN_MESSAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PROTOCOL_ERROR_BYTES = 16 * 1024;

const MAX_PROTOCOL_METADATA_BYTES = 16 * 1024;
const MAX_SELECTION_BYTES = 256 * 1024;
const MAX_REST_TOKEN_BYTES = 4096;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_CAPABILITIES = 16;
const MAX_BATCH_RESULTS = 100;

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function serializedByteLength(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : 0;
  } catch {
    return null;
  }
}

function serializedLimitError(label, value, limit, displayLimit) {
  const bytes = serializedByteLength(value);
  if (bytes === null) return `${label} must be JSON-serializable`;
  return bytes > limit ? `${label} exceeds the ${displayLimit} limit` : null;
}

function stringLimitError(label, value, limit, displayLimit = `${limit} bytes`) {
  if (typeof value !== 'string') return `${label} must be a string`;
  return byteLength(value) > limit ? `${label} exceeds the ${displayLimit} limit` : null;
}

function messageIdError(value) {
  return Number.isSafeInteger(value) && value >= 0 ? null : 'message id must be a non-negative safe integer';
}

function resultFieldsError(value, label = 'result', { dispatchReceipt = false } = {}) {
  if (dispatchReceipt) {
    const receiptError = dispatchReceiptValidationError(value.dispatchReceipt, { terminal: true });
    if (receiptError) return `${label} ${receiptError}`;
    if (value.dispatchReceipt.state === 'completed' && value.error != null) {
      return `${label} completed Dispatch Receipt must not include an error`;
    }
    if (value.dispatchReceipt.state !== 'completed' && value.error == null) {
      return `${label} non-completed Dispatch Receipt must include an error`;
    }
  }
  if (value.error != null) {
    const error = stringLimitError(`${label} error`, value.error, MAX_PROTOCOL_ERROR_BYTES, 'error size');
    if (error) return error;
  }
  if (Object.hasOwn(value, 'result')) {
    const error = serializedLimitError(`${label} value`, value.result, MAX_PROTOCOL_VALUE_BYTES, '5 MB protocol');
    if (error) return error;
  }
  if (value.metadata != null) {
    if (!isRecord(value.metadata)) return `${label} metadata must be an object`;
    const error = serializedLimitError(`${label} metadata`, value.metadata, MAX_PROTOCOL_METADATA_BYTES, 'metadata size');
    if (error) return error;
  }
  return null;
}

function selectionError(selection) {
  if (!isRecord(selection)) return 'selection payload must be an object';
  const sizeError = serializedLimitError('selection payload', selection, MAX_SELECTION_BYTES, '256 KiB protocol');
  if (sizeError) return sizeError;
  if (selection.nodes != null) {
    if (!Array.isArray(selection.nodes)) return 'selection nodes must be an array';
    if (selection.nodes.length > 50) return 'selection payload must contain at most 50 nodes';
  }
  // Field-level coercion, whitelisting and truncation intentionally happen in
  // the daemon's selection projection. Keeping admission focused on the total
  // envelope and collection shape preserves that sanitizer contract: an
  // overlong fileKey is capped and a non-string one is dropped, for example.
  for (let index = 0; index < (selection.nodes || []).length; index++) {
    const node = selection.nodes[index];
    if (!isRecord(node)) return `selection node ${index + 1} must be an object`;
  }
  return null;
}

export function validateExecPayload(value) {
  if (!isRecord(value)) return 'request body must be an object';
  if (!['eval', 'render-plan', 'render-plan-batch'].includes(value.action)) return 'action must be "eval", "render-plan", or "render-plan-batch"';
  if (value.action === 'eval') {
    if (typeof value.code !== 'string' || !value.code.length) return 'eval code must be a non-empty string';
    if (byteLength(value.code) > MAX_PROTOCOL_VALUE_BYTES) return 'eval code exceeds the 5 MB protocol limit';
  }
  if (value.action === 'render-plan') {
    try { assertSemanticRenderPlan(value.plan, { executable: true }); }
    catch (error) { return `render plan is invalid: ${error.message}`; }
    const sizeError = serializedLimitError('render plan', value.plan, MAX_PROTOCOL_VALUE_BYTES, '5 MB protocol');
    if (sizeError) return sizeError;
  }
  if (value.action === 'render-plan-batch') {
    if (!Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > 100) {
      return 'render plan batch must contain 1-100 plans';
    }
    for (let index = 0; index < value.plans.length; index++) {
      try { assertSemanticRenderPlan(value.plans[index], { executable: true }); }
      catch (error) { return `render plan batch item ${index + 1} is invalid: ${error.message}`; }
    }
    if (value.options != null && !isRecord(value.options)) return 'render plan batch options must be an object';
    if (value.options?.gap != null && (!Number.isFinite(Number(value.options.gap)) || Number(value.options.gap) < 0 || Number(value.options.gap) > 10000)) {
      return 'render plan batch gap must be between 0 and 10000';
    }
    if (value.options?.vertical != null && typeof value.options.vertical !== 'boolean') return 'render plan batch vertical must be boolean';
    const sizeError = serializedLimitError(
      'render plan batch',
      { plans: value.plans, options: value.options || {} },
      MAX_PROTOCOL_VALUE_BYTES,
      '5 MB protocol',
    );
    if (sizeError) return sizeError;
  }
  if (value.fileKey != null && (typeof value.fileKey !== 'string' || byteLength(value.fileKey) > 64)) {
    return 'fileKey must be a string of at most 64 bytes';
  }
  if (!['figma', 'figjam', 'slides', 'dev'].includes(value.expectedEditor)) {
    return 'expectedEditor must be "figma", "figjam", "slides", or "dev"';
  }
  if (value.requireDocumentRevision != null
    && (value.action !== 'eval' || typeof value.requireDocumentRevision !== 'boolean')) {
    return 'requireDocumentRevision must be a boolean on eval requests';
  }
  if (value.timeoutMs != null && (!Number.isFinite(Number(value.timeoutMs)) || Number(value.timeoutMs) <= 0)) {
    return 'timeoutMs must be a positive finite number';
  }
  if (value.deadlineAt != null && (!Number.isFinite(Number(value.deadlineAt)) || Number(value.deadlineAt) <= 0)) {
    return 'deadlineAt must be a positive finite timestamp';
  }
  return null;
}

export function validatePluginMessage(value, { authenticated = false } = {}) {
  if (!isRecord(value)) return 'plugin message must be an object';
  if (typeof value.type !== 'string') return 'plugin message type must be a string';
  const messageSizeError = serializedLimitError(
    'plugin message', value, MAX_PLUGIN_MESSAGE_BYTES, '5 MiB transport',
  );
  if (messageSizeError) return messageSizeError;
  if (!authenticated) {
    if (value.type !== 'hello') return 'expected hello before authentication';
    if (!Number.isInteger(value.proto)) return 'hello proto must be an integer';
    for (const [field, limit] of [['nonce', 128], ['version', 128], ['proof', 256]]) {
      if (typeof value[field] !== 'string' || !value[field]) return `hello ${field} must be a non-empty string`;
      const error = stringLimitError(`hello ${field}`, value[field], limit);
      if (error) return error;
    }
    if (value.capabilities != null) {
      if (!Array.isArray(value.capabilities)) return 'hello capabilities must be an array';
      if (value.capabilities.length > MAX_CAPABILITIES) return `hello must contain at most ${MAX_CAPABILITIES} capabilities`;
      for (const capability of value.capabilities) {
        if (typeof capability !== 'string') return 'hello capability must be a string';
        if (!capability || byteLength(capability) > 128) return 'hello capability must be 1-128 bytes';
      }
    }
    const handshakeSizeError = serializedLimitError(
      'hello message', value, MAX_HANDSHAKE_BYTES, '16 KiB handshake',
    );
    if (handshakeSizeError) return handshakeSizeError;
    return null;
  }
  switch (value.type) {
    case 'result': {
      const idError = messageIdError(value.id);
      if (idError) return `result ${idError}`;
      return resultFieldsError(value, 'result', { dispatchReceipt: true });
    }
    case 'lane-settled': {
      const receiptError = dispatchReceiptValidationError(value.dispatchReceipt, { terminal: true });
      return receiptError ? `lane-settled ${receiptError}` : null;
    }
    case 'batch-result':
      {
        const idError = messageIdError(value.id);
        if (idError) return `batch-result ${idError}`;
      }
      if (!Array.isArray(value.results)) return 'batch-result results must be an array';
      if (value.results.length > MAX_BATCH_RESULTS) return `batch-result must contain at most ${MAX_BATCH_RESULTS} results`;
      for (let index = 0; index < value.results.length; index++) {
        const item = value.results[index];
        if (!isRecord(item)) return `batch result item ${index + 1} must be an object`;
        if (typeof item.success !== 'boolean') return `batch result item ${index + 1} success must be boolean`;
        const itemError = resultFieldsError(item, `batch result item ${index + 1}`);
        if (itemError) return itemError;
      }
      return serializedLimitError(
        'batch-result results', value.results, MAX_PROTOCOL_VALUE_BYTES, '5 MB protocol',
      );
    case 'ping':
      return null;
    case 'rest-token':
      return stringLimitError('rest-token value', value.value, MAX_REST_TOKEN_BYTES, '4096 bytes');
    case 'selection':
      return selectionError(value.selection);
    default:
      return `unknown authenticated plugin message type: ${value.type}`;
  }
}
