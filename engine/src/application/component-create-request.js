// Closed request Interface for `component create`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';
import { finiteNodeCoordinate } from './node-coordinate.js';

export const MAX_COMPONENT_CREATE_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const MAX_COMPONENT_CREATE_NAME_CODE_UNITS = 1_024;

function requestError(message) {
  return new Error(`Invalid component create command: ${message}.`);
}

function parentReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError('parent must not be empty');
    if (error.code === 'too-long') {
      throw requestError(`parent must be at most ${MAX_COMPONENT_CREATE_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError('parent must be a Figma node id or URL containing node-id');
  }
}

function dimension(value, field) {
  let number;
  try { number = finiteNodeCoordinate(value, field); }
  catch (error) { throw requestError(error.message); }
  if (number <= 0) throw requestError(`${field} must be a positive finite number`);
  return number;
}

function coordinate(value, field) {
  try { return finiteNodeCoordinate(value, field); }
  catch (error) { throw requestError(error.message); }
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

function componentName(value) {
  if (typeof value !== 'string') throw requestError('name must be a string');
  if (value.length > MAX_COMPONENT_CREATE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_COMPONENT_CREATE_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function takeValue(args, cursor, token, inline, label, { signed = false } = {}) {
  if (inline !== null) {
    if (inline.length === 0) throw requestError(`${label} requires a value`);
    return { value: inline, cursor };
  }
  const value = args[cursor + 1];
  if (value === undefined || value === '--' || (!signed && value.startsWith('-'))) {
    throw requestError(`${token} requires a value`);
  }
  return { value, cursor: cursor + 1 };
}

function shortInline(token, option) {
  return token.startsWith(option) && token.length > option.length
    ? token.slice(option.length).replace(/^=/, '') : null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'create') {
    throw new Error('Expected a component create command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Create arguments must be strings.');
  }

  const positionals = [];
  let width = 100;
  let height = 100;
  let x = 0;
  let y = 0;
  let parent = null;
  let indexValue = null;
  let json = false;
  const seen = new Set();
  let literal = false;

  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }

    const optionCases = [
      { key: 'width', aliases: ['-w', '--width'], inline: token.startsWith('--width=')
        ? token.slice('--width='.length) : shortInline(token, '-w'), signed: false },
      { key: 'height', aliases: ['-h', '--height'], inline: token.startsWith('--height=')
        ? token.slice('--height='.length) : shortInline(token, '-h'), signed: false },
      { key: 'x', aliases: ['-x'], inline: shortInline(token, '-x'), signed: true },
      { key: 'y', aliases: ['-y'], inline: shortInline(token, '-y'), signed: true },
      { key: 'index', aliases: ['--index'], inline: token.startsWith('--index=')
        ? token.slice('--index='.length) : null, signed: true },
    ];
    const matched = !literal && optionCases.find((entry) =>
      entry.aliases.includes(token) || entry.inline !== null);
    if (matched) {
      if (seen.has(matched.key)) throw requestError(`${matched.aliases.at(-1)} may be provided only once`);
      seen.add(matched.key);
      const taken = takeValue(args, cursor, token, matched.inline, matched.aliases.at(-1), {
        signed: matched.signed,
      });
      cursor = taken.cursor;
      if (matched.key === 'width') width = dimension(taken.value, 'width');
      else if (matched.key === 'height') height = dimension(taken.value, 'height');
      else if (matched.key === 'x') x = coordinate(taken.value, 'x');
      else if (matched.key === 'y') y = coordinate(taken.value, 'y');
      else indexValue = childIndex(taken.value);
      continue;
    }

    const parentInline = !literal && token.startsWith('--parent=')
      ? token.slice('--parent='.length) : null;
    if (!literal && (token === '--parent' || parentInline !== null)) {
      if (parent !== null) throw requestError('--parent may be provided only once');
      const taken = takeValue(args, cursor, token, parentInline, '--parent');
      cursor = taken.cursor;
      parent = parentReference(taken.value);
      continue;
    }

    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }

  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return {
    name: componentName(positionals[0] ?? 'Component'),
    width,
    height,
    x,
    y,
    parent,
    index: indexValue,
    json,
  };
}

export function parseComponentCreateRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    name: input.name,
    width: input.width,
    height: input.height,
    x: input.x,
    y: input.y,
    parentId: input.parent?.nodeId || null,
    index: input.index,
    json: input.json,
  });
}

export function acceptsComponentCreateArgv(args) {
  try { parseComponentCreateRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Create request must be an object.');
  }
  return {
    name: componentName(request.name ?? 'Component'),
    width: dimension(request.width ?? 100, 'width'),
    height: dimension(request.height ?? 100, 'height'),
    x: coordinate(request.x ?? 0, 'x'),
    y: coordinate(request.y ?? 0, 'y'),
    parent: request.parentId === null || request.parentId === undefined
      ? null : parentReference(request.parentId),
    index: request.index === null || request.index === undefined ? null : childIndex(request.index),
    json: request.json === true,
  };
}

function argvFromInput(input, { planning = false } = {}) {
  const args = ['component', 'create'];
  if (input.width !== 100) args.push('--width', String(input.width));
  if (input.height !== 100) args.push('--height', String(input.height));
  if (input.x !== 0) args.push('-x', String(input.x));
  if (input.y !== 0) args.push('-y', String(input.y));
  if (input.parent) {
    args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId);
  }
  if (input.index !== null) args.push('--index', String(input.index));
  if (input.json) args.push('--json');
  if (input.name !== 'Component') {
    if (input.name.startsWith('-') || input.name.length === 0) args.push('--');
    args.push(input.name);
  }
  return args;
}

export function componentCreateArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseComponentCreateRequest(args);
  return args;
}

export function componentCreatePlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = argvFromInput(input, { planning: true });
  parseComponentCreateRequest(args);
  return args;
}

export function componentCreateFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).parent?.fileKey || null;
}
