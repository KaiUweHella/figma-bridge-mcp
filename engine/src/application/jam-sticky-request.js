// Closed request Interface for `jam sticky`.

import { finiteNodeCoordinate } from './node-coordinate.js';
import { STICKY_COLORS } from '../lib/jam-colors.js';

export const MAX_JAM_STICKY_TEXT_CODE_UNITS = 100_000;
export const MAX_JAM_STICKY_COLOR_CODE_UNITS = 512;

function requestError(message) {
  return new Error(`Invalid Jam Sticky command: ${message}.`);
}

function textValue(value) {
  if (typeof value !== 'string' || value.length > MAX_JAM_STICKY_TEXT_CODE_UNITS) {
    throw requestError(`text must be a string of at most ${MAX_JAM_STICKY_TEXT_CODE_UNITS} code units`);
  }
  return value;
}

function colorValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_JAM_STICKY_COLOR_CODE_UNITS) {
    throw requestError(`color must be a string of at most ${MAX_JAM_STICKY_COLOR_CODE_UNITS} code units`);
  }
  const source = STICKY_COLORS[value.toLowerCase()] || value;
  const match = /^#?([0-9a-f]{6})$/i.exec(source);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function coordinateValue(value, field) {
  try { return finiteNodeCoordinate(value, field); }
  catch (error) { throw requestError(error.message); }
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

export function parseJamStickyRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'sticky') {
    throw new Error('Expected a jam sticky command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Sticky arguments must be strings.');
  }
  let color = null;
  let position = { x: null, y: null };
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal) {
      const definitions = [['color', '--color'], ['at', '--at']];
      let matched = false;
      for (const [field, name] of definitions) {
        const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
        if (token !== name && inline === null) continue;
        if (seen.has(field)) throw requestError(`${name} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, name, inline);
        index = item.index;
        if (field === 'color') color = colorValue(item.value);
        else position = positionValue(item.value);
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
    text: textValue(positionals[0]), color, x: position.x, y: position.y,
  });
}

export function acceptsJamStickyArgv(args) {
  try { parseJamStickyRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Sticky request must be an object.');
  }
  if (Object.keys(request).some((key) => !['text', 'color', 'at', 'x', 'y'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
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
  } else {
    position = { x: coordinateValue(request.x, 'x'), y: coordinateValue(request.y, 'y') };
  }
  return {
    text: textValue(request.text), color: colorValue(request.color), ...position,
  };
}

export function jamStickyArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'jam', 'sticky',
    ...(input.color === null ? [] : [`--color=${input.color}`]),
    ...(input.x === null ? [] : [`--at=${input.x},${input.y}`]),
    '--', input.text,
  ];
  parseJamStickyRequest(args);
  return args;
}
