// Closed request Interface for `inspect`.
//
// Commander, figma_run and figma_inspect share this parser so node identity,
// output format and option arity are decided before planning or dispatch.

import { normalizeNodeId } from '../lib/node-id.js';

export const INSPECT_FORMATS = Object.freeze(['text', 'spec', 'yaml', 'json']);
export const MAX_INSPECT_NODE_ID_CODE_UNITS = 512;
export const INSPECT_NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

function commandError(message) {
  return new Error(`Invalid inspect command: ${message}.`);
}

function normalizeFormat(value) {
  const format = String(value || '').toLowerCase();
  if (!INSPECT_FORMATS.includes(format)) {
    throw commandError(`unknown format ${JSON.stringify(value)} — use ${INSPECT_FORMATS.join(', ')}`);
  }
  return format;
}

function parsedInspectRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'inspect') {
    throw new Error('Expected an inspect command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Inspect arguments must be strings.');
  }

  const positionals = [];
  let explicitFormat = null;
  let json = false;
  let spec = false;
  let literal = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-f' || token === '--format')) {
      const value = args[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
        throw commandError(`${token} requires a format`);
      }
      explicitFormat = normalizeFormat(value);
      index++;
      continue;
    }
    if (!literal && /^(?:-f|--format)=/.test(token)) {
      explicitFormat = normalizeFormat(token.slice(token.indexOf('=') + 1));
      continue;
    }
    if (!literal && token === '--json') {
      json = true;
      continue;
    }
    if (!literal && token === '--spec') {
      spec = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw commandError(`unknown option ${token}`);
    positionals.push(token);
  }

  if (positionals.length === 0) throw commandError('missing required argument nodeId');
  if (positionals.length > 1) throw commandError(`unexpected argument ${positionals[1]}`);

  const normalized = normalizeNodeId(positionals[0]);
  if (!normalized.id) throw commandError('nodeId must not be empty');
  if (normalized.id.length > MAX_INSPECT_NODE_ID_CODE_UNITS) {
    throw commandError(`nodeId must be at most ${MAX_INSPECT_NODE_ID_CODE_UNITS} code units`);
  }
  if (!INSPECT_NODE_ID_PATTERN.test(normalized.id)) {
    throw commandError('nodeId must be a Figma node id or URL containing node-id');
  }

  return {
    nodeId: normalized.id,
    fileKey: normalized.fileKey || null,
    warning: normalized.warning || '',
    // Preserve Commander's established precedence for combined legacy flags.
    format: explicitFormat || (json ? 'json' : spec ? 'spec' : 'text'),
  };
}

/** Parse one already-tokenized Inspect argv without consulting global argv. */
export function parseInspectRequest(args) {
  const { nodeId, format, warning } = parsedInspectRequest(args);
  return { nodeId, format, warning };
}

/** Closed Target Context projection: only the node field may name a file. */
export function inspectFigmaUrlFileKeyFromArgv(args) {
  return parsedInspectRequest(args).fileKey;
}

/** Capability planning asks only whether the Adapter input is closed and valid. */
export function acceptsInspectArgv(args) {
  try {
    parseInspectRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Inspect request must be an object.');
  }
  if (typeof request.nodeId !== 'string' || request.nodeId.trim().length === 0) {
    throw commandError('nodeId must be a non-empty string');
  }
  normalizeFormat(request.format || 'text');
  const normalized = normalizeNodeId(request.nodeId);
  if (!normalized.id || normalized.id.length > MAX_INSPECT_NODE_ID_CODE_UNITS
    || !INSPECT_NODE_ID_PATTERN.test(normalized.id)) {
    throw commandError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
  return { nodeId: request.nodeId.trim(), format: normalizeFormat(request.format || 'text') };
}

/** Canonical semantic argv used inside an accepted Command Plan. */
export function inspectArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['inspect', normalizeNodeId(input.nodeId).id, '--format', input.format];
}

/** Preserve a URL long enough for the Capability Catalog to resolve its file. */
export function inspectPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = inspectArgvFromRequest(input);
  if (normalizeNodeId(input.nodeId).fileKey) args[1] = input.nodeId;
  return args;
}
