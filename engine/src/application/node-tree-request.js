// Closed request Interface for `node tree`.
//
// Commander and figma_run share this parser so optional node identity, depth,
// output identity and URL-derived targeting are decided before readiness.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEFAULT_NODE_TREE_DEPTH = 3;
export const MAX_NODE_TREE_DEPTH = 64;

function requestError(message) {
  return new Error(`Invalid node tree command: ${message}.`);
}

function depthValue(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) {
    throw requestError(`depth must be an integer between 0 and ${MAX_NODE_TREE_DEPTH}`);
  }
  const depth = Number(value);
  if (depth > MAX_NODE_TREE_DEPTH) {
    throw requestError(`depth must be an integer between 0 and ${MAX_NODE_TREE_DEPTH}`);
  }
  return depth;
}

function nodeValue(value) {
  if (value == null) return { nodeId: null, fileKey: null, warning: '' };
  try {
    const reference = parseNodeReference(value);
    return {
      nodeId: reference.nodeId,
      fileKey: reference.fileKey,
      warning: reference.warning,
    };
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedNodeTreeRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'tree') {
    throw new Error('Expected a node tree command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Tree arguments must be strings.');
  }

  const positionals = [];
  let depth = DEFAULT_NODE_TREE_DEPTH;
  let withIds = false;
  let depthSeen = false;
  let idsSeen = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-d' || token === '--depth')) {
      if (depthSeen) throw requestError('depth may be provided only once');
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw requestError(`${token} requires a depth`);
      }
      depth = depthValue(value);
      depthSeen = true;
      index++;
      continue;
    }
    if (!literal && /^(?:-d|--depth)=/.test(token)) {
      if (depthSeen) throw requestError('depth may be provided only once');
      depth = depthValue(token.slice(token.indexOf('=') + 1));
      depthSeen = true;
      continue;
    }
    if (!literal && token === '--ids') {
      if (idsSeen) throw requestError('--ids may be provided only once');
      withIds = true;
      idsSeen = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { ...nodeValue(positionals[0]), depth, withIds };
}

export function parseNodeTreeRequest(args) {
  const { fileKey: _fileKey, ...request } = parsedNodeTreeRequest(args);
  return request;
}

export function nodeTreeFigmaUrlFileKeyFromArgv(args) {
  return parsedNodeTreeRequest(args).fileKey;
}

export function acceptsNodeTreeArgv(args) {
  try {
    parseNodeTreeRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Node Tree request must be an object.');
  }
  if (request.nodeId != null && typeof request.nodeId !== 'string') {
    throw requestError('nodeId must be a string');
  }
  if (request.withIds != null && typeof request.withIds !== 'boolean') {
    throw requestError('withIds must be a boolean');
  }
  const node = nodeValue(request.nodeId == null ? null : request.nodeId.trim());
  return {
    ...node,
    depth: depthValue(request.depth ?? DEFAULT_NODE_TREE_DEPTH),
    withIds: request.withIds === true,
  };
}

export function nodeTreeArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'node', 'tree',
    ...(input.nodeId ? [input.nodeId] : []),
    '--depth', String(input.depth),
    ...(input.withIds ? ['--ids'] : []),
  ];
}

export function nodeTreePlanningArgvFromRequest(request) {
  const canonical = nodeTreeArgvFromRequest(request);
  if (!request?.nodeId) return canonical;
  const reference = parseNodeReference(request.nodeId);
  if (!reference.fileKey) return canonical;
  canonical[2] = reference.planningValue;
  return canonical;
}
