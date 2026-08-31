/**
 * Figma Bridge (Safe/Hardened) Plugin
 *
 * Safe Mode: connects to the local figma-bridge-mcp daemon over WebSocket.
 * No debug port, no app patching. The connection is authenticated with an
 * access key the user pastes in once; it is persisted in figma.clientStorage
 * (only reachable from this main thread, not the UI iframe) and handed to the
 * UI on request.
 */

const KEY_STORAGE = 'daemonKey';
const LOCAL_DEVELOPMENT_PLUGIN_ID = 'figma-bridge-mcp-local-development';
const BRIDGE_PORTS = Object.freeze(
  figma.pluginId === LOCAL_DEVELOPMENT_PLUGIN_ID
    ? [3460]
    : [3456, 3457, 3458, 3459, 3460],
);
// Minimal durable identity shared with figma-bridge.json. Repository paths
// deliberately stay outside the Figma document; the plugin stores only the
// stable Design Entity handle needed to resolve them server-side.
const DESIGN_ENTITY_STORAGE = 'figma-bridge-design-entity';

// Monotonic document revision for freshness-safe Design Captures. A plugin
// restart resets this counter, but the daemon assigns every authenticated
// socket a new connectionId, so revision 0 can never revive an older Capture.
// If this editor does not expose documentchange, null disables caching.
let documentRevision = 0;
let documentRevisionAvailable = false;
let activeConnectionEpoch = null;
const replayableLaneSettlements = [];
const MAX_REPLAYABLE_LANE_SETTLEMENTS = 8;
// dynamic-page plugins must load all pages before subscribing to the
// document-wide event. Initialize it only for Commands that explicitly need
// a multi-roundtrip revision proof: Figma warns that loading every page can be
// slow in large files, so ordinary reads/writes must retain dynamic loading.
let documentRevisionReady = null;
function ensureDocumentRevisionReady() {
  if (!documentRevisionReady) {
    documentRevisionReady = (async () => {
      try {
        await figma.loadAllPagesAsync();
        figma.on('documentchange', () => {
          if (documentRevision < Number.MAX_SAFE_INTEGER) documentRevision++;
          else documentRevisionAvailable = false;
        });
        documentRevisionAvailable = true;
      } catch (e) {
        documentRevisionAvailable = false;
      }
    })();
  }
  return documentRevisionReady;
}

const MAX_PAGE_REVISION_OBSERVERS = 512;
const pageRevisionObservers = new Map();
async function ensurePageRevisionReady(nodeId) {
  let node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error('Revision observation target was not found.');
  while (node && node.type !== 'PAGE') node = node.parent;
  if (!node || node.type !== 'PAGE') {
    throw new Error('Revision observation target is not attached to a Figma page.');
  }
  let observer = pageRevisionObservers.get(node.id);
  if (!observer) {
    if (pageRevisionObservers.size >= MAX_PAGE_REVISION_OBSERVERS) {
      throw new Error('Page revision observer limit exceeded. Reopen the plugin, then retry.');
    }
    observer = { page: node, pageId: node.id, revision: 0 };
    node.on('nodechange', () => {
      if (observer.revision < Number.MAX_SAFE_INTEGER) observer.revision++;
      else observer.revision = null;
    });
    pageRevisionObservers.set(node.id, observer);
  }
  if (!Number.isSafeInteger(observer.revision)) {
    throw new Error('Page revision observation is no longer available. Reopen the plugin, then retry.');
  }
  return observer;
}

function revisionMetadata(before, executionTiming = null) {
  const after = documentRevisionAvailable ? documentRevision : null;
  return {
    documentRevisionBefore: before,
    documentRevisionAfter: after,
    revisionObservation: {
      scope: 'document',
      revisionBefore: before,
      revisionAfter: after,
    },
    ...(executionTiming ? { executionTiming } : {}),
  };
}

function pageRevisionMetadata(observer, before, executionTiming = null) {
  return {
    documentRevisionBefore: null,
    documentRevisionAfter: null,
    revisionObservation: {
      scope: 'page',
      pageId: observer.pageId,
      revisionBefore: before,
      revisionAfter: Number.isSafeInteger(observer.revision) ? observer.revision : null,
    },
    ...(executionTiming ? { executionTiming } : {}),
  };
}

// Generated runtime: npm run sync:plugin. Edit the canonical module at
// engine/src/lib/plugin-execution-timing.js, never this marked block.
// BEGIN PLUGIN EXECUTION TIMING RUNTIME
const PLUGIN_EXECUTION_TIMING_SCHEMA = 'figma-bridge/plugin-execution-timing';
const PLUGIN_EXECUTION_TIMING_VERSION = 1;
const MAX_PLUGIN_EXECUTION_TIMING_MS = 130_000;

const PLUGIN_EXECUTION_TIMING_FIELDS = Object.freeze([
  'schema',
  'version',
  'queuedMs',
  'executionMs',
  'totalMs',
]);

function pluginExecutionDuration(start, end) {
  return Math.max(0, Math.min(MAX_PLUGIN_EXECUTION_TIMING_MS, Math.round(end - start)));
}

function createPluginExecutionTiming({ queuedAt, startedAt, finishedAt }) {
  const queuedMs = pluginExecutionDuration(queuedAt, startedAt);
  const executionMs = pluginExecutionDuration(startedAt, finishedAt);
  return Object.freeze({
    schema: PLUGIN_EXECUTION_TIMING_SCHEMA,
    version: PLUGIN_EXECUTION_TIMING_VERSION,
    queuedMs,
    executionMs,
    totalMs: Math.min(MAX_PLUGIN_EXECUTION_TIMING_MS, queuedMs + executionMs),
  });
}

function pluginExecutionTimingValidationError(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Plugin execution timing must be an object';
  }
  const keys = Object.keys(value).sort();
  const expected = [...PLUGIN_EXECUTION_TIMING_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return 'Plugin execution timing contains unknown or missing fields';
  }
  if (value.schema !== PLUGIN_EXECUTION_TIMING_SCHEMA
      || value.version !== PLUGIN_EXECUTION_TIMING_VERSION) {
    return 'Plugin execution timing schema/version is unsupported';
  }
  for (const field of ['queuedMs', 'executionMs', 'totalMs']) {
    if (!Number.isSafeInteger(value[field])
        || value[field] < 0
        || value[field] > MAX_PLUGIN_EXECUTION_TIMING_MS) {
      return `Plugin execution timing ${field} must be a bounded integer`;
    }
  }
  const expectedTotal = Math.min(
    MAX_PLUGIN_EXECUTION_TIMING_MS,
    value.queuedMs + value.executionMs,
  );
  if (value.totalMs !== expectedTotal) {
    return 'Plugin execution timing total does not match its segments';
  }
  return null;
}

function parsePluginExecutionTiming(value) {
  if (pluginExecutionTimingValidationError(value)) return null;
  return Object.freeze({
    schema: value.schema,
    version: value.version,
    queuedMs: value.queuedMs,
    executionMs: value.executionMs,
    totalMs: value.totalMs,
  });
}
// END PLUGIN EXECUTION TIMING RUNTIME

// Generated runtime: npm run sync:plugin. Edit the canonical module at
// engine/src/lib/asset-stream-protocol.js, never this marked block.
// BEGIN ASSET STREAM RUNTIME
const ASSET_STREAM_CAPABILITY = "asset-stream-v1";
const ASSET_STREAM_CHUNK_BYTES = 256 * 1024;
const ASSET_STREAM_MAX_BYTES = 512 * 1024 * 1024;
const ASSET_STREAM_HASH_BLOCKS_PER_YIELD = 16 * 1024;

const ASSET_STREAM_SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function assetStreamRotate(value, count) {
  return ((value >>> count) | (value << (32 - count))) >>> 0;
}

function assetStreamRequestValidationError(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "asset stream request must be an object";
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "ref") {
    return "asset stream request must contain only kind and ref";
  }
  if (!['image', 'svg'].includes(value.kind)) {
    return 'asset stream kind must be "image" or "svg"';
  }
  if (typeof value.ref !== "string" || value.ref.length < 1 || value.ref.length > 1024) {
    return "asset stream ref must be a 1-1024 character string";
  }
  if (value.kind === "svg" && !/^I?\d+:\d+(;\d+:\d+)*$/u.test(value.ref)) {
    return "asset stream SVG ref must be a canonical Figma node id";
  }
  return null;
}

// SHA-256 reads virtual padding bytes instead of allocating a second buffer
// proportional to the asset. Figma's API already returns one Uint8Array; the
// stream protocol adds only one 64-word schedule and one bounded chunk view.
async function assetStreamSha256(bytes, {
  checkpoint = () => {},
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Asset stream SHA-256 requires Uint8Array bytes.");
  }
  const length = bytes.length;
  if (length < 1 || length > ASSET_STREAM_MAX_BYTES) {
    throw new Error("Asset stream bytes exceed the bounded single-asset range.");
  }
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const bitHigh = Math.floor((length * 8) / 0x100000000) >>> 0;
  const bitLow = (length * 8) >>> 0;
  const paddingByte = (index) => {
    if (index < length) return bytes[index];
    if (index === length) return 0x80;
    if (index < paddedLength - 8) return 0;
    const shift = (7 - (index - (paddedLength - 8))) * 8;
    return shift >= 32
      ? (bitHigh >>> (shift - 32)) & 0xff
      : (bitLow >>> shift) & 0xff;
  };
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f,
    0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  let blocksSinceYield = 0;
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] =
        (paddingByte(at) << 24) |
        (paddingByte(at + 1) << 16) |
        (paddingByte(at + 2) << 8) |
        paddingByte(at + 3);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const s0 =
        assetStreamRotate(left, 7) ^
        assetStreamRotate(left, 18) ^
        (left >>> 3);
      const s1 =
        assetStreamRotate(right, 17) ^
        assetStreamRotate(right, 19) ^
        (right >>> 10);
      words[index] =
        (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const upper =
        assetStreamRotate(e, 6) ^
        assetStreamRotate(e, 11) ^
        assetStreamRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first =
        (h + upper + choice + ASSET_STREAM_SHA_K[index] + words[index]) >>> 0;
      const lower =
        assetStreamRotate(a, 2) ^
        assetStreamRotate(a, 13) ^
        assetStreamRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
    blocksSinceYield += 1;
    if (
      blocksSinceYield >= ASSET_STREAM_HASH_BLOCKS_PER_YIELD &&
      offset + 64 < paddedLength
    ) {
      checkpoint();
      await yieldControl();
      blocksSinceYield = 0;
    }
  }
  checkpoint();
  return Array.from(hash, (value) => value.toString(16).padStart(8, "0")).join("");
}

async function readAssetStreamSource(figmaApi, request) {
  const error = assetStreamRequestValidationError(request);
  if (error) throw new Error(error);
  if (request.kind === "image") {
    const image = figmaApi.getImageByHash(request.ref);
    if (!image) throw new Error("image not found");
    const bytes = await image.getBytesAsync();
    let size = null;
    try {
      size = await image.getSizeAsync();
    } catch {}
    return { bytes, details: { kind: "image", size } };
  }
  const node = await figmaApi.getNodeByIdAsync(request.ref);
  if (!node) throw new Error("node not found");
  if (!("exportAsync" in node)) throw new Error("node cannot be exported");
  return {
    bytes: await node.exportAsync({ format: "SVG" }),
    details: { kind: "svg" },
  };
}
// END ASSET STREAM RUNTIME

