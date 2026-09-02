// Revision-aware Design Capture Module.
//
// The Interface returns one canonical, information-rich walker Capture.
// Structure/style, deduplication and output formats are projections and never
// participate in the cache key. A Capture is reused only after the plugin has
// proved that the same connection is still on the same observed revision.
import { nodeWalkerCode } from '../design-extract.js';
import {
  sameObservedRevision,
  stableObservedRevision,
} from '../lib/revision-context.js';

// Bump whenever the canonical walker payload changes. Version 7 adds
// wall-clock-bounded chunks stitched into one complete capture.
export const DESIGN_CAPTURE_SCHEMA_VERSION = 7;

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// One plugin eval must stay well inside the daemon/plugin transport window
// (22-25 s) even when a large screen resolves native Inspect CSS per layer.
const DEFAULT_CHUNK_BUDGET_MS = 12_000;
// The plugin socket rejects oversized messages outright (MAX_PLUGIN_MESSAGE_BYTES);
// a chunk stays far below it so the last counted layer cannot push it over.
const DEFAULT_CHUNK_BUDGET_BYTES = 2_500_000;
const PROBE_CODE = '(async () => null)()';
const DEPTH_RETRY_KINDS = new Set(['timeout', 'plugin-timeout', 'plugin-protocol']);

