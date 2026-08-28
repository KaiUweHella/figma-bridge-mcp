// Closed request Interface for `component instantiate`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';
import { finiteNodeCoordinate } from './node-coordinate.js';

export const MAX_COMPONENT_INSTANTIATE_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const MAX_COMPONENT_INSTANTIATE_NAME_CODE_UNITS = 1_024;

function requestError(message) {
  return new Error(`Invalid component instantiate command: ${message}.`);
}

function nodeReference(value, field) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError(`${field} must not be empty`);
    if (error.code === 'too-long') {
      throw requestError(`${field} must be at most ${MAX_COMPONENT_INSTANTIATE_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError(`${field} must be a Figma node id or URL containing node-id`);
  }
}

function coordinate(value, field) {
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
  if (value.length > MAX_COMPONENT_INSTANTIATE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_COMPONENT_INSTANTIATE_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function optionValue(args, index, token, inline, label, { signed = false } = {}) {
  if (inline !== null) {
    if (inline.length === 0 && label !== '--name') throw requestError(`${label} requires a value`);
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (value === undefined || value === '--'
    || (!signed && label !== '--name' && value.startsWith('-'))
    || (label === '--name' && value.startsWith('--'))) {
    throw requestError(`${token} requires a value`);
  }
  return { value, index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'instantiate') {
    throw new Error('Expected a component instantiate command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Instantiate arguments must be strings.');
  }

  const positionals = [];
  let x = 0;
  let y = 0;
  let xSeen = false;
  let ySeen = false;
  let parent = null;
  let indexValue = null;
  let name = null;
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

    const xInline = !literal && token.startsWith('-x') && token.length > 2
      ? token.slice(2).replace(/^=/, '') : null;
    if (!literal && (token === '-x' || xInline !== null)) {
      if (xSeen) throw requestError('-x may be provided only once');
      xSeen = true;
      const parsed = optionValue(args, cursor, token, xInline, '-x', { signed: true });
      cursor = parsed.index;
      x = coordinate(parsed.value, 'x');
      continue;
    }

    const yInline = !literal && token.startsWith('-y') && token.length > 2
      ? token.slice(2).replace(/^=/, '') : null;
    if (!literal && (token === '-y' || yInline !== null)) {
      if (ySeen) throw requestError('-y may be provided only once');
      ySeen = true;
      const parsed = optionValue(args, cursor, token, yInline, '-y', { signed: true });
      cursor = parsed.index;
      y = coordinate(parsed.value, 'y');
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
      const parsed = optionValue(args, cursor, token, nameInline, '--name');
      cursor = parsed.index;
      name = layerName(parsed.value);
      continue;
    }

    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }

  if (positionals.length === 0) throw requestError('componentId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  const component = nodeReference(positionals[0], 'componentId');
  const fileKeys = new Set([component.fileKey, parent?.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('component and parent target multiple Figma files');
  return { component, parent, x, y, index: indexValue, name, json };
}

export function parseComponentInstantiateRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    componentId: input.component.nodeId,
    parentId: input.parent?.nodeId || null,
    x: input.x,
    y: input.y,
    index: input.index,
    name: input.name,
    json: input.json,
  });
}

export function acceptsComponentInstantiateArgv(args) {
  try { parseComponentInstantiateRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Instantiate request must be an object.');
  }
  const component = nodeReference(request.componentId, 'componentId');
  const parent = request.parentId === null || request.parentId === undefined
    ? null : nodeReference(request.parentId, 'parent');
  const fileKeys = new Set([component.fileKey, parent?.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('component and parent target multiple Figma files');
  return {
    component,
    parent,
    x: coordinate(request.x ?? 0, 'x'),
    y: coordinate(request.y ?? 0, 'y'),
    index: request.index === null || request.index === undefined ? null : childIndex(request.index),
    name: request.name === null || request.name === undefined ? null : layerName(request.name),
    json: request.json === true,
  };
}

function argvFromInput(input, { planning = false } = {}) {
  const componentValue = planning ? input.component.planningValue : input.component.nodeId;
  const args = ['component', 'instantiate', componentValue];
  if (input.x !== 0) args.push('-x', String(input.x));
  if (input.y !== 0) args.push('-y', String(input.y));
  if (input.name !== null) args.push(`--name=${input.name}`);
  if (input.parent) {
    args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId);
  }
  if (input.index !== null) args.push('--index', String(input.index));
  if (input.json) args.push('--json');
  return args;
}

export function componentInstantiateArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseComponentInstantiateRequest(args);
  return args;
}

export function componentInstantiatePlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = argvFromInput(input, { planning: true });
  parseComponentInstantiateRequest(args);
  return args;
}

export function componentInstantiateFigmaUrlFileKeyFromArgv(args) {
  const input = parsedRequest(args);
  const keys = new Set([input.component.fileKey, input.parent?.fileKey].filter(Boolean));
  if (keys.size > 1) throw requestError('component and parent target multiple Figma files');
  return keys.values().next().value || null;
}
