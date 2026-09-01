// Closed request Interface for `jam section`.

import { finiteNodeCoordinate } from './node-coordinate.js';

export const DEFAULT_JAM_SECTION_WIDTH = 800;
export const DEFAULT_JAM_SECTION_HEIGHT = 600;
export const MAX_JAM_SECTION_NAME_CODE_UNITS = 100_000;

function requestError(message) {
  return new Error(`Invalid Jam Section command: ${message}.`);
}

function nameValue(value) {
  if (typeof value !== 'string' || value.length > MAX_JAM_SECTION_NAME_CODE_UNITS) {
    throw requestError(`name must be a string of at most ${MAX_JAM_SECTION_NAME_CODE_UNITS} code units`);
  }
  return value;
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
    return { width: DEFAULT_JAM_SECTION_WIDTH, height: DEFAULT_JAM_SECTION_HEIGHT };
  }
  if (typeof value !== 'string') throw requestError('size must be a w,h string');
  const [rawWidth, rawHeight] = value.split(',');
  const width = parseFloat(String(rawWidth).trim());
  const height = parseFloat(String(rawHeight).trim());
  return {
    width: dimensionValue(Number.isFinite(width) ? width : DEFAULT_JAM_SECTION_WIDTH, 'width'),
    height: dimensionValue(Number.isFinite(height) ? height : DEFAULT_JAM_SECTION_HEIGHT, 'height'),
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

export function parseJamSectionRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'section') {
    throw new Error('Expected a jam section command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Section arguments must be strings.');
  }
  let size = { width: DEFAULT_JAM_SECTION_WIDTH, height: DEFAULT_JAM_SECTION_HEIGHT };
  let position = { x: null, y: null };
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal) {
      let matched = false;
      for (const [field, option] of [['at', '--at'], ['size', '--size']]) {
        const inline = token.startsWith(`${option}=`) ? token.slice(option.length + 1) : null;
        if (token !== option && inline === null) continue;
        if (seen.has(field)) throw requestError(`${option} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, option, inline);
        index = item.index;
        if (field === 'at') position = positionValue(item.value);
        else size = sizeValue(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('name is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return Object.freeze({
    name: nameValue(positionals[0]), width: size.width, height: size.height,
    x: position.x, y: position.y,
  });
}

export function acceptsJamSectionArgv(args) {
  try { parseJamSectionRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Section request must be an object.');
  }
  const allowed = ['name', 'size', 'at', 'width', 'height', 'x', 'y'];
  if (Object.keys(request).some((key) => !allowed.includes(key))) {
    throw requestError('request contains an unknown field');
  }
  if (request.size !== undefined && (request.width !== undefined || request.height !== undefined)) {
    throw requestError('use either size or width/height, not both');
  }
  let size;
  if (request.size !== undefined) size = sizeValue(request.size);
  else size = {
    width: dimensionValue(request.width ?? DEFAULT_JAM_SECTION_WIDTH, 'width'),
    height: dimensionValue(request.height ?? DEFAULT_JAM_SECTION_HEIGHT, 'height'),
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
  return { name: nameValue(request.name), ...size, ...position };
}

export function jamSectionArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'jam', 'section',
    ...(input.width === DEFAULT_JAM_SECTION_WIDTH && input.height === DEFAULT_JAM_SECTION_HEIGHT
      ? [] : [`--size=${input.width},${input.height}`]),
    ...(input.x === null ? [] : [`--at=${input.x},${input.y}`]),
    '--', input.name,
  ];
  parseJamSectionRequest(args);
  return args;
}
