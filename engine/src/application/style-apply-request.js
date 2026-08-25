// Closed request Interface for `style apply`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_STYLE_APPLY_QUERY_CODE_UNITS = 512;
export const MAX_STYLE_APPLY_NODES = 500;
const MAX_STYLE_APPLY_NODE_LIST_CODE_UNITS = 65_536;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
const FIELDS = new Set(['fill', 'stroke', 'text', 'effect', 'grid', 'layout-guide']);

function requestError(message) {
  return new Error(`Invalid style apply command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || value.length === 0) throw requestError('style is required');
  if (value.length > MAX_STYLE_APPLY_QUERY_CODE_UNITS) {
    throw requestError(`style exceeds ${MAX_STYLE_APPLY_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) throw requestError('style contains unsafe control characters');
  return value;
}

function fieldValue(value, option = '--field') {
  if (typeof value !== 'string' || value.length === 0) throw requestError(`${option} requires a value`);
  const field = value.toLowerCase();
  if (!FIELDS.has(field)) {
    throw requestError(`${option} must be fill, stroke, text, effect, layout-guide (Grid Style), or grid (alias)`);
  }
  // `grid` is the backwards-compatible spelling for a Grid Style on Figma
  // Layout Guides. It never means Auto Layout GRID (`layoutMode: "GRID"`).
  return field === 'layout-guide' ? 'grid' : field;
}

function nodeListValue(value) {
  if (typeof value !== 'string' || value.length === 0) throw requestError('nodeIds are required');
  if (value.length > MAX_STYLE_APPLY_NODE_LIST_CODE_UNITS) {
    throw requestError(`nodeIds exceed ${MAX_STYLE_APPLY_NODE_LIST_CODE_UNITS} code units`);
  }
  const raw = value.split(/[\s,]+/).filter(Boolean);
  if (raw.length === 0) throw requestError('nodeIds are required');
  if (raw.length > MAX_STYLE_APPLY_NODES) throw requestError(`at most ${MAX_STYLE_APPLY_NODES} nodes are supported`);
  const references = raw.map((entry) => {
    try { return parseNodeReference(entry); }
    catch (error) {
      if (!(error instanceof NodeReferenceError)) throw error;
      throw requestError('each nodeId must be a Figma node id or URL containing node-id');
    }
  });
  const ids = references.map(({ nodeId }) => nodeId);
  if (new Set(ids).size !== ids.length) throw requestError('nodeIds must not contain duplicates');
  const fileKeys = new Set(references.map(({ fileKey }) => fileKey).filter(Boolean));
  if (fileKeys.size > 1) throw requestError('nodeIds reference multiple Figma files');
  return { ids, references, fileKey: fileKeys.values().next().value || null };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || args[1] !== 'apply') {
    throw new Error('Expected a style apply command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Style Apply arguments must be strings.');
  }
  const positionals = [];
  let field = null;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const long = !literal ? token.match(/^--field=(.*)$/s) : null;
    const short = !literal ? token.match(/^-f(.+)$/s) : null;
    if (!literal && (token === '-f' || token === '--field' || long || short)) {
      if (field !== null) throw requestError('--field may be provided only once');
      const inline = long?.[1] ?? short?.[1];
      const value = inline === undefined ? args[++index] : inline;
      field = fieldValue(value, long ? '--field' : short ? '-f' : token);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (field === null) throw requestError('--field is required');
  if (positionals.length < 2) throw requestError('style and nodeIds are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return { style: queryValue(positionals[0]), field, nodes: nodeListValue(positionals[1]) };
}

export function parseStyleApplyRequest(args) {
  const input = parsedRequest(args);
  return { style: input.style, field: input.field, nodeIds: input.nodes.ids };
}

export function styleApplyFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).nodes.fileKey;
}

export function acceptsStyleApplyArgv(args) {
  try { parseStyleApplyRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Style Apply request must be an object.');
  }
  const nodeSource = Array.isArray(request.nodeIds) ? request.nodeIds.join(',') : request.nodeIds;
  return {
    style: queryValue(request.style),
    field: fieldValue(request.field),
    nodes: nodeListValue(nodeSource),
  };
}

export function styleApplyArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['style', 'apply', '--field', input.field, '--', input.style, input.nodes.ids.join(',')];
}

export function styleApplyPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const planningNodes = input.nodes.references.map(({ planningValue }) => planningValue).join(',');
  return ['style', 'apply', '--field', input.field, '--', input.style, planningNodes];
}
