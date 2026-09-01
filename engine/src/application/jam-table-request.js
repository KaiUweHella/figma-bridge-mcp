// Closed request Interface for `jam table`.

import { finiteNodeCoordinate } from './node-coordinate.js';

export const MAX_JAM_TABLE_ROWS = 1_000;
export const MAX_JAM_TABLE_COLUMNS = 1_000;
export const MAX_JAM_TABLE_CELLS = 50_000;
export const MAX_JAM_TABLE_CELL_TEXT_CODE_UNITS = 100_000;
export const MAX_JAM_TABLE_DATA_CODE_UNITS = 300_000;

function requestError(message) {
  return new Error(`Invalid Jam Table command: ${message}.`);
}

function dimensionValue(value, field, maximum) {
  const parsed = parseInt(String(value), 10);
  const normalized = Math.max(1, parsed || 1);
  if (!Number.isSafeInteger(normalized) || normalized > maximum) {
    throw requestError(`${field} must resolve to an integer from 1 to ${maximum}`);
  }
  return normalized;
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

function boundedJson(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw requestError('data must be JSON-serializable'); }
  if (typeof serialized !== 'string' || serialized.length > MAX_JAM_TABLE_DATA_CODE_UNITS) {
    throw requestError(`data must serialize to at most ${MAX_JAM_TABLE_DATA_CODE_UNITS} code units`);
  }
  return serialized;
}

function normalizedCell(value) {
  let text;
  try { text = String(value ?? ''); }
  catch { throw requestError('every data cell must have a string representation'); }
  if (text.length > MAX_JAM_TABLE_CELL_TEXT_CODE_UNITS) {
    throw requestError(`cell text must be at most ${MAX_JAM_TABLE_CELL_TEXT_CODE_UNITS} code units`);
  }
  return text;
}

function normalizedData(value, rows, columns) {
  if (value === undefined || value === null || value === '') return [];
  let parsed;
  if (typeof value === 'string') {
    if (value.length > MAX_JAM_TABLE_DATA_CODE_UNITS) {
      throw requestError(`data must be at most ${MAX_JAM_TABLE_DATA_CODE_UNITS} code units`);
    }
    try { parsed = JSON.parse(value); }
    catch (error) { throw requestError(`data is not valid JSON: ${error.message}`); }
  } else if (Array.isArray(value)) {
    parsed = JSON.parse(boundedJson(value));
  } else throw requestError('data must be an array of rows');
  if (!Array.isArray(parsed)) throw requestError('data must be an array of rows');
  const data = parsed.slice(0, rows).map((row) => (
    Array.isArray(row) ? row.slice(0, columns).map(normalizedCell) : []
  ));
  boundedJson(data);
  return data;
}

function optionValue(args, index, token, inline) {
  if (inline !== null) return { value: inline, index };
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

export function parseJamTableRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'table') {
    throw new Error('Expected a jam table command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Table arguments must be strings.');
  }
  let rawData;
  let position = { x: null, y: null };
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal) {
      let matched = false;
      for (const [field, name] of [['data', '--data'], ['at', '--at']]) {
        const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
        if (token !== name && inline === null) continue;
        if (seen.has(field)) throw requestError(`${name} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, name, inline);
        index = item.index;
        if (field === 'data') rawData = item.value;
        else position = positionValue(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('rows and columns are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  const rows = dimensionValue(positionals[0], 'rows', MAX_JAM_TABLE_ROWS);
  const columns = dimensionValue(positionals[1], 'columns', MAX_JAM_TABLE_COLUMNS);
  if (rows * columns > MAX_JAM_TABLE_CELLS) {
    throw requestError(`table must contain at most ${MAX_JAM_TABLE_CELLS} cells`);
  }
  return Object.freeze({
    rows, columns, data: normalizedData(rawData, rows, columns),
    x: position.x, y: position.y,
  });
}

export function acceptsJamTableArgv(args) {
  try { parseJamTableRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Table request must be an object.');
  }
  const allowed = ['rows', 'columns', 'cols', 'data', 'at', 'x', 'y'];
  if (Object.keys(request).some((key) => !allowed.includes(key))) {
    throw requestError('request contains an unknown field');
  }
  if (request.columns !== undefined && request.cols !== undefined) {
    throw requestError('use either columns or cols, not both');
  }
  if (request.rows === undefined || (request.columns === undefined && request.cols === undefined)) {
    throw requestError('rows and columns are required');
  }
  const rows = dimensionValue(request.rows, 'rows', MAX_JAM_TABLE_ROWS);
  const columns = dimensionValue(request.columns ?? request.cols, 'columns', MAX_JAM_TABLE_COLUMNS);
  if (rows * columns > MAX_JAM_TABLE_CELLS) {
    throw requestError(`table must contain at most ${MAX_JAM_TABLE_CELLS} cells`);
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
  } else position = { x: coordinateValue(request.x, 'x'), y: coordinateValue(request.y, 'y') };
  return { rows, columns, data: normalizedData(request.data, rows, columns), ...position };
}

export function jamTableArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'jam', 'table', String(input.rows), String(input.columns),
    ...(input.data.length === 0 ? [] : [`--data=${JSON.stringify(input.data)}`]),
    ...(input.x === null ? [] : [`--at=${input.x},${input.y}`]),
  ];
  parseJamTableRequest(args);
  return args;
}
