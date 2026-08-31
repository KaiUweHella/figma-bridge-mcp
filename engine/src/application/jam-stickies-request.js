// Closed request Interface for `jam stickies`.

import { finiteNodeCoordinate } from './node-coordinate.js';
import { STICKY_COLORS } from '../lib/jam-colors.js';

export const DEFAULT_JAM_STICKIES_COLUMNS = 4;
export const MAX_JAM_STICKIES_ITEMS = 256;
export const MAX_JAM_STICKIES_SOURCE_CODE_UNITS = 300_000;
export const MAX_JAM_STICKIES_TEXT_CODE_UNITS = 100_000;
export const MAX_JAM_STICKIES_COLOR_CODE_UNITS = 512;

function requestError(message) {
  return new Error(`Invalid Jam Stickies command: ${message}.`);
}

function colorValue(value) {
  if (!value) return null;
  const source = String(value);
  if (source.length > MAX_JAM_STICKIES_COLOR_CODE_UNITS) {
    throw requestError(`color must be at most ${MAX_JAM_STICKIES_COLOR_CODE_UNITS} code units`);
  }
  const resolved = STICKY_COLORS[source.toLowerCase()] || source;
  const match = /^#?([0-9a-f]{6})$/i.exec(resolved);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function textValue(value, index) {
  const text = typeof value === 'string' ? value : String(value);
  if (text.length > MAX_JAM_STICKIES_TEXT_CODE_UNITS) {
    throw requestError(`item ${index + 1} text must be at most ${MAX_JAM_STICKIES_TEXT_CODE_UNITS} code units`);
  }
  return text;
}

function normalizedItems(value, globalColor = null) {
  if (!Array.isArray(value) || value.length === 0) throw requestError('Nothing to add');
  if (value.length > MAX_JAM_STICKIES_ITEMS) {
    throw requestError(`at most ${MAX_JAM_STICKIES_ITEMS} items are accepted`);
  }
  const items = value.map((item, index) => Object.freeze(typeof item === 'string'
    ? { text: textValue(item, index), color: colorValue(globalColor) }
    : {
      text: textValue(item?.text ?? '', index),
      color: colorValue(item?.color || globalColor),
    }));
  if (JSON.stringify(items).length > MAX_JAM_STICKIES_SOURCE_CODE_UNITS) {
    throw requestError(`normalized items must be at most ${MAX_JAM_STICKIES_SOURCE_CODE_UNITS} code units`);
  }
  return Object.freeze(items);
}

function sourceItems(value, globalColor) {
  if (typeof value !== 'string') throw requestError('items must be text');
  if (value.length > MAX_JAM_STICKIES_SOURCE_CODE_UNITS) {
    throw requestError(`items must be at most ${MAX_JAM_STICKIES_SOURCE_CODE_UNITS} code units`);
  }
  const trimmed = value.trim();
  let parsed;
  if (trimmed.startsWith('[')) {
    try { parsed = JSON.parse(trimmed); }
    catch { throw requestError('items is not valid JSON'); }
  } else {
    parsed = trimmed.split(/[\n;]/).map((item) => item.trim()).filter(Boolean);
  }
  return normalizedItems(Array.isArray(parsed) ? parsed : [], globalColor);
}

function columnsValue(value) {
  if (value === undefined || value === null) return DEFAULT_JAM_STICKIES_COLUMNS;
  const parsed = parseInt(String(value), 10);
  const legacy = Math.max(1, parsed || DEFAULT_JAM_STICKIES_COLUMNS);
  return Math.min(legacy, MAX_JAM_STICKIES_ITEMS);
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

export function parseJamStickiesRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'stickies') {
    throw new Error('Expected a jam stickies command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Stickies arguments must be strings.');
  }
  let globalColor = null;
  let columns = DEFAULT_JAM_STICKIES_COLUMNS;
  let position = { x: null, y: null };
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal) {
      let matched = false;
      for (const [field, name] of [
        ['color', '--color'], ['at', '--at'], ['columns', '--columns'],
      ]) {
        const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
        if (token !== name && inline === null) continue;
        if (seen.has(field)) throw requestError(`${name} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, name, inline);
        index = item.index;
        if (field === 'color') globalColor = item.value;
        else if (field === 'at') position = positionValue(item.value);
        else columns = columnsValue(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('items is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return Object.freeze({
    items: sourceItems(positionals[0], globalColor), columns,
    x: position.x, y: position.y,
  });
}

export function acceptsJamStickiesArgv(args) {
  try { parseJamStickiesRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Stickies request must be an object.');
  }
  const allowed = ['source', 'items', 'color', 'at', 'x', 'y', 'columns'];
  if (Object.keys(request).some((key) => !allowed.includes(key))) {
    throw requestError('request contains an unknown field');
  }
  if (request.source !== undefined && request.items !== undefined) {
    throw requestError('use either source or items, not both');
  }
  const items = request.source !== undefined
    ? sourceItems(request.source, request.color)
    : normalizedItems(request.items, request.color);
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
  return { items, columns: columnsValue(request.columns), ...position };
}

export function jamStickiesArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'jam', 'stickies',
    ...(input.columns === DEFAULT_JAM_STICKIES_COLUMNS ? [] : [`--columns=${input.columns}`]),
    ...(input.x === null ? [] : [`--at=${input.x},${input.y}`]),
    '--', JSON.stringify(input.items),
  ];
  parseJamStickiesRequest(args);
  return args;
}
