// Closed request Interface for `node move`.
//
// Signed numeric positionals are recognized before option rejection so a
// negative coordinate cannot be mistaken for an unknown Commander option.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';
import { finiteNodeCoordinate } from './node-coordinate.js';

export const MAX_NODE_MOVE_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const NODE_MOVE_NODE_ID_PATTERN = NODE_REFERENCE_PATTERN;
export const MAX_NODE_MOVE_PAGE_CODE_UNITS = 512;

function requestError(message) {
  return new Error(`Invalid node move command: ${message}.`);
}

function assertStringArguments(args) {
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Move arguments must be strings.');
  }
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError('nodeId must not be empty');
    if (error.code === 'too-long') {
      throw requestError(`nodeId must be at most ${MAX_NODE_MOVE_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError('nodeId must be a Figma node id or URL containing node-id');
  }
}

function coordinate(value, field) {
  try {
    return finiteNodeCoordinate(value, field);
  } catch (error) {
    throw requestError(error.message);
  }
}

function pageValue(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw requestError('page must be a non-empty name or id');
  }
  const page = value.trim();
  if (page.length > MAX_NODE_MOVE_PAGE_CODE_UNITS) {
    throw requestError(`page must be at most ${MAX_NODE_MOVE_PAGE_CODE_UNITS} code units`);
  }
  return page;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'move') {
    throw new Error('Expected a node move command.');
  }
  assertStringArguments(args);

  const positionals = [];
  let page = null;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '--page' || token === '-p')) {
      if (page !== null) throw requestError('page may be provided only once');
      const value = args[index + 1];
      if (typeof value !== 'string' || value === '--') {
        throw requestError(`${token} requires a page name or id`);
      }
      page = pageValue(value);
      index++;
      continue;
    }
    if (!literal && token.startsWith('--page=')) {
      if (page !== null) throw requestError('page may be provided only once');
      page = pageValue(token.slice('--page='.length));
      continue;
    }
    if (!literal && token.startsWith('-p') && token.length > 2) {
      if (page !== null) throw requestError('page may be provided only once');
      page = pageValue(token.slice(2));
      continue;
    }
    if (!literal && token.startsWith('-') && !Number.isFinite(Number(token))) {
      throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }

  if (positionals.length < 3) {
    throw requestError('nodeId, x and y are required');
  }
  if (positionals.length > 3) {
    throw requestError(`unexpected argument ${positionals[3]}`);
  }
  const normalized = nodeReference(positionals[0]);
  return {
    nodeId: normalized.nodeId,
    fileKey: normalized.fileKey,
    x: coordinate(positionals[1], 'x'),
    y: coordinate(positionals[2], 'y'),
    page,
  };
}

export function parseNodeMoveRequest(args) {
  const { nodeId, x, y, page } = parsedRequest(args);
  return { nodeId, x, y, page };
}

export function nodeMoveFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}

export function acceptsNodeMoveArgv(args) {
  try {
    parseNodeMoveRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node Move request must be an object.');
  }
  const reference = nodeReference(request.nodeId);
  return {
    nodeId: reference.nodeId,
    reference,
    x: coordinate(request.x, 'x'),
    y: coordinate(request.y, 'y'),
    page: request.page === null || request.page === undefined ? null : pageValue(request.page),
  };
}

export function nodeMoveArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['node', 'move', input.nodeId];
  if (input.page) args.push('--page', input.page);
  // Keep signed coordinates out of every option scanner, including Commander.
  args.push('--', String(input.x), String(input.y));
  parseNodeMoveRequest(args);
  return args;
}

export function nodeMovePlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = nodeMoveArgvFromRequest(request);
  if (input.reference.fileKey) args[2] = input.reference.planningValue;
  return args;
}