function parseEval(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function hasDepthMarker(node) {
  return Boolean(node?.more) || (node?.kids || []).some(hasDepthMarker);
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
    complete: request.complete,
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
  let depth = Math.max(0, requested);
  let blankRetries = 1;
  for (;;) {
    try {
      const result = await attempt(depth);
      if (!result && blankRetries-- > 0) continue;
      return { result, depth };
    } catch (error) {
      if (DEPTH_RETRY_KINDS.has(error?.kind) && depth > 4) {
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
  if (!Number.isInteger(depth) || depth < 0 || depth > 30) {
    throw new Error('Design Capture depth must be an integer between 0 and 30');
  }
  const chunkBudgetMs = request.chunkBudgetMs == null
    ? DEFAULT_CHUNK_BUDGET_MS
    : Number(request.chunkBudgetMs);
  if (!Number.isInteger(chunkBudgetMs) || chunkBudgetMs < 0) {
    throw new Error('Design Capture chunkBudgetMs must be a non-negative integer');
  }
  const chunkBudgetBytes = request.chunkBudgetBytes == null
    ? DEFAULT_CHUNK_BUDGET_BYTES
    : Number(request.chunkBudgetBytes);
  if (!Number.isInteger(chunkBudgetBytes) || chunkBudgetBytes < 0) {
    throw new Error('Design Capture chunkBudgetBytes must be a non-negative integer');
  }
  return Object.freeze({
    nodeId: request.nodeId,
    fileKey: request.fileKey || null,
    depth,
    includeHidden: request.includeHidden === true,
    // Complete captures walk large subtrees in several wall-clock-bounded
    // plugin evals and stitch them under one observed revision. Opting out
    // returns the first bounded eval with its frontier marked budgetCut.
    complete: request.complete !== false,
    chunkBudgetMs,
    chunkBudgetBytes,
  });
}

function captureEnvelope(request, result, actualDepth, source, cache, stitching) {
  return Object.freeze({
    schemaVersion: DESIGN_CAPTURE_SCHEMA_VERSION,
    source: source ? Object.freeze({ ...source }) : null,
    options: Object.freeze({
      depth: request.depth,
      includeHidden: request.includeHidden,
      resolveInstances: true,
      withIds: true,
      withVars: true,
      complete: request.complete,
      chunkBudgetMs: request.chunkBudgetMs,
      chunkBudgetBytes: request.chunkBudgetBytes,
    }),
    completeness: Object.freeze({
      requestedDepth: request.depth,
      actualDepth,
      payloadComplete: actualDepth === request.depth,
      depthLimited: result.frames.some(hasDepthMarker),
      budgetLimited: result.frames.some(hasBudgetCut),
      stitchedCaptures: stitching.stitchedCaptures,
      budgetCuts: stitching.budgetCuts,
    }),
    result,
    cache,
  });
}

function hasBudgetCut(node) {
  return Boolean(node?.budgetCut) || (node?.kids || []).some(hasBudgetCut);
}

function setIdentity(entry) {
  return entry?.entityId || entry?.setKey || entry?.id || entry?.name || null;
}

function mergeSets(target, extra) {
  const seen = new Set(target.map(setIdentity));
  for (const entry of extra || []) {
    const identity = setIdentity(entry);
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    target.push(entry);
  }
}

/**
 * Complete every budget-cut frontier in place: each frontier child is walked
 * in its own bounded eval at the depth that remains below it, and its frames
 * replace the cut. Every stitched eval must observe the same revision as the
 * root walk; a changed document fails explicitly instead of mixing revisions.
 */
async function completeBudgetCuts(result, request, source, walkOnce) {
  const pending = [];
  const scan = (node, absoluteDepth) => {
    if (node?.budgetCut && Array.isArray(node.frontier) && node.frontier.length) {
      pending.push({ node, absoluteDepth });
    }
    for (const kid of node?.kids || []) scan(kid, absoluteDepth + 1);
  };
  for (const frame of result.frames) scan(frame, 0);
  let stitchedCaptures = 0;
  let budgetCuts = 0;
  while (pending.length) {
    const { node, absoluteDepth } = pending.shift();
    const kids = [];
    for (const child of node.frontier) {
      const childDepth = absoluteDepth + 1;
      const response = await walkOnce(child.id, Math.max(0, request.depth - childDepth));
      if (source && response?.metadata && !sameObservedRevision(source, response.metadata)) {
        throw new Error(
          `Design Capture observed a document change while completing node ${request.nodeId} `
          + `(${stitchedCaptures} stitched eval(s) so far); retry the capture on the settled document.`,
        );
      }
      const part = parseEval(response?.value);
      if (part?.error) throw new Error(part.error);
      if (!part || !Array.isArray(part.frames)) {
        throw new Error(`Design Capture returned no data for frontier node ${child.id}`);
      }
      for (const frame of part.frames) {
        kids.push(frame);
        scan(frame, childDepth);
      }
      mergeSets(result.sets, part.sets);
      stitchedCaptures++;
    }
    node.kids = kids;
    delete node.frontier;
    delete node.more;
    delete node.budgetCut;
    budgetCuts++;
  }
  return { stitchedCaptures, budgetCuts };
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
    if (maxEntries <= 0 || maxBytes <= 0 || !stableObservedRevision(capture.source)) return false;
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
    const walkOnce = (nodeId, maxDepth) => evaluateWithMetadata(nodeWalkerCode(nodeId, {
      maxDepth,
      // 0 = unlimited. Truncating copy is acceptable for a page census, but
      // never for the canonical design-to-code Capture.
      textLimit: 0,
      resolveInstances: true,
      withIds: true,
      withVars: true,
      includeHidden: request.includeHidden,
      budgetMs: request.complete ? request.chunkBudgetMs : 0,
      budgetBytes: request.complete ? request.chunkBudgetBytes : 0,
    }));
    const { result, depth } = await walkWithDepthRetry(request.depth, async (candidateDepth) => {
      const response = await walkOnce(request.nodeId, candidateDepth);
      source = response?.metadata || null;
      return parseEval(response?.value);
    });

    if (result?.error) throw new Error(result.error);
    if (!result || !Array.isArray(result.frames)) {
      throw new Error(`Design Capture returned no data for node ${request.nodeId}`);
    }
    if (!Array.isArray(result.sets)) result.sets = [];
    const stitching = request.complete
      ? await completeBudgetCuts(result, request, source, walkOnce)
      : { stitchedCaptures: 0, budgetCuts: 0 };
    deepFreeze(result);
    return captureEnvelope(request, result, depth, source, 'miss', stitching);
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
        if (sameObservedRevision(cached.capture.source, probe?.metadata)) {
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