// Generated runtime: npm run sync:plugin. Edit the canonical module at
// engine/src/lib/dispatch-receipt.js, never this marked block.
// BEGIN DISPATCH RECEIPT RUNTIME
const DISPATCH_RECEIPT_SCHEMA = 'figma-bridge/dispatch-receipt';
const DISPATCH_RECEIPT_CAPABILITY = 'dispatch-receipt-v1';
const PLUGIN_WRITE_LANE_CAPABILITY = 'write-lane-v1';
const PLUGIN_READ_LANE_CAPABILITY = 'read-lane-v1';
const DISPATCH_OPERATION_CAPABILITIES = Object.freeze({
  'asset-stream': 'asset-stream-v1',
  eval: 'eval-v1',
  'typed-read': 'typed-read-v1',
  'render-plan': 'render-plan-v1',
  'render-plan-batch': 'render-plan-batch-v1',
  'reload-ui': 'reload-ui-v1',
});
const KNOWN_PLUGIN_CAPABILITIES = Object.freeze([
  'asset-stream-v1',
  DISPATCH_RECEIPT_CAPABILITY,
  'eval-v1',
  'execution-deadline-v1',
  'page-revision-v1',
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

function operationCapability(action) {
  const capability = DISPATCH_OPERATION_CAPABILITIES[action];
  if (!capability) throw new Error(`unsupported Plugin action for Dispatch Receipt: ${String(action)}`);
  return capability;
}

function dispatchReceiptValidationError(receipt, { terminal = null } = {}) {
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

function createPreparedDispatchReceipt({
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

function terminalDispatchReceipt(receipt, state, reason = null) {
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

function dispatchReceiptIdentityMatches(prepared, terminal) {
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

function validatePreparedDispatchContext(receipt, {
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

// BEGIN TYPED READ RUNTIME
const TYPED_READ_CAPABILITY = 'typed-read-v1';
const BRIDGE_HEALTH_TYPED_READ = 'bridge-health-v1';
const STYLE_CONSUMERS_TYPED_READ = 'style-consumers-v1';
const NODE_BINDINGS_TYPED_READ = 'node-bindings-v1';
const TOKEN_OVERLAP_TYPED_READ = 'token-overlap-v1';
const COMPONENT_PROPERTY_LIST_TYPED_READ = 'component-property-list-v1';
const TYPED_READ_OPERATIONS = Object.freeze([
  BRIDGE_HEALTH_TYPED_READ,
  STYLE_CONSUMERS_TYPED_READ,
  NODE_BINDINGS_TYPED_READ,
  TOKEN_OVERLAP_TYPED_READ,
  COMPONENT_PROPERTY_LIST_TYPED_READ,
]);

function typedReadRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typedReadExactKeys(value, keys) {
  return typedReadRecord(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function typedReadAnchorError(value) {
  const fields = new Set([
    'fillStyleId', 'strokeStyleId', 'backgroundStyleId', 'textStyleId',
    'effectStyleId', 'gridStyleId',
  ]);
  if (!typedReadExactKeys(value, ['nodeId', 'fields'])) return 'after must contain only nodeId and fields';
  if (typeof value.nodeId !== 'string' || value.nodeId.length < 1 || value.nodeId.length > 1024) {
    return 'after nodeId must contain 1-1024 code units';
  }
  if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > fields.size
    || value.fields.some((field) => !fields.has(field))
    || new Set(value.fields).size !== value.fields.length
    || value.fields.some((field, index) => index > 0 && value.fields[index - 1] >= field)) {
    return 'after fields must be a sorted unique inherited-style field set';
  }
  return null;
}

function typedReadRequestValidationError(operation, request) {
  if (!TYPED_READ_OPERATIONS.includes(operation)) return 'typed-read operation is unsupported';
  if (operation === BRIDGE_HEALTH_TYPED_READ) {
    return typedReadExactKeys(request, [])
      ? null
      : 'Bridge health typed-read request contains an unknown field';
  }
  if (operation === NODE_BINDINGS_TYPED_READ) {
    if (!typedReadExactKeys(request, ['nodeId'])) {
      return 'Node Binding Facts typed-read request has an unknown or missing field';
    }
    if (request.nodeId !== null && (typeof request.nodeId !== 'string'
      || request.nodeId.length < 1 || request.nodeId.length > 512
      || !/^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/.test(request.nodeId))) {
      return 'Node Binding Facts typed-read nodeId is invalid';
    }
    return null;
  }
  if (operation === COMPONENT_PROPERTY_LIST_TYPED_READ) {
    if (!typedReadExactKeys(request, ['componentId'])) {
      return 'Component Property Facts typed-read request has an unknown or missing field';
    }
    if (request.componentId !== null && (typeof request.componentId !== 'string'
      || request.componentId.length < 1 || request.componentId.length > 512
      || !/^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/.test(request.componentId))) {
      return 'Component Property Facts typed-read componentId is invalid';
    }
    return null;
  }
  if (operation === TOKEN_OVERLAP_TYPED_READ) {
    if (!typedReadExactKeys(request, ['queries', 'limit'])) {
      return 'Token Overlap typed-read request has an unknown or missing field';
    }
    if (!Array.isArray(request.queries) || request.queries.length < 2
      || request.queries.length > 32) {
      return 'Token Overlap typed-read requires 2-32 Collection queries';
    }
    if (request.queries.some((query) => typeof query !== 'string' || !query.trim()
      || query.length > 512
      || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(query))) {
      return 'Token Overlap typed-read Collection query is invalid';
    }
    const folded = request.queries.map((query) => query.toLocaleLowerCase('en-US'));
    if (new Set(folded).size !== folded.length) {
      return 'Token Overlap typed-read Collection queries must be unique';
    }
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
      return 'Token Overlap typed-read limit must be 1-1000';
    }
    return null;
  }
  if (!typedReadExactKeys(request, ['style', 'type', 'limit', 'after'])) {
    return 'Style Consumer typed-read request has an unknown or missing field';
  }
  if (typeof request.style !== 'string' || request.style.length < 1 || request.style.length > 512
    || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(request.style)) {
    return 'Style Consumer typed-read style is invalid';
  }
  if (request.type !== null && !['PAINT', 'TEXT', 'EFFECT', 'GRID'].includes(request.type)) {
    return 'Style Consumer typed-read type is invalid';
  }
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500) {
    return 'Style Consumer typed-read limit must be 1-500';
  }
  if (request.after !== null) return typedReadAnchorError(request.after);
  return null;
}

async function executeStyleConsumersTypedRead(figmaApi, request) {
  const requestError = typedReadRequestValidationError(STYLE_CONSUMERS_TYPED_READ, request);
  if (requestError) throw new Error(requestError);
  const maxStyleCandidates = 10_000;
  const maxConsumers = 100_000;
  const maxSerializedCodeUnits = 250_000;
  const allowedFields = new Set([
    'fillStyleId', 'strokeStyleId', 'backgroundStyleId', 'textStyleId',
    'effectStyleId', 'gridStyleId',
  ]);
  const direct = await figmaApi.getStyleByIdAsync(request.style);
  let style = direct && (!request.type || direct.type === request.type) ? direct : null;
  let resolution = 'id';
  if (!style) {
    const loaders = {
      PAINT: () => figmaApi.getLocalPaintStylesAsync(),
      TEXT: () => figmaApi.getLocalTextStylesAsync(),
      EFFECT: () => figmaApi.getLocalEffectStylesAsync(),
      GRID: () => figmaApi.getLocalGridStylesAsync(),
    };
    const lists = request.type
      ? [await loaders[request.type]()]
      : await Promise.all(Object.values(loaders).map((load) => load()));
    const pool = lists.flat();
    if (pool.length > maxStyleCandidates) {
      throw new Error('Style Consumer style-candidate limit exceeded. Use an exact style id.');
    }
    const exact = pool.filter((candidate) => candidate.name === request.style);
    const matches = exact.length ? exact
      : pool.filter((candidate) => candidate.name.toLowerCase().includes(request.style.toLowerCase()));
    if (matches.length > 1) throw new Error('Style reference is ambiguous (' + matches.length + ' matches). Use an exact style id or name.');
    if (matches.length === 0) throw new Error('Style not found in the targeted Figma document.');
    style = matches[0];
    resolution = exact.length ? 'exact-name' : 'partial-name';
  }
  if (typeof style.id !== 'string' || typeof style.key !== 'string'
    || typeof style.name !== 'string' || typeof style.remote !== 'boolean'
    || !['PAINT', 'TEXT', 'EFFECT', 'GRID'].includes(style.type)
    || typeof style.getStyleConsumersAsync !== 'function') {
    throw new Error('Style Consumer encountered incompatible publishable metadata.');
  }
  const nativeConsumers = await style.getStyleConsumersAsync();
  if (!Array.isArray(nativeConsumers) || nativeConsumers.length > maxConsumers) {
    throw new Error('Style Consumer candidate limit exceeded.');
  }
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const consumers = nativeConsumers.map((consumer) => {
    if (!consumer || !consumer.node || !Array.isArray(consumer.fields)
      || typeof consumer.node.id !== 'string' || typeof consumer.node.name !== 'string'
      || typeof consumer.node.type !== 'string' || consumer.node.id.length < 1
      || consumer.node.id.length > 1024 || consumer.node.name.length > 1024) {
      throw new Error('Style Consumer encountered incompatible node metadata.');
    }
    const fields = [...consumer.fields].sort(compareText);
    if (fields.length < 1 || fields.length > allowedFields.size
      || new Set(fields).size !== fields.length
      || fields.some((field) => !allowedFields.has(field))) {
      throw new Error('Style Consumer encountered an incompatible inherited style field.');
    }
    return { node: { id: consumer.node.id, name: consumer.node.name, type: consumer.node.type }, fields };
  });
  const compare = (left, right) => compareText(left.node.id, right.node.id)
    || compareText(left.fields.join('\u0000'), right.fields.join('\u0000'));
  consumers.sort(compare);
  for (let index = 1; index < consumers.length; index++) {
    if (compare(consumers[index - 1], consumers[index]) === 0) {
      throw new Error('Style Consumer returned a duplicate node/field identity.');
    }
  }
  let start = 0;
  if (request.after) {
    const anchorIndex = consumers.findIndex((consumer) => consumer.node.id === request.after.nodeId
      && consumer.fields.length === request.after.fields.length
      && consumer.fields.every((field, index) => field === request.after.fields[index]));
    if (anchorIndex === -1) throw new Error('Style Consumer cursor is stale. Restart without --cursor.');
    start = anchorIndex + 1;
  }
  const end = Math.min(consumers.length, start + request.limit);
  const page = consumers.slice(start, end);
  const omittedBefore = start;
  const omittedAfter = consumers.length - end;
  const payload = {
    schemaVersion: 1,
    resolution,
    query: request.style,
    requestedType: request.type,
    style: { id: style.id, key: style.key, name: style.name, type: style.type, remote: style.remote },
    scan: { api: 'getStyleConsumersAsync', complete: true, interruptible: false },
    cursorAnchor: request.after,
    total: consumers.length,
    returned: page.length,
    omitted: omittedBefore + omittedAfter,
    omittedBefore,
    omittedAfter,
    complete: omittedBefore === 0 && omittedAfter === 0,
    nextAnchor: omittedAfter > 0
      ? { nodeId: page[page.length - 1].node.id, fields: page[page.length - 1].fields }
      : null,
    consumers: page,
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > maxSerializedCodeUnits) {
    throw new Error('Style Consumer serialized-size limit exceeded. Lower --limit.');
  }
  return serialized;
}

async function executeNodeBindingsTypedRead(figmaApi, request) {
  const requestError = typedReadRequestValidationError(NODE_BINDINGS_TYPED_READ, request);
  if (requestError) throw new Error(requestError);
  const maxNodes = 128;
  const maxFacts = 384;
  const maxLabel = 512;
  const maxResources = 20_000;
  const maxField = 128;
  const maxId = 512;
  const maxSerializedCodeUnits = 1_000_000;
  const lookupTimeoutMs = 7000;
  const clean = (value, limit) => {
    const text = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
    if (text.length > limit) {
      throw new Error('Figma Node Binding Facts exceed the bounded result contract.');
    }
    return text;
  };
  async function findTarget(id) {
    let timeoutHandle;
    try {
      return await Promise.race([
        figmaApi.getNodeByIdAsync(id),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(
            'Figma node lookup timed out before the bounded read: ' + id,
          )), lookupTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
    }
  }
  const target = request.nodeId ? await findTarget(request.nodeId) : null;
  if (request.nodeId && !target) {
    throw new Error('Node not found in the targeted Figma document: ' + request.nodeId);
  }
  const nodes = request.nodeId ? [target] : Array.from(figmaApi.currentPage.selection || []);
  if (nodes.length > maxNodes) {
    throw new Error('Figma selection exceeds the bounded Node Binding Facts contract.');
  }

  const variableCache = new Map();
  const collectionCache = new Map();
  let localVariables = null;
  let localCollections = null;
  let factCount = 0;
  async function localVariable(id) {
    if (localVariables === null) {
      localVariables = false;
      if (typeof figmaApi.variables.getLocalVariablesAsync === 'function') {
        try {
          const candidates = await figmaApi.variables.getLocalVariablesAsync();
          if (!Array.isArray(candidates) || candidates.length > maxResources) {
            throw new Error('Figma local Variable catalog exceeds the bounded Node Binding Facts contract.');
          }
          localVariables = new Map(candidates
            .filter((candidate) => candidate && candidate.remote === false
              && typeof candidate.id === 'string' && candidate.id.length <= maxId)
            .map((candidate) => [candidate.id, candidate]));
        } catch (error) {
          if (/exceeds the bounded/.test(String(error && error.message || error))) throw error;
        }
      }
    }
    return localVariables && localVariables.get(id) || null;
  }
  async function localCollection(id) {
    if (localCollections === null) {
      localCollections = false;
      if (typeof figmaApi.variables.getLocalVariableCollectionsAsync === 'function') {
        try {
          const candidates = await figmaApi.variables.getLocalVariableCollectionsAsync();
          if (!Array.isArray(candidates) || candidates.length > maxResources) {
            throw new Error('Figma local Collection catalog exceeds the bounded Node Binding Facts contract.');
          }
          localCollections = new Map(candidates
            .filter((candidate) => candidate && candidate.remote === false
              && typeof candidate.id === 'string' && candidate.id.length <= maxId)
            .map((candidate) => [candidate.id, candidate]));
        } catch (error) {
          if (/exceeds the bounded/.test(String(error && error.message || error))) throw error;
        }
      }
    }
    return localCollections && localCollections.get(id) || null;
  }
  async function collectionFact(collectionId) {
    if (!collectionId) return null;
    const id = clean(collectionId, maxId);
    if (collectionCache.has(id)) return collectionCache.get(id);
    let collection = await localCollection(id);
    if (!collection && typeof figmaApi.variables.getVariableCollectionByIdAsync === 'function') {
      try { collection = await figmaApi.variables.getVariableCollectionByIdAsync(id); } catch {}
    }
    const fact = { id, name: collection ? clean(collection.name, maxLabel) : null, resolved: !!collection };
    collectionCache.set(id, fact);
    return fact;
  }
  async function variableFact(alias) {
    if (!alias || typeof alias.id !== 'string') {
      throw new Error('Figma returned unsupported node binding topology.');
    }
    const id = clean(alias.id, maxId);
    if (variableCache.has(id)) return variableCache.get(id);
    let variable = await localVariable(id);
    if (!variable && typeof figmaApi.variables.getVariableByIdAsync === 'function') {
      try { variable = await figmaApi.variables.getVariableByIdAsync(id); } catch {}
    }
    const fact = variable ? {
      id,
      name: clean(variable.name, maxLabel),
      resolvedType: clean(variable.resolvedType, 64),
      collection: await collectionFact(variable.variableCollectionId),
      resolved: true,
    } : { id, name: null, resolvedType: null, collection: null, resolved: false };
    variableCache.set(id, fact);
    return fact;
  }
  async function bindingFact(field, variableAlias, index = null, propertyName = null) {
    factCount++;
    if (factCount > maxFacts) {
      throw new Error('Figma node bindings exceed the bounded Node Binding Facts contract.');
    }
    return {
      field: clean(field, maxField),
      index,
      propertyName: propertyName == null ? null : clean(propertyName, maxLabel),
      variable: await variableFact(variableAlias),
    };
  }

  const results = [];
  for (const node of nodes) {
    const bindings = [];
    for (const [field, value] of Object.entries(node.boundVariables || {})) {
      if (field === 'componentProperties' && value && typeof value === 'object'
        && !Array.isArray(value) && typeof value.id !== 'string') {
        for (const [propertyName, variableAlias] of Object.entries(value)) {
          if (variableAlias == null) continue;
          bindings.push(await bindingFact(field, variableAlias, null, propertyName));
        }
      } else if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          if (value[index] == null) continue;
          bindings.push(await bindingFact(field, value[index], index));
        }
      } else if (value != null) {
        bindings.push(await bindingFact(field, value));
      }
    }
    results.push({
      id: clean(node.id, 96),
      name: clean(node.name, maxLabel),
      type: clean(node.type, 64),
      bindings,
    });
  }
  const payload = {
    schemaVersion: 1,
    source: request.nodeId ? 'node' : 'selection',
    nodes: results,
  };
  if (JSON.stringify(payload).length > maxSerializedCodeUnits) {
    throw new Error('Figma Node Binding Facts exceed the bounded serialized result contract.');
  }
  return payload;
}

async function executeComponentPropertyListTypedRead(figmaApi, request) {
  const requestError = typedReadRequestValidationError(COMPONENT_PROPERTY_LIST_TYPED_READ, request);
  if (requestError) throw new Error(requestError);
  const maxProperties = 50_000;
  const maxName = 1_024;
  const maxValue = 200_000;
  const maxOptions = 10_000;
  const maxVisits = 50_000;
  const maxSerializedCodeUnits = 700_000;
  const lookupTimeoutMs = 7_000;
  const own = (record, key) => record && Object.prototype.hasOwnProperty.call(record, key);
  const clean = (value, maximum) => typeof value === 'string'
    ? value.slice(0, maximum).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ')
    : '';
  async function findTarget(id) {
    let timeoutHandle;
    try {
      return await Promise.race([
        figmaApi.getNodeByIdAsync(id),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(
            'Figma component lookup timed out before the bounded read: ' + id,
          )), lookupTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
    }
  }
  const node = request.componentId === null
    ? figmaApi.currentPage?.selection?.[0]
    : await findTarget(request.componentId);
  if (!node) throw new Error(request.componentId === null
    ? 'Select one local Component or Component Set.'
    : 'Node not found: ' + request.componentId);
  if (!['COMPONENT', 'COMPONENT_SET'].includes(node.type) || node.remote !== false) {
    throw new Error('Component Property List requires one local Component or Component Set.');
  }
  const definitions = node.componentPropertyDefinitions;
  if (!typedReadRecord(definitions)) throw new Error('Component returned invalid property definitions.');
  const entries = Object.entries(definitions);
  if (entries.length > maxProperties) throw new Error('Component exceeds the bounded property-definition count.');
  const bindings = new Map(entries.map(([name]) => [name, []]));
  const slotDefinitionNames = entries
    .filter(([, definition]) => definition?.type === 'SLOT')
    .map(([name]) => name);
  const nestedInstances = [];
  const slots = [];
  const stack = Array.isArray(node.children) ? [...node.children].reverse() : [];
  let visits = 0;
  while (stack.length) {
    if (++visits > maxVisits) throw new Error('Component exceeds the bounded sublayer visit count.');
    const child = stack.pop();
    if (!typedReadRecord(child)) throw new Error('Component contains an invalid sublayer.');
    if (!['INSTANCE', 'SLOT'].includes(child.type) && Array.isArray(child.children)) {
      for (let index = child.children.length - 1; index >= 0; index--) stack.push(child.children[index]);
    }
    const references = child.componentPropertyReferences;
    if (references !== null && references !== undefined) {
      if (!typedReadRecord(references)) throw new Error('Component contains invalid property references.');
      for (const field of ['visible', 'characters', 'mainComponent']) {
        if (!own(references, field)) continue;
        const property = references[field];
        if (typeof property !== 'string' || property.length > maxName) {
          throw new Error('Component contains an invalid property reference.');
        }
        if (!bindings.has(property)) {
          throw new Error('Component sublayer references an unknown property definition.');
        }
        bindings.get(property).push({
          nodeId: child.id,
          nodeName: clean(String(child.name || ''), maxName),
          nodeType: clean(String(child.type || ''), 64),
          field,
        });
      }
    }
    if (child.type === 'INSTANCE') {
      if (typeof child.isExposedInstance !== 'boolean') {
        throw new Error('Nested Instance returned invalid exposure metadata.');
      }
      nestedInstances.push({
        id: child.id,
        name: clean(String(child.name || ''), maxName),
        exposed: child.isExposedInstance,
      });
    }
    if (child.type === 'SLOT') {
      const violations = Array.isArray(child.limitViolations) ? child.limitViolations : [];
      if (violations.some((value) => !['BELOW_MIN', 'ABOVE_MAX', 'HAS_NON_PREFERRED'].includes(value))) {
        throw new Error('Slot returned invalid limit violations.');
      }
      slots.push({
        id: child.id,
        name: clean(String(child.name || ''), maxName),
        childCount: Array.isArray(child.children) ? child.children.length : 0,
        limitViolations: violations,
        property: null,
      });
    }
  }
  const baseName = (value) => String(value).split('#')[0].trim().toLowerCase();
  const assignedSlotProperties = new Set();
  for (const slot of slots) {
    const matches = slotDefinitionNames.filter((name) => !assignedSlotProperties.has(name)
      && (name === slot.name || baseName(name) === baseName(slot.name)));
    if (matches.length === 1) {
      slot.property = matches[0];
      assignedSlotProperties.add(matches[0]);
    }
  }
  const unmatchedSlots = slots.filter((slot) => slot.property === null);
  const unmatchedSlotProperties = slotDefinitionNames.filter((name) => !assignedSlotProperties.has(name));
  if (unmatchedSlots.length === 1 && unmatchedSlotProperties.length === 1) {
    unmatchedSlots[0].property = unmatchedSlotProperties[0];
  }

  const properties = entries.map(([name, definition]) => {
    const defaultValue = definition?.type === 'SLOT' && definition.defaultValue === undefined
      ? null : definition?.defaultValue;
    if (typeof name !== 'string' || !name || name.length > maxName
      || !typedReadRecord(definition)
      || typeof definition.type !== 'string' || !definition.type || definition.type.length > 64
      || !((definition.type === 'SLOT' && defaultValue === null)
        || typeof defaultValue === 'boolean'
        || (typeof defaultValue === 'string' && defaultValue.length <= maxValue))) {
      throw new Error('Component Property List encountered incompatible definition metadata.');
    }
    const variantOptions = definition.variantOptions === undefined ? null : definition.variantOptions;
    if (variantOptions !== null && (!Array.isArray(variantOptions)
      || variantOptions.length > maxOptions
      || variantOptions.some((option) => typeof option !== 'string' || option.length > maxName))) {
      throw new Error('Component Property List encountered invalid Variant options.');
    }
    const preferredValues = definition.preferredValues === undefined ? null : definition.preferredValues;
    if (preferredValues !== null && (!Array.isArray(preferredValues)
      || preferredValues.length > maxOptions
      || preferredValues.some((value) => !typedReadRecord(value)
        || !['COMPONENT', 'COMPONENT_SET'].includes(value.type)
        || typeof value.key !== 'string' || !value.key || value.key.length > maxName))) {
      throw new Error('Component Property List encountered invalid preferred values.');
    }
    const description = definition.description === undefined ? null : definition.description;
    if (description !== null && (typeof description !== 'string' || description.length > maxValue)) {
      throw new Error('Component Property List encountered an invalid description.');
    }
    const slotSettings = definition.slotSettings === undefined ? null : definition.slotSettings;
    if (slotSettings !== null && !typedReadRecord(slotSettings)) {
      throw new Error('Component Property List encountered invalid Slot settings.');
    }
    if (slotSettings !== null) {
      const allowed = new Set(['stretchChildOnInsert', 'displayEmptyByDefault', 'minChildren', 'maxChildren', 'allowPreferredValuesOnly']);
      if (Object.keys(slotSettings).some((key) => !allowed.has(key))) {
        throw new Error('Component Property List encountered unknown Slot settings.');
      }
      for (const key of ['stretchChildOnInsert', 'displayEmptyByDefault', 'allowPreferredValuesOnly']) {
        if (slotSettings[key] !== undefined && typeof slotSettings[key] !== 'boolean') {
          throw new Error('Component Property List encountered an invalid Slot Boolean setting.');
        }
      }
      for (const key of ['minChildren', 'maxChildren']) {
        if (slotSettings[key] !== undefined && slotSettings[key] !== null
          && (!Number.isSafeInteger(slotSettings[key]) || slotSettings[key] < 0)) {
          throw new Error('Component Property List encountered an invalid Slot child limit.');
        }
      }
    }
    const nativeBindings = definition.boundVariables === undefined ? null : definition.boundVariables;
    if (nativeBindings !== null && (!typedReadRecord(nativeBindings)
      || Object.keys(nativeBindings).some((key) => key !== 'defaultValue')
      || (nativeBindings.defaultValue !== undefined
        && (!typedReadRecord(nativeBindings.defaultValue)
          || nativeBindings.defaultValue.type !== 'VARIABLE_ALIAS'
          || typeof nativeBindings.defaultValue.id !== 'string'
          || !nativeBindings.defaultValue.id || nativeBindings.defaultValue.id.length > maxName)))) {
      throw new Error('Component Property List encountered invalid default Variable binding metadata.');
    }
    const defaultValueVariable = nativeBindings?.defaultValue
      ? { type: nativeBindings.defaultValue.type, id: nativeBindings.defaultValue.id }
      : null;
    const propertyBindings = bindings.get(name) || [];
    const bindingStatus = definition.type === 'VARIANT' ? 'native-axis'
      : definition.type === 'SLOT' ? (slots.some((slot) => slot.property === name) ? 'native-slot' : 'unbound')
        : propertyBindings.length ? 'wired' : 'unbound';
    return {
      name,
      type: definition.type,
      defaultValue,
      variantOptions,
      preferredValues,
      description,
      slotSettings,
      defaultValueVariable,
      bindings: propertyBindings,
      bindingStatus,
    };
  });
  const payload = {
    schemaVersion: 2,
    status: 'listed',
    source: request.componentId === null ? 'selection' : 'id',
    component: {
      id: node.id,
      name: clean(String(node.name || ''), maxName),
      type: node.type,
    },
    properties,
    nestedInstances,
    slots,
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > maxSerializedCodeUnits) {
    throw new Error('Component Property List result exceeded the bounded response limit.');
  }
  return serialized;
}

async function executeTokenOverlapTypedRead(figmaApi, request) {
  const requestError = typedReadRequestValidationError(TOKEN_OVERLAP_TYPED_READ, request);
  if (requestError) throw new Error(requestError);
  const maxCollectionCandidates = 10_000;
  const maxTargetVariables = 100_000;
  const maxString = 512;
  const maxSerializedCodeUnits = 2_000_000;
  const validText = (value, empty = true) => typeof value === 'string'
    && value.length <= maxString && (empty || value.length > 0);
  const collections = await figmaApi.variables.getLocalVariableCollectionsAsync();
  if (!Array.isArray(collections) || collections.length > maxCollectionCandidates
    || collections.some((collection) => !collection || !validText(collection.id, false)
      || !validText(collection.name) || collection.remote
      || !Array.isArray(collection.variableIds)
      || collection.variableIds.length > maxTargetVariables
      || collection.variableIds.some((id) => !validText(id, false))
      || new Set(collection.variableIds).size !== collection.variableIds.length)
    || new Set(collections.map((collection) => collection.id)).size !== collections.length) {
    throw new Error('Token Overlap encountered invalid Collection metadata.');
  }
  const resolved = request.queries.map((query) => {
    const folded = query.toLocaleLowerCase('en-US');
    const byId = collections.filter((collection) => collection.id === query);
    const exact = collections.filter((collection) =>
      collection.name.toLocaleLowerCase('en-US') === folded);
    const partial = collections.filter((collection) =>
      collection.name.toLocaleLowerCase('en-US').includes(folded));
    const matches = byId.length ? byId : exact.length ? exact : partial;
    if (!matches.length) throw new Error('Token Overlap Collection not found.');
    if (matches.length > 1) throw new Error('Token Overlap Collection query is ambiguous.');
    return { query, collection: matches[0] };
  });
  if (new Set(resolved.map((item) => item.collection.id)).size !== resolved.length) {
    throw new Error('Token Overlap queries resolve to the same Collection.');
  }
  const membershipTotal = resolved.reduce((total, item) =>
    total + item.collection.variableIds.length, 0);
  if (membershipTotal > maxTargetVariables) {
    throw new Error('Token Overlap selected Variable membership limit exceeded.');
  }
  const memberships = resolved.flatMap((item, collectionIndex) =>
    item.collection.variableIds.map((id) => ({ id, collectionIndex })));
  if (new Set(memberships.map((item) => item.id)).size !== memberships.length) {
    throw new Error('Token Overlap encountered cross-Collection Variable identity reuse.');
  }
  const variables = [];
  for (let start = 0; start < memberships.length; start += 64) {
    variables.push(...await Promise.all(memberships.slice(start, start + 64)
      .map((item) => figmaApi.variables.getVariableByIdAsync(item.id))));
  }
  const counts = resolved.map(() => new Map());
  for (let index = 0; index < memberships.length; index++) {
    const membership = memberships[index];
    const variable = variables[index];
    const owner = resolved[membership.collectionIndex].collection;
    if (!variable || variable.id !== membership.id || variable.remote
      || variable.variableCollectionId !== owner.id || !validText(variable.name, false)) {
      throw new Error('Token Overlap could not load exact Variable membership.');
    }
    const map = counts[membership.collectionIndex];
    map.set(variable.name, (map.get(variable.name) || 0) + 1);
  }
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const union = [...new Set(counts.flatMap((map) => [...map.keys()]))].sort(compare);
  const common = union.filter((name) => counts.every((map) => map.get(name) === 1));
  const list = (items) => {
    const projected = items.slice(0, request.limit);
    return {
      total: items.length,
      returned: projected.length,
      omitted: items.length - projected.length,
      complete: projected.length === items.length,
      items: projected,
    };
  };
  const perCollection = resolved.map((item, index) => {
    const map = counts[index];
    const names = [...map.keys()].sort(compare);
    const only = names.filter((name) => counts.every((other, otherIndex) =>
      otherIndex === index || !other.has(name)));
    const missing = union.filter((name) => !map.has(name));
    const ambiguous = names.filter((name) => map.get(name) > 1)
      .map((name) => ({ name, count: map.get(name) }));
    return {
      collection: item.collection.name,
      total: names.length,
      variableCount: item.collection.variableIds.length,
      duplicateNameCount: ambiguous.reduce((total, entry) => total + entry.count - 1, 0),
      only_here: list(only),
      missing_here: list(missing),
      ambiguous_here: list(ambiguous),
    };
  });
  const commonCore = list(common);
  const complete = commonCore.complete && perCollection.every((row) =>
    row.only_here.complete && row.missing_here.complete && row.ambiguous_here.complete);
  const payload = {
    schemaVersion: 1,
    limit: request.limit,
    complete,
    resolved: resolved.map((item) => ({
      query: item.query,
      id: item.collection.id,
      name: item.collection.name,
    })),
    collections: resolved.map((item) => item.collection.name),
    commonCore,
    perCollection,
  };
  if (JSON.stringify(payload).length > maxSerializedCodeUnits) {
    throw new Error('Token Overlap result exceeded the serialized-size limit. Lower --limit.');
  }
  return payload;
}

async function executeTypedReadOperation(figmaApi, operation, request) {
  const error = typedReadRequestValidationError(operation, request);
  if (error) throw new Error(error);
  if (operation === BRIDGE_HEALTH_TYPED_READ) {
    const editorType = String(figmaApi?.editorType || '');
    if (!['figma', 'figjam', 'slides', 'dev'].includes(editorType) || !figmaApi?.currentPage) {
      throw new Error('Bridge health could not read the active Figma document context.');
    }
    return JSON.stringify({ schemaVersion: 1, responsive: true, editorType });
  }
  if (operation === STYLE_CONSUMERS_TYPED_READ) {
    return executeStyleConsumersTypedRead(figmaApi, request);
  }
  if (operation === NODE_BINDINGS_TYPED_READ) {
    return JSON.stringify(await executeNodeBindingsTypedRead(figmaApi, request));
  }
  if (operation === TOKEN_OVERLAP_TYPED_READ) {
    return JSON.stringify(await executeTokenOverlapTypedRead(figmaApi, request));
  }
  if (operation === COMPONENT_PROPERTY_LIST_TYPED_READ) {
    return executeComponentPropertyListTypedRead(figmaApi, request);
  }
  throw new Error('Typed-read operation is unsupported.');
}
// END TYPED READ RUNTIME

function currentDispatchContext(action) {
  return {
    action,
    connectionEpoch: activeConnectionEpoch,
    fileKey: (typeof figma.fileKey === 'string' && figma.fileKey) || null,
    editorType: figma.editorType || null,
  };
}

function dispatchReceiptForFailure(receipt, reason) {
  if (reason === 'malformed-receipt') return receipt;
  try { return terminalDispatchReceipt(receipt, 'not-dispatched', reason); }
  catch (error) { return receipt; }
}

function preflightPluginDispatch(msg, action) {
  const validation = validatePreparedDispatchContext(
    msg.dispatchReceipt,
    currentDispatchContext(action),
  );
  if (validation.ok) return msg.dispatchReceipt;
  figma.ui.postMessage({
    type: 'result',
    id: msg.id,
    error: validation.message,
    dispatchReceipt: dispatchReceiptForFailure(msg.dispatchReceipt, validation.reason),
  });
  return null;
}

function postDispatchResult(msg, state, reason, fields = {}) {
  let dispatchReceipt = msg.dispatchReceipt;
  try { dispatchReceipt = terminalDispatchReceipt(msg.dispatchReceipt, state, reason); }
  catch (error) {}
  figma.ui.postMessage({ type: 'result', id: msg.id, ...fields, dispatchReceipt });
}

function postLaneSettled(msg, state, reason = null) {
  let dispatchReceipt = msg.dispatchReceipt;
  try { dispatchReceipt = terminalDispatchReceipt(msg.dispatchReceipt, state, reason); }
  catch (error) { return; }
  const prior = replayableLaneSettlements.findIndex(
    (value) => value.requestId === dispatchReceipt.requestId,
  );
  if (prior >= 0) replayableLaneSettlements.splice(prior, 1);
  replayableLaneSettlements.push(dispatchReceipt);
  if (replayableLaneSettlements.length > MAX_REPLAYABLE_LANE_SETTLEMENTS) {
    replayableLaneSettlements.shift();
  }
  figma.ui.postMessage({ type: 'lane-settled', dispatchReceipt });
}

const pendingAssetStreamAcks = new Map();

function assetStreamAckKey(id, sequence) {
  return `${id}:${sequence}`;
}

function postAssetStreamFrameAndWait(msg, frame, sequence, remainingMs) {
  const key = assetStreamAckKey(msg.id, sequence);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAssetStreamAcks.delete(key);
      reject(new Error('Asset stream acknowledgement timed out'));
    }, Math.max(1, remainingMs));
    pendingAssetStreamAcks.set(key, () => {
      clearTimeout(timeout);
      pendingAssetStreamAcks.delete(key);
      resolve();
    });
    figma.ui.postMessage(frame);
  });
}

function postAssetStreamEnd(msg, state, reason, fields = {}) {
  let dispatchReceipt = msg.dispatchReceipt;
  try { dispatchReceipt = terminalDispatchReceipt(msg.dispatchReceipt, state, reason); }
  catch (error) {}
  figma.ui.postMessage({
    type: 'asset-stream-end', id: msg.id, chunks: fields.chunks || 0,
    ...(fields.error ? { error: fields.error } : {}),
    ...(fields.metadata ? { metadata: fields.metadata } : {}),
    dispatchReceipt,
  });
}

// Visible UI: a compact always-on status/kill-switch shell. Setup, activity
// and checkpoint controls expand on demand through the `resize` message.
const COMPACT_UI_SIZE = { width: 320, height: 132 };
figma.showUI(__html__, COMPACT_UI_SIZE);

// Execute code with auto-return and deadline notification.
//
// REPL pattern: first try the code as a single EXPRESSION — `return (code)`.
// If that throws a SyntaxError, the throw happens at PARSE time, before any
// execution, so falling back to running the code as plain statements never
// double-executes anything. The previous string heuristics (split at the last
// `;`, "no semicolon = expression") corrupted legal code: a trailing
// `for (…) { … }` block, or multi-statement code without semicolons, became a
// SyntaxError. Statement code now returns undefined unless it ends with an
// explicit `return` — which is what every engine call site already does.
// The underlying QuickJS evaluation cannot be cancelled. When its deadline is
// reached we notify the caller immediately but deliberately keep awaiting the
// actual promise. This quarantines the write lane until the uncertain mutation
// has really stopped and prevents a later command from interleaving with it.
async function executeCode(code, timeoutMs = 22000, onTimeout = null) {
  const trimmed = code.trim();

  let execPromise;
  try {
    // eval() (not new Function — Figma's QuickJS blocks that) runs in the
    // plugin's main scope where `figma` is already global.
    execPromise = eval(`(async () => { return (${trimmed}\n) })()`);
  } catch (e) {
    if (e instanceof SyntaxError) {
      execPromise = eval(`(async () => { ${trimmed} })()`);
    } else {
      throw e;
    }
  }

  let timedOut = false;
  const timeoutError = new Error(`Execution timeout (${timeoutMs / 1000}s)`);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    if (typeof onTimeout === 'function') onTimeout(timeoutError);
  }, timeoutMs);
  try {
    const result = await execPromise;
    return { result, timedOut, timeoutError };
  } catch (error) {
    if (timedOut) return { result: undefined, timedOut: true, timeoutError };
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt) {
  const requested = Number(timeoutMs);
  const total = Number.isFinite(requested)
    ? Math.min(120000, Math.max(1, requested))
    : 22000;
  const responseMargin = Math.min(1000, Math.max(25, Math.round(total * 0.01)));
  const absolute = Number(deadlineAt);
  const remaining = Number.isFinite(absolute)
    ? absolute - Date.now()
    : total - Math.max(0, Date.now() - queuedAt);
  return Math.floor(remaining - responseMargin);
}

// Generated runtime: npm run sync:plugin. Edit the canonical module at
// engine/src/lib/structured-render-executor.js, never this marked block.
// BEGIN STRUCTURED RENDER RUNTIME
function structuredNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function structuredVariableSpec(value) {
  if (typeof value !== 'string' || !value.startsWith('var:')) return null;
  const source = value.slice(4);
  const separator = source.indexOf('|');
  const requested = (separator < 0 ? source : source.slice(0, separator)).trim();
  const fallback = separator < 0 ? null : source.slice(separator + 1).trim() || null;
  if (!requested) return { error: 'variable name is empty' };
  const colon = requested.indexOf(':');
  return {
    requested,
    name: colon > 0 ? requested.slice(colon + 1) : requested,
    collection: colon > 0 ? requested.slice(0, colon) : null,
    fallback,
  };
}

function structuredColorSupported(value) {
  const variable = structuredVariableSpec(value);
  if (variable) return !variable.error && (variable.fallback == null || (variable.fallback !== 'none' && structuredColorSupported(variable.fallback)));
  return value == null || value === 'none'
    || /^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(String(value));
}

function structuredGradientTransformFromCssAngle(degrees, width = 1, height = 1) {
  const radians = Number(degrees) * Math.PI / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const x = sin * Math.max(structuredNumber(width, 1), 0.0001);
  const y = -cos * Math.max(structuredNumber(height, 1), 0.0001);
  const length = Math.hypot(x, y) || 1;
  const axisX = x / length;
  const axisY = y / length;
  return [
    [axisX, axisY, 0.5 - 0.5 * (axisX + axisY)],
    [-axisY, axisX, 0.5 - 0.5 * (-axisY + axisX)],
  ];
}

function structuredGradientColor(input, previous = null) {
  const source = String(input || '').trim();
  if (source.toLowerCase() === 'transparent') {
    return { ...(previous || { r: 0, g: 0, b: 0 }), a: 0 };
  }
  const hex = source.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let value = hex[1];
    if (value.length === 3) value = value.split('').map((part) => part + part).join('');
    return {
      r: parseInt(value.slice(0, 2), 16) / 255,
      g: parseInt(value.slice(2, 4), 16) / 255,
      b: parseInt(value.slice(4, 6), 16) / 255,
      a: value.length === 8 ? parseInt(value.slice(6), 16) / 255 : 1,
    };
  }
  const rgb = source.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/\s*,\s*/).map(Number);
    if ((parts.length === 3 || parts.length === 4)
      && parts.slice(0, 3).every((part) => Number.isFinite(part) && part >= 0 && part <= 255)
      && (parts.length === 3 || (Number.isFinite(parts[3]) && parts[3] >= 0 && parts[3] <= 1))) {
      return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: parts[3] ?? 1 };
    }
  }
  return null;
}

