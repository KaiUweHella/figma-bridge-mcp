// Runtime contracts for the authenticated execution and plugin-message seams.
//
// Cryptographic verification remains in daemon-auth/plugin-handshake. This
// module owns message shape, size and required-field validation before the
// daemon interprets any caller-controlled value.

import { assertSemanticRenderPlan } from './semantic-render-plan.js';
import {
  createPreparedDispatchReceipt,
  dispatchReceiptValidationError,
} from './dispatch-receipt.js';
import { typedReadRequestValidationError } from './typed-read-operations.js';
import {
  ASSET_STREAM_CHUNK_BYTES,
  ASSET_STREAM_MAX_BYTES,
  assetStreamRequestValidationError,
} from './asset-stream-protocol.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A Render Plan may name one explicit target slide. Shape only: whether the id
// resolves to a SLIDE is the plugin's decision at execution time.
const RENDER_PLAN_SLIDE_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

function renderPlanSlideTargetError(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || !RENDER_PLAN_SLIDE_PATTERN.test(value)) {
    return 'render plan slide must be a Figma node id';
  }
  return null;
}


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

function revisionObservationError(value) {
  if (!isRecord(value)) return 'revisionObservation must be an object';
  if (!['document', 'page'].includes(value.scope)) {
    return 'revisionObservation scope must be "document" or "page"';
  }
  const keys = Object.keys(value).sort();
  const expected = value.scope === 'page' ? ['nodeId', 'scope'] : ['scope'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return `revisionObservation ${value.scope} scope contains unknown or missing fields`;
  }
  if (value.scope === 'page'
    && (typeof value.nodeId !== 'string'
      || !/^I?\d+:\d+(;\d+:\d+)*$/.test(value.nodeId)
      || byteLength(value.nodeId) > 1024)) {
    return 'revisionObservation page nodeId must be a canonical bounded Figma node id';
  }
  return null;
}

/**
 * Prove that one eval source fits both authenticated transport envelopes after
 * JSON escaping. The placeholders use the largest accepted scalar identities,
 * so callers can run this before target selection and Plugin readiness.
 */
