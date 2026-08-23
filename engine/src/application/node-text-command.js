// Value-returning Command Application for `node set-text`.
//
// The Application owns generated Plugin code, font preflight and result
// validation. Commander and MCP remain presentation/transport Adapters.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  MAX_NODE_TEXT_INPUT_CODE_UNITS,
  MAX_NODE_TEXT_NODE_ID_CODE_UNITS,
  NODE_TEXT_NODE_ID_PATTERN,
  nodeTextArgvFromRequest,
  nodeTextPlanningArgvFromRequest,
  parseNodeTextRequest,
} from './node-text-request.js';

export { nodeTextArgvFromRequest, nodeTextPlanningArgvFromRequest } from './node-text-request.js';

const NODE_TEXT_APPLICATION_ID = 'node.set-text';
// The Plugin WebSocket accepts 5 MiB. JSON may expand one UTF-16 code unit to
// six ASCII bytes, so the combined old/new result stays below 4.2 MiB plus its
// small envelope. Refuse before mutation instead of creating an uncertain
// write whose success response cannot cross the transport.
export const MAX_NODE_TEXT_RESULT_CODE_UNITS = 700_000;
export const NODE_TEXT_PREVIEW_CODE_POINTS = 120;

function jsString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function normalizedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Node Text request must be an object.');
  }
  if (typeof request.nodeId !== 'string' || request.nodeId.length === 0) {
    throw new TypeError('Node Text node id must be a non-empty string.');
  }
  if (typeof request.text !== 'string') {
    throw new TypeError('Node Text value must be a string.');
  }
  const nodeId = normalizeNodeId(request.nodeId).id;
  if (nodeId.length === 0 || nodeId.length > MAX_NODE_TEXT_NODE_ID_CODE_UNITS) {
    throw new Error(`Node Text node id must be at most ${MAX_NODE_TEXT_NODE_ID_CODE_UNITS} code units.`);
  }
  if (!NODE_TEXT_NODE_ID_PATTERN.test(nodeId)) {
    throw new Error('Node Text node id must be a Figma node id or URL containing node-id.');
  }
  if (request.text.length > MAX_NODE_TEXT_INPUT_CODE_UNITS) {
    throw new Error(`Node Text value must be at most ${MAX_NODE_TEXT_INPUT_CODE_UNITS} code units.`);
  }
  return { nodeId, text: request.text };
}

/** Adapter helper for the bounded figma_run command surface. */
export function nodeTextRequestFromArgv(args) {
  return parseNodeTextRequest(args);
}

/** Select the exact execution Seam for one authentic Command Plan. */
export function nodeTextPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Text routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === NODE_TEXT_APPLICATION_ID
    ? 'command-application'
    : 'not-node-text';
}

/** Execute only the accepted tracer through the Command Application Seam. */
export async function executeNodeTextPlan(plan, adapters = {}) {
  if (nodeTextPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Node Text Command Application.`);
  }
  return executeNodeText(nodeTextRequestFromArgv(plan.argv), adapters);
}

/** Generate one injection-safe Plugin evaluation for the complete Figma Command. */
export function nodeTextCode(request) {
  const input = normalizedRequest(request);
  const nodeId = jsString(input.nodeId);
  const text = jsString(input.text);
  return `(async () => {
    const nextText = ${text};
    const node = await figma.getNodeByIdAsync(${nodeId});
    if (!node) throw new Error('Node not found: ' + ${nodeId});
    if (node.type !== 'TEXT') throw new Error('Not a TEXT node: ' + node.type + ' — pass the text layer id (see node tree)');
    const oldText = node.characters;
    if (typeof oldText !== 'string'
      || oldText.length + nextText.length > ${MAX_NODE_TEXT_RESULT_CODE_UNITS}) {
      throw new Error('Existing Node Text exceeds the bounded result limit');
    }

    const candidates = oldText.length > 0
      ? node.getRangeAllFontNames(0, oldText.length)
      : [node.fontName];
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('TEXT node returned invalid font metadata');
    }
    const fonts = [];
    const seen = new Set();
    for (const font of candidates) {
      if (!font || typeof font.family !== 'string' || typeof font.style !== 'string') {
        throw new Error('TEXT node returned invalid font metadata');
      }
      const key = JSON.stringify([font.family, font.style]);
      if (!seen.has(key)) { seen.add(key); fonts.push(font); }
    }

    // Convert each rejection into data so Promise.all waits for every unique
    // font preflight before the Application decides whether mutation is safe.
    const loaded = await Promise.all(fonts.map(async (font) => {
      try { await figma.loadFontAsync(font); return { ok: true }; }
      catch (error) { return { ok: false, error }; }
    }));
    const failed = loaded.find((result) => !result.ok);
    if (failed) {
      if (failed.error instanceof Error) throw failed.error;
      throw new Error('Unable to load every font used by the TEXT node');
    }

    node.characters = nextText;
    return { id: node.id, oldText, text: node.characters };
  })()`;
}

/** Validate the closed, bounded value crossing the Plugin execution Seam. */
export function validateNodeTextResult(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Node Text returned an invalid result object.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'id' || keys[1] !== 'oldText' || keys[2] !== 'text') {
    throw new Error('Node Text returned an invalid result shape.');
  }
  if (typeof value.id !== 'string' || value.id.length === 0
    || value.id.length > MAX_NODE_TEXT_NODE_ID_CODE_UNITS || !NODE_TEXT_NODE_ID_PATTERN.test(value.id)) {
    throw new Error('Node Text returned an invalid node id.');
  }
  if (typeof value.oldText !== 'string' || typeof value.text !== 'string'
    || value.oldText.length + value.text.length > MAX_NODE_TEXT_RESULT_CODE_UNITS) {
    throw new Error('Node Text returned an invalid or oversized text value.');
  }
  if (expected.nodeId !== undefined && value.id !== expected.nodeId) {
    throw new Error('Node Text returned a result for a different node.');
  }
  if (expected.text !== undefined && value.text !== expected.text) {
    throw new Error('Node Text returned a different text value.');
  }
  return value;
}

/**
 * Value-returning Node Text Command Application. The exact validated value is
 * preserved; only presentation Adapters use bounded previews.
 */
export async function executeNodeText(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Node Text command requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const value = await adapters.evaluate(nodeTextCode(input));
  try {
    return validateNodeTextResult(value, input);
  } catch (error) {
    // The Plugin accepted the evaluation, so a malformed or mismatched value
    // cannot be treated as a pre-dispatch request error or retried safely.
    error.kind = 'plugin-result';
    error.phase = 'plugin-response';
    error.outcome = 'unknown-after-dispatch';
    throw error;
  }
}

function textPreview(value) {
  const points = Array.from(value);
  const displayed = points.length > NODE_TEXT_PREVIEW_CODE_POINTS
    ? `${points.slice(0, NODE_TEXT_PREVIEW_CODE_POINTS).join('')}…`
    : value;
  return JSON.stringify(displayed)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Adapter-neutral presentation rows with escaped, bounded text previews. */
export function nodeTextResultRows(result) {
  validateNodeTextResult(result);
  return [{
    tone: 'plain',
    marker: '✓',
    markerTone: 'success',
    text: `Text set on ${result.id}: ${textPreview(result.oldText)} → ${textPreview(result.text)}`,
  }];
}

export function formatNodeTextResult(result) {
  return nodeTextResultRows(result)
    .map((row) => row.marker ? `${row.marker} ${row.text}` : row.text)
    .join('\n');
}