function structuredGradientPaint(input, dimensions = null) {
  const match = String(input || '').trim().match(/^(linear|radial|angular|diamond)-gradient\s*\(([\s\S]*)\)\s*$/i);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const parts = [];
  let depth = 0, buffer = '';
  for (const character of match[2]) {
    if (character === '(') depth++;
    else if (character === ')') depth--;
    if (depth < 0) throw new Error('gradient has unbalanced parentheses');
    if (character === ',' && depth === 0) { parts.push(buffer.trim()); buffer = ''; }
    else buffer += character;
  }
  if (depth !== 0) throw new Error('gradient has unbalanced parentheses');
  if (buffer.trim()) parts.push(buffer.trim());
  let angle = 180;
  let center = { x: 0.5, y: 0.5 };
  let stopParts = parts;
  const angleMatch = parts[0]?.match(/^(-?\d+(?:\.\d+)?)deg$/i);
  if (angleMatch) {
    angle = Number(angleMatch[1]);
    stopParts = parts.slice(1);
  } else if (kind === 'radial') {
    const position = parts[0]?.match(/^(?:(?:circle|ellipse)(?:\s+.*?)?\s+)?at\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/i);
    if (position) {
      center = { x: Number(position[1]) / 100, y: Number(position[2]) / 100 };
      if (center.x < 0 || center.x > 1 || center.y < 0 || center.y > 1) throw new Error('radial gradient center must be inside 0-100%');
      stopParts = parts.slice(1);
    }
  }
  if (stopParts.length < 2) throw new Error('gradient needs at least two color stops');
  const stops = [];
  for (let index = 0; index < stopParts.length; index++) {
    const source = stopParts[index];
    const positionMatch = source.match(/(-?\d+(?:\.\d+)?)%\s*$/);
    const position = positionMatch ? Number(positionMatch[1]) / 100 : index / (stopParts.length - 1);
    if (position < 0 || position > 1) throw new Error('gradient stop positions must be inside 0-100%');
    const colorSource = positionMatch ? source.slice(0, positionMatch.index).trim() : source.trim();
    const color = structuredGradientColor(colorSource, stops[stops.length - 1]?.color);
    if (!color) throw new Error(`unsupported gradient color: ${colorSource || 'empty'}`);
    stops.push({ position, color });
  }
  return {
    type: { linear: 'GRADIENT_LINEAR', radial: 'GRADIENT_RADIAL', angular: 'GRADIENT_ANGULAR', diamond: 'GRADIENT_DIAMOND' }[kind],
    gradientStops: stops,
    gradientTransform: kind === 'radial'
      ? [[1, 0, center.x - 0.5], [0, 1, center.y - 0.5]]
      : structuredGradientTransformFromCssAngle(angle, dimensions?.width, dimensions?.height),
  };
}

function structuredPaintLayers(input) {
  const source = String(input ?? '').trim();
  if (!source) return [];
  const layers = [];
  let depth = 0, buffer = '';
  for (const character of source) {
    if (character === '(') depth++;
    else if (character === ')') depth--;
    if (depth < 0) throw new Error('paint list has unbalanced parentheses');
    if (character === ',' && depth === 0) { layers.push(buffer.trim()); buffer = ''; }
    else buffer += character;
  }
  if (depth !== 0) throw new Error('paint list has unbalanced parentheses');
  if (buffer.trim()) layers.push(buffer.trim());
  if (!layers.length || layers.some((layer) => !layer)) throw new Error('paint list contains an empty layer');
  return layers;
}

function structuredPaintSupported(value) {
  if (structuredVariableSpec(value)) return structuredColorSupported(value);
  if (structuredColorSupported(value)) return true;
  try { return Boolean(structuredGradientPaint(value)); }
  catch { return false; }
}

function structuredFillPaintSupported(value) {
  if (structuredVariableSpec(value) || structuredColorSupported(value)) return structuredPaintSupported(value);
  try {
    const layers = structuredPaintLayers(value);
    return layers.length > 0 && layers.every((layer) => Boolean(structuredGradientPaint(layer)));
  } catch { return false; }
}

function structuredNumericSupported(value, { variable = false } = {}) {
  const reference = variable ? structuredVariableSpec(value) : null;
  return reference
    ? !reference.error && (reference.fallback == null || Number.isFinite(Number(reference.fallback)))
    : Number.isFinite(Number(value));
}

function structuredLineHeight(value, fallback = { unit: 'AUTO' }) {
  if (value == null) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { unit: 'PIXELS', value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const unit = String(value.unit || '').toUpperCase();
  if (unit === 'AUTO' && Object.keys(value).length === 1) return { unit: 'AUTO' };
  if (['PIXELS', 'PERCENT'].includes(unit)
    && typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0) {
    return { unit, value: value.value };
  }
  return fallback;
}

function structuredLineHeightSupported(value) {
  const variable = structuredVariableSpec(value);
  if (variable) return !variable.error
    && (variable.fallback == null || (Number.isFinite(Number(variable.fallback)) && Number(variable.fallback) >= 0));
  const projected = structuredLineHeight(value, null);
  return projected !== null;
}

function structuredStringSupported(value) {
  const reference = structuredVariableSpec(value);
  return reference ? !reference.error : typeof value === 'string';
}

function structuredFontStyle(weight, italic) {
  const names = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };
  const numeric = Number(weight);
  const base = names[numeric]
    || ({ normal: 'Regular', medium: 'Medium', semibold: 'Semi Bold', bold: 'Bold' }[String(weight || '').toLowerCase()])
    || 'Regular';
  return italic === true || italic === 'true' ? `${base} Italic` : base;
}

function structuredFontNameCandidates(fontName) {
  const candidates = [fontName];
  const compact = String(fontName.style || '').replace(/\b(Extra|Semi)\s+(?=(?:Light|Bold)\b)/g, '$1');
  if (compact !== fontName.style) candidates.push({ family: fontName.family, style: compact });
  return candidates;
}

function structuredFontAxes(input) {
  const source = String(input ?? '').trim();
  if (!source) throw new Error('fontAxes needs at least one axis');
  const axes = {};
  for (const raw of source.split(',')) {
    const part = raw.trim();
    const match = part.match(/^(?:"([a-z0-9]{4})"|([a-z0-9]{4}))\s*(?:=|\s)\s*(-?\d+(?:\.\d+)?)$/i);
    if (!match) throw new Error(`fontAxes entry "${part}" must use wght=357 or "wght" 357`);
    const tag = match[1] || match[2];
    if (Object.prototype.hasOwnProperty.call(axes, tag)) throw new Error(`fontAxes contains duplicate axis "${tag}"`);
    axes[tag] = Number(match[3]);
  }
  return axes;
}

function structuredTracks(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('tracks must be a non-empty string');
  return input.split(',').map((raw) => {
    const source = raw.trim();
    if (source === 'hug') return { type: 'HUG' };
    const fixed = source.match(/^fixed:([\d.]+)$/);
    if (fixed && Number.isFinite(Number(fixed[1]))) return { type: 'FIXED', value: Number(fixed[1]) };
    const flex = source.match(/^flex(?::([\d.]+))?$/);
    if (flex && Number(flex[1] || 1) > 0) return { type: 'FLEX', value: Number(flex[1] || 1) };
    throw new Error(`unsupported Grid track: ${source || 'empty'}`);
  });
}

function structuredDashPattern(input) {
  if (input == null || input === '') return [];
  const values = String(input).trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('strokeDashPattern must contain non-negative numbers');
  }
  return values;
}

function structuredCssFunctions(input) {
  const source = String(input || '').trim();
  if (!source || source === 'none') return [];
  const functions = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] || '')) index++;
    const match = source.slice(index).match(/^([a-z-]+)\s*\(/i);
    if (!match) throw new Error(`unsupported filter syntax near "${source.slice(index, index + 24)}"`);
    const name = match[1].toLowerCase();
    index += match[0].length;
    const start = index;
    let depth = 1;
    while (index < source.length && depth > 0) {
      if (source[index] === '(') depth++;
      else if (source[index] === ')') depth--;
      index++;
    }
    if (depth !== 0) throw new Error(`unterminated ${name}() filter`);
    functions.push({ name, value: source.slice(start, index - 1).trim() });
  }
  return functions;
}

function structuredEffectColor(input, fallback = null) {
  const source = String(input || '').trim();
  const hex = source.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let value = hex[1];
    if (value.length === 3) value = value.split('').map((part) => part + part).join('');
    return {
      r: parseInt(value.slice(0, 2), 16) / 255,
      g: parseInt(value.slice(2, 4), 16) / 255,
      b: parseInt(value.slice(4, 6), 16) / 255,
      a: value.length === 8 ? parseInt(value.slice(6), 16) / 255 : 1,
    };
  }
  const rgb = source.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/\s*,\s*/).map(Number);
    if ((parts.length === 3 || parts.length === 4)
      && parts.slice(0, 3).every((part) => Number.isFinite(part) && part >= 0 && part <= 255)
      && (parts.length === 3 || (Number.isFinite(parts[3]) && parts[3] >= 0 && parts[3] <= 1))) {
      return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: parts[3] ?? 1 };
    }
  }
  if (fallback) return fallback;
  throw new Error(`unsupported effect color: ${source || 'empty'}`);
}

function structuredShadow(input) {
  if (typeof input !== 'string') throw new Error('shadow must be a string');
  const presets = {
    sm: '0 1px 2px rgba(0,0,0,0.05)', md: '0 4px 6px rgba(0,0,0,0.1)',
    lg: '0 10px 15px rgba(0,0,0,0.1)', xl: '0 20px 25px rgba(0,0,0,0.1)',
    '2xl': '0 25px 50px rgba(0,0,0,0.25)', soft: '0 4px 12px rgba(0,0,0,0.08)',
    subtle: '0 2px 4px rgba(0,0,0,0.06)', strong: '0 16px 32px rgba(0,0,0,0.2)',
    hard: '0 8px 0 rgba(0,0,0,1)', glow: '0 0 24px rgba(59,130,246,0.5)',
  };
  let source = input.trim();
  if (source.toLowerCase() === 'none') return null;
  source = presets[source.toLowerCase()] || source;
  const colorMatch = source.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i);
  const color = colorMatch
    ? structuredEffectColor(colorMatch[0])
    : { r: 0, g: 0, b: 0, a: 0.1 };
  if (colorMatch) source = `${source.slice(0, colorMatch.index)} ${source.slice(colorMatch.index + colorMatch[0].length)}`;
  const values = source.trim().split(/\s+/).filter(Boolean).map((part) => Number(part.replace(/px$/i, '')));
  if (values.length < 2 || values.length > 4 || values.some((part) => !Number.isFinite(part))) {
    throw new Error(`shadow needs 2-4 numeric lengths: ${input}`);
  }
  const [x, y, blur = 0, spread = 0] = values;
  if (blur < 0) throw new Error('shadow blur must be non-negative');
  return { x, y, blur, spread, color };
}