export function evalTransportEnvelopeError(code) {
  const rawError = stringLimitError(
    'eval code', code, MAX_PROTOCOL_VALUE_BYTES, '5 MB protocol',
  );
  if (rawError) return rawError;
  const maximumUuid = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const maximumFileKey = 'f'.repeat(64);
  const common = {
    code,
    requireDocumentRevision: true,
    revisionObservation: { scope: 'page', nodeId: '1:2' },
    timeoutMs: Number.MAX_SAFE_INTEGER,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };
  const execError = serializedLimitError('eval request', {
    action: 'eval', ...common, expectedEditor: 'figjam', fileKey: maximumFileKey,
  }, MAX_EXEC_BODY_BYTES, '5 MiB HTTP body');
  if (execError) return execError;
  const dispatchReceipt = createPreparedDispatchReceipt({
    requestId: maximumUuid,
    connectionEpoch: maximumUuid,
    fileKey: maximumFileKey,
    editorType: 'figjam',
    action: 'eval',
  });
  return serializedLimitError('eval Plugin message', {
    action: 'eval', id: Number.MAX_SAFE_INTEGER, ...common, dispatchReceipt,
  }, MAX_PLUGIN_MESSAGE_BYTES, '5 MiB Plugin message');
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
  if (!['asset-stream', 'eval', 'typed-read', 'render-plan', 'render-plan-batch'].includes(value.action)) return 'action must be "asset-stream", "eval", "typed-read", "render-plan", or "render-plan-batch"';
  if (value.action === 'asset-stream') {
    const error = assetStreamRequestValidationError(value.asset);
    if (error) return error;
    if (Object.hasOwn(value, 'code')) return 'asset-stream must not contain JavaScript code';
  }
  if (value.action === 'eval') {
    if (typeof value.code !== 'string' || !value.code.length) return 'eval code must be a non-empty string';
    if (byteLength(value.code) > MAX_PROTOCOL_VALUE_BYTES) return 'eval code exceeds the 5 MB protocol limit';
  }
  if (value.action === 'typed-read') {
    const error = typedReadRequestValidationError(value.operation, value.request);
    if (error) return error;
    if (Object.hasOwn(value, 'code')) return 'typed-read must not contain JavaScript code';
    const sizeError = serializedLimitError(
      'typed-read request', value.request, 16 * 1024, '16 KiB typed-read request',
    );
    if (sizeError) return sizeError;
  }
  if (value.action === 'render-plan') {
    try { assertSemanticRenderPlan(value.plan, { executable: true }); }
    catch (error) { return `render plan is invalid: ${error.message}`; }
    if (value.options != null && !isRecord(value.options)) return 'render plan options must be an object';
    if (value.options && Object.keys(value.options).some((key) => ![
      'smart', 'x', 'y', 'materializeResources', 'slide',
    ].includes(key))) {
      return 'render plan options contain an unknown field';
    }
    const slideError = renderPlanSlideTargetError(value.options?.slide);
    if (slideError) return slideError;
    if (value.options?.smart != null && typeof value.options.smart !== 'boolean') return 'render plan smart must be boolean';
    if (value.options?.materializeResources != null
      && typeof value.options.materializeResources !== 'boolean') {
      return 'render plan materializeResources must be boolean';
    }
    for (const key of ['x', 'y']) {
      if (value.options?.[key] != null
        && (!Number.isFinite(value.options[key]) || Math.abs(value.options[key]) > 1_000_000)) {
        return `render plan ${key} must be finite and between -1000000 and 1000000`;
      }
    }
    const sizeError = serializedLimitError(
      'render plan', { plan: value.plan, options: value.options || {} },
      MAX_PROTOCOL_VALUE_BYTES, '5 MB protocol',
    );
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
    if (value.options && Object.keys(value.options).some((key) => ![
      'gap', 'vertical', 'smart', 'x', 'y', 'materializeResources',
    ].includes(key))) {
      return 'render plan batch options contain an unknown field';
    }
    if (value.options?.gap != null && (!Number.isFinite(Number(value.options.gap)) || Number(value.options.gap) < 0 || Number(value.options.gap) > 10000)) {
      return 'render plan batch gap must be between 0 and 10000';
    }
    if (value.options?.vertical != null && typeof value.options.vertical !== 'boolean') return 'render plan batch vertical must be boolean';
    if (value.options?.smart != null && typeof value.options.smart !== 'boolean') return 'render plan batch smart must be boolean';
    if (value.options?.materializeResources != null
      && typeof value.options.materializeResources !== 'boolean') {
      return 'render plan batch materializeResources must be boolean';
    }
    for (const key of ['x', 'y']) {
      if (value.options?.[key] != null && !Number.isFinite(value.options[key])) {
        return `render plan batch ${key} must be finite`;
      }
    }
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
    && (!['asset-stream', 'eval'].includes(value.action) || typeof value.requireDocumentRevision !== 'boolean')) {
    return 'requireDocumentRevision must be a boolean on eval or asset-stream requests';
  }
  if (value.revisionObservation != null) {
    if (!['asset-stream', 'eval'].includes(value.action)) return 'revisionObservation is supported only on eval or asset-stream requests';
    const error = revisionObservationError(value.revisionObservation);
    if (error) return error;
    if (value.requireDocumentRevision !== true) {
      return 'revisionObservation requires the compatibility document-revision flag';
    }
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
    case 'asset-stream-start': {
      const idError = messageIdError(value.id);
      if (idError) return `asset-stream-start ${idError}`;
      const receiptError = dispatchReceiptValidationError(value.dispatchReceipt, { terminal: false });
      if (receiptError) return `asset-stream-start ${receiptError}`;
      if (!Number.isSafeInteger(value.totalBytes)
        || value.totalBytes < 1 || value.totalBytes > ASSET_STREAM_MAX_BYTES) {
        return `asset-stream-start totalBytes must be 1-${ASSET_STREAM_MAX_BYTES}`;
      }
      if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
        return 'asset-stream-start sha256 must be lowercase SHA-256 hex';
      }
      if (!isRecord(value.details) || !['image', 'svg'].includes(value.details.kind)) {
        return 'asset-stream-start details must identify image or svg';
      }
      const detailKeys = Object.keys(value.details).sort();
      const expected = value.details.kind === 'image' ? ['kind', 'size'] : ['kind'];
      if (detailKeys.length !== expected.length
        || detailKeys.some((key, index) => key !== expected[index])) {
        return 'asset-stream-start details contain unknown or missing fields';
      }
      if (value.details.kind === 'image' && value.details.size != null) {
        const size = value.details.size;
        if (!isRecord(size) || Object.keys(size).sort().join(',') !== 'height,width'
          || !Number.isFinite(size.width) || size.width <= 0
          || !Number.isFinite(size.height) || size.height <= 0) {
          return 'asset-stream-start image size is invalid';
        }
      }
      return null;
    }
    case 'asset-stream-chunk': {
      const idError = messageIdError(value.id);
      if (idError) return `asset-stream-chunk ${idError}`;
      if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
        return 'asset-stream-chunk sequence must be a non-negative safe integer';
      }
      const maxBase64 = Math.ceil(ASSET_STREAM_CHUNK_BYTES / 3) * 4 + 4;
      if (typeof value.base64 !== 'string' || value.base64.length < 4
        || value.base64.length > maxBase64) {
        return 'asset-stream-chunk base64 is outside the bounded chunk envelope';
      }
      return null;
    }
    case 'asset-stream-end': {
      const idError = messageIdError(value.id);
      if (idError) return `asset-stream-end ${idError}`;
      if (!Number.isSafeInteger(value.chunks) || value.chunks < 0) {
        return 'asset-stream-end chunks must be a non-negative safe integer';
      }
      return resultFieldsError(value, 'asset-stream-end', { dispatchReceipt: true });
    }
    case 'result': {
      const idError = messageIdError(value.id);
      if (idError) return `result ${idError}`;
      return resultFieldsError(value, 'result', { dispatchReceipt: true });
    }
    case 'lane-settled': {
      const receiptError = dispatchReceiptValidationError(value.dispatchReceipt, { terminal: true });
      return receiptError ? `lane-settled ${receiptError}` : null;
    }
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
