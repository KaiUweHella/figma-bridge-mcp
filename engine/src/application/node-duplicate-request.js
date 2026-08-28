// Closed request Interface for `node duplicate`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';
import { finiteNodeCoordinate } from './node-coordinate.js';

export const MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const MAX_NODE_DUPLICATE_NAME_CODE_UNITS = 1_024;
export const NODE_DUPLICATE_DEFAULT_OFFSET = 40;

function requestError(message) {
  return new Error(`Invalid node duplicate command: ${message}.`);
}

function nodeReference(value, field) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError(`${field} must not be empty`);
    if (error.code === 'too-long') {
      throw requestError(`${field} must be at most ${MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError(`${field} must be a Figma node id or URL containing node-id`);
  }
}

function offset(value, field) {
  try {
    return finiteNodeCoordinate(value, field);
  } catch (error) {
    throw requestError(error.message);
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

function layerName(value) {
  if (typeof value !== 'string') throw requestError('name must be a string');
  if (value.length > MAX_NODE_DUPLICATE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_NODE_DUPLICATE_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function optionValue(args, index, token, inline, label, { signed = false, empty = false } = {}) {
  if (inline !== null) {
    if (!empty && inline.length === 0) throw requestError(`${label} requires a value`);
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (value === undefined || value === '--'
    || (!signed && !empty && value.startsWith('-'))
    || (empty && value.startsWith('--'))) {
    throw requestError(`${token} requires a value`);
  }
  return { value, index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'duplicate') {
    throw new Error('Expected a node duplicate command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Duplicate arguments must be strings.');
  }

  const positionals = [];
  let parent = null;
  let indexValue = null;
  let name = null;
  let offsetX = NODE_DUPLICATE_DEFAULT_OFFSET;
  let offsetY = NODE_DUPLICATE_DEFAULT_OFFSET;
  let offsetXSeen = false;
  let offsetYSeen = false;
  let json = false;
  let literal = false;

  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }

    const parentInline = !literal && token.startsWith('--parent=')
      ? token.slice('--parent='.length) : null;
    if (!literal && (token === '--parent' || parentInline !== null)) {
      if (parent !== null) throw requestError('--parent may be provided only once');
      const parsed = optionValue(args, cursor, token, parentInline, '--parent');
      cursor = parsed.index;
      parent = nodeReference(parsed.value, 'parent');
      continue;
    }

    const indexInline = !literal && token.startsWith('--index=')
      ? token.slice('--index='.length) : null;
    if (!literal && (token === '--index' || indexInline !== null)) {
      if (indexValue !== null) throw requestError('--index may be provided only once');
      const parsed = optionValue(args, cursor, token, indexInline, '--index', { signed: true });
      cursor = parsed.index;
      indexValue = childIndex(parsed.value);
      continue;
    }

    const nameInline = !literal && token.startsWith('--name=')
      ? token.slice('--name='.length) : null;
    if (!literal && (token === '--name' || nameInline !== null)) {
      if (name !== null) throw requestError('--name may be provided only once');
      const parsed = optionValue(args, cursor, token, nameInline, '--name', { empty: true });
      cursor = parsed.index;
      name = layerName(parsed.value);
      continue;
    }

    const offsetXInline = !literal && token.startsWith('--offset-x=')
      ? token.slice('--offset-x='.length) : null;
    if (!literal && (token === '--offset-x' || offsetXInline !== null)) {
      if (offsetXSeen) throw requestError('--offset-x may be provided only once');
      offsetXSeen = true;
      const parsed = optionValue(args, cursor, token, offsetXInline, '--offset-x', { signed: true });
      cursor = parsed.index;
      offsetX = offset(parsed.value, 'offset-x');
      continue;
    }

    const offsetYInline = !literal && token.startsWith('--offset-y=')
      ? token.slice('--offset-y='.length) : null;
    if (!literal && (token === '--offset-y' || offsetYInline !== null)) {
      if (offsetYSeen) throw requestError('--offset-y may be provided only once');
      offsetYSeen = true;
      const parsed = optionValue(args, cursor, token, offsetYInline, '--offset-y', { signed: true });
      cursor = parsed.index;
      offsetY = offset(parsed.value, 'offset-y');
      continue;
    }

    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }

  if (positionals.length === 0) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  const source = nodeReference(positionals[0], 'nodeId');
  const fileKeys = new Set([source.fileKey, parent?.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('source and parent target multiple Figma files');
  return { source, parent, index: indexValue, name, offsetX, offsetY, json };
}

export function parseNodeDuplicateRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    nodeId: input.source.nodeId,
    parentId: input.parent?.nodeId || null,
    index: input.index,
    name: input.name,
    offsetX: input.offsetX,
    offsetY: input.offsetY,
    json: input.json,
  });
}

export function acceptsNodeDuplicateArgv(args) {
  try { parseNodeDuplicateRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node Duplicate request must be an object.');
  }
  const source = nodeReference(request.nodeId, 'nodeId');
  const parent = request.parentId === null || request.parentId === undefined
    ? null : nodeReference(request.parentId, 'parent');
  const fileKeys = new Set([source.fileKey, parent?.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('source and parent target multiple Figma files');
  return {
    source,
    parent,
    index: request.index === null || request.index === undefined ? null : childIndex(request.index),
    name: request.name === null || request.name === undefined ? null : layerName(request.name),
    offsetX: offset(request.offsetX ?? NODE_DUPLICATE_DEFAULT_OFFSET, 'offset-x'),
    offsetY: offset(request.offsetY ?? NODE_DUPLICATE_DEFAULT_OFFSET, 'offset-y'),
    json: request.json === true,
  };
}

function argvFromInput(input, { planning = false } = {}) {
  const args = [
    'node', 'duplicate', planning ? input.source.planningValue : input.source.nodeId,
  ];
  if (input.parent) {
    args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId);
  }
  if (input.index !== null) args.push('--index', String(input.index));
  if (input.name !== null) args.push(`--name=${input.name}`);
  if (input.offsetX !== NODE_DUPLICATE_DEFAULT_OFFSET) {
    args.push(`--offset-x=${input.offsetX}`);
  }
  if (input.offsetY !== NODE_DUPLICATE_DEFAULT_OFFSET) {
    args.push(`--offset-y=${input.offsetY}`);
  }
  if (input.json) args.push('--json');
  return args;
}

export function nodeDuplicateArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseNodeDuplicateRequest(args);
  return args;
}

export function nodeDuplicatePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseNodeDuplicateRequest(args);
  return args;
}

export function nodeDuplicateFigmaUrlFileKeyFromArgv(args) {
  const input = parsedRequest(args);
  const keys = new Set([input.source.fileKey, input.parent?.fileKey].filter(Boolean));
  if (keys.size > 1) throw requestError('source and parent target multiple Figma files');
  return keys.values().next().value || null;
}
