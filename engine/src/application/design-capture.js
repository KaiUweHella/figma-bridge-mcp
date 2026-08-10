// Revision-aware Design Capture Module.
//
// The Interface returns one canonical, information-rich walker Capture.
// Structure/style, deduplication and output formats are projections and never
// participate in the cache key. A Capture is reused only after the plugin has
// proved that the same connection is still on the same document revision.
import { nodeWalkerCode } from '../design-extract.js';

export const DESIGN_CAPTURE_SCHEMA_VERSION = 1;

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const PROBE_CODE = '(async () => null)()';

function parseEval(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function hasDepthMarker(node) {
  return Boolean(node?.more) || (node?.kids || []).some(hasDepthMarker);
}

function stableRevision(metadata) {
  return Boolean(
    metadata &&
    typeof metadata.connectionId === 'string' && metadata.connectionId &&
    Number.isSafeInteger(metadata.documentRevisionBefore) &&
    metadata.documentRevisionBefore >= 0 &&
    metadata.documentRevisionBefore === metadata.documentRevisionAfter
  );
}

function sameRevision(a, b) {
  return stableRevision(a) && stableRevision(b) &&
    a.connectionId === b.connectionId &&
    (a.fileKey || null) === (b.fileKey || null) &&
    a.documentRevisionAfter === b.documentRevisionAfter;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function captureKey(request) {
  return JSON.stringify({
    schemaVersion: DESIGN_CAPTURE_SCHEMA_VERSION,
    fileKey: request.fileKey || null,
    nodeId: request.nodeId,
    depth: request.depth,
    includeHidden: request.includeHidden === true,
    resolveInstances: true,
    withIds: true,
    withVars: true,
  });
}

/**
 * Run attempt(depth) at requested depth, degrading only on payload/timeout
 * errors (never below 4) and retrying one blank result per execution.
 */
export async function walkWithDepthRetry(requested, attempt) {
  let depth = Math.max(1, requested);
  let blankRetries = 1;
  for (;;) {
    try {
      const result = await attempt(depth);
      if (!result && blankRetries-- > 0) continue;
      return { result, depth };
    } catch (error) {
      if (/payload|too large|timeout/i.test(error.message) && depth > 4) {
        depth -= 2;
        continue;
      }
      throw error;
    }
  }
}

function normalizedRequest(request = {}) {
  const depth = Number.parseInt(request.depth ?? 12, 10);
  if (!request.nodeId || typeof request.nodeId !== 'string') {
    throw new TypeError('Design Capture requires an explicit nodeId');
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
    throw new Error('Design Capture depth must be an integer between 1 and 30');
  }
  return Object.freeze({
    nodeId: request.nodeId,
    fileKey: request.fileKey || null,
    depth,
    includeHidden: request.includeHidden === true,
  });
}

function captureEnvelope(request, result, actualDepth, source, cache) {
  return Object.freeze({
    schemaVersion: DESIGN_CAPTURE_SCHEMA_VERSION,
    source: source ? Object.freeze({ ...source }) : null,
    options: Object.freeze({
      depth: request.depth,
      includeHidden: request.includeHidden,
      resolveInstances: true,
      withIds: true,
      withVars: true,
    }),
    completeness: Object.freeze({
      requestedDepth: request.depth,
      actualDepth,
      payloadComplete: actualDepth === request.depth,
      depthLimited: result.frames.some(hasDepthMarker),
    }),
    result,
    cache,
  });
}

/**
 * Create a bounded Design Capture Module.
 *
 * `evaluateWithMetadata(code)` must return `{ value, metadata }`. Callers may
 * instead provide `evaluate(code)`; that compatibility Adapter is always
 * uncached because it cannot prove freshness.
 */
export function createDesignCaptureModule({
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const entries = new Map();
  const inFlight = new Map();
  let totalBytes = 0;

  const remove = (key) => {
    const old = entries.get(key);
    if (!old) return;
    entries.delete(key);
    totalBytes -= old.bytes;
  };

  const remember = (key, capture) => {
    if (maxEntries <= 0 || maxBytes <= 0 || !stableRevision(capture.source)) return false;
    const bytes = Buffer.byteLength(JSON.stringify(capture.result));
    if (bytes > maxBytes) return false;
    remove(key);
    entries.set(key, { capture, bytes });
    totalBytes += bytes;
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      remove(entries.keys().next().value);
    }
    return true;
  };

  async function fresh(request, adapters) {
    const evaluateWithMetadata = typeof adapters.evaluateWithMetadata === 'function'
      ? adapters.evaluateWithMetadata
      : async (code) => ({ value: await adapters.evaluate(code), metadata: null });
    let source = null;
    const { result, depth } = await walkWithDepthRetry(request.depth, async (candidateDepth) => {
      const response = await evaluateWithMetadata(nodeWalkerCode(request.nodeId, {
        maxDepth: candidateDepth,
        textLimit: 200,
        resolveInstances: true,
        withIds: true,
        withVars: true,
        includeHidden: request.includeHidden,
      }));
      source = response?.metadata || null;
      return parseEval(response?.value);
    });

    if (result?.error) throw new Error(result.error);
    if (!result || !Array.isArray(result.frames)) {
      throw new Error(`Design Capture returned no data for node ${request.nodeId}`);
    }
    deepFreeze(result);
    return captureEnvelope(request, result, depth, source, 'miss');
  }

  return Object.freeze({
    async capture(rawRequest, adapters = {}) {
      if (typeof adapters.evaluateWithMetadata !== 'function' && typeof adapters.evaluate !== 'function') {
        throw new TypeError('Design Capture requires evaluateWithMetadata(code) or evaluate(code)');
      }
      const request = normalizedRequest(rawRequest);
      const key = captureKey(request);
      const cached = entries.get(key);

      if (cached && typeof adapters.evaluateWithMetadata === 'function') {
        const probe = await adapters.evaluateWithMetadata(PROBE_CODE);
        if (sameRevision(cached.capture.source, probe?.metadata)) {
          // Map insertion order is the LRU order.
          entries.delete(key);
          entries.set(key, cached);
          return Object.freeze({ ...cached.capture, cache: 'hit' });
        }
        remove(key);
      }

      if (inFlight.has(key)) {
        const joined = await inFlight.get(key);
        return Object.freeze({ ...joined, cache: 'joined' });
      }

      const pending = fresh(request, adapters).then((capture) => {
        const cachedResult = remember(key, capture);
        return cachedResult ? capture : Object.freeze({ ...capture, cache: 'bypass' });
      });
      inFlight.set(key, pending);
      try {
        return await pending;
      } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      }
    },
  });
}
