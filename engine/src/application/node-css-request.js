// Closed request Interface for `node css`.

import { normalizeNodeId } from '../lib/node-id.js';

const MAX_NODE_ID_CODE_UNITS = 512;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

function requestError(message) {
  return new Error(`Invalid node css command: ${message}.`);
}

function nodeValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw requestError('nodeId is required');
  }
  const normalized = normalizeNodeId(value.trim());
  if (!normalized.id || normalized.id.length > MAX_NODE_ID_CODE_UNITS
    || !NODE_ID_PATTERN.test(normalized.id)) {
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
  return {
    nodeId: normalized.id,
    fileKey: normalized.fileKey || null,
    warning: normalized.warning || '',
  };
}

function parsedNodeCssRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'css') {
    throw new Error('Expected a node css command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node CSS arguments must be strings.');
  }

  const positionals = [];
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { ...nodeValue(positionals[0]), json };
}

export function parseNodeCssRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedNodeCssRequest(args);
  return request;
}

export function nodeCssFigmaUrlFileKeyFromArgv(args) {
  return parsedNodeCssRequest(args).fileKey;
}

export function acceptsNodeCssArgv(args) {
  try {
    parseNodeCssRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Node CSS request must be an object.');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return { ...nodeValue(request.nodeId), json: request.json === true };
}

export function nodeCssArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['node', 'css', input.nodeId, ...(input.json ? ['--json'] : [])];
}

export function nodeCssPlanningArgvFromRequest(request) {
  const canonical = nodeCssArgvFromRequest(request);
  const input = typedRequest(request);
  if (input.fileKey) canonical[2] = String(request.nodeId).trim();
  return canonical;
}
