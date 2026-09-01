// Closed request Interface for `node rename`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_NODE_RENAME_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const MAX_NODE_RENAME_NAME_CODE_UNITS = 1_024;

function requestError(message) {
  return new Error(`Invalid node rename command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError('nodeId must not be empty');
    if (error.code === 'too-long') {
      throw requestError(`nodeId must be at most ${MAX_NODE_RENAME_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError('nodeId must be a Figma node id or URL containing node-id');
  }
}

function nameValue(value) {
  if (typeof value !== 'string') throw requestError('name must be a string');
  if (value.length > MAX_NODE_RENAME_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_NODE_RENAME_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'rename') {
    throw new Error('Expected a node rename command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Rename arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('missing required arguments nodeId, name');
  if (positionals.length === 1) throw requestError('missing required argument name');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return { reference: nodeReference(positionals[0]), name: nameValue(positionals[1]) };
}

export function parseNodeRenameRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({ nodeId: input.reference.nodeId, name: input.name });
}

export function acceptsNodeRenameArgv(args) {
  try { parseNodeRenameRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node Rename request must be an object.');
  }
  return { reference: nodeReference(request.nodeId), name: nameValue(request.name) };
}

function argvFromInput(input, { planning = false } = {}) {
  const args = [
    'node', 'rename', planning ? input.reference.planningValue : input.reference.nodeId,
  ];
  if (input.name.length === 0 || input.name.startsWith('-')) args.push('--');
  args.push(input.name);
  return args;
}

export function nodeRenameArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseNodeRenameRequest(args);
  return args;
}

export function nodeRenamePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseNodeRenameRequest(args);
  return args;
}

export function nodeRenameFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}
