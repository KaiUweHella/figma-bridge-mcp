// Closed request Interface for `node set-text`.
//
// Commander and MCP share this parser so positional arity, option rejection
// and the `--` literal delimiter are decided before planning or dispatch.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

// Keep the closed request Interface aligned with the shared execution wrapper.
// Rejecting here is important: MCP confirmation happens before dispatch.
export const MAX_NODE_TEXT_INPUT_CODE_UNITS = 200_000;
export const MAX_NODE_TEXT_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const NODE_TEXT_NODE_ID_PATTERN = NODE_REFERENCE_PATTERN;

function commandError(message) {
  return new Error(`Invalid node set-text command: ${message}.`);
}

function assertStringArguments(args) {
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Text arguments must be strings.');
  }
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw commandError('nodeId must not be empty');
    if (error.code === 'too-long') {
      throw commandError(`nodeId must be at most ${MAX_NODE_TEXT_NODE_ID_CODE_UNITS} code units`);
    }
    throw commandError('nodeId must be a Figma node id or URL containing node-id');
  }
}

function parsedNodeTextRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'set-text') {
    throw new Error('Expected a node set-text command.');
  }
  assertStringArguments(args);

  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) {
      throw commandError(`unknown option ${token}`);
    }
    positionals.push(token);
  }

  if (positionals.length === 0) {
    throw commandError('missing required arguments nodeId, text');
  }
  if (positionals.length === 1) {
    throw commandError('missing required argument text');
  }
  if (positionals.length > 2) {
    throw commandError(`unexpected argument ${positionals[2]}`);
  }
  const normalized = nodeReference(positionals[0]);
  const nodeId = normalized.nodeId;
  if (positionals[1].length > MAX_NODE_TEXT_INPUT_CODE_UNITS) {
    throw commandError(`text must be at most ${MAX_NODE_TEXT_INPUT_CODE_UNITS} code units`);
  }
  return {
    nodeId,
    fileKey: normalized.fileKey,
    // Empty text is a real value. Arity, rather than truthiness, distinguishes
    // it from a missing positional.
    text: positionals[1],
  };
}

/** Parse one already-tokenized Node Text argv without consulting global argv. */
export function parseNodeTextRequest(args) {
  const { nodeId, text } = parsedNodeTextRequest(args);
  return { nodeId, text };
}

/** Closed Target Context projection: text payload can never impersonate a file. */
export function nodeTextFigmaUrlFileKeyFromArgv(args) {
  return parsedNodeTextRequest(args).fileKey;
}

/** Capability planning asks only whether the Adapter input is closed and valid. */
export function acceptsNodeTextArgv(args) {
  try {
    parseNodeTextRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Node Text request must be an object.');
  }
  if (typeof request.nodeId !== 'string' || request.nodeId.length === 0) {
    throw commandError('nodeId must be a non-empty string');
  }
  if (typeof request.text !== 'string') {
    throw commandError('text must be a string');
  }
  const reference = nodeReference(request.nodeId);
  if (request.text.length > MAX_NODE_TEXT_INPUT_CODE_UNITS) {
    throw commandError(`text must be at most ${MAX_NODE_TEXT_INPUT_CODE_UNITS} code units`);
  }
  return { nodeId: reference.nodeId, text: request.text, reference };
}

/** Convert one typed Adapter request into canonical Command Plan argv. */
export function nodeTextArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['node', 'set-text', input.nodeId];
  // The delimiter gives typed Adapters one explicit path for empty text and
  // for values Commander would otherwise interpret as help or an option.
  if (input.text.length === 0 || input.text.startsWith('-')) args.push('--');
  args.push(input.text);
  parseNodeTextRequest(args);
  return args;
}

/**
 * Planning input keeps a Figma URL long enough for Figma Target Context
 * resolution. The Capability Catalog can canonicalize the resulting plan argv.
 */
export function nodeTextPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = nodeTextArgvFromRequest(request);
  if (input.reference.fileKey) args[2] = input.reference.planningValue;
  return args;
}
