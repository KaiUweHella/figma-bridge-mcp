// Closed request Interface for `jam shape`.

import { finiteNodeCoordinate } from './node-coordinate.js';
import { JAM_SHAPE_TYPES } from '../lib/jam-shape-types.js';

export const DEFAULT_JAM_SHAPE_TYPE = 'ROUNDED_RECTANGLE';
export const DEFAULT_JAM_SHAPE_WIDTH = 200;
export const DEFAULT_JAM_SHAPE_HEIGHT = 140;
export const MAX_JAM_SHAPE_TEXT_CODE_UNITS = 100_000;

function requestError(message) {
  return new Error(`Invalid Jam Shape command: ${message}.`);
}

function textValue(value) {
  if (typeof value !== 'string' || value.length > MAX_JAM_SHAPE_TEXT_CODE_UNITS) {
    throw requestError(`text must be a string of at most ${MAX_JAM_SHAPE_TEXT_CODE_UNITS} code units`);
  }
  return value;
}

function typeValue(value) {
  const type = String(value ?? DEFAULT_JAM_SHAPE_TYPE).toUpperCase();
  if (!JAM_SHAPE_TYPES.includes(type)) {
    throw requestError(`type must be one of ${JAM_SHAPE_TYPES.join(', ')}`);
  }
  return type;
}

function coordinateValue(value, field) {
  try { return finiteNodeCoordinate(value, field); }
  catch (error) { throw requestError(error.message); }
}

function dimensionValue(value, field) {
  const number = coordinateValue(value, field);
  if (number < 0.01) throw requestError(`${field} must be at least 0.01`);
  return number;
}

function sizeValue(value) {
  if (value === undefined || value === null) {
    return { width: DEFAULT_JAM_SHAPE_WIDTH, height: DEFAULT_JAM_SHAPE_HEIGHT };
  }
  if (typeof value !== 'string') throw requestError('size must be a w,h string');
  const [rawWidth, rawHeight] = value.split(',');
  const width = parseFloat(String(rawWidth).trim());
  const height = parseFloat(String(rawHeight).trim());
  return {
    width: dimensionValue(Number.isFinite(width) ? width : DEFAULT_JAM_SHAPE_WIDTH, 'width'),
    height: dimensionValue(Number.isFinite(height) ? height : DEFAULT_JAM_SHAPE_HEIGHT, 'height'),
  };
}

function positionValue(value) {
  if (value === undefined || value === null) return { x: null, y: null };
  if (typeof value !== 'string') throw requestError('at must be an x,y string');
  const [rawX, rawY] = value.split(',');
  const x = parseFloat(String(rawX).trim());
  const y = parseFloat(String(rawY).trim());
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: null, y: null };
  return { x: coordinateValue(x, 'x'), y: coordinateValue(y, 'y') };
}

function optionValue(args, index, token, inline) {
  if (inline !== null) return { value: inline, index };
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

export function parseJamShapeRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'shape') {
    throw new Error('Expected a jam shape command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Shape arguments must be strings.');
  }
  let type = DEFAULT_JAM_SHAPE_TYPE;
  let size = { width: DEFAULT_JAM_SHAPE_WIDTH, height: DEFAULT_JAM_SHAPE_HEIGHT };
  let position = { x: null, y: null };
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal) {
      let matched = false;
      for (const [field, name] of [['type', '--type'], ['at', '--at'], ['size', '--size']]) {
        const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
        if (token !== name && inline === null) continue;
        if (seen.has(field)) throw requestError(`${name} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, name, inline);
        index = item.index;
        if (field === 'type') type = typeValue(item.value);
        else if (field === 'at') position = positionValue(item.value);
        else size = sizeValue(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('text is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return Object.freeze({
    text: textValue(positionals[0]), type,
    width: size.width, height: size.height, x: position.x, y: position.y,
  });
}

export function acceptsJamShapeArgv(args) {
  try { parseJamShapeRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Shape request must be an object.');
  }
  const allowed = ['text', 'type', 'size', 'at', 'width', 'height', 'x', 'y'];
  if (Object.keys(request).some((key) => !allowed.includes(key))) {
    throw requestError('request contains an unknown field');
  }
  if (request.size !== undefined && (request.width !== undefined || request.height !== undefined)) {
    throw requestError('use either size or width/height, not both');
  }
  let size;
  if (request.size !== undefined) size = sizeValue(request.size);
  else size = {
    width: dimensionValue(request.width ?? DEFAULT_JAM_SHAPE_WIDTH, 'width'),
    height: dimensionValue(request.height ?? DEFAULT_JAM_SHAPE_HEIGHT, 'height'),
  };
  let position;
  if (request.at !== undefined && (request.x !== undefined || request.y !== undefined)) {
    throw requestError('use either at or x/y, not both');
  }
  if (request.at !== undefined) position = positionValue(request.at);
  else if (request.x === undefined && request.y === undefined) position = { x: null, y: null };
  else if (request.x === null && request.y === null) position = { x: null, y: null };
  else if (request.x === undefined || request.y === undefined
    || request.x === null || request.y === null) {
    throw requestError('x and y must be provided together');
  } else position = { x: coordinateValue(request.x, 'x'), y: coordinateValue(request.y, 'y') };
  return { text: textValue(request.text), type: typeValue(request.type), ...size, ...position };
}

export function jamShapeArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'jam', 'shape',
    ...(input.type === DEFAULT_JAM_SHAPE_TYPE ? [] : [`--type=${input.type}`]),
    ...(input.width === DEFAULT_JAM_SHAPE_WIDTH && input.height === DEFAULT_JAM_SHAPE_HEIGHT
      ? [] : [`--size=${input.width},${input.height}`]),
    ...(input.x === null ? [] : [`--at=${input.x},${input.y}`]),
    '--', input.text,
  ];
  parseJamShapeRequest(args);
  return args;
}
