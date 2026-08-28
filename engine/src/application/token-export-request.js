// Closed request Interface for `export css` and `export dtcg`.
//
// The legacy DTCG positional grammar stays intact:
//   export dtcg [output] [nodeId]
// A recognizable node reference in the first optional slot means a scoped
// stdout export. Commander and MCP canonicalize through this one parser.

import { normalizeNodeId } from '../lib/node-id.js';

export const TOKEN_EXPORT_FORMATS = Object.freeze(['css', 'dtcg']);
export const TOKEN_EXPORT_DIALECTS = Object.freeze(['legacy', '2025']);
export const MAX_TOKEN_EXPORT_NODE_ID_CODE_UNITS = 512;
export const MAX_TOKEN_EXPORT_PATH_CODE_UNITS = 4096;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const NODE_REFERENCE_PATTERN = /^(?:I?[0-9]+[:-][0-9]+|https?:\/\/)/i;

function requestError(message) {
  return new Error(`Invalid token export command: ${message}.`);
}

function isNodeReference(value) {
  return typeof value === 'string' && NODE_REFERENCE_PATTERN.test(value);
}

function parsedTokenExportRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'export'
    || !TOKEN_EXPORT_FORMATS.includes(args[1])) {
    throw new Error('Expected an export css or export dtcg command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Token Export arguments must be strings.');
  }

  const format = args[1];
  const positionals = [];
  let dialect = format === 'dtcg' ? 'legacy' : null;
  let dialectSeen = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '--dialect' || token.startsWith('--dialect='))) {
      if (format !== 'dtcg') throw requestError('--dialect is available only for DTCG');
      if (dialectSeen) throw requestError('--dialect may be provided only once');
      const inline = token.startsWith('--dialect=');
      const value = inline ? token.slice('--dialect='.length) : args[++index];
      if (typeof value !== 'string' || !value) throw requestError('--dialect requires a value');
      dialect = value.toLowerCase();
      if (!TOKEN_EXPORT_DIALECTS.includes(dialect)) {
        throw requestError('--dialect must be legacy or 2025');
      }
      dialectSeen = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }

  if (format === 'css' && positionals.length > 1) {
    throw requestError(`unexpected argument ${positionals[1]}`);
  }
  if (format === 'dtcg' && positionals.length > 2) {
    throw requestError(`unexpected argument ${positionals[2]}`);
  }

  let output = null;
  let rawNodeId = null;
  if (format === 'css') rawNodeId = positionals[0] || null;
  else if (positionals.length === 1) {
    if (isNodeReference(positionals[0])) rawNodeId = positionals[0];
    else output = positionals[0];
  } else if (positionals.length === 2) {
    output = positionals[0];
    rawNodeId = positionals[1];
  }

  if (output !== null && (!output || output.length > MAX_TOKEN_EXPORT_PATH_CODE_UNITS)) {
    throw requestError(`output must contain 1 to ${MAX_TOKEN_EXPORT_PATH_CODE_UNITS} code units`);
  }

  let nodeId = null;
  let fileKey = null;
  if (rawNodeId !== null) {
    const normalized = normalizeNodeId(rawNodeId);
    nodeId = normalized.id;
    fileKey = normalized.fileKey || null;
    if (!nodeId || nodeId.length > MAX_TOKEN_EXPORT_NODE_ID_CODE_UNITS
      || !NODE_ID_PATTERN.test(nodeId)) {
      throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
    }
  }

  return { format, nodeId, fileKey, output, dialect };
}

export function parseTokenExportRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedTokenExportRequest(args);
  return request;
}

export function tokenExportFigmaUrlFileKeyFromArgv(args) {
  return parsedTokenExportRequest(args).fileKey;
}

export function acceptsTokenExportArgv(args) {
  try { parseTokenExportRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) =>
      !['format', 'nodeId', 'output', 'dialect'].includes(key))) {
    throw new TypeError('Token Export request must be a closed object.');
  }
  if (!TOKEN_EXPORT_FORMATS.includes(request.format)) {
    throw requestError('format must be css or dtcg');
  }
  for (const key of ['nodeId', 'output', 'dialect']) {
    if (request[key] != null && typeof request[key] !== 'string') {
      throw requestError(`${key} must be a string`);
    }
  }
  if (request.format === 'css' && (request.output != null || request.dialect != null)) {
    throw requestError('CSS does not accept output or dialect fields');
  }
  const args = ['export', request.format];
  if (request.format === 'dtcg' && request.output) args.push(request.output);
  if (request.nodeId) args.push(request.nodeId.trim());
  if (request.format === 'dtcg' && request.dialect != null) {
    args.push('--dialect', request.dialect);
  }
  return parsedTokenExportRequest(args);
}

export function tokenExportArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['export', input.format];
  if (input.format === 'dtcg' && input.output) args.push(input.output);
  if (input.nodeId) args.push(input.nodeId);
  if (input.format === 'dtcg' && input.dialect !== 'legacy') {
    args.push('--dialect', input.dialect);
  }
  return args;
}

export function tokenExportPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = tokenExportArgvFromRequest({
    format: input.format,
    nodeId: input.nodeId,
    output: input.output,
    dialect: input.dialect,
  });
  if (input.fileKey && request.nodeId) {
    const nodeIndex = input.format === 'dtcg' && input.output ? 3 : 2;
    args[nodeIndex] = request.nodeId.trim();
  }
  return args;
}
