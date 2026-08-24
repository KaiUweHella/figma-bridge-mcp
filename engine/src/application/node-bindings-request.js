// Closed request Interface for `node bindings`.

import { normalizeNodeId } from '../lib/node-id.js';

const MAX_NODE_ID_CODE_UNITS = 512;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;

function requestError(message) {
  return new Error(`Invalid node bindings command: ${message}.`);
}

function nodeValue(value) {
  if (value == null) return { nodeId: null, fileKey: null, warning: '' };
  if (typeof value !== 'string' || !value.trim()) throw requestError('nodeId must not be empty');
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

function parsedNodeBindingsRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'bindings') {
    throw new Error('Expected a node bindings command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Bindings arguments must be strings.');
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
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { ...nodeValue(positionals[0]), json };
}

export function parseNodeBindingsRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedNodeBindingsRequest(args);
  return request;
}

export function nodeBindingsFigmaUrlFileKeyFromArgv(args) {
  return parsedNodeBindingsRequest(args).fileKey;
}

export function acceptsNodeBindingsArgv(args) {
  try {
    parseNodeBindingsRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Node Bindings request must be an object.');
  }
  if (request.nodeId != null && typeof request.nodeId !== 'string') {
    throw requestError('nodeId must be a string');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return {
    ...nodeValue(request.nodeId == null ? null : request.nodeId),
    json: request.json === true,
  };
}

export function nodeBindingsArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'node', 'bindings',
    ...(input.nodeId ? [input.nodeId] : []),
    ...(input.json ? ['--json'] : []),
  ];
}

export function nodeBindingsPlanningArgvFromRequest(request) {
  const canonical = nodeBindingsArgvFromRequest(request);
  const input = typedRequest(request);
  if (input.fileKey) canonical[2] = String(request.nodeId).trim();
  return canonical;
}