function structuredFiniteEffectNumber(props, key, fallback, { min = 0, max = Infinity } = {}) {
  const value = props[key] == null ? fallback : Number(props[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max === Infinity ? 'Infinity' : max}`);
  }
  return value;
}

function structuredEffects(props) {
  const effects = [];
  for (const fn of structuredCssFunctions(props.filter)) {
    if (fn.name === 'blur') {
      const radius = Number(fn.value.replace(/px$/i, ''));
      if (!Number.isFinite(radius) || radius < 0) throw new Error('filter blur must be non-negative');
      if (radius > 0) effects.push({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius, visible: true });
    } else if (fn.name === 'drop-shadow') {
      const shadow = structuredShadow(fn.value);
      if (shadow) effects.push({ type: 'DROP_SHADOW', color: shadow.color, offset: { x: shadow.x, y: shadow.y }, radius: shadow.blur, spread: shadow.spread, visible: true, blendMode: 'NORMAL' });
    } else throw new Error(`CSS filter ${fn.name}() is not supported by native Figma effects`);
  }
  for (const [key, type] of [['shadow', 'DROP_SHADOW'], ['innerShadow', 'INNER_SHADOW']]) {
    if (props[key] == null) continue;
    for (const raw of Array.isArray(props[key]) ? props[key] : [props[key]]) {
      const shadow = structuredShadow(raw);
      if (shadow) effects.push({ type, color: shadow.color, offset: { x: shadow.x, y: shadow.y }, radius: shadow.blur, spread: shadow.spread, visible: true, blendMode: 'NORMAL' });
    }
  }
  for (const [key, type] of [['blur', 'LAYER_BLUR'], ['bgBlur', 'BACKGROUND_BLUR']]) {
    if (props[key] == null) continue;
    const radius = structuredFiniteEffectNumber(props, key, 0);
    if (radius > 0) effects.push({ type, blurType: 'NORMAL', radius, visible: true });
  }
  if (props.noise !== undefined && props.noise !== null && props.noise !== false && props.noise !== 'false') {
    const value = String(props.noise).toLowerCase();
    const noiseType = value.startsWith('duo') ? 'DUOTONE' : value.startsWith('multi') ? 'MULTITONE' : value.startsWith('mono') || value === 'true' ? 'MONOTONE' : null;
    if (!noiseType) throw new Error('noise must be mono, duo, or multi');
    const effect = {
      type: 'NOISE', noiseType,
      density: structuredFiniteEffectNumber(props, 'noiseDensity', 0.4, { max: 1 }),
      noiseSize: structuredFiniteEffectNumber(props, 'noiseSize', 1.5),
      // Current Figma Desktop rejects blendMode on NOISE writes even though
      // the installed typings expose it on readback. Omit the default NORMAL;
      // Figma materializes it when the effect is read again.
      color: structuredEffectColor(props.noiseColor || '#000000'), visible: true,
    };
    if (noiseType === 'DUOTONE') effect.secondaryColor = structuredEffectColor(props.noiseColor2 || '#ffffff');
    if (noiseType === 'MULTITONE') effect.opacity = structuredFiniteEffectNumber(props, 'noiseOpacity', 0.5, { max: 1 });
    effects.push(effect);
  }
  if (props.texture !== undefined && props.texture !== null && props.texture !== false && props.texture !== 'false') {
    effects.push({
      type: 'TEXTURE', noiseSize: structuredFiniteEffectNumber(props, 'textureSize', 12),
      radius: structuredFiniteEffectNumber(props, 'textureRadius', 30),
      clipToShape: !(props.textureClip === false || props.textureClip === 'false'), visible: true,
    });
  }
  if (props.progressiveBlur != null) {
    const radius = structuredFiniteEffectNumber(props, 'progressiveBlur', 0);
    const direction = String(props.progressiveBlurDir || 'down').toLowerCase();
    const offsets = {
      down: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }], up: [{ x: 0.5, y: 1 }, { x: 0.5, y: 0 }],
      right: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], left: [{ x: 1, y: 0.5 }, { x: 0, y: 0.5 }],
    }[direction];
    if (!offsets) throw new Error('progressiveBlurDir must be down, up, left, or right');
    if (radius > 0) effects.push({
      type: 'LAYER_BLUR', blurType: 'PROGRESSIVE', radius,
      startRadius: structuredFiniteEffectNumber(props, 'progressiveBlurStart', 0),
      startOffset: offsets[0], endOffset: offsets[1], visible: true,
    });
  }
  if (props.glass !== undefined && props.glass !== null && props.glass !== false && props.glass !== 'false') {
    effects.push({
      type: 'GLASS', visible: true,
      refraction: structuredFiniteEffectNumber(props, 'glassRefraction', 0.95, { max: 1 }),
      depth: structuredFiniteEffectNumber(props, 'glassDepth', 50, { min: 1 }),
      radius: structuredFiniteEffectNumber(props, 'glassRadius', 6),
      dispersion: structuredFiniteEffectNumber(props, 'glassDispersion', 0.4, { max: 1 }),
      lightIntensity: structuredFiniteEffectNumber(props, 'glassLight', 0.7, { max: 1 }),
      lightAngle: structuredFiniteEffectNumber(props, 'glassLightAngle', 130, { min: -360, max: 360 }),
    });
  }
  return effects;
}

function structuredSvgFilterDescriptors(svg) {
  const descriptors = [];
  for (const opening of String(svg || '').match(/<[^>]+>/g) || []) {
    const id = opening.match(/\bid=["'](figma-filter-[^"']+)["']/i)?.[1];
    const filter = opening.match(/\bfilter=["']([^"']+)["']/i)?.[1];
    if (id && filter && filter !== 'none' && !filter.startsWith('url(')) descriptors.push({ id, filter });
  }
  return descriptors;
}

function structuredVariantPairs(input) {
  if (input == null || String(input).trim() === '') return {};
  const pairs = {};
  for (const raw of String(input).split(',')) {
    const separator = raw.indexOf('=');
    const key = separator < 0 ? '' : raw.slice(0, separator).trim();
    const value = separator < 0 ? '' : raw.slice(separator + 1).trim();
    if (!key || !value) throw new Error(`variant segment needs Axis=Value: ${raw.trim() || 'empty'}`);
    if (Object.prototype.hasOwnProperty.call(pairs, key)) throw new Error(`variant axis is duplicated: ${key}`);
    pairs[key] = value;
  }
  return pairs;
}

function structuredDesignEntityId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(value);
}

function structuredOverrideEntries(props, prefix) {
  return Object.entries(props || {})
    .filter(([key]) => key.startsWith(`${prefix}:`))
    .map(([key, value]) => ({ key, target: key.slice(prefix.length + 1), value }));
}

function structuredLayerName(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function structuredFindOverrideLayer(root, requested, predicate, label) {
  const descendants = typeof root.findAll === 'function'
    ? root.findAll((node) => predicate(node))
    : [];
  const exact = descendants.filter((node) => node.name === requested);
  const matches = exact.length
    ? exact
    : descendants.filter((node) => structuredLayerName(node.name) === structuredLayerName(requested));
  if (matches.length !== 1) {
    throw new Error(`${label}: ${matches.length ? 'is ambiguous' : 'does not exist'} on component ${root.name || root.id}`);
  }
  return matches[0];
}

const STRUCTURED_RESIDUE_LIMIT = 50;

function structuredStableHandle(value) {
  const source = String(value || '(unavailable)');
  return Array.from(source).slice(0, 256).join('');
}

function createStructuredMutationJournal(figmaApi) {
  const entries = [];

  const record = (kind, resource, { handle = null, removable = true } = {}) => {
    const stableHandle = structuredStableHandle(handle || resource?.id || resource?.hash);
    entries.push({
      kind,
      handle: stableHandle,
      removable: removable && typeof resource?.remove === 'function',
      resource,
    });
    if (typeof figmaApi?.__figmaBridgeMutationCheckpoint === 'function') {
      figmaApi.__figmaBridgeMutationCheckpoint({ sequence: entries.length, kind, handle: stableHandle });
    }
    return resource;
  };

  const publicReport = (outcome, { removed = 0, residue = [] } = {}) => ({
    version: 1,
    outcome,
    created: entries.length,
    removed,
    residueCount: residue.length,
    residue: residue.slice(0, STRUCTURED_RESIDUE_LIMIT),
    residueTruncated: residue.length > STRUCTURED_RESIDUE_LIMIT,
  });

  return {
    record,
    completed() {
      return publicReport('completed');
    },
    async rollback() {
      if (!entries.length) return publicReport('no-mutation');
      let removed = 0;
      const residue = [];
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry.removable) {
          residue.push({ kind: entry.kind, handle: entry.handle, reason: 'no-removal-api' });
          continue;
        }
        try {
          if (entry.resource?.removed !== true) await entry.resource.remove();
          removed++;
        } catch {
          residue.push({ kind: entry.kind, handle: entry.handle, reason: 'remove-failed' });
        }
      }
      return publicReport(residue.length ? 'partial-residue' : 'rolled-back', { removed, residue });
    },
  };
}

function structuredExecutionError(error, report, prefix) {
  const original = error instanceof Error ? error : new Error(String(error));
  const residue = report.residueCount
    ? `; ${report.residueCount} bounded residue entr${report.residueCount === 1 ? 'y' : 'ies'} reported`
    : '';
  return Object.assign(
    new Error(
      `${prefix}; mutation outcome=${report.outcome}${residue} (${original.message || original})`,
      { cause: original },
    ),
    { mutationOutcome: report.outcome, mutationReport: report },
  );
}

function structuredRenderFailureResult(error, executor = 'structured-v1') {
  if (!error || !['no-mutation', 'rolled-back', 'partial-residue'].includes(error.mutationOutcome)) return null;
  const report = error.mutationReport;
  if (!report || report.version !== 1 || report.outcome !== error.mutationOutcome) return null;
  return {
    executor,
    mutationOutcome: error.mutationOutcome,
    mutationReport: report,
  };
}

const STRUCTURED_PREFLIGHT_CATALOG_TIMEOUT_MS = 15_000;

/**
 * @param {{ preflightTimeoutMs?: number }} [runtime]
 */
function structuredPreflightTimeout(runtime = {}) {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
    || Object.keys(runtime).some((key) => key !== 'preflightTimeoutMs')) {
    throw new Error('Structured render runtime options are invalid');
  }
  const timeout = runtime.preflightTimeoutMs === undefined
    ? STRUCTURED_PREFLIGHT_CATALOG_TIMEOUT_MS
    : Number(runtime.preflightTimeoutMs);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > STRUCTURED_PREFLIGHT_CATALOG_TIMEOUT_MS) {
    throw new Error(`Structured render preflight timeout must be 1-${STRUCTURED_PREFLIGHT_CATALOG_TIMEOUT_MS}ms`);
  }
  return Math.floor(timeout);
}

async function createStructuredPreflightApi(figmaApi, runtime = {}) {
  const timeoutMs = structuredPreflightTimeout(runtime);
  let timeoutHandle;
  let resources;
  try {
    resources = await Promise.race([
      Promise.all([
        figmaApi.variables?.getLocalVariableCollectionsAsync?.() || [],
        figmaApi.variables?.getLocalVariablesAsync?.() || [],
        figmaApi.getLocalTextStylesAsync?.() || [],
      ]),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(
          `Structured render preflight catalog read timed out after ${timeoutMs}ms`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle != null) clearTimeout(timeoutHandle);
  }
  const [collections, variables, textStyles] = resources;
  let virtualId = 0;
  const nextId = (kind) => `preflight:${kind}:${++virtualId}`;
  const virtualCollections = [...collections];
  const virtualVariables = [...variables];
  const virtualTextStyles = [...textStyles];

  const api = {
    mixed: figmaApi.mixed,
    base64Decode: (...args) => figmaApi.base64Decode(...args),
    loadFontAsync: (...args) => figmaApi.loadFontAsync(...args),
    createImage() {
      return { hash: nextId('image') };
    },
    async createImageAsync() {
      return { hash: nextId('image') };
    },
    async getLocalTextStylesAsync() {
      return [...virtualTextStyles];
    },
    createTextStyle() {
      const style = {
        id: nextId('text-style'), name: '',
        fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14,
        lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 },
        paragraphSpacing: 0, paragraphIndent: 0,
        remove() {
          const index = virtualTextStyles.indexOf(this);
          if (index >= 0) virtualTextStyles.splice(index, 1);
        },
      };
      virtualTextStyles.push(style);
      return style;
    },
    variables: {
      async getLocalVariableCollectionsAsync() { return [...virtualCollections]; },
      async getLocalVariablesAsync() { return [...virtualVariables]; },
      createVariableCollection(name) {
        const collection = {
          id: nextId('collection'), name,
          modes: [{ modeId: nextId('mode'), name: 'Default' }],
          remove() {
            const index = virtualCollections.indexOf(this);
            if (index >= 0) virtualCollections.splice(index, 1);
          },
        };
        virtualCollections.push(collection);
        return collection;
      },
      createVariable(name, collection, type) {
        const variable = {
          id: nextId('variable'), name, resolvedType: type,
          variableCollectionId: collection.id, valuesByMode: {}, scopes: ['ALL_SCOPES'],
          setValueForMode(modeId, value) { this.valuesByMode[modeId] = value; },
          remove() {
            const index = virtualVariables.indexOf(this);
            if (index >= 0) virtualVariables.splice(index, 1);
          },
        };
        virtualVariables.push(variable);
        return variable;
      },
      setBoundVariableForPaint: (...args) => figmaApi.variables.setBoundVariableForPaint(...args),
    },
  };
  return api;
}

async function prepareStructuredComponents(figmaApi, plan) {
  const intents = [];
  const bindings = new WeakMap();
  const overrides = new WeakMap();
  const collect = (node) => {
    if (node.source.type === 'instance') intents.push(node);
    for (const child of node.children || []) collect(child);
  };
  collect(plan.root);
  if (!intents.length) return { bindings, overrides };

  const table = plan.designEntityBindings;
  const targetFileKey = table?.targetConstraint?.kind === 'file-key'
    ? String(table.targetConstraint.fileKey || '') : null;
  if (targetFileKey && figmaApi.fileKey !== targetFileKey) {
    throw new Error(`Structured component preflight failed: Design Entity bindings target a different Figma file`);
  }

  const resolveVariant = (target, requested, label) => {
    const wanted = structuredVariantPairs(requested);
    if (!Object.keys(wanted).length) {
      if (target.type === 'COMPONENT_SET') return target.defaultVariant || target.children?.[0] || null;
      return target.type === 'COMPONENT' ? target : null;
    }
    const set = target.type === 'COMPONENT_SET'
      ? target
      : target.type === 'COMPONENT' && target.parent?.type === 'COMPONENT_SET' ? target.parent : null;
    const candidates = set?.children || (target.type === 'COMPONENT' ? [target] : []);
    const matches = candidates.filter((candidate) => {
      const actual = candidate.variantProperties || structuredVariantPairs(candidate.name);
      return Object.entries(wanted).every(([axis, value]) => actual?.[axis] === value);
    });
    if (matches.length !== 1) {
      const available = candidates.map((candidate) => candidate.name).filter(Boolean).join(' | ');
      throw new Error(`${label}: variant "${requested}" ${matches.length ? 'is ambiguous' : 'does not exist'}${available ? ` (available: ${available})` : ''}`);
    }
    return matches[0];
  };

  const resolveHandle = async (binding, label, variant = null) => {
    if (!binding || binding.entityKind !== 'component') {
      throw new Error(`${label}: executable component binding is missing`);
    }
    if (variant && !binding.variantIntents.includes(String(variant))) {
      throw new Error(`${label}: variant intent is not present in the immutable Plan binding`);
    }
    let target = null;
    if (binding.handleKind === 'published-key') {
      try { target = await figmaApi.importComponentByKeyAsync(String(binding.handle)); }
      catch {
        try { target = await figmaApi.importComponentSetByKeyAsync(String(binding.handle)); }
        catch {
          // A Registry Design Entity may intentionally carry both anchors:
          // the publish key is strongest, while the node id is the explicit
          // current-file locator. Falling back to that id is still identity-
          // based and never a display-name guess.
          const fallback = binding.localFallback;
          if (fallback && figmaApi.fileKey === fallback.fileKey) {
            target = await figmaApi.getNodeByIdAsync(String(fallback.handle));
          }
          if (!target) throw new Error(`${label}: published component key ${binding.handle} could not be imported and its exact-file local fallback is unavailable`);
        }
      }
    } else if (binding.handleKind === 'local-node') {
      if (!targetFileKey || figmaApi.fileKey !== targetFileKey) {
        throw new Error(`${label}: local component binding is stale for this Figma file`);
      }
      target = await figmaApi.getNodeByIdAsync(String(binding.handle));
      if (!target) throw new Error(`${label}: local component node ${binding.handle} does not exist in this file`);
    } else {
      throw new Error(`${label}: binding does not identify an instantiable component`);
    }
    if (!['COMPONENT', 'COMPONENT_SET'].includes(target.type)) {
      throw new Error(`${label}: linked Figma node is ${target.type}, not a component or component set`);
    }
    const component = resolveVariant(target, variant, label);
    if (!component || component.type !== 'COMPONENT') throw new Error(`${label}: no instantiable component resolved`);
    return component;
  };

  const outcomes = await Promise.all(intents.map(async (node) => {
    const props = node.source.props;
    const label = `Design Entity ${props.entity}`;
    try {
      const binding = table?.bindings?.[props.entity];
      return { node, component: await resolveHandle(binding, label, props.variant) };
    } catch (error) {
      return { node, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const failures = outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error);
  if (failures.length) throw new Error(`Structured component preflight failed: ${failures.slice(0, 5).join('; ')}`);

  const swapEntities = new Set();
  for (const outcome of outcomes) {
    const { node, component } = outcome;
    const props = node.source.props;
    const label = `Design Entity ${props.entity}`;
    bindings.set(node, component);
    const prepared = { properties: {}, texts: [], fills: [], swaps: [] };
    // Figma throws when componentPropertyDefinitions is read from a variant
    // COMPONENT. Resolve the owning COMPONENT_SET before touching the accessor.
    const definitionOwner = component.parent?.type === 'COMPONENT_SET' ? component.parent : component;
    const definitions = definitionOwner.componentPropertyDefinitions || {};
    const definitionKeys = Object.keys(definitions);

    for (const entry of structuredOverrideEntries(props, 'prop')) {
      const matches = definitionKeys.filter((key) => key === entry.target || key.split('#')[0] === entry.target);
      if (matches.length !== 1) {
        failures.push(`${label}: component property "${entry.target}" ${matches.length ? 'is ambiguous' : 'does not exist'}`);
        continue;
      }
      const key = matches[0];
      const definition = definitions[key];
      if (definition.type === 'VARIANT') {
        failures.push(`${label}: prop:${entry.target} is a variant property; use variant="Axis=Value"`);
        continue;
      }
      let next = entry.value;
      if (definition.type === 'BOOLEAN') {
        if (![true, false, 'true', 'false'].includes(next)) {
          failures.push(`${label}: prop:${entry.target} must be true or false`);
          continue;
        }
        next = next === true || next === 'true';
      } else if (definition.type === 'INSTANCE_SWAP') {
        if (!structuredDesignEntityId(String(next))) {
          failures.push(`${label}: prop:${entry.target} instance swap needs a Registry Design Entity id`);
          continue;
        }
        swapEntities.add(String(next));
        next = { entity: String(next) };
      } else next = String(next);
      prepared.properties[key] = next;
    }

    for (const entry of structuredOverrideEntries(props, 'text')) {
      try {
        const target = structuredFindOverrideLayer(component, entry.target, (candidate) => candidate.type === 'TEXT', `${label} text:${entry.target}`);
        prepared.texts.push({ ...entry, targetNode: target });
      } catch (error) { failures.push(error.message); }
    }
    for (const entry of structuredOverrideEntries(props, 'fill')) {
      try {
        structuredFindOverrideLayer(component, entry.target, (candidate) => 'fills' in candidate, `${label} fill:${entry.target}`);
        prepared.fills.push(entry);
      } catch (error) { failures.push(error.message); }
    }
    for (const entry of structuredOverrideEntries(props, 'swap')) {
      if (!structuredDesignEntityId(String(entry.value))) {
        failures.push(`${label}: swap:${entry.target} needs a Registry Design Entity id`);
        continue;
      }
      try {
        structuredFindOverrideLayer(component, entry.target, (candidate) => candidate.type === 'INSTANCE', `${label} swap:${entry.target}`);
        prepared.swaps.push({ ...entry, entity: String(entry.value) });
        swapEntities.add(String(entry.value));
      } catch (error) { failures.push(error.message); }
    }
    overrides.set(node, prepared);
  }

  if (failures.length) throw new Error(`Structured component preflight failed: ${failures.slice(0, 5).join('; ')}`);
  const swapComponents = new Map();
  const swapOutcomes = await Promise.all([...swapEntities].map(async (entity) => {
    const binding = table?.bindings?.[entity];
    if (!binding) return { entity, error: `swap Design Entity ${entity} is not bound in the Render Plan` };
    try {
      const variant = binding.variantIntents.length === 1 ? binding.variantIntents[0] : null;
      return { entity, component: await resolveHandle(binding, `Swap Design Entity ${entity}`, variant) };
    } catch (error) {
      return { entity, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const swapFailures = swapOutcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error);
  if (swapFailures.length) throw new Error(`Structured component preflight failed: ${swapFailures.slice(0, 5).join('; ')}`);
  for (const outcome of swapOutcomes) swapComponents.set(outcome.entity, outcome.component);

  const fonts = new Map();
  for (const prepared of intents.map((node) => overrides.get(node))) {
    for (const { targetNode } of prepared.texts) {
      if (targetNode.fontName && targetNode.fontName !== figmaApi.mixed) {
        fonts.set(`${targetNode.fontName.family}/${targetNode.fontName.style}`, targetNode.fontName);
      } else if (typeof targetNode.getRangeAllFontNames === 'function') {
        for (const font of targetNode.getRangeAllFontNames(0, targetNode.characters?.length || 0)) {
          fonts.set(`${font.family}/${font.style}`, font);
        }
      }
    }
  }
  try {
    await Promise.all([...fonts.values()].map((font) => figmaApi.loadFontAsync(font)));
  } catch (error) {
    throw new Error(`Structured component preflight failed: instance text override font is unavailable (${error.message || error})`);
  }
  return { bindings, overrides, swapComponents };
}

async function prepareStructuredImages(figmaApi, plan, journal = null) {
  const intents = [];
  const bindings = new WeakMap();
  const collect = (node) => {
    if (node.asset?.kind === 'embedded-raster') intents.push(node);
    for (const child of node.children || []) collect(child);
  };
  collect(plan.root);
  const outcomes = [];
  for (const node of intents) {
    try {
      const image = figmaApi.createImage(figmaApi.base64Decode(node.asset.base64));
      if (!image?.hash) {
        journal?.record('image-resource', image, { handle: '(unavailable)', removable: false });
        throw new Error('Figma returned no image hash');
      }
      journal?.record('image-resource', image, { handle: image.hash, removable: false });
      outcomes.push({ node, hash: image.hash });
    } catch (error) {
      outcomes.push({ node, error: `${node.path || node.name}: image preflight failed (${error.message || error})` });
      if (journal) break;
    }
  }
  const failures = outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error);
  if (failures.length) throw new Error(`Structured image preflight failed: ${failures.slice(0, 5).join('; ')}`);
  for (const outcome of outcomes) bindings.set(outcome.node, outcome.hash);
  return { bindings };
}

function structuredVariableScopes(name, type) {
  if (type !== 'FLOAT') return null;
  const head = String(name || '').trim().toLowerCase().split('/')[0];
  if (head === 'space' || head === 'spacing') return ['GAP'];
  if (head === 'radius' || head === 'radii') return ['CORNER_RADIUS'];
  return null;
}

function structuredScopeQuestion(name, type, collection) {
  const allowed = type === 'COLOR'
    ? ['ALL_SCOPES', 'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR', 'EFFECT_COLOR']
    : type === 'STRING'
      ? ['ALL_SCOPES', 'TEXT_CONTENT', 'FONT_FAMILY', 'FONT_STYLE']
      : ['ALL_SCOPES', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP', 'STROKE_FLOAT', 'EFFECT_FLOAT', 'OPACITY', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT'];
  return {
    name, collection, resolvedType: type, status: 'USER_DECISION_REQUIRED',
    currentScopes: ['ALL_SCOPES'], allowedScopes: allowed,
    question: `Should "${name}" remain unrestricted (ALL_SCOPES), or be limited to one or more compatible ${type} scopes?`,
  };
}

const STRUCTURED_RENDER_IMAGE_ASSET_KIND = 'embedded-raster';
const STRUCTURED_RENDER_IMAGE_ASSET_PROBLEM = 'image needs host-materialized embedded bytes';
const STRUCTURED_RENDER_INSTANCE_IDENTITY_PROP = 'entity';
const STRUCTURED_RENDER_COMPATIBILITY_EXECUTOR = 'generated-eval-compatibility';

function inspectStructuredRenderPlan(plan) {
  const problems = [];
  const annotationProperties = new Set([
    'width', 'height', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight', 'fills',
    'strokes', 'effects', 'strokeWeight', 'cornerRadius', 'textStyleId',
    'textAlignHorizontal', 'fontFamily', 'fontStyle', 'fontSize', 'fontWeight',
    'lineHeight', 'letterSpacing', 'itemSpacing', 'padding', 'layoutMode',
    'alignItems', 'opacity', 'mainComponent', 'gridRowGap', 'gridColumnGap',
    'gridRowCount', 'gridColumnCount', 'gridRowAnchorIndex',
    'gridColumnAnchorIndex', 'gridRowSpan', 'gridColumnSpan',
  ]);
  let fallbackAnnotationCount = 0;
  const frameProps = new Set([
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH', 'flex', 'gap', 'p', 'padding', 'px', 'py',
    'pt', 'pr', 'pb', 'pl', 'items', 'align', 'justify', 'bg', 'fill', 'image',
    'imageScale', 'rounded',
    'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'cornerSmoothing',
    'clip', 'overflow', 'position', 'x', 'y', 'grow', 'stretch', 'hug', 'opacity', 'visible', 'locked', 'rotate',
    'blendMode', 'mask', 'maskType', 'stroke', 'strokeWidth', 'strokeAlign', 'entity',
    'strokeDashPattern', 'strokeCap', 'strokeTopWidth', 'strokeRightWidth',
    'strokeBottomWidth', 'strokeLeftWidth', 'shadow', 'innerShadow', 'blur',
    'bgBlur', 'filter', 'noise', 'noiseDensity', 'noiseSize', 'noiseColor',
    'noiseColor2', 'noiseOpacity', 'texture', 'textureSize', 'textureRadius',
    'textureClip', 'progressiveBlur', 'progressiveBlurDir', 'progressiveBlurStart',
    'glass', 'glassRefraction', 'glassDepth', 'glassRadius', 'glassDispersion',
    'glassLight', 'glassLightAngle', 'wrap', 'wrapGap', 'counterAxisSpacing', 'gridColumns',
    'gridRows', 'columnGap', 'rowGap', 'gridAutoFlow', 'gridRow', 'gridColumn',
    'gridRowSpan', 'gridColumnSpan', 'gridHAlign', 'gridVAlign',
  ]);
  const textProps = new Set([
    'name', 'content', 'w', 'h', 'width', 'height', 'size', 'weight', 'italic',
    'color', 'font', 'fontStyle', 'style', 'align', 'lineHeight', 'letterSpacing',
    'paragraphSpacing', 'paragraphIndent', 'position', 'x', 'y', 'grow',
    'opacity', 'minW', 'maxW', 'minH', 'maxH', 'gridRow', 'gridColumn',
    'gridRowSpan', 'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'truncate',
    'maxLines', 'fontAxes', 'mask', 'maskType', 'runs',
  ]);
  const rectProps = new Set([
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH',
    'bg', 'fill', 'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL',
    'roundedBR', 'cornerSmoothing', 'blendMode', 'opacity', 'visible', 'rotate',
    'position', 'x', 'y', 'gridRow', 'gridColumn', 'gridRowSpan',
    'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'mask', 'maskType', 'filter',
  ]);
  const ellipseProps = new Set([
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH',
    'bg', 'fill', 'stroke', 'strokeWidth', 'strokeAlign', 'strokeDashPattern',
    'strokeCap', 'arc', 'arcStart', 'innerRadius', 'opacity', 'visible', 'rotate',
    'position', 'x', 'y', 'gridRow', 'gridColumn', 'gridRowSpan',
    'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'mask', 'maskType', 'filter',
  ]);
  const iconProps = new Set([
    'name', 'size', 's', 'w', 'h', 'width', 'height', 'color', 'c',
    'preserveColors', 'opacity', 'visible', 'rotate', 'position', 'x', 'y',
    'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan', 'gridHAlign',
    'gridVAlign', 'mask', 'maskType',
  ]);
  const imageProps = new Set([
    'name', 'src', 'imageScale', 'w', 'h', 'width', 'height', 'minW', 'maxW',
    'minH', 'maxH', 'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL',
    'roundedBR', 'cornerSmoothing', 'opacity', 'visible', 'rotate', 'position',
    'x', 'y', 'grow', 'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan',
    'gridHAlign', 'gridVAlign', 'filter', 'blendMode', 'mask', 'maskType',
  ]);
  const instanceProps = new Set([
    'entity', 'name', 'component', 'id', 'key', 'variant', 'w', 'h', 'width',
    'height', 'minW', 'maxW', 'minH', 'maxH', 'grow', 'opacity', 'visible',
    'rotate', 'position', 'x', 'y', 'gridRow', 'gridColumn', 'gridRowSpan',
    'gridColumnSpan', 'gridHAlign', 'gridVAlign',
  ]);
  const instanceOverridePrefixes = ['prop:', 'text:', 'fill:', 'swap:'];
  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  if (!isRecord(plan) || plan.kind !== 'figma-bridge/semantic-render-plan' || plan.version !== 1) {
    return { supported: false, problems: ['unsupported Semantic Render Plan contract'] };
  }
  if (typeof plan.adapter !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(plan.adapter)) {
    problems.push('render adapter must be a bounded lowercase identifier');
  }
  if (plan.designEntityBindings !== undefined) {
    const table = plan.designEntityBindings;
    const target = table?.targetConstraint;
    const entries = isRecord(table?.bindings) ? Object.entries(table.bindings) : [];
    if (!isRecord(table) || table.version !== 1 || !isRecord(table.registry)
      || !/^[a-f0-9]{64}$/.test(String(table.registry.sourceFingerprint || ''))
      || table.registry.schemaVersion !== 1 || !isRecord(target)
      || !['file-key', 'authenticated-session'].includes(target.kind)
      || (target.kind === 'file-key' && (typeof target.fileKey !== 'string' || !target.fileKey
        || target.fileKey.length > 256 || /[\u0000-\u001f\u007f]/.test(target.fileKey)))
      || !entries.length || entries.length > 2000) {
      problems.push('Design Entity binding table is invalid');
    } else {
      for (const [entity, binding] of entries) {
        if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(entity)
          || !isRecord(binding) || binding.entityId !== entity
          || !['component', 'screen', 'frame'].includes(binding.entityKind)
          || !['published-key', 'local-node', 'created-root'].includes(binding.handleKind)
          || typeof binding.handle !== 'string' || !binding.handle || binding.handle.length > 256
          || /[\u0000-\u001f\u007f]/.test(binding.handle)
          || !Array.isArray(binding.purposes) || !binding.purposes.length
          || binding.purposes.length > 3
          || new Set(binding.purposes).size !== binding.purposes.length
          || binding.purposes.some((purpose) => !['instance', 'instance-swap', 'render-root'].includes(purpose))
          || !Array.isArray(binding.variantIntents) || binding.variantIntents.length > 100
          || new Set(binding.variantIntents).size !== binding.variantIntents.length
          || binding.variantIntents.some((variant) => typeof variant !== 'string' || !variant
            || variant.length > 512 || /[\u0000-\u001f\u007f]/.test(variant))
          || (binding.handleKind === 'local-node' && !/^\d+:\d+$/.test(binding.handle))
          || (binding.handleKind === 'created-root'
            && (binding.handle !== 'created-root' || binding.entityKind === 'component'
              || !binding.purposes.includes('render-root')))
          || (binding.handleKind !== 'created-root'
            && (binding.entityKind !== 'component' || binding.purposes.includes('render-root')))
          || (binding.localFallback !== undefined
            && (!isRecord(binding.localFallback)
              || binding.handleKind !== 'published-key'
              || binding.localFallback.handleKind !== 'local-node'
              || !/^\d+:\d+$/.test(binding.localFallback.handle)
              || typeof binding.localFallback.fileKey !== 'string'
              || !binding.localFallback.fileKey || binding.localFallback.fileKey.length > 256
              || /[\u0000-\u001f\u007f]/.test(binding.localFallback.fileKey)))) {
          problems.push(`Design Entity binding ${entity} is invalid`);
          break;
        }
      }
    }
  }
  if (plan.provenance !== undefined) {
    let serialized = '';
    try { serialized = JSON.stringify(plan.provenance); } catch (e) {}
    if (!isRecord(plan.provenance) || !serialized || serialized.length > 1024) {
      problems.push('render provenance must be a bounded object');
    }
  }
  if (plan.adapter === 'dom-capture' && isRecord(plan.provenance)) {
    if (!Number.isInteger(plan.provenance.captureVersion) || plan.provenance.captureVersion < 1) {
      problems.push('DOM-capture provenance requires a positive captureVersion');
    }
    if (plan.provenance.captureHash !== undefined
      && !/^[a-f0-9]{64}$/.test(String(plan.provenance.captureHash))) {
      problems.push('DOM-capture provenance captureHash must be SHA-256');
    }
    if (plan.provenance.viewport !== undefined
      && (!isRecord(plan.provenance.viewport)
        || !Number.isFinite(plan.provenance.viewport.width) || plan.provenance.viewport.width <= 0
        || !Number.isFinite(plan.provenance.viewport.height) || plan.provenance.viewport.height <= 0)) {
      problems.push('DOM-capture provenance viewport must contain positive width and height');
    }
  }
  const visit = (node, path = 'root') => {
    if (!isRecord(node) || !isRecord(node.source) || !isRecord(node.source.props)) {
      problems.push(`${path}: missing executable source properties`);
      return;
    }
    if (node.fallbackAnnotations !== undefined) {
      if (!Array.isArray(node.fallbackAnnotations)) problems.push(`${path}: fallbackAnnotations must be an array`);
      else {
        const policies = new Set();
        for (let index = 0; index < node.fallbackAnnotations.length; index++) {
          fallbackAnnotationCount++;
          const annotation = node.fallbackAnnotations[index];
          const label = `${path}.fallbackAnnotations[${index}]`;
          if (!isRecord(annotation)) { problems.push(`${label}: must be an object`); continue; }
          if (typeof annotation.policy !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(annotation.policy)) problems.push(`${label}: policy is invalid`);
          else if (policies.has(annotation.policy)) problems.push(`${label}: policy ${annotation.policy} is duplicated`);
          else policies.add(annotation.policy);
          if (typeof annotation.labelMarkdown !== 'string' || !annotation.labelMarkdown.trim() || annotation.labelMarkdown.length > 1000) problems.push(`${label}: labelMarkdown must contain at most 1000 characters`);
          if (!Array.isArray(annotation.properties) || annotation.properties.some((property) => !annotationProperties.has(property))) problems.push(`${label}: properties contains an unsupported Figma annotation property`);
        }
      }
    }
    const type = node.source.type;
    const allowed = type === 'frame' ? frameProps
      : type === 'text' ? textProps
        : type === 'rect' ? rectProps
          : type === 'ellipse' ? ellipseProps
            : type === 'icon' ? iconProps
              : type === 'image' ? imageProps
              : type === 'instance' ? instanceProps
                : null;
    if (!allowed) problems.push(`${path}: node type ${type || 'missing'} is not supported by the native executor`);
    else {
      for (const key of Object.keys(node.source.props)) {
        const dynamicInstanceOverride = type === 'instance'
          && instanceOverridePrefixes.some((prefix) => key.startsWith(prefix));
        if (!allowed.has(key) && !dynamicInstanceOverride) problems.push(`${path}: ${type}.${key} is not supported by the native executor`);
        if (dynamicInstanceOverride && !key.slice(key.indexOf(':') + 1).trim()) {
          problems.push(`${path}: ${key} needs a property or layer name after the colon`);
        }
      }
      const props = node.source.props;
      if (type === 'frame' && (!structuredFillPaintSupported(props.bg ?? props.fill) || !structuredPaintSupported(props.stroke))) problems.push(`${path}: frame paint needs the compatibility executor`);
      if (type === 'frame' && props.image != null) {
        if (!node.asset || node.asset.kind !== 'embedded-raster') problems.push(`${path}: frame image needs host-materialized embedded bytes`);
        if (props.imageScale != null && !['fill', 'fit', 'crop', 'tile'].includes(String(props.imageScale).toLowerCase())) problems.push(`${path}: imageScale is unsupported`);
      }
      if (type === 'text' && !structuredPaintSupported(props.color)) problems.push(`${path}: text paint needs the compatibility executor`);
      if (type === 'rect' && !structuredFillPaintSupported(props.bg ?? props.fill)) problems.push(`${path}: rectangle paint needs the compatibility executor`);
      if (type === 'ellipse' && (!structuredFillPaintSupported(props.bg ?? props.fill) || !structuredPaintSupported(props.stroke))) problems.push(`${path}: ellipse paint needs the compatibility executor`);
      if (type === 'icon' && !structuredColorSupported(props.color ?? props.c)) problems.push(`${path}: icon paint needs the compatibility executor`);
      if (type === 'image') {
        if (!node.asset || node.asset.kind !== STRUCTURED_RENDER_IMAGE_ASSET_KIND) {
          problems.push(`${path}: ${STRUCTURED_RENDER_IMAGE_ASSET_PROBLEM}`);
        }
        if (props.imageScale != null && !['fill', 'fit', 'crop', 'tile'].includes(String(props.imageScale).toLowerCase())) problems.push(`${path}: imageScale is unsupported`);
      }
      if (type === 'instance') {
        if (typeof props.entity !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(props.entity)) problems.push(`${path}: native instances require an explicit Registry Design Entity id`);
        const binding = plan.designEntityBindings?.bindings?.[props.entity];
        if (!binding || binding.entityKind !== 'component'
          || !binding.purposes?.includes('instance')) problems.push(`${path}: Registry instance needs an immutable component binding`);
        if (props.key != null || props.id != null) problems.push(`${path}: component handles must exist only in the Plan binding table`);
        if (props.component != null) problems.push(`${path}: name-based component lookup is not supported; use the Registry key/id`);
        try { structuredVariantPairs(props.variant); }
        catch (error) { problems.push(`${path}: ${error.message}`); }
        if (props.variant != null && binding
          && !binding.variantIntents?.includes(String(props.variant))) {
          problems.push(`${path}: variant intent is absent from the immutable component binding`);
        }
        for (const entry of structuredOverrideEntries(props, 'fill')) {
          if (!structuredColorSupported(entry.value)) problems.push(`${path}: ${entry.key} needs a solid color or COLOR variable`);
        }
        for (const entry of structuredOverrideEntries(props, 'swap')) {
          const entity = String(entry.value);
          if (!structuredDesignEntityId(entity)) problems.push(`${path}: ${entry.key} needs a Registry Design Entity id`);
          else {
            const swapBinding = plan.designEntityBindings?.bindings?.[entity];
            if (!swapBinding || swapBinding.entityKind !== 'component'
              || !swapBinding.purposes?.includes('instance-swap')) problems.push(`${path}: swap Design Entity ${entity} has no immutable component binding`);
          }
        }
        if ((node.children || []).length) problems.push(`${path}: an Instance cannot contain authored child nodes`);
      }
      if (type === 'frame' && props.entity != null) {
        const binding = plan.designEntityBindings?.bindings?.[props.entity];
        if (path !== 'root') problems.push(`${path}: only the rendered root may carry a Design Entity`);
        if (!binding || !['screen', 'frame'].includes(binding.entityKind)
          || binding.handleKind !== 'created-root'
          || !binding.purposes?.includes('render-root')) {
          problems.push(`${path}: rendered-root Design Entity needs an immutable created-root binding`);
        }
      }
      if (type === 'frame' && props.flex === 'grid' && (!props.gridColumns || !props.gridRows)) {
        problems.push(`${path}: Grid requires explicit rows and columns`);
      }
      if (type === 'frame' && props.flex === 'grid') {
        try { structuredTracks(props.gridRows); structuredTracks(props.gridColumns); }
        catch (error) { problems.push(`${path}: ${error.message}`); }
      }
      if (props.position != null && props.position !== 'absolute') problems.push(`${path}: position must be absolute`);
      if (props.opacity != null && (Number(props.opacity) < 0 || Number(props.opacity) > 1)) problems.push(`${path}: opacity must be between 0 and 1`);
      if (props.gridHAlign != null && !['min', 'center', 'max', 'auto'].includes(String(props.gridHAlign).toLowerCase())) problems.push(`${path}: gridHAlign is unsupported`);
      if (props.gridVAlign != null && !['min', 'center', 'max', 'auto'].includes(String(props.gridVAlign).toLowerCase())) problems.push(`${path}: gridVAlign is unsupported`);
      if (props.maskType != null && !['alpha', 'vector', 'luminance'].includes(String(props.maskType).toLowerCase())) problems.push(`${path}: maskType is unsupported`);
      if (props.blendMode != null && !['normal', 'darken', 'multiply', 'linear-burn', 'color-burn', 'lighten', 'screen', 'linear-dodge', 'color-dodge', 'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'pass-through'].includes(String(props.blendMode).toLowerCase())) problems.push(`${path}: blendMode is unsupported`);
      for (const key of ['w', 'h', 'width', 'height']) {
        const raw = props[key];
        if (raw != null && !['fill', 'hug'].includes(raw) && !structuredNumericSupported(raw, { variable: true })) {
          problems.push(`${path}: ${key} must be numeric, fill, hug, or a FLOAT variable`);
        }
      }
      for (const key of ['x', 'y', 'opacity', 'rotate', 'minW', 'maxW', 'minH', 'maxH', 'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan']) {
        const dimensionConstraint = ['minW', 'maxW', 'minH', 'maxH'].includes(key);
        if (props[key] != null && !(dimensionConstraint
          ? structuredNumericSupported(props[key], { variable: true })
          : Number.isFinite(Number(props[key])))) problems.push(`${path}: ${key} must be numeric${dimensionConstraint ? ' or a FLOAT variable' : ''}`);
      }
      if (type === 'frame') {
        for (const key of ['gap', 'wrapGap', 'counterAxisSpacing', 'p', 'padding', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'grow', 'columnGap', 'rowGap']) {
          if (props[key] != null && !structuredNumericSupported(props[key], { variable: key !== 'grow' })) problems.push(`${path}: ${key} must be numeric or a FLOAT variable`);
        }
        if (props.wrap != null && ![true, false, 'true', 'false'].includes(props.wrap)) problems.push(`${path}: wrap must be true or false`);
        for (const key of ['strokeWidth', 'strokeTopWidth', 'strokeRightWidth', 'strokeBottomWidth', 'strokeLeftWidth', 'cornerSmoothing']) {
          if (props[key] != null && (!Number.isFinite(Number(props[key])) || Number(props[key]) < 0)) problems.push(`${path}: ${key} must be a non-negative number`);
        }
        if (props.cornerSmoothing != null && Number(props.cornerSmoothing) > 1) problems.push(`${path}: cornerSmoothing must be between 0 and 1`);
        try { structuredDashPattern(props.strokeDashPattern); }
        catch (error) { problems.push(`${path}: ${error.message}`); }
        if (props.strokeAlign != null && !['inside', 'outside', 'center'].includes(String(props.strokeAlign).toLowerCase())) problems.push(`${path}: strokeAlign is unsupported`);
        if (props.strokeCap != null && !['none', 'round', 'square'].includes(String(props.strokeCap).toLowerCase())) problems.push(`${path}: strokeCap is unsupported`);
        if (props.flex != null && !['row', 'col', 'column', 'grid', 'none', 'stack', 'free'].includes(props.flex)) problems.push(`${path}: flex is unsupported`);
        if (props.justify != null && !['start', 'center', 'end', 'between'].includes(props.justify)) problems.push(`${path}: justify is unsupported`);
        if ((props.items ?? props.align) != null && !['start', 'center', 'end', 'stretch'].includes(props.items ?? props.align)) problems.push(`${path}: items/align is unsupported`);
        if (props.stretch != null && ![true, false, 'true', 'false'].includes(props.stretch)) problems.push(`${path}: stretch must be true or false`);
        if (props.hug != null && !['both', 'w', 'width', 'h', 'height'].includes(String(props.hug))) problems.push(`${path}: hug must be both, width/w, or height/h`);
        if (props.overflow != null && !['visible', 'hidden', 'clip'].includes(String(props.overflow))) problems.push(`${path}: overflow must be visible, hidden, or clip`);
      }
      if (type === 'text') {
        for (const key of ['size', 'weight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent', 'grow']) {
          const variable = key !== 'grow';
          if (props[key] != null && !structuredNumericSupported(props[key], { variable })) problems.push(`${path}: ${key} must be numeric${variable ? ' or a FLOAT variable' : ''}`);
        }
        if (props.lineHeight != null && !structuredLineHeightSupported(props.lineHeight)) {
          problems.push(`${path}: lineHeight must be AUTO, PIXELS, PERCENT, or a FLOAT variable`);
        }
        for (const key of ['font', 'fontStyle']) {
          if (props[key] != null && !structuredStringSupported(props[key])) problems.push(`${path}: ${key} must be a string or STRING variable`);
        }
        if (props.align != null && !['left', 'center', 'right', 'justified'].includes(props.align)) problems.push(`${path}: text align is unsupported`);
        if (props.truncate != null && ![true, false, 'true', 'false'].includes(props.truncate)) problems.push(`${path}: truncate must be true or false`);
        if (props.maxLines != null && (!Number.isInteger(Number(props.maxLines)) || Number(props.maxLines) < 1)) problems.push(`${path}: maxLines must be a positive integer`);
        if (props.fontAxes != null) {
          try { structuredFontAxes(props.fontAxes); }
          catch (error) { problems.push(`${path}: ${error.message}`); }
        }
        if (props.runs != null) {
          if (!Array.isArray(props.runs)) problems.push(`${path}: rich-text runs must be an array`);
          else {
            const contentLength = String(props.content || '').length;
            let previousEnd = 0;
            for (let index = 0; index < props.runs.length; index++) {
              const run = props.runs[index];
              const label = `${path}.runs[${index}]`;
              if (!isRecord(run) || !Number.isInteger(run.start) || !Number.isInteger(run.end)
                || run.start < previousEnd || run.start < 0 || run.end <= run.start || run.end > contentLength) {
                problems.push(`${label}: range is invalid or overlapping`);
                continue;
              }
              previousEnd = run.end;
              if (!isRecord(run.style)) { problems.push(`${label}: style must be an object`); continue; }
              const allowedRunStyles = new Set(['font', 'fontStyle', 'weight', 'italic', 'color', 'size', 'letterSpacing', 'underline', 'decoration', 'href']);
              for (const key of Object.keys(run.style)) if (!allowedRunStyles.has(key)) problems.push(`${label}: style.${key} is unsupported`);
              for (const key of ['font', 'fontStyle']) if (run.style[key] != null && typeof run.style[key] !== 'string') problems.push(`${label}: ${key} must be a string`);
              for (const key of ['size', 'letterSpacing']) if (run.style[key] != null && !Number.isFinite(Number(run.style[key]))) problems.push(`${label}: ${key} must be numeric`);
              if (run.style.weight != null && typeof run.style.weight !== 'string' && !Number.isFinite(Number(run.style.weight))) problems.push(`${label}: weight must be a name or number`);
              if (run.style.color != null && (!structuredColorSupported(run.style.color) || structuredVariableSpec(run.style.color))) problems.push(`${label}: color must be a literal solid color`);
              if (run.style.italic != null && ![true, false, 'true', 'false'].includes(run.style.italic)) problems.push(`${label}: italic must be true or false`);
              if (run.style.underline != null && ![true, false, 'true', 'false'].includes(run.style.underline)) problems.push(`${label}: underline must be true or false`);
              if (run.style.decoration != null && !['none', 'underline', 'strikethrough'].includes(String(run.style.decoration).toLowerCase())) problems.push(`${label}: decoration is unsupported`);
              if (run.style.href != null && (typeof run.style.href !== 'string' || run.style.href.length > 2048 || !/^(https?:|mailto:|tel:)/i.test(run.style.href))) problems.push(`${label}: href must be an HTTP(S), mailto or tel URL`);
            }
          }
        }
      }
      for (const key of ['gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan']) {
        if (props[key] != null && (!Number.isInteger(Number(props[key])) || Number(props[key]) < 1)) problems.push(`${path}: ${key} must be a positive integer`);
      }
      if (type === 'ellipse') {
        for (const key of ['strokeWidth', 'arc', 'arcStart', 'innerRadius']) {
          if (props[key] != null && !Number.isFinite(Number(props[key]))) problems.push(`${path}: ${key} must be numeric`);
        }
        try { structuredDashPattern(props.strokeDashPattern); }
        catch (error) { problems.push(`${path}: ${error.message}`); }
        if (props.strokeAlign != null && !['inside', 'outside', 'center'].includes(String(props.strokeAlign).toLowerCase())) problems.push(`${path}: strokeAlign is unsupported`);
        if (props.strokeCap != null && !['none', 'round', 'square'].includes(String(props.strokeCap).toLowerCase())) problems.push(`${path}: strokeCap is unsupported`);
        if (props.strokeWidth != null && Number(props.strokeWidth) < 0) problems.push(`${path}: strokeWidth must be non-negative`);
      }
      if (type === 'rect' || type === 'image') {
        for (const key of ['rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'cornerSmoothing']) {
          if (props[key] != null && !structuredNumericSupported(props[key], { variable: key !== 'cornerSmoothing' })) problems.push(`${path}: ${key} must be numeric${key !== 'cornerSmoothing' ? ' or a FLOAT variable' : ''}`);
        }
        if (props.cornerSmoothing != null && (Number(props.cornerSmoothing) < 0 || Number(props.cornerSmoothing) > 1)) problems.push(`${path}: cornerSmoothing must be between 0 and 1`);
      }
      if (type === 'icon') {
        const asset = node.asset;
        if (!isRecord(asset) || typeof asset.svg !== 'string' || !/^\s*<svg\b/i.test(asset.svg)) {
          problems.push(`${path}: icon needs executable SVG asset intent`);
        } else if (asset.svg.length > 100 * 1024) {
          problems.push(`${path}: icon SVG exceeds 100 KB`);
        } else {
          for (const descriptor of structuredSvgFilterDescriptors(asset.svg)) {
            try { structuredEffects({ filter: descriptor.filter }); }
            catch (error) { problems.push(`${path}: SVG layer ${descriptor.id}: ${error.message}`); }
          }
        }
      }
      if (['frame', 'rect', 'ellipse', 'image'].includes(type)) {
        try {
          const effects = structuredEffects(props);
          const frameCannotUseSpread = type === 'frame'
            && effects.some((effect) => ['DROP_SHADOW', 'INNER_SHADOW'].includes(effect.type) && 'spread' in effect && effect.spread !== 0)
            && ((props.bg ?? props.fill) == null || (props.bg ?? props.fill) === 'none' || !(props.clip === true || props.clip === 'true'));
          if (frameCannotUseSpread) throw new Error('shadow spread on a Frame requires a visible fill and clip=true in the Figma API');
        }
        catch (error) { problems.push(`${path}: ${error.message}`); }
      }
    }
    for (let index = 0; index < (node.children || []).length; index++) visit(node.children[index], `${path}.children[${index}]`);
    if (type === 'frame' && node.source.props.flex === 'grid') {
      if (node.source.props.gridAutoFlow === 'column') {
        const flowChildren = (node.children || []).filter((child) => child.source?.props?.position !== 'absolute');
        const allExplicit = flowChildren.every((child) => child.source?.props?.gridRow != null && child.source?.props?.gridColumn != null);
        if (!allExplicit) problems.push(`${path}: column Grid auto-flow needs explicit gridRow/gridColumn placement for every flow child`);
      } else if (node.source.props.gridAutoFlow != null && node.source.props.gridAutoFlow !== 'row') {
        problems.push(`${path}: gridAutoFlow is unsupported`);
      }
      try {
        const rows = structuredTracks(node.source.props.gridRows).length;
        const columns = structuredTracks(node.source.props.gridColumns).length;
        const occupied = new Set();
        for (let index = 0; index < (node.children || []).length; index++) {
          const childProps = node.children[index]?.source?.props || {};
          if (childProps.gridRow == null && childProps.gridColumn == null) continue;
          if (childProps.gridRow == null || childProps.gridColumn == null) {
            problems.push(`${path}.children[${index}]: explicit Grid placement needs both gridRow and gridColumn`);
            continue;
          }
          const row = Number(childProps.gridRow), column = Number(childProps.gridColumn);
          const rowSpan = Number(childProps.gridRowSpan || 1), columnSpan = Number(childProps.gridColumnSpan || 1);
          if (![row, column, rowSpan, columnSpan].every(Number.isInteger)) continue;
          if (row + rowSpan - 1 > rows || column + columnSpan - 1 > columns) {
            problems.push(`${path}.children[${index}]: Grid placement exceeds declared tracks`);
            continue;
          }
          for (let r = row; r < row + rowSpan; r++) {
            for (let c = column; c < column + columnSpan; c++) {
              const cell = `${r}:${c}`;
              if (occupied.has(cell)) problems.push(`${path}.children[${index}]: Grid placement overlaps cell ${cell}`);
              occupied.add(cell);
            }
          }
        }
      } catch {}
    }
  };
  visit(plan.root);
  if (fallbackAnnotationCount > 500) problems.push('Render Plan exceeds 500 fallback annotations');
  return { supported: problems.length === 0, problems };
}

async function prepareStructuredVariables(figmaApi, plan, journal = null, {
  materializeGenerated = false,
} = {}) {
  const intents = [];
  const bindings = new WeakMap();
  const addColor = (node, key, raw) => {
    const spec = structuredVariableSpec(raw);
    if (spec) intents.push({ node, key, type: 'COLOR', spec, kind: null });
  };
  const addFloat = (node, key, raw, kind, { generated = true } = {}) => {
    const spec = structuredVariableSpec(raw);
    if (spec) intents.push({ node, key, type: 'FLOAT', spec, kind });
    else if (generated && Number(raw) > 0) {
      const number = Number(raw);
      // Figma rejects decimal points in variable names. Keep the exact numeric
      // value while using the established token-safe spelling (0.5 -> 0-5).
      const tokenNumber = String(number).replace(/\./g, '-');
      intents.push({
        node, key, type: 'FLOAT', kind,
        spec: { requested: `${kind === 'radius' ? 'radius' : 'space'}/${tokenNumber}px`, name: `${kind === 'radius' ? 'radius' : 'space'}/${tokenNumber}px`, collection: null, fallback: String(number) },
        generated: true,
      });
    }
  };
  const addString = (node, key, raw, kind) => {
    const spec = structuredVariableSpec(raw);
    if (spec) intents.push({ node, key, type: 'STRING', spec, kind });
  };
  const addDimensions = (node, props) => {
    addFloat(node, 'width', props.w ?? props.width, 'dimension', { generated: false });
    addFloat(node, 'height', props.h ?? props.height, 'dimension', { generated: false });
    addFloat(node, 'minWidth', props.minW, 'dimension', { generated: false });
    addFloat(node, 'maxWidth', props.maxW, 'dimension', { generated: false });
    addFloat(node, 'minHeight', props.minH, 'dimension', { generated: false });
    addFloat(node, 'maxHeight', props.maxH, 'dimension', { generated: false });
  };
  const collect = (node) => {
    const props = node.source.props;
    const type = node.source.type;
    addDimensions(node, props);
    if (type === 'frame') {
      addColor(node, 'fill', props.bg ?? props.fill);
      addColor(node, 'stroke', props.stroke);
      const padding = props.p ?? props.padding;
      const px = props.px ?? padding, py = props.py ?? padding;
      addFloat(node, 'paddingTop', props.pt ?? py, 'space');
      addFloat(node, 'paddingRight', props.pr ?? px, 'space');
      addFloat(node, 'paddingBottom', props.pb ?? py, 'space');
      addFloat(node, 'paddingLeft', props.pl ?? px, 'space');
      if (props.flex === 'grid') {
        addFloat(node, 'gridRowGap', props.rowGap, 'space');
        addFloat(node, 'gridColumnGap', props.columnGap ?? props.gap, 'space');
      } else {
        const horizontal = props.flex === 'row';
        if (props.justify !== 'between') addFloat(node, 'itemSpacing', horizontal ? (props.columnGap ?? props.gap) : (props.rowGap ?? props.gap), 'space');
        if (props.wrap === true || props.wrap === 'true') addFloat(node, 'counterAxisSpacing', horizontal
          ? (props.rowGap ?? props.wrapGap ?? props.counterAxisSpacing)
          : (props.columnGap ?? props.wrapGap ?? props.counterAxisSpacing), 'space');
      }
      const radius = props.rounded ?? props.radius;
      addFloat(node, 'topLeftRadius', props.roundedTL ?? radius, 'radius');
      addFloat(node, 'topRightRadius', props.roundedTR ?? radius, 'radius');
      addFloat(node, 'bottomLeftRadius', props.roundedBL ?? radius, 'radius');
      addFloat(node, 'bottomRightRadius', props.roundedBR ?? radius, 'radius');
    } else if (type === 'text') {
      addColor(node, 'fill', props.color);
      addFloat(node, 'fontSize', props.size, 'typography', { generated: false });
      addFloat(node, 'fontWeight', props.weight, 'typography', { generated: false });
      addFloat(node, 'lineHeight', props.lineHeight, 'typography', { generated: false });
      addFloat(node, 'letterSpacing', props.letterSpacing, 'typography', { generated: false });
      addFloat(node, 'paragraphSpacing', props.paragraphSpacing, 'typography', { generated: false });
      addFloat(node, 'paragraphIndent', props.paragraphIndent, 'typography', { generated: false });
      addString(node, 'fontFamily', props.font, 'typography');
      addString(node, 'fontStyle', props.fontStyle, 'typography');
    } else if (type === 'rect' || type === 'image') {
      if (type === 'rect') addColor(node, 'fill', props.bg ?? props.fill);
      const radius = props.rounded ?? props.radius;
      addFloat(node, 'topLeftRadius', props.roundedTL ?? radius, 'radius');
      addFloat(node, 'topRightRadius', props.roundedTR ?? radius, 'radius');
      addFloat(node, 'bottomLeftRadius', props.roundedBL ?? radius, 'radius');
      addFloat(node, 'bottomRightRadius', props.roundedBR ?? radius, 'radius');
    } else if (type === 'ellipse') {
      addColor(node, 'fill', props.bg ?? props.fill);
      addColor(node, 'stroke', props.stroke);
    } else if (type === 'icon') addColor(node, 'color', props.color ?? props.c);
    else if (type === 'instance') {
      for (const entry of structuredOverrideEntries(props, 'fill')) addColor(node, entry.key, entry.value);
    }
    for (const child of node.children || []) collect(child);
  };
  collect(plan.root);

  const reusedVariableIds = new Set();
  const report = {
    references: intents.length, reused: 0, created: 0, bound: 0,
    literal: 0, ambiguous: 0, unsupported: 0,
  };
  const fail = (prefix, entries, { unsupported = null } = {}) => {
    const ambiguous = entries.filter((entry) => /ambiguous/i.test(entry)).length;
    const next = {
      ...report,
      reused: reusedVariableIds.size,
      ambiguous,
      unsupported: unsupported ?? Math.max(0, entries.length - ambiguous),
    };
    throw new Error(`${prefix}: ${entries.slice(0, 5).join('; ')} [variable report: reused=${next.reused}, created=0, bound=0, literal=${next.literal}, ambiguous=${next.ambiguous}, unsupported=${next.unsupported}]`);
  };

  if (intents.length && !figmaApi.variables) fail('Structured variable preflight failed', ['Figma variables are unavailable']);
  const [collections, variables] = intents.length
    ? await Promise.all([
      figmaApi.variables.getLocalVariableCollectionsAsync(),
      figmaApi.variables.getLocalVariablesAsync(),
    ])
    : [[], []];
  const failures = [];
  const pending = new Map();
  const plannedNames = new Map();
  const resolutions = new Map();

  const variableValue = (variable, seen = new Set()) => {
    if (!variable || seen.has(variable.id)) return null;
    seen.add(variable.id);
    let value = Object.values(variable.valuesByMode || {})[0];
    if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
      value = variableValue(variables.find((candidate) => candidate.id === value.id), seen);
    }
    return value;
  };
  const chooseCollection = (requested, allowMissing, label) => {
    if (!requested) return null;
    const lower = requested.toLowerCase();
    let matches = collections.filter((collection) => collection.name.toLowerCase() === lower);
    if (!matches.length) matches = collections.filter((collection) => collection.name.toLowerCase().includes(lower));
    if (matches.length > 1) {
      failures.push(`${label}: collection "${requested}" is ambiguous (${matches.map((item) => item.name).join(', ')})`);
      return null;
    }
    if (!matches.length && !allowMissing) failures.push(`${label}: collection "${requested}" does not exist`);
    return matches[0] || null;
  };
  const namespaceMatches = (name, kind) => {
    const head = String(name || '').toLowerCase().split('/')[0];
    return kind === 'radius' ? ['radius', 'radii'].includes(head) : ['space', 'spacing'].includes(head);
  };
  const resolveIntent = (intent, index) => {
    const label = `variable ${intent.spec.requested} at intent ${index + 1}`;
    const requestedCollection = intent.spec.collection || plan.variableCollection || null;
    const fallback = intent.type === 'FLOAT'
      ? (intent.spec.fallback == null ? null : Number(intent.spec.fallback))
      : intent.spec.fallback;
    const mayCreate = fallback != null && (intent.type !== 'FLOAT' || Number.isFinite(fallback));
    let collection = chooseCollection(requestedCollection, mayCreate, label);
    if (requestedCollection && !collection && failures.some((failure) => failure.startsWith(`${label}: collection`) && failure.includes('ambiguous'))) return null;
    const scoped = collection ? variables.filter((variable) => variable.variableCollectionId === collection.id) : requestedCollection ? [] : variables;
    let candidates;
    if (intent.generated) {
      // Literal spacing/radius values own a deterministic generated identity.
      // Value matching against authored aliases (for example space/5 and
      // space/xl both equal to 20) guesses design-system semantics and makes a
      // harmless literal ambiguous. Reuse only the exact generated name;
      // otherwise create that name in the chosen/default collection.
      candidates = scoped.filter((variable) => variable.resolvedType === 'FLOAT'
        && namespaceMatches(variable.name, intent.kind)
        && variable.name === intent.spec.name);
    } else {
      candidates = scoped.filter((variable) => variable.name === intent.spec.name);
      if (!candidates.length) candidates = scoped.filter((variable) => variable.name.split('/').slice(-1)[0] === intent.spec.name);
    }
    if (candidates.length > 1) {
      if (intent.generated) {
        report.ambiguous++;
        return { variable: null, value: fallback, unbound: 'ambiguous' };
      }
      failures.push(`${label}: variable is ambiguous (${candidates.map((item) => item.name).join(', ')})`);
      return null;
    }
    if (candidates.length === 1) {
      const variable = candidates[0];
      if (variable.resolvedType !== intent.type) {
        failures.push(`${label}: expected ${intent.type}, found ${variable.resolvedType}`);
        return null;
      }
      const value = variableValue(variable);
      if (intent.generated && value !== fallback) {
        report.unsupported++;
        return { variable: null, value: fallback, unbound: 'value-mismatch' };
      }
      reusedVariableIds.add(variable.id);
      return { variable, value };
    }
    if (intent.generated && !materializeGenerated) {
      report.literal++;
      return { variable: null, value: fallback, unbound: 'literal' };
    }
    if (!mayCreate) {
      failures.push(`${label}: missing ${intent.type} variable and no usable fallback was supplied`);
      return null;
    }
    const targetName = requestedCollection || 'Tokens';
    if (intent.generated && !requestedCollection) {
      const defaultCollections = collections.filter((candidate) => candidate.name.toLowerCase() === 'tokens');
      if (defaultCollections.length > 1) {
        report.ambiguous++;
        return { variable: null, value: fallback, unbound: 'ambiguous-collection' };
      }
      collection = defaultCollections[0] || null;
    }
    const identity = `${targetName.toLowerCase()}:${intent.spec.name}`;
    const priorType = plannedNames.get(identity);
    if (priorType && priorType !== intent.type) {
      failures.push(`${label}: the same variable is required as both ${priorType} and ${intent.type}`);
      return null;
    }
    plannedNames.set(identity, intent.type);
    const key = `${identity}:${intent.type}`;
    const prior = pending.get(key);
    if (prior && JSON.stringify(prior.value) !== JSON.stringify(fallback)) {
      failures.push(`${label}: conflicting fallback values for the same variable`);
      return null;
    }
    if (!prior) pending.set(key, {
      key, name: intent.spec.name, type: intent.type, value: fallback,
      collection, collectionName: targetName,
    });
    return { pendingKey: key, value: fallback };
  };

  for (let index = 0; index < intents.length; index++) resolutions.set(intents[index], resolveIntent(intents[index], index));
  if (failures.length) fail('Structured variable preflight failed', failures);

  const intentByNode = new WeakMap();
  for (const intent of intents) {
    if (!intentByNode.has(intent.node)) intentByNode.set(intent.node, new Map());
    intentByNode.get(intent.node).set(intent.key, intent);
  }
  const resolvedIntentValue = (node, key, raw, fallback) => {
    const intent = intentByNode.get(node)?.get(key);
    if (!intent) return raw ?? fallback;
    const resolution = resolutions.get(intent);
    const final = resolution?.pendingKey ? pending.get(resolution.pendingKey) : resolution;
    return final?.value ?? intent.spec.fallback ?? raw ?? fallback;
  };
  const fontNames = new WeakMap();
  const runFontNames = new WeakMap();
  const fontRequests = [];
  const collectTextFonts = (node) => {
    if (node.source.type === 'text') {
      const props = node.source.props;
      const family = String(resolvedIntentValue(node, 'fontFamily', props.font, 'Inter'));
      const weight = resolvedIntentValue(node, 'fontWeight', props.weight, 400);
      const explicitStyle = resolvedIntentValue(node, 'fontStyle', props.fontStyle, null);
      const fontName = { family, style: explicitStyle ? String(explicitStyle) : structuredFontStyle(weight, props.italic) };
      fontRequests.push({ node, fontName, exact: Boolean(structuredVariableSpec(props.font) || structuredVariableSpec(props.fontStyle)) });
      for (let index = 0; index < (props.runs || []).length; index++) {
        const style = props.runs[index].style || {};
        if (style.font == null && style.fontStyle == null && style.weight == null && style.italic == null) continue;
        const runFamily = String(style.font ?? family);
        const runStyle = style.fontStyle != null
          ? String(style.fontStyle)
          : structuredFontStyle(style.weight ?? weight, style.italic ?? props.italic);
        fontRequests.push({ node, runIndex: index, fontName: { family: runFamily, style: runStyle }, exact: false });
      }
    }
    for (const child of node.children || []) collectTextFonts(child);
  };
  collectTextFonts(plan.root);
  const loadedFontCache = new Map();
  for (const request of fontRequests) {
    const key = `${request.fontName.family}/${request.fontName.style}`;
    let loaded = loadedFontCache.get(key);
    if (!loaded) {
      let originalError = null;
      for (const candidate of structuredFontNameCandidates(request.fontName)) {
        try {
          await figmaApi.loadFontAsync(candidate);
          loaded = candidate;
          break;
        } catch (error) { originalError ||= error; }
      }
      if (!loaded) {
        if (request.exact) {
          fail('Structured variable preflight failed', [`bound font ${key} is unavailable; install it or provide an available family/style (${originalError?.message || originalError})`]);
        }
        const fallbacks = [
          ...structuredFontNameCandidates({ family: 'Inter', style: request.fontName.style }),
          { family: 'Inter', style: 'Regular' },
        ];
        for (const candidate of fallbacks) {
          try {
            await figmaApi.loadFontAsync(candidate);
            loaded = candidate;
            break;
          } catch {}
        }
        if (!loaded) throw originalError || new Error(`font ${key} is unavailable`);
      }
      loadedFontCache.set(key, loaded);
    }
    if (request.runIndex === undefined) fontNames.set(request.node, loaded);
    else {
      if (!runFontNames.has(request.node)) runFontNames.set(request.node, new Map());
      runFontNames.get(request.node).set(request.runIndex, loaded);
    }
  }

  const createdVariables = [];
  const createdVariableObjects = [];
  const scopeQuestions = [];
  const createdCollections = new Map();
  const newCollectionObjects = [];
  try {
    for (const descriptor of pending.values()) {
      let collection = descriptor.collection;
      if (!collection) {
        const key = descriptor.collectionName.toLowerCase();
        collection = createdCollections.get(key)
          || collections.find((candidate) => candidate.name.toLowerCase() === key);
        if (!collection) {
          collection = figmaApi.variables.createVariableCollection(descriptor.collectionName);
          newCollectionObjects.push(collection);
          journal?.record('variable-collection', collection);
        }
        createdCollections.set(key, collection);
        if (!collections.includes(collection)) collections.push(collection);
      }
      let name = descriptor.name;
      if (variables.some((variable) => variable.variableCollectionId === collection.id && variable.name === name)) {
        let suffix = 2;
        while (variables.some((variable) => variable.variableCollectionId === collection.id && variable.name === `${descriptor.name}-${suffix}`)) suffix++;
        name = `${descriptor.name}-${suffix}`;
      }
      const variable = figmaApi.variables.createVariable(name, collection, descriptor.type);
      createdVariableObjects.push(variable);
      journal?.record('variable', variable);
      const value = descriptor.type === 'COLOR'
        ? (() => {
          const source = String(descriptor.value).replace(/^#/, '');
          const full = source.length === 3 ? source.split('').map((part) => part + part).join('') : source;
          return { r: parseInt(full.slice(0, 2), 16) / 255, g: parseInt(full.slice(2, 4), 16) / 255, b: parseInt(full.slice(4, 6), 16) / 255, a: full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1 };
        })()
        : descriptor.value;
      for (const mode of collection.modes || []) variable.setValueForMode(mode.modeId, value);
      const scopes = structuredVariableScopes(name, descriptor.type);
      if (scopes) variable.scopes = scopes;
      else scopeQuestions.push(structuredScopeQuestion(name, descriptor.type, collection.name));
      variables.push(variable);
      createdVariables.push(`${collection.name}/${name}`);
      descriptor.variable = variable;
      descriptor.value = value;
    }
  } catch (error) {
    // Resource preparation is part of preflight. Roll back any primitives
    // created earlier in this loop so a rejected name/value cannot leave a
    // partially populated token collection behind.
    if (!journal) {
      for (const variable of createdVariableObjects.reverse()) {
        try { variable.remove(); } catch {}
      }
      for (const collection of newCollectionObjects.reverse()) {
        try { collection.remove(); } catch {}
      }
    }
    throw error;
  }

  for (const intent of intents) {
    const resolution = resolutions.get(intent);
    if (!resolution) continue;
    const final = resolution.pendingKey ? pending.get(resolution.pendingKey) : resolution;
    if (!final?.variable) continue;
    if (!bindings.has(intent.node)) bindings.set(intent.node, new Map());
    bindings.get(intent.node).set(intent.key, { variable: final.variable, value: final.value });
  }
  Object.assign(report, {
    reused: reusedVariableIds.size,
    created: createdVariables.length,
    bound: intents.length - report.literal - report.ambiguous - report.unsupported,
  });
  return { bindings, createdVariables: createdVariables.sort(), scopeQuestions, fontNames, runFontNames, variableReport: report };
}

function structuredTextStyleValue(value, fallback) {
  if (!value || typeof value !== 'object') return fallback;
  const unit = String(value.unit || fallback.unit).toUpperCase();
  if (unit === 'AUTO') return { unit: 'AUTO' };
  return { unit, value: structuredNumber(value.value, fallback.value) };
}

function structuredTextStyleSignature(descriptor) {
  // Figma stores many style scalars as float32 (for example 1.54 becomes
  // 1.5399999618530273). Canonicalize before reconciliation so a style just
  // created from the same CSS value can be reused by the next text run.
  const canonicalNumber = (value) => Math.round(structuredNumber(value) * 10000) / 10000;
  const lineHeight = structuredTextStyleValue(descriptor.lineHeight, { unit: 'AUTO' });
  let letterSpacing = structuredTextStyleValue(descriptor.letterSpacing, { unit: 'PIXELS', value: 0 });
  if (canonicalNumber(letterSpacing.value) === 0) letterSpacing = { unit: 'PIXELS', value: 0 };
  return JSON.stringify({
    family: descriptor.fontName?.family || '',
    style: descriptor.fontName?.style || '',
    size: canonicalNumber(descriptor.fontSize),
    lineHeight: lineHeight.unit === 'AUTO' ? lineHeight : { ...lineHeight, value: canonicalNumber(lineHeight.value) },
    letterSpacing: { ...letterSpacing, value: canonicalNumber(letterSpacing.value) },
    paragraphSpacing: canonicalNumber(descriptor.paragraphSpacing),
    paragraphIndent: canonicalNumber(descriptor.paragraphIndent),
  });
}

async function prepareStructuredTextStyles(figmaApi, plan, variableContext, journal = null, {
  materializeGenerated = false,
} = {}) {
  const requests = [];
  const bindings = new WeakMap();
  const bindingValue = (node, key, raw, fallback) => variableContext.bindings.get(node)?.get(key)?.value ?? raw ?? fallback;
  const collect = (node) => {
    if (node.source.type === 'text') {
      const props = node.source.props;
      const fontName = variableContext.fontNames.get(node) || {
        family: String(bindingValue(node, 'fontFamily', props.font, 'Inter')),
        style: String(bindingValue(node, 'fontStyle', props.fontStyle, structuredFontStyle(bindingValue(node, 'fontWeight', props.weight, 400), props.italic))),
      };
      requests.push({
        node,
        explicitName: String(props.style || '').trim() || null,
        descriptor: {
          fontName,
          fontSize: structuredNumber(bindingValue(node, 'fontSize', props.size, 14), 14),
          lineHeight: structuredLineHeight(bindingValue(node, 'lineHeight', props.lineHeight)),
          letterSpacing: props.letterSpacing == null ? { unit: 'PIXELS', value: 0 } : { unit: 'PIXELS', value: structuredNumber(bindingValue(node, 'letterSpacing', props.letterSpacing)) },
          paragraphSpacing: structuredNumber(bindingValue(node, 'paragraphSpacing', props.paragraphSpacing, 0)),
          paragraphIndent: structuredNumber(bindingValue(node, 'paragraphIndent', props.paragraphIndent, 0)),
        },
      });
    }
    for (const child of node.children || []) collect(child);
  };
  collect(plan.root);
  if (!requests.length) return {
    bindings, createdStyles: [],
    textStyleReport: { references: 0, reused: 0, created: 0, bound: 0, literal: 0 },
  };
  if (typeof figmaApi.getLocalTextStylesAsync !== 'function' || typeof figmaApi.createTextStyle !== 'function') {
    if (!materializeGenerated && requests.every((request) => !request.explicitName)) {
      return {
        bindings, createdStyles: [],
        textStyleReport: {
          references: requests.length, reused: 0, created: 0, bound: 0,
          literal: requests.length,
        },
      };
    }
    throw new Error('Structured text-style preflight failed: local Text Style APIs are unavailable');
  }

  const styles = await figmaApi.getLocalTextStylesAsync();
  const createdObjects = [];
  const reusedIds = new Set();
  const createdStyles = [];
  let literal = 0;
  const styleBySignature = new Map();
  for (const style of styles) {
    const signature = structuredTextStyleSignature(style);
    if (!styleBySignature.has(signature)) styleBySignature.set(signature, style);
  }
  const generatedName = (descriptor) => {
    const family = String(descriptor.fontName.family).replace(/\//g, '-');
    const lineHeight = descriptor.lineHeight.unit === 'AUTO'
      ? 'Auto'
      : `${descriptor.lineHeight.value}${descriptor.lineHeight.unit === 'PERCENT' ? '%' : 'px'}`;
    const letterSpacing = descriptor.letterSpacing.value ? ` · LS ${descriptor.letterSpacing.value}px` : '';
    return `Typography/Generated/${family}/${descriptor.fontSize} ${descriptor.fontName.style} · LH ${lineHeight}${letterSpacing}`;
  };

  try {
    for (const request of requests) {
      const signature = structuredTextStyleSignature(request.descriptor);
      let style;
      if (request.explicitName) {
        style = styles.find((candidate) => candidate.name === request.explicitName);
        if (style && structuredTextStyleSignature(style) !== signature) {
          throw new Error(`named Text Style "${request.explicitName}" exists with different typography; reconcile or rename it before render`);
        }
      } else {
        style = styleBySignature.get(signature);
      }
      if (style) reusedIds.add(style.id);
      else {
        if (!request.explicitName && !materializeGenerated) {
          literal++;
          continue;
        }
        const name = request.explicitName || generatedName(request.descriptor);
        const sameName = styles.find((candidate) => candidate.name === name);
        if (sameName) throw new Error(`generated Text Style "${name}" collides with different typography`);
        style = figmaApi.createTextStyle();
        createdObjects.push(style);
        journal?.record('text-style', style);
        style.name = name;
        style.fontName = request.descriptor.fontName;
        style.fontSize = request.descriptor.fontSize;
        style.lineHeight = request.descriptor.lineHeight;
        style.letterSpacing = request.descriptor.letterSpacing;
        style.paragraphSpacing = request.descriptor.paragraphSpacing;
        style.paragraphIndent = request.descriptor.paragraphIndent;
        styles.push(style);
        createdStyles.push(name);
        styleBySignature.set(signature, style);
      }
      bindings.set(request.node, style);
    }
  } catch (error) {
    if (!journal) {
      for (const style of createdObjects.reverse()) {
        try { style.remove(); } catch {}
      }
    }
    throw new Error(`Structured text-style preflight failed: ${error.message || error}`);
  }
  return {
    bindings,
    createdStyles,
    textStyleReport: {
      references: requests.length,
      reused: reusedIds.size,
      created: createdStyles.length,
      bound: requests.length - literal,
      literal,
    },
  };
}

function auditStructuredCreatedNodes(records) {
  const mismatches = [];
  const summary = {
    nodes: records.length, grids: 0, autoLayouts: 0, freeLayouts: 0,
    instances: 0, absoluteNodes: 0,
  };
  const expectedTypes = {
    frame: 'FRAME', text: 'TEXT', rect: 'RECTANGLE', image: 'RECTANGLE',
    ellipse: 'ELLIPSE', icon: 'FRAME', instance: 'INSTANCE',
  };
  const mismatch = (semanticNode, fact, expected, actual) => mismatches.push({
    path: String(semanticNode.path || ''),
    fact: String(fact),
    expected: expected == null ? '(none)' : String(expected),
    actual: actual == null ? '(none)' : String(actual),
  });
  for (let index = 0; index < records.length; index++) {
    const { semanticNode, created, parent } = records[index];
    const sourceType = semanticNode.source.type;
    const props = semanticNode.source.props;
    const expectedType = expectedTypes[sourceType];
    if (created.type !== expectedType) mismatch(semanticNode, 'node type', expectedType, created.type);
    if (sourceType === 'instance') summary.instances++;
    if (sourceType === 'frame') {
      const expectedLayout = props.flex === 'grid'
        ? 'GRID'
        : ['none', 'stack', 'free'].includes(props.flex)
          ? 'NONE'
          : props.flex === 'row' ? 'HORIZONTAL' : 'VERTICAL';
      if (created.layoutMode !== expectedLayout) mismatch(semanticNode, 'layout mode', expectedLayout, created.layoutMode);
      if (expectedLayout === 'GRID') summary.grids++;
      else if (expectedLayout === 'NONE') summary.freeLayouts++;
      else summary.autoLayouts++;
    }
    if (parent && created.parent !== parent) {
      mismatch(semanticNode, 'parent', parent.id, created.parent?.id || null);
    }
    if (props.position === 'absolute') {
      summary.absoluteNodes++;
      if (parent?.layoutMode !== 'NONE' && created.layoutPositioning !== 'ABSOLUTE') {
        mismatch(semanticNode, 'layout positioning', 'ABSOLUTE', created.layoutPositioning || null);
      }
    }
    if (created.getPluginData('figmaBridge.semanticPath') !== String(semanticNode.path || '')) {
      mismatch(semanticNode, 'semantic path metadata', String(semanticNode.path || ''), created.getPluginData('figmaBridge.semanticPath'));
    }
    if (created.getPluginData('figmaBridge.semanticIndex') !== String(index)) {
      mismatch(semanticNode, 'semantic index metadata', String(index), created.getPluginData('figmaBridge.semanticIndex'));
    }
  }
  return {
    version: 1,
    passed: mismatches.length === 0,
    summary,
    mismatchCount: mismatches.length,
    ...(mismatches.length ? { mismatches: mismatches.slice(0, 20) } : {}),
  };
}

async function executePreparedStructuredRenderPlan(figmaApi, plan, {
  componentContext,
  imageContext,
  variableContext,
  textStyleContext,
}, journal) {
  const createdRecords = [];
  const fallbackAnnotationReport = { requested: 0, applied: 0, deduplicated: 0, unsupported: 0 };

  const value = (props, short, long, fallback = undefined) => props[short] ?? props[long] ?? fallback;
  const hex = (input) => {
    let source = String(input || '#000000').replace(/^#/, '');
    if (source.length === 3) source = source.split('').map((part) => part + part).join('');
    const alpha = source.length === 8 ? parseInt(source.slice(6), 16) / 255 : 1;
    source = source.slice(0, 6);
    return {
      type: 'SOLID',
      color: { r: parseInt(source.slice(0, 2), 16) / 255, g: parseInt(source.slice(2, 4), 16) / 255, b: parseInt(source.slice(4, 6), 16) / 255 },
      ...(alpha < 1 ? { opacity: alpha } : {}),
    };
  };
  const align = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
  const justify = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };

  const bindingFor = (node, key) => variableContext.bindings.get(node)?.get(key) || null;
  const resolvedNumber = (node, key, raw, fallback = 0) => {
    const binding = bindingFor(node, key);
    if (binding && typeof binding.value === 'number') return binding.value;
    const spec = structuredVariableSpec(raw);
    return structuredNumber(spec?.fallback ?? raw, fallback);
  };
  const resolvedString = (node, key, raw, fallback = '') => {
    const binding = bindingFor(node, key);
    if (binding && typeof binding.value === 'string') return binding.value;
    const spec = structuredVariableSpec(raw);
    return String(spec?.fallback ?? raw ?? fallback);
  };
  const bindScalar = (node, key, created, field) => {
    const binding = bindingFor(node, key);
    if (binding) created.setBoundVariable(field, binding.variable);
  };
  const solidPaint = (input, fallback) => {
    if (input && typeof input === 'object'
      && ['r', 'g', 'b'].every((channel) => Number.isFinite(Number(input[channel])))) {
      const alpha = Number.isFinite(Number(input.a)) ? Number(input.a) : 1;
      return {
        type: 'SOLID',
        color: { r: Number(input.r), g: Number(input.g), b: Number(input.b) },
        ...(alpha < 1 ? { opacity: alpha } : {}),
      };
    }
    return hex(input || fallback);
  };
  const boundPaint = (node, key, raw, fallback = '#808080', target = null) => {
    const binding = bindingFor(node, key);
    const spec = structuredVariableSpec(raw);
    const resolved = binding?.value ?? spec?.fallback ?? raw ?? fallback;
    const paint = binding ? solidPaint(resolved, fallback) : structuredGradientPaint(resolved, target) || hex(resolved);
    return binding ? figmaApi.variables.setBoundVariableForPaint(paint, 'color', binding.variable) : paint;
  };
  const boundPaints = (node, key, raw, fallback = '#808080', target = null) => {
    const binding = bindingFor(node, key);
    if (binding || structuredVariableSpec(raw)) return [boundPaint(node, key, raw, fallback, target)];
    const layers = structuredPaintLayers(raw || fallback);
    return layers.map((layer) => structuredGradientPaint(layer, target) || hex(layer));
  };
  const applyRichTextRuns = (created, semanticNode, props) => {
    for (let index = 0; index < (props.runs || []).length; index++) {
      const run = props.runs[index];
      const style = run.style || {};
      const fontName = variableContext.runFontNames.get(semanticNode)?.get(index);
      if (fontName) created.setRangeFontName(run.start, run.end, fontName);
      if (style.size != null) created.setRangeFontSize(run.start, run.end, structuredNumber(style.size));
      if (style.color != null) created.setRangeFills(run.start, run.end, [hex(style.color)]);
      if (style.letterSpacing != null) {
        created.setRangeLetterSpacing(run.start, run.end, { unit: 'PIXELS', value: structuredNumber(style.letterSpacing) });
      }
      const decoration = style.decoration != null
        ? String(style.decoration).toUpperCase()
        : (style.underline === true || style.underline === 'true') ? 'UNDERLINE' : null;
      if (decoration) created.setRangeTextDecoration(run.start, run.end, decoration);
      if (style.href) created.setRangeHyperlink(run.start, run.end, { type: 'URL', value: String(style.href) });
    }
  };

  const applyInstanceOverrides = (created, semanticNode) => {
    const prepared = componentContext.overrides.get(semanticNode);
    if (!prepared) return;
    const properties = {};
    for (const [key, raw] of Object.entries(prepared.properties)) {
      if (raw && typeof raw === 'object' && raw.entity) {
        const target = componentContext.swapComponents.get(raw.entity);
        if (!target) throw new Error(`Structured component preflight lost swap Design Entity ${raw.entity}`);
        properties[key] = target.id;
      } else properties[key] = raw;
    }
    if (Object.keys(properties).length) created.setProperties(properties);
    for (const entry of prepared.texts) {
      const target = structuredFindOverrideLayer(created, entry.target, (candidate) => candidate.type === 'TEXT', `Instance ${created.name} text:${entry.target}`);
      target.characters = String(entry.value);
    }
    for (const entry of prepared.fills) {
      const target = structuredFindOverrideLayer(created, entry.target, (candidate) => 'fills' in candidate, `Instance ${created.name} fill:${entry.target}`);
      target.fills = [boundPaint(semanticNode, entry.key, entry.value, '#808080', target)];
    }
    for (const entry of prepared.swaps) {
      const target = structuredFindOverrideLayer(created, entry.target, (candidate) => candidate.type === 'INSTANCE', `Instance ${created.name} swap:${entry.target}`);
      const component = componentContext.swapComponents.get(entry.entity);
      if (!component) throw new Error(`Structured component preflight lost swap Design Entity ${entry.entity}`);
      target.swapComponent(component);
    }
  };

  const existing = [...figmaApi.currentPage.children];
  const initialX = existing.reduce((right, node) => Math.max(right, structuredNumber(node.x) + structuredNumber(node.width)), 0) + (existing.length ? 100 : 0);

  const applyPlacement = (created, semanticNode, props, parent) => {
    if (props.opacity != null) created.opacity = structuredNumber(props.opacity, 1);
    if (props.visible === false || props.visible === 'false') created.visible = false;
    if (props.locked === true || props.locked === 'true') created.locked = true;
    if (props.rotate != null) created.rotation = structuredNumber(props.rotate);
    if (props.blendMode != null) created.blendMode = String(props.blendMode).toUpperCase().replace(/-/g, '_');
    if (props.mask != null || props.maskType != null) {
      created.isMask = !(props.mask === false || props.mask === 'false');
      if (created.isMask) created.maskType = String(props.maskType || (typeof props.mask === 'string' ? props.mask : 'ALPHA')).toUpperCase();
    }
    for (const [prop, apiName] of [['minW', 'minWidth'], ['maxW', 'maxWidth'], ['minH', 'minHeight'], ['maxH', 'maxHeight']]) {
      if (props[prop] != null) {
        created[apiName] = resolvedNumber(semanticNode, apiName, props[prop]);
        bindScalar(semanticNode, apiName, created, apiName);
      }
    }
    if (!parent) return;
    if (props.position === 'absolute' && parent.layoutMode !== 'NONE') created.layoutPositioning = 'ABSOLUTE';
    if (props.x != null) created.x = structuredNumber(props.x);
    if (props.y != null) created.y = structuredNumber(props.y);
    if (props.grow != null && parent.layoutMode !== 'NONE') created.layoutGrow = structuredNumber(props.grow);
    const width = value(props, 'w', 'width');
    const height = value(props, 'h', 'height');
    if (width === 'fill' && parent.layoutMode !== 'NONE') created.layoutSizingHorizontal = 'FILL';
    if (height === 'fill' && parent.layoutMode !== 'NONE') created.layoutSizingVertical = 'FILL';
    if (props.stretch === true || props.stretch === 'true') {
      if (parent.layoutMode === 'HORIZONTAL') created.layoutSizingVertical = 'FILL';
      if (parent.layoutMode === 'VERTICAL') created.layoutSizingHorizontal = 'FILL';
    }
    if (parent.layoutMode === 'GRID') {
      const row = structuredNumber(props.gridRow, 0), column = structuredNumber(props.gridColumn, 0);
      if (row > 0 && column > 0) created.setGridChildPosition(row - 1, column - 1);
      if (props.gridRowSpan != null) created.gridRowSpan = structuredNumber(props.gridRowSpan, 1);
      if (props.gridColumnSpan != null) created.gridColumnSpan = structuredNumber(props.gridColumnSpan, 1);
      const horizontal = String(props.gridHAlign || '').toUpperCase();
      const vertical = String(props.gridVAlign || '').toUpperCase();
      if (horizontal) created.gridChildHorizontalAlign = horizontal;
      if (vertical) created.gridChildVerticalAlign = vertical;
    }
  };

  const applyFallbackAnnotations = (created, semanticNode) => {
    const intents = semanticNode.fallbackAnnotations || [];
    if (!intents.length) return;
    const storedPolicies = new Set();
    try {
      const stored = JSON.parse(created.getPluginData('figmaBridge.fallbackAnnotations') || '{}');
      for (const entry of stored.annotations || []) if (entry?.policy) storedPolicies.add(entry.policy);
    } catch {}
    const metadata = [];
    for (const intent of intents) {
      fallbackAnnotationReport.requested++;
      metadata.push({ policy: intent.policy, fact: intent.fact || intent.policy });
      if (storedPolicies.has(intent.policy)) {
        fallbackAnnotationReport.deduplicated++;
        continue;
      }
      if (!('annotations' in created)) {
        fallbackAnnotationReport.unsupported++;
        continue;
      }
      const existing = Array.from(created.annotations || [], (annotation) => ({
        ...(annotation.labelMarkdown ? { labelMarkdown: annotation.labelMarkdown } : annotation.label ? { label: annotation.label } : {}),
        ...(annotation.categoryId ? { categoryId: annotation.categoryId } : {}),
        ...(annotation.properties ? { properties: Array.from(annotation.properties, (property) => ({ type: property.type })) } : {}),
      }));
      if (existing.some((annotation) => 'labelMarkdown' in annotation && annotation.labelMarkdown === intent.labelMarkdown)) {
        fallbackAnnotationReport.deduplicated++;
        storedPolicies.add(intent.policy);
        continue;
      }
      created.annotations = [...existing, {
        labelMarkdown: intent.labelMarkdown,
        properties: intent.properties.map((type) => ({ type })),
      }];
      storedPolicies.add(intent.policy);
      fallbackAnnotationReport.applied++;
    }
    created.setPluginData('figmaBridge.fallbackAnnotations', JSON.stringify({
      schemaVersion: 1,
      annotations: metadata,
    }));
  };

  const trackCreated = (node) => {
    journal.record('scene-node', node);
    return node;
  };

  const create = async (semanticNode, parent = null, root = false) => {
    const props = semanticNode.source.props;
    let created;
    if (semanticNode.source.type === 'text') {
      created = trackCreated(figmaApi.createText());
      created.name = props.name || String(props.content || '').slice(0, 40) || 'Text';
      created.fontName = variableContext.fontNames.get(semanticNode)
        || { family: resolvedString(semanticNode, 'fontFamily', props.font, 'Inter'), style: resolvedString(semanticNode, 'fontStyle', props.fontStyle, structuredFontStyle(resolvedNumber(semanticNode, 'fontWeight', props.weight, 400), props.italic)) };
      created.characters = String(props.content || '');
      const textStyle = textStyleContext.bindings.get(semanticNode);
      created.fontSize = resolvedNumber(semanticNode, 'fontSize', props.size, 14);
      bindScalar(semanticNode, 'fontSize', created, 'fontSize');
      bindScalar(semanticNode, 'fontFamily', created, 'fontFamily');
      bindScalar(semanticNode, 'fontStyle', created, 'fontStyle');
      bindScalar(semanticNode, 'fontWeight', created, 'fontWeight');
      const width = value(props, 'w', 'width', 'hug');
      if (width === 'hug') created.textAutoResize = 'WIDTH_AND_HEIGHT';
      // FILL sizing is applied by applyPlacement only after appendChild. Figma
      // rejects layoutSizingHorizontal while the text has no Auto Layout parent.
      else if (width === 'fill') created.textAutoResize = 'HEIGHT';
      else { created.textAutoResize = 'HEIGHT'; created.resize(resolvedNumber(semanticNode, 'width', width, Math.max(1, created.width)), resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), Math.max(1, created.height))); }
      if (props.color) created.fills = [boundPaint(semanticNode, 'fill', props.color, '#808080', created)];
      if (props.align) created.textAlignHorizontal = ({ left: 'LEFT', center: 'CENTER', right: 'RIGHT', justified: 'JUSTIFIED' })[props.align] || String(props.align).toUpperCase();
      if (props.lineHeight != null) {
        const binding = bindingFor(semanticNode, 'lineHeight');
        created.lineHeight = structuredLineHeight(binding?.value ?? props.lineHeight);
        bindScalar(semanticNode, 'lineHeight', created, 'lineHeight');
      }
      if (props.letterSpacing != null) {
        created.letterSpacing = { unit: 'PIXELS', value: resolvedNumber(semanticNode, 'letterSpacing', props.letterSpacing) };
        bindScalar(semanticNode, 'letterSpacing', created, 'letterSpacing');
      }
      if (props.paragraphSpacing != null) {
        created.paragraphSpacing = resolvedNumber(semanticNode, 'paragraphSpacing', props.paragraphSpacing);
        bindScalar(semanticNode, 'paragraphSpacing', created, 'paragraphSpacing');
      }
      if (props.paragraphIndent != null) {
        created.paragraphIndent = resolvedNumber(semanticNode, 'paragraphIndent', props.paragraphIndent);
        bindScalar(semanticNode, 'paragraphIndent', created, 'paragraphIndent');
      }
      if (props.truncate === true || props.truncate === 'true' || props.maxLines != null) created.textTruncation = 'ENDING';
      if (props.maxLines != null) created.maxLines = Number(props.maxLines);
      if (props.fontAxes != null) {
        created.setPluginData('figmaBridge.variableFontAxes', JSON.stringify({
          schemaVersion: 1,
          ranges: [{ start: 0, end: created.characters.length, axes: structuredFontAxes(props.fontAxes) }],
        }));
      }
      // Apply the named style only after every raw typography setter. Figma
      // detaches a Text Style when fontSize/fontName/lineHeight is assigned
      // after setTextStyleIdAsync, even when the value is identical.
      if (textStyle) {
        if (typeof created.setTextStyleIdAsync === 'function') {
          await created.setTextStyleIdAsync(textStyle.id);
        } else {
          created.textStyleId = textStyle.id;
        }
        // Node-level token/color intent remains an explicit style override.
        for (const field of ['fontSize', 'fontFamily', 'fontStyle', 'fontWeight', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent']) {
          bindScalar(semanticNode, field, created, field);
        }
        if (props.color) created.fills = [boundPaint(semanticNode, 'fill', props.color, '#808080', created)];
      }
      applyRichTextRuns(created, semanticNode, props);
    } else if (semanticNode.source.type === 'rect') {
      created = trackCreated(figmaApi.createRectangle());
      created.name = props.name || 'Rectangle';
      created.resize(resolvedNumber(semanticNode, 'width', value(props, 'w', 'width'), 100), resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), 100));
      const background = props.bg ?? props.fill ?? '#e4e4e7';
      created.fills = background === 'none' ? [] : boundPaints(semanticNode, 'fill', background, '#808080', created);
      const radius = resolvedNumber(semanticNode, 'topLeftRadius', props.rounded ?? props.radius);
      created.cornerRadius = radius;
      created.topLeftRadius = resolvedNumber(semanticNode, 'topLeftRadius', props.roundedTL ?? props.rounded ?? props.radius);
      created.topRightRadius = resolvedNumber(semanticNode, 'topRightRadius', props.roundedTR ?? props.rounded ?? props.radius);
      created.bottomLeftRadius = resolvedNumber(semanticNode, 'bottomLeftRadius', props.roundedBL ?? props.rounded ?? props.radius);
      created.bottomRightRadius = resolvedNumber(semanticNode, 'bottomRightRadius', props.roundedBR ?? props.rounded ?? props.radius);
      for (const field of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) bindScalar(semanticNode, field, created, field);
      if (props.cornerSmoothing != null) created.cornerSmoothing = structuredNumber(props.cornerSmoothing);
      created.effects = structuredEffects(props);
    } else if (semanticNode.source.type === 'image') {
      created = trackCreated(figmaApi.createRectangle());
      created.name = props.name || semanticNode.asset.name || 'Image';
      created.resize(resolvedNumber(semanticNode, 'width', value(props, 'w', 'width'), 200), resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), 150));
      const imageHash = imageContext.bindings.get(semanticNode);
      if (!imageHash) throw new Error(`Structured image preflight lost ${created.name}`);
      created.fills = [{ type: 'IMAGE', imageHash, scaleMode: String(props.imageScale || 'FILL').toUpperCase() }];
      const radius = resolvedNumber(semanticNode, 'topLeftRadius', props.rounded ?? props.radius);
      created.cornerRadius = radius;
      created.topLeftRadius = resolvedNumber(semanticNode, 'topLeftRadius', props.roundedTL ?? props.rounded ?? props.radius);
      created.topRightRadius = resolvedNumber(semanticNode, 'topRightRadius', props.roundedTR ?? props.rounded ?? props.radius);
      created.bottomLeftRadius = resolvedNumber(semanticNode, 'bottomLeftRadius', props.roundedBL ?? props.rounded ?? props.radius);
      created.bottomRightRadius = resolvedNumber(semanticNode, 'bottomRightRadius', props.roundedBR ?? props.rounded ?? props.radius);
      for (const field of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) bindScalar(semanticNode, field, created, field);
      if (props.cornerSmoothing != null) created.cornerSmoothing = structuredNumber(props.cornerSmoothing);
      created.effects = structuredEffects(props);
    } else if (semanticNode.source.type === 'ellipse') {
      created = trackCreated(figmaApi.createEllipse());
      created.name = props.name || 'Ellipse';
      const width = resolvedNumber(semanticNode, 'width', value(props, 'w', 'width'), 100);
      created.resize(width, resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), width));
      const background = props.bg ?? props.fill;
      created.fills = background && background !== 'none'
        ? boundPaints(semanticNode, 'fill', background, '#808080', created)
        : [];
      if (props.stroke && props.stroke !== 'none') {
        created.strokes = [boundPaint(semanticNode, 'stroke', props.stroke, '#808080', created)];
        created.strokeWeight = structuredNumber(props.strokeWidth, 1);
        if (props.strokeAlign) created.strokeAlign = String(props.strokeAlign).toUpperCase();
        created.dashPattern = structuredDashPattern(props.strokeDashPattern);
        if (props.strokeCap) created.strokeCap = String(props.strokeCap).toUpperCase();
      }
      if (props.arc != null || props.arcStart != null || props.innerRadius != null) {
        const start = structuredNumber(props.arcStart) * Math.PI / 180;
        created.arcData = {
          startingAngle: start,
          endingAngle: start + structuredNumber(props.arc, 360) * Math.PI / 180,
          innerRadius: Math.max(0, Math.min(1, structuredNumber(props.innerRadius))),
        };
      }
      created.effects = structuredEffects(props);
    } else if (semanticNode.source.type === 'icon') {
      created = trackCreated(figmaApi.createNodeFromSvg(semanticNode.asset.svg));
      created.name = props.name || semanticNode.asset.name || 'Icon';
      created.fills = [];
      const size = structuredNumber(props.size ?? props.s, 24);
      created.resize(resolvedNumber(semanticNode, 'width', value(props, 'w', 'width'), size), resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), size));
      const preserveColors = props.preserveColors === true || props.preserveColors === 'true';
      const color = props.color ?? props.c;
      if (!preserveColors && color) {
        const paint = boundPaint(semanticNode, 'color', color);
        const recolor = (node) => {
          if (Array.isArray(node.fills) && node.fills.length) node.fills = [paint];
          if (Array.isArray(node.strokes) && node.strokes.length) node.strokes = [paint];
          for (const child of node.children || []) recolor(child);
        };
        for (const child of created.children || []) recolor(child);
      }
      for (const descriptor of structuredSvgFilterDescriptors(semanticNode.asset.svg)) {
        for (const filtered of created.findAll((node) => node.name === descriptor.id)) {
          filtered.effects = structuredEffects({ filter: descriptor.filter });
        }
      }
    } else if (semanticNode.source.type === 'instance') {
      const component = componentContext.bindings.get(semanticNode);
      if (!component) throw new Error(`Structured component preflight lost ${props.entity}`);
      created = trackCreated(component.createInstance());
      created.name = props.name || component.name || props.entity;
      applyInstanceOverrides(created, semanticNode);
      const requestedWidth = value(props, 'w', 'width');
      const requestedHeight = value(props, 'h', 'height');
      const numericWidth = requestedWidth != null && !['fill', 'hug'].includes(requestedWidth)
        ? resolvedNumber(semanticNode, 'width', requestedWidth, created.width) : created.width;
      const numericHeight = requestedHeight != null && !['fill', 'hug'].includes(requestedHeight)
        ? resolvedNumber(semanticNode, 'height', requestedHeight, created.height) : created.height;
      if (numericWidth !== created.width || numericHeight !== created.height) created.resize(numericWidth, numericHeight);
    } else {
      created = trackCreated(figmaApi.createFrame());
      created.name = props.name || 'Frame';
      const width = value(props, 'w', 'width');
      const height = value(props, 'h', 'height');
      const hug = String(props.hug || '');
      const hugWidth = ['both', 'w', 'width'].includes(hug);
      const hugHeight = ['both', 'h', 'height'].includes(hug);
      created.resize(typeof width === 'string' && ['fill', 'hug'].includes(width) ? 320 : resolvedNumber(semanticNode, 'width', width, 320), typeof height === 'string' && ['fill', 'hug'].includes(height) ? 200 : resolvedNumber(semanticNode, 'height', height, 200));
      const mode = props.flex === 'grid' ? 'GRID' : ['none', 'stack', 'free'].includes(props.flex) ? 'NONE' : props.flex === 'row' ? 'HORIZONTAL' : 'VERTICAL';
      created.layoutMode = mode;
      if (mode !== 'NONE' && mode !== 'GRID') {
        const horizontal = mode === 'HORIZONTAL';
        const primaryGap = horizontal ? (props.columnGap ?? props.gap) : (props.rowGap ?? props.gap);
        created.itemSpacing = props.justify === 'between' ? 0 : resolvedNumber(semanticNode, 'itemSpacing', primaryGap);
        if (props.justify !== 'between') bindScalar(semanticNode, 'itemSpacing', created, 'itemSpacing');
        created.primaryAxisAlignItems = justify[props.justify] || align[props.justify] || 'MIN';
        created.counterAxisAlignItems = align[props.items || props.align] || 'MIN';
        if (props.wrap === true || props.wrap === 'true') {
          created.layoutWrap = 'WRAP';
          const counterGap = horizontal
            ? (props.rowGap ?? props.wrapGap ?? props.counterAxisSpacing)
            : (props.columnGap ?? props.wrapGap ?? props.counterAxisSpacing);
          created.counterAxisSpacing = resolvedNumber(semanticNode, 'counterAxisSpacing', counterGap);
          bindScalar(semanticNode, 'counterAxisSpacing', created, 'counterAxisSpacing');
        }
      }
      const paddingRaw = props.p ?? props.padding;
      const pxRaw = props.px ?? paddingRaw, pyRaw = props.py ?? paddingRaw;
      const paddingValues = {
        paddingTop: props.pt ?? pyRaw, paddingRight: props.pr ?? pxRaw,
        paddingBottom: props.pb ?? pyRaw, paddingLeft: props.pl ?? pxRaw,
      };
      for (const [field, raw] of Object.entries(paddingValues)) {
        created[field] = resolvedNumber(semanticNode, field, raw);
        bindScalar(semanticNode, field, created, field);
      }
      if (mode === 'GRID') {
        const rows = structuredTracks(props.gridRows), columns = structuredTracks(props.gridColumns);
        created.gridRowCount = rows.length; created.gridColumnCount = columns.length;
        created.gridRowGap = resolvedNumber(semanticNode, 'gridRowGap', props.rowGap);
        created.gridColumnGap = resolvedNumber(semanticNode, 'gridColumnGap', props.columnGap ?? props.gap);
        bindScalar(semanticNode, 'gridRowGap', created, 'gridRowGap');
        bindScalar(semanticNode, 'gridColumnGap', created, 'gridColumnGap');
        rows.forEach((item, index) => Object.assign(created.gridRowSizes[index], item));
        columns.forEach((item, index) => Object.assign(created.gridColumnSizes[index], item));
      }
      if (mode === 'VERTICAL') {
        created.primaryAxisSizingMode = hugHeight || height == null || height === 'hug' ? 'AUTO' : 'FIXED';
        created.counterAxisSizingMode = hugWidth || width == null || width === 'hug' ? 'AUTO' : 'FIXED';
      } else if (mode === 'HORIZONTAL') {
        created.primaryAxisSizingMode = hugWidth || width == null || width === 'hug' ? 'AUTO' : 'FIXED';
        created.counterAxisSizingMode = hugHeight || height == null || height === 'hug' ? 'AUTO' : 'FIXED';
      }
      const background = props.bg ?? props.fill;
      if (semanticNode.asset?.kind === 'embedded-raster') {
        const imageHash = imageContext.bindings.get(semanticNode);
        if (!imageHash) throw new Error(`Structured image preflight lost ${created.name}`);
        created.fills = [{
          type: 'IMAGE', imageHash,
          scaleMode: String(props.imageScale || 'FILL').toUpperCase(),
        }];
      } else {
        created.fills = background && background !== 'none'
          ? boundPaints(semanticNode, 'fill', background, '#808080', created)
          : [];
      }
      const radiusRaw = props.rounded ?? props.radius;
      created.cornerRadius = resolvedNumber(semanticNode, 'topLeftRadius', radiusRaw);
      const cornerValues = {
        topLeftRadius: props.roundedTL ?? radiusRaw, topRightRadius: props.roundedTR ?? radiusRaw,
        bottomLeftRadius: props.roundedBL ?? radiusRaw, bottomRightRadius: props.roundedBR ?? radiusRaw,
      };
      for (const [field, raw] of Object.entries(cornerValues)) {
        created[field] = resolvedNumber(semanticNode, field, raw);
        bindScalar(semanticNode, field, created, field);
      }
      if (props.cornerSmoothing != null) created.cornerSmoothing = structuredNumber(props.cornerSmoothing);
      if (props.stroke && props.stroke !== 'none') {
        created.strokes = [boundPaint(semanticNode, 'stroke', props.stroke, '#808080', created)];
        created.strokeWeight = structuredNumber(props.strokeWidth, 1);
        if (props.strokeAlign) created.strokeAlign = String(props.strokeAlign).toUpperCase();
        created.dashPattern = structuredDashPattern(props.strokeDashPattern);
        if (props.strokeCap) created.strokeCap = String(props.strokeCap).toUpperCase();
        for (const [prop, field] of [['strokeTopWidth', 'strokeTopWeight'], ['strokeRightWidth', 'strokeRightWeight'], ['strokeBottomWidth', 'strokeBottomWeight'], ['strokeLeftWidth', 'strokeLeftWeight']]) {
          if (props[prop] != null) created[field] = structuredNumber(props[prop]);
        }
      }
      created.effects = structuredEffects(props);
      created.clipsContent = props.clip === true || props.clip === 'true'
        || props.overflow === 'hidden' || props.overflow === 'clip';
    }
    bindScalar(semanticNode, 'width', created, 'width');
    bindScalar(semanticNode, 'height', created, 'height');
    if (parent) parent.appendChild(created);
    if (semanticNode.source.type === 'frame' && props.flex === 'grid') {
      // Figma can initialize a native Grid with default dimensions both when
      // layoutMode changes and when the Grid enters an Auto Layout parent.
      // Restore only explicit numeric axes after the final append; FILL/HUG
      // remains owned by applyPlacement below.
      const requestedWidth = value(props, 'w', 'width');
      const requestedHeight = value(props, 'h', 'height');
      const explicitWidth = typeof requestedWidth === 'string' && ['fill', 'hug'].includes(requestedWidth)
        ? created.width : resolvedNumber(semanticNode, 'width', requestedWidth, created.width);
      const explicitHeight = typeof requestedHeight === 'string' && ['fill', 'hug'].includes(requestedHeight)
        ? created.height : resolvedNumber(semanticNode, 'height', requestedHeight, created.height);
      created.resize(explicitWidth, explicitHeight);
    }
    applyPlacement(created, semanticNode, props, parent);
    if (root) { created.x = props.x == null ? initialX : structuredNumber(props.x); created.y = structuredNumber(props.y); }
    const semanticIndex = createdRecords.length;
    created.setPluginData('figmaBridge.semanticPath', String(semanticNode.path || ''));
    created.setPluginData('figmaBridge.semanticIndex', String(semanticIndex));
    if (root) {
      created.setPluginData('figmaBridge.renderPlanVersion', String(plan.version));
      created.setPluginData('figmaBridge.renderAdapter', String(plan.adapter));
      if (plan.provenance !== undefined) {
        created.setPluginData('figmaBridge.renderProvenance', JSON.stringify(plan.provenance));
      }
      const entityBinding = plan.designEntityBindings?.bindings?.[props.entity];
      if (entityBinding?.handleKind === 'created-root') {
        created.setPluginData('figma-bridge-design-entity', JSON.stringify({
          version: 1,
          id: entityBinding.entityId,
          kind: entityBinding.entityKind,
        }));
      }
    }
    applyFallbackAnnotations(created, semanticNode);
    createdRecords.push({ semanticNode, created, parent });
    for (const child of semanticNode.children || []) await create(child, created, false);
    return created;
  };

  const root = await create(plan.root, null, true);
  const structuralReport = auditStructuredCreatedNodes(createdRecords);
  const rootEntityBinding = plan.designEntityBindings?.bindings?.[plan.root.source.props.entity];
  return {
    id: root.id, name: root.name, width: root.width, height: root.height,
    executor: 'structured-v1',
    structuralReport,
    ...(rootEntityBinding?.handleKind === 'created-root' ? {
      designEntity: {
        id: rootEntityBinding.entityId,
        kind: rootEntityBinding.entityKind,
        nodeId: root.id,
      },
    } : {}),
    ...(variableContext.variableReport.references ? { variableReport: variableContext.variableReport } : {}),
    ...(variableContext.createdVariables.length ? { createdVariables: variableContext.createdVariables } : {}),
    ...(variableContext.scopeQuestions.length ? { scopeQuestions: variableContext.scopeQuestions } : {}),
    textStyleReport: textStyleContext.textStyleReport,
    ...(textStyleContext.createdStyles.length ? { createdTextStyles: textStyleContext.createdStyles } : {}),
    ...(fallbackAnnotationReport.requested ? { fallbackAnnotationReport } : {}),
  };
}

async function preflightStructuredPlans(figmaApi, plans, {
  batch = false,
  materializeResources = false,
} = {}, runtime = {}) {
  const unsupported = [];
  for (let index = 0; index < plans.length; index++) {
    const support = inspectStructuredRenderPlan(plans[index]);
    if (!support.supported) unsupported.push(batch
      ? `plan ${index + 1}: ${support.problems.slice(0, 3).join('; ')}`
      : support.problems.slice(0, 5).join('; '));
  }
  if (unsupported.length) {
    throw new Error(batch
      ? `Structured batch unsupported: ${unsupported.slice(0, 5).join(' | ')}`
      : `Structured render unsupported: ${unsupported[0]}`);
  }

  for (const plan of plans) {
    const target = plan.designEntityBindings?.targetConstraint;
    if (target?.kind === 'file-key' && figmaApi.fileKey !== target.fileKey) {
      throw new Error('Design Entity binding table targets a different Figma file');
    }
  }

  // The facade keeps a shared, in-memory catalog for the whole request. This
  // catches cross-plan variable/style naming conflicts without creating a
  // Figma resource. Fonts and component handles are resolved against the real
  // API because those reads do not mutate the document.
  const preflightApi = await createStructuredPreflightApi(figmaApi, runtime);
  const componentContexts = [];
  for (const plan of plans) {
    componentContexts.push(await prepareStructuredComponents(figmaApi, plan));
    const variableContext = await prepareStructuredVariables(preflightApi, plan, null, {
      materializeGenerated: materializeResources,
    });
    await prepareStructuredTextStyles(preflightApi, plan, variableContext, null, {
      materializeGenerated: materializeResources,
    });
    await prepareStructuredImages(preflightApi, plan);
  }
  return componentContexts;
}

async function materializeStructuredResources(figmaApi, plans, componentContexts, journal, {
  materializeResources = false,
} = {}) {
  const prepared = [];
  for (let index = 0; index < plans.length; index++) {
    const variableContext = await prepareStructuredVariables(figmaApi, plans[index], journal, {
      materializeGenerated: materializeResources,
    });
    const textStyleContext = await prepareStructuredTextStyles(
      figmaApi, plans[index], variableContext, journal,
      { materializeGenerated: materializeResources },
    );
    const imageContext = await prepareStructuredImages(figmaApi, plans[index], journal);
    prepared.push({
      componentContext: componentContexts[index],
      variableContext,
      textStyleContext,
      imageContext,
    });
  }
  return prepared;
}

async function executeStructuredRenderPlan(figmaApi, plan, options = {}, runtime = {}) {
  const journal = createStructuredMutationJournal(figmaApi);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => ![
      'smart', 'x', 'y', 'materializeResources',
    ].includes(key))) {
    throw structuredExecutionError(
      new Error('Structured render placement options are invalid'),
      await journal.rollback(),
      'Structured render preflight failed',
    );
  }
  const placementOptions = /** @type {{
    smart?: unknown, x?: unknown, y?: unknown, materializeResources?: unknown,
  }} */ (options);
  if (placementOptions.smart !== undefined && typeof placementOptions.smart !== 'boolean') {
    throw structuredExecutionError(
      new Error('Structured render smart placement must be boolean'),
      await journal.rollback(),
      'Structured render preflight failed',
    );
  }
  if (placementOptions.materializeResources !== undefined
    && typeof placementOptions.materializeResources !== 'boolean') {
    throw structuredExecutionError(
      new Error('Structured render materializeResources must be boolean'),
      await journal.rollback(),
      'Structured render preflight failed',
    );
  }
  const explicitX = placementOptions.x === null || placementOptions.x === undefined
    ? (placementOptions.smart === false ? 0 : null)
    : Number(placementOptions.x);
  const explicitY = placementOptions.y === null || placementOptions.y === undefined
    ? null
    : Number(placementOptions.y);
  if ((explicitX !== null && (!Number.isFinite(explicitX) || Math.abs(explicitX) > 1_000_000))
    || (explicitY !== null && (!Number.isFinite(explicitY) || Math.abs(explicitY) > 1_000_000))) {
    throw structuredExecutionError(
      new Error('Structured render position must be finite and between -1000000 and 1000000'),
      await journal.rollback(),
      'Structured render preflight failed',
    );
  }
  const positionedPlan = (explicitX === null && explicitY === null)
    ? plan
    : JSON.parse(JSON.stringify(plan));
  if (positionedPlan !== plan) {
    positionedPlan.root.source.props = {
      ...positionedPlan.root.source.props,
      ...(explicitX === null ? {} : { x: explicitX }),
      ...(explicitY === null ? {} : { y: explicitY }),
    };
  }
  let componentContexts;
  try {
    componentContexts = await preflightStructuredPlans(figmaApi, [positionedPlan], {
      materializeResources: placementOptions.materializeResources === true,
    }, runtime);
  } catch (error) {
    throw structuredExecutionError(error, await journal.rollback(), 'Structured render preflight failed');
  }
  try {
    const [prepared] = await materializeStructuredResources(
      figmaApi, [positionedPlan], componentContexts, journal,
      { materializeResources: placementOptions.materializeResources === true },
    );
    const result = await executePreparedStructuredRenderPlan(figmaApi, positionedPlan, prepared, journal);
    const mutationReport = journal.completed();
    return { ...result, mutationOutcome: mutationReport.outcome, mutationReport };
  } catch (error) {
    throw structuredExecutionError(error, await journal.rollback(), 'Structured render failed');
  }
}

async function executeStructuredRenderPlanBatch(figmaApi, plans, options = {}, runtime = {}) {
  const journal = createStructuredMutationJournal(figmaApi);
  if (!Array.isArray(plans) || !plans.length) {
    throw structuredExecutionError(
      new Error('Structured batch needs at least one Render Plan'),
      await journal.rollback(),
      'Structured batch preflight failed',
    );
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => ![
      'gap', 'vertical', 'smart', 'x', 'y', 'materializeResources',
    ].includes(key))) {
    throw structuredExecutionError(
      new Error('Structured batch options are invalid'),
      await journal.rollback(),
      'Structured batch preflight failed',
    );
  }
  const batchOptions = /** @type {{
    gap?: unknown, vertical?: unknown, smart?: unknown, x?: unknown, y?: unknown,
    materializeResources?: unknown,
  }} */ (options);
  const gap = structuredNumber(batchOptions.gap, 40);
  if (gap < 0 || gap > 10000) {
    throw structuredExecutionError(
      new Error('Structured batch gap must be between 0 and 10000'),
      await journal.rollback(),
      'Structured batch preflight failed',
    );
  }
  const vertical = batchOptions.vertical === true;
  const smart = batchOptions.smart !== false;
  if (batchOptions.materializeResources !== undefined
    && typeof batchOptions.materializeResources !== 'boolean') {
    throw structuredExecutionError(
      new Error('Structured batch materializeResources must be boolean'),
      await journal.rollback(),
      'Structured batch preflight failed',
    );
  }
  const explicitX = batchOptions.x === null || batchOptions.x === undefined ? null : Number(batchOptions.x);
  const explicitY = batchOptions.y === null || batchOptions.y === undefined ? null : Number(batchOptions.y);
  if ((explicitX !== null && !Number.isFinite(explicitX))
    || (explicitY !== null && !Number.isFinite(explicitY))) {
    throw structuredExecutionError(
      new Error('Structured batch position must be finite'),
      await journal.rollback(),
      'Structured batch preflight failed',
    );
  }
  const positionedPlans = plans.map((plan) => JSON.parse(JSON.stringify(plan)));
  let componentContexts;
  try {
    componentContexts = await preflightStructuredPlans(figmaApi, positionedPlans, {
      batch: true,
      materializeResources: batchOptions.materializeResources === true,
    }, runtime);
  } catch (error) {
    throw structuredExecutionError(error, await journal.rollback(), 'Structured batch preflight failed');
  }

  const existing = [...figmaApi.currentPage.children];
  let x = explicitX ?? (smart
    ? existing.reduce((right, node) => Math.max(right, structuredNumber(node.x) + structuredNumber(node.width)), 0) + (existing.length ? 100 : 0)
    : 0);
  let y = explicitY ?? 100;
  const frames = [];
  const createdVariables = new Set();
  const scopeQuestions = [];
  const variableReport = {
    references: 0, reused: 0, created: 0, bound: 0,
    literal: 0, ambiguous: 0, unsupported: 0,
  };
  const textStyleReport = { references: 0, reused: 0, created: 0, bound: 0, literal: 0 };
  const createdTextStyles = new Set();
  const fallbackAnnotationReport = { requested: 0, applied: 0, deduplicated: 0, unsupported: 0 };
  try {
    const preparedPlans = await materializeStructuredResources(
      figmaApi, positionedPlans, componentContexts, journal,
      { materializeResources: batchOptions.materializeResources === true },
    );
    for (let index = 0; index < positionedPlans.length; index++) {
      const positioned = positionedPlans[index];
      positioned.root.source.props = { ...positioned.root.source.props, x, y };
      const result = await executePreparedStructuredRenderPlan(figmaApi, positioned, preparedPlans[index], journal);
      frames.push(result);
      for (const name of result.createdVariables || []) createdVariables.add(name);
      for (const question of result.scopeQuestions || []) scopeQuestions.push(question);
      for (const key of Object.keys(variableReport)) variableReport[key] += structuredNumber(result.variableReport?.[key]);
      for (const key of Object.keys(textStyleReport)) textStyleReport[key] += structuredNumber(result.textStyleReport?.[key]);
      for (const name of result.createdTextStyles || []) createdTextStyles.add(name);
      for (const key of Object.keys(fallbackAnnotationReport)) fallbackAnnotationReport[key] += structuredNumber(result.fallbackAnnotationReport?.[key]);
      if (vertical) y += result.height + gap;
      else x += result.width + gap;
    }
  } catch (error) {
    throw structuredExecutionError(
      error,
      await journal.rollback(),
      `Structured batch failed after ${frames.length} of ${plans.length} plans`,
    );
  }
  const mutationReport = journal.completed();
  return {
    frames,
    executor: 'structured-batch-v1',
    mutationOutcome: mutationReport.outcome,
    mutationReport,
    ...(variableReport.references ? { variableReport } : {}),
    ...(createdVariables.size ? { createdVariables: [...createdVariables].sort() } : {}),
    ...(scopeQuestions.length ? { scopeQuestions } : {}),
    textStyleReport,
    ...(createdTextStyles.size ? { createdTextStyles: [...createdTextStyles].sort() } : {}),
    ...(fallbackAnnotationReport.requested ? { fallbackAnnotationReport } : {}),
  };
}
// END STRUCTURED RENDER RUNTIME

// Normalize anything thrown into a non-empty string. `throw 'msg'` or a
// rejected plain object used to produce `error: undefined`, which the daemon
// treats as SUCCESS (falsy error check) — a failing script read as "worked,
// returned nothing".
function errorMessage(error) {
  let message;
  if (error && typeof error.message === 'string' && error.message) message = error.message;
  try {
    message ||= typeof error === 'string' ? error : JSON.stringify(error) || String(error);
  } catch (e) {
    message ||= String(error);
  }
  const figmaTimeout = message.match(
    /^Unable to establish connection to Figma after (\d+(?:\.\d+)?) seconds?\. Please check your internet connection\.$/,
  );
  if (figmaTimeout) {
    return `Figma document API timed out after ${figmaTimeout[1]} seconds. The local Bridge can remain connected; inspect the command outcome before retrying a write.`;
  }
  return message;
}

// --- Selection push (UI feature C) ---
// Fully automatic: every selection change is pushed (debounced) — the UI
// displays it and forwards it to the daemon, where the MCP tool
// figma_selection picks it up. There is no button; selecting IS the gesture.
//
// Component identity: for the first few nodes the STABLE publish key is
// resolved (main component for instances, own key for components/sets) so a
// Storybook/code mapping can identify the component — node ids are file-local.
const KEY_RESOLVE_CAP = 10; // bound the async main-component lookups per push

async function selectionSnapshot() {
  const selection = figma.currentPage.selection;
  const nodes = [];
  for (let i = 0; i < Math.min(selection.length, 50); i++) {
    const n = selection[i];
    const entry = { id: n.id, name: n.name, type: n.type };
    try {
      entry.width = Math.round(n.width);
      entry.height = Math.round(n.height);
    } catch (e) {}
    try {
      const raw = n.getPluginData(DESIGN_ENTITY_STORAGE);
      if (raw) {
        const link = JSON.parse(raw);
        if (link && link.version === 1 && typeof link.id === 'string' && link.id) {
          entry.entityId = link.id;
          if (typeof link.kind === 'string' && link.kind) entry.entityKind = link.kind;
        }
      }
    } catch (e) {}
    if (i < KEY_RESOLVE_CAP) {
      try {
        if (n.type === 'INSTANCE') {
          const main = await n.getMainComponentAsync();
          if (main) {
            entry.mainName = main.name;
            if (main.key) entry.componentKey = main.key;
            if (main.parent && main.parent.type === 'COMPONENT_SET') {
              entry.setName = main.parent.name;
              if (main.parent.key) entry.setKey = main.parent.key;
            }
          }
        } else if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
          if (n.key) entry.componentKey = n.key;
        }
      } catch (e) {}
    }
    nodes.push(entry);
  }
  return {
    page: figma.currentPage.name,
    total: selection.length,
    nodes,
    // File identity for the optional REST layer (default scope = this file).
    // figma.fileKey needs enablePrivatePluginApi in the manifest and is
    // undefined for never-saved drafts — both degrade to null gracefully.
    fileKey: (typeof figma.fileKey === 'string' && figma.fileKey) || null,
    fileName: figma.root.name,
    // Which editor the bridge is attached to. The plugin runs in FigJam and
    // Slides too, and a command/editor mismatch must be visible to the agent.
    editorType: figma.editorType || null,
  };
}

async function pushSelection() {
  figma.ui.postMessage({ type: 'selection-snapshot', selection: await selectionSnapshot() });
}

// Auto-push on selection change (debounced) so the agent's figma_selection is
// always current without the user pressing the button.
let selectionDebounce = null;
figma.on('selectionchange', () => {
  if (selectionDebounce) clearTimeout(selectionDebounce);
  selectionDebounce = setTimeout(pushSelection, 300);
});

// Eval serialization chain — every handler in it catches its own errors, so
// the chain itself never rejects (a rejected chain would wedge all later evals).
let evalChain = Promise.resolve();

// Handle messages from UI (WebSocket bridge)
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'asset-stream-ack') {
    pendingAssetStreamAcks.get(assetStreamAckKey(msg.id, msg.sequence))?.();
    return;
  }
  // --- Access-key bridge (clientStorage is only reachable here) ---
  if (msg.type === 'get-key') {
    let value = '';
    try {
      value = (await figma.clientStorage.getAsync(KEY_STORAGE)) || '';
    } catch (e) {
      value = '';
    }
    figma.ui.postMessage({ type: 'key', value, ports: BRIDGE_PORTS });
    return;
  }

  if (msg.type === 'save-key') {
    try {
      await figma.clientStorage.setAsync(KEY_STORAGE, msg.value || '');
      figma.ui.postMessage({ type: 'key-saved', value: msg.value || '' });
      figma.notify('Access key saved', { timeout: 1500 });
    } catch (e) {
      figma.ui.postMessage({ type: 'key-saved', value: msg.value || '', error: errorMessage(e) });
    }
    return;
  }

  // Reload only the UI iframe. The plugin main thread, clientStorage pairing
  // key and Figma document context stay alive; the fresh iframe immediately
  // reruns quiet HTTP discovery and mutual-HMAC authentication.
  if (msg.type === 'reload-ui') {
    const { id } = msg;
    if (!preflightPluginDispatch(msg, 'reload-ui')) return;
    postDispatchResult(msg, 'completed', null, { result: { reloading: true } });
    setTimeout(() => {
      figma.showUI(__html__, COMPACT_UI_SIZE);
    }, 100);
    return;
  }

  // --- Eval bridge ---
  if (msg.type === 'asset-stream') {
    const { asset, requireDocumentRevision, revisionObservation, timeoutMs, deadlineAt } = msg;
    const queuedAt = Date.now();
    evalChain = evalChain.then(async () => {
      if (!preflightPluginDispatch(msg, 'asset-stream')) return;
      let pageRevisionObserver = null;
      let revisionBefore = null;
      let startedAt = Date.now();
      let chunks = 0;
      const timedMetadata = () => {
        const timing = createPluginExecutionTiming({ queuedAt, startedAt, finishedAt: Date.now() });
        return pageRevisionObserver
          ? pageRevisionMetadata(pageRevisionObserver, revisionBefore, timing)
          : revisionMetadata(revisionBefore, timing);
      };
      try {
        pageRevisionObserver = revisionObservation?.scope === 'page'
          ? await ensurePageRevisionReady(revisionObservation.nodeId)
          : null;
        if (!pageRevisionObserver && requireDocumentRevision === true) {
          await ensureDocumentRevisionReady();
        }
        revisionBefore = pageRevisionObserver
          ? pageRevisionObserver.revision
          : documentRevisionAvailable ? documentRevision : null;
        startedAt = Date.now();
        let remainingMs = remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt);
        if (remainingMs <= 0) {
          postAssetStreamEnd(msg, 'not-dispatched', 'deadline-elapsed', {
            error: 'Asset stream deadline elapsed before plugin start',
            metadata: timedMetadata(),
          });
          postLaneSettled(msg, 'not-dispatched', 'deadline-elapsed');
          return;
        }
        const source = await readAssetStreamSource(figma, asset);
        const sha256 = await assetStreamSha256(source.bytes, {
          checkpoint() {
            if (remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt) <= 0) {
              throw new Error('Asset stream deadline elapsed during hashing');
            }
          },
        });
        remainingMs = remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt);
        await postAssetStreamFrameAndWait(msg, {
          type: 'asset-stream-start', id: msg.id,
          totalBytes: source.bytes.length, sha256, details: source.details,
          dispatchReceipt: msg.dispatchReceipt,
        }, -1, remainingMs);
        for (let offset = 0; offset < source.bytes.length; offset += ASSET_STREAM_CHUNK_BYTES) {
          remainingMs = remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt);
          if (remainingMs <= 0) throw new Error('Asset stream deadline elapsed during chunks');
          const bytes = source.bytes.subarray(
            offset,
            Math.min(source.bytes.length, offset + ASSET_STREAM_CHUNK_BYTES),
          );
          await postAssetStreamFrameAndWait(msg, {
            type: 'asset-stream-chunk', id: msg.id, sequence: chunks,
            base64: figma.base64Encode(bytes),
          }, chunks, remainingMs);
          chunks++;
        }
        postAssetStreamEnd(msg, 'completed', null, {
          chunks,
          metadata: timedMetadata(),
        });
        postLaneSettled(msg, 'completed');
      } catch (error) {
        postAssetStreamEnd(msg, 'failed', 'execution-error', {
          chunks,
          error: errorMessage(error),
          metadata: timedMetadata(),
        });
        postLaneSettled(msg, 'failed', 'execution-error');
      }
    });
    return;
  }

  if (msg.type === 'typed-read') {
    const { operation, request, timeoutMs, deadlineAt } = msg;
    const queuedAt = Date.now();
    if (!preflightPluginDispatch(msg, 'typed-read')) return;
    const startedAt = Date.now();
    const timedMetadata = () => revisionMetadata(
      documentRevisionAvailable ? documentRevision : null,
      createPluginExecutionTiming({ queuedAt, startedAt, finishedAt: Date.now() }),
    );
    try {
      if (remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt) <= 0) {
        postDispatchResult(msg, 'not-dispatched', 'deadline-elapsed', {
          error: 'Typed read deadline elapsed before plugin start', metadata: timedMetadata(),
        });
        postLaneSettled(msg, 'not-dispatched', 'deadline-elapsed');
        return;
      }
      const result = await executeTypedReadOperation(figma, operation, request);
      postDispatchResult(msg, 'completed', null, { result, metadata: timedMetadata() });
      postLaneSettled(msg, 'completed');
    } catch (error) {
      postDispatchResult(msg, 'failed', 'execution-error', {
        error: errorMessage(error), metadata: timedMetadata(),
      });
      postLaneSettled(msg, 'failed', 'execution-error');
    }
    return;
  }

  // Serialized through a promise chain: figma.ui.onmessage is async, so two
  // evals arriving back-to-back would otherwise interleave at their await
  // points and mutate shared document state mid-flight. The daemon currently
  // sends strictly serially, but the plugin must not depend on that.
  if (msg.type === 'eval') {
    const { code, requireDocumentRevision, revisionObservation, timeoutMs, deadlineAt } = msg;
    const queuedAt = Date.now();
    evalChain = evalChain.then(async () => {
      if (!preflightPluginDispatch(msg, 'eval')) return;
      let pageRevisionObserver = null;
      let revisionBefore = null;
      let startedAt = Date.now();
      const timedMetadata = () => {
        const timing = createPluginExecutionTiming({ queuedAt, startedAt, finishedAt: Date.now() });
        return pageRevisionObserver
          ? pageRevisionMetadata(pageRevisionObserver, revisionBefore, timing)
          : revisionMetadata(revisionBefore, timing);
      };
      try {
        pageRevisionObserver = revisionObservation?.scope === 'page'
          ? await ensurePageRevisionReady(revisionObservation.nodeId)
          : null;
        if (!pageRevisionObserver && requireDocumentRevision === true) {
          await ensureDocumentRevisionReady();
        }
        revisionBefore = pageRevisionObserver
          ? pageRevisionObserver.revision
          : documentRevisionAvailable ? documentRevision : null;
        startedAt = Date.now();
        const remainingMs = remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt);
        if (remainingMs <= 0) {
          postDispatchResult(msg, 'not-dispatched', 'deadline-elapsed', {
            error: 'Execution deadline elapsed before plugin start',
            metadata: timedMetadata(),
          });
          postLaneSettled(msg, 'not-dispatched', 'deadline-elapsed');
          return;
        }
        let timeoutPosted = false;
        const execution = await executeCode(code, remainingMs, (timeoutError) => {
          timeoutPosted = true;
          postDispatchResult(msg, 'unknown', 'execution-timeout', {
            error: errorMessage(timeoutError),
            metadata: timedMetadata(),
          });
        });
        if (!timeoutPosted && !execution.timedOut) {
          postDispatchResult(msg, 'completed', null, {
            result: execution.result,
            metadata: timedMetadata(),
          });
        }
        postLaneSettled(
          msg,
          timeoutPosted || execution.timedOut ? 'unknown' : 'completed',
          timeoutPosted || execution.timedOut ? 'execution-timeout' : null,
        );
      } catch (error) {
        postDispatchResult(msg, 'failed', 'execution-error', {
          error: errorMessage(error),
          metadata: timedMetadata(),
        });
        postLaneSettled(msg, 'failed', 'execution-error');
      }
    });
    return;
  }

  if (msg.type === 'render-plan') {
    const { plan, timeoutMs, deadlineAt } = msg;
    const queuedAt = Date.now();
    evalChain = evalChain.then(async () => {
      if (!preflightPluginDispatch(msg, 'render-plan')) return;
      const revisionBefore = documentRevisionAvailable ? documentRevision : null;
      const startedAt = Date.now();
      const timedMetadata = () => revisionMetadata(
        revisionBefore,
        createPluginExecutionTiming({ queuedAt, startedAt, finishedAt: Date.now() }),
      );
      try {
        if (remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt) <= 0) {
          postDispatchResult(msg, 'not-dispatched', 'deadline-elapsed', {
            error: 'Execution deadline elapsed before plugin start',
            metadata: timedMetadata(),
          });
          postLaneSettled(msg, 'not-dispatched', 'deadline-elapsed');
          return;
        }
        const result = await executeStructuredRenderPlan(figma, plan, msg.options || {});
        postDispatchResult(msg, 'completed', null, {
          result,
          metadata: timedMetadata(),
        });
        postLaneSettled(msg, 'completed');
      } catch (error) {
        const result = structuredRenderFailureResult(error, 'structured-v1');
        postDispatchResult(msg, 'failed', 'execution-error', {
          error: errorMessage(error),
          ...(result ? { result } : {}),
          metadata: timedMetadata(),
        });
        postLaneSettled(msg, 'failed', 'execution-error');
      }
    });
    return;
  }

  if (msg.type === 'render-plan-batch') {
    const { plans, options, timeoutMs, deadlineAt } = msg;
    const queuedAt = Date.now();
    evalChain = evalChain.then(async () => {
      if (!preflightPluginDispatch(msg, 'render-plan-batch')) return;
      const revisionBefore = documentRevisionAvailable ? documentRevision : null;
      const startedAt = Date.now();
      const timedMetadata = () => revisionMetadata(
        revisionBefore,
        createPluginExecutionTiming({ queuedAt, startedAt, finishedAt: Date.now() }),
      );
      try {
        if (remainingExecutionBudget(timeoutMs, queuedAt, deadlineAt) <= 0) {
          postDispatchResult(msg, 'not-dispatched', 'deadline-elapsed', {
            error: 'Execution deadline elapsed before plugin start',
            metadata: timedMetadata(),
          });
          postLaneSettled(msg, 'not-dispatched', 'deadline-elapsed');
          return;
        }
        const result = await executeStructuredRenderPlanBatch(figma, plans, options || {});
        postDispatchResult(msg, 'completed', null, {
          result,
          metadata: timedMetadata(),
        });
        postLaneSettled(msg, 'completed');
      } catch (error) {
        const result = structuredRenderFailureResult(error, 'structured-batch-v1');
        postDispatchResult(msg, 'failed', 'execution-error', {
          error: errorMessage(error),
          ...(result ? { result } : {}),
          metadata: timedMetadata(),
        });
        postLaneSettled(msg, 'failed', 'execution-error');
      }
    });
    return;
  }

  // --- UI feature bridge ---
  // The iframe cannot resize itself; it asks the main thread.
  if (msg.type === 'resize') {
    const w = Math.max(300, Math.min(500, Number(msg.width) || COMPACT_UI_SIZE.width));
    const h = Math.max(120, Math.min(620, Number(msg.height) || COMPACT_UI_SIZE.height));
    if (figma.editorType !== 'dev') figma.ui.resize(w, h);
    return;
  }

  function formatVersionHistoryLabel(date) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `Figma Bridge checkpoint · ${day} ${months[date.getMonth()]} ${date.getFullYear()}, ${hours}:${minutes}`;
  }

  // Save checkpoint (UI feature D): a labeled entry in Figma's native version
  // history. No restore API exists — this is a safety net the user restores
  // from via Figma's own version history panel.
  if (msg.type === 'save-version') {
    if (figma.editorType === 'dev') {
      const error = 'Figma Dev Mode is read-only. Switch to Design mode to save a named version.';
      figma.ui.postMessage({ type: 'version-saved', error });
      figma.notify(error, { error: true, timeout: 4000 });
      return;
    }
    try {
      await figma.saveVersionHistoryAsync(formatVersionHistoryLabel(new Date()));
      figma.ui.postMessage({ type: 'version-saved' });
      figma.notify('✓ Checkpoint saved to Figma’s version history', { timeout: 2000 });
    } catch (e) {
      figma.ui.postMessage({ type: 'version-saved', error: errorMessage(e) });
      figma.notify('Figma Bridge: saving the checkpoint failed — ' + errorMessage(e), { error: true });
    }
    return;
  }

  if (msg.type === 'connected') {
    activeConnectionEpoch = typeof msg.connectionEpoch === 'string' ? msg.connectionEpoch : null;
    figma.notify(
      figma.editorType === 'dev'
        ? '✓ Figma Bridge connected in Dev Mode (read-only)'
        : '✓ Figma Bridge connected',
      { timeout: 2500 },
    );
    // Seed the daemon with the current selection right away.
    pushSelection();
    for (const dispatchReceipt of replayableLaneSettlements) {
      figma.ui.postMessage({ type: 'lane-settled', dispatchReceipt });
    }
  }

  if (msg.type === 'disconnected') {
    activeConnectionEpoch = null;
    figma.notify('Figma Bridge disconnected', { timeout: 2000 });
  }

  if (msg.type === 'connection-epoch') {
    activeConnectionEpoch = typeof msg.connectionEpoch === 'string' ? msg.connectionEpoch : null;
  }

  // Another plugin instance for this same file superseded this connection.
  // Other files remain independently routable; the UI owns the visible state.
  if (msg.type === 'superseded') {
    activeConnectionEpoch = null;
    figma.notify('Figma Bridge: another Figma window took over the connection', { timeout: 4000 });
  }

  // Fired once per outage, after the UI has scanned all ports for a few
  // seconds without finding the daemon.
  if (msg.type === 'daemon-unreachable') {
    figma.notify('Figma Bridge: daemon not reachable — run figma_connect to restore it', {
      error: true,
      timeout: 5000,
    });
  }

  if (msg.type === 'auth-error') {
    // The daemon distinguishes why auth failed; mirror that in the toast.
    // Re-entering the key only helps for invalid-key.
    const reason = msg.reason || 'invalid-key';
    if (reason === 'no-key-configured') {
      figma.notify('Figma Bridge: daemon has no access key configured — run figma_connect', { error: true });
    } else if (reason === 'timeout') {
      figma.notify('Figma Bridge: auth handshake timed out — reconnecting', { error: true, timeout: 3000 });
    } else {
      figma.notify('Figma Bridge: access key rejected — re-enter it', { error: true });
    }
  }

  if (msg.type === 'error') {
    figma.notify('Figma Bridge: ' + msg.message, { error: true });
  }
};

console.log('Figma Bridge (Safe/Hardened) plugin started');
