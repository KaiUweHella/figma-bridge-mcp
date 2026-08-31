// Closed request Interface for `node reparent`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_NODE_REPARENT_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;

function requestError(message) {
  return new Error(`Invalid node reparent command: ${message}.`);
}
function nodeReference(value, field) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError(`${field} must not be empty`);
    if (error.code === 'too-long') throw requestError(`${field} is too long`);
    throw requestError(`${field} must be a Figma node id or URL containing node-id`);
  }
}
function childIndex(value) {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw requestError('index must be a non-negative safe integer');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw requestError('index must be a non-negative safe integer');
  }
  return number;
}
function optionValue(args, index, token, inline) {
  if (inline !== null) {
    if (inline.length === 0) throw requestError('--index requires a value');
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (value === undefined || value === '--') throw requestError(`${token} requires a value`);
  return { value, index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'reparent') {
    throw new Error('Expected a node reparent command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Reparent arguments must be strings.');
  }
  const positionals = [];
  let indexValue = null;
  let preservePosition = true;
  let json = false;
  let literal = false;
  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true; continue;
    }
    if (!literal && token === '--no-preserve-position') {
      if (!preservePosition) throw requestError('--no-preserve-position may be provided only once');
      preservePosition = false; continue;
    }
    const inline = !literal && token.startsWith('--index=') ? token.slice('--index='.length) : null;
    if (!literal && (token === '--index' || inline !== null)) {
      if (indexValue !== null) throw requestError('--index may be provided only once');
      const parsed = optionValue(args, cursor, token, inline);
      cursor = parsed.index;
      indexValue = childIndex(parsed.value);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('nodeId and parentId are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  const child = nodeReference(positionals[0], 'nodeId');
  const parent = nodeReference(positionals[1], 'parentId');
  const fileKeys = new Set([child.fileKey, parent.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('node and parent target multiple Figma files');
  return { child, parent, index: indexValue, preservePosition, json };
}

export function parseNodeReparentRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    nodeId: input.child.nodeId, parentId: input.parent.nodeId,
    index: input.index, preservePosition: input.preservePosition, json: input.json,
  });
}
export function acceptsNodeReparentArgv(args) {
  try { parseNodeReparentRequest(args); return true; } catch { return false; }
}
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node Reparent request must be an object.');
  }
  const child = nodeReference(request.nodeId, 'nodeId');
  const parent = nodeReference(request.parentId, 'parentId');
  const fileKeys = new Set([child.fileKey, parent.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('node and parent target multiple Figma files');
  return {
    child, parent,
    index: request.index === null || request.index === undefined ? null : childIndex(request.index),
    preservePosition: request.preservePosition !== false,
    json: request.json === true,
  };
}
function argvFromInput(input, { planning = false } = {}) {
  const args = ['node', 'reparent',
    planning ? input.child.planningValue : input.child.nodeId,
    planning ? input.parent.planningValue : input.parent.nodeId];
  if (input.index !== null) args.push('--index', String(input.index));
  if (!input.preservePosition) args.push('--no-preserve-position');
  if (input.json) args.push('--json');
  return args;
}
export function nodeReparentArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseNodeReparentRequest(args); return args;
}
export function nodeReparentPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseNodeReparentRequest(args); return args;
}
export function nodeReparentFigmaUrlFileKeyFromArgv(args) {
  const input = parsedRequest(args);
  return input.child.fileKey || input.parent.fileKey || null;
}
