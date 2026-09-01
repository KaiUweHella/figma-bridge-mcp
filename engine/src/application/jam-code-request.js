// Closed request Interface for `jam code`.

import { finiteNodeCoordinate } from './node-coordinate.js';

export const DEFAULT_JAM_CODE_LANGUAGE = 'TYPESCRIPT';
export const MAX_JAM_CODE_SOURCE_CODE_UNITS = 300_000;
export const MAX_JAM_CODE_LANGUAGE_CODE_UNITS = 64;
const UNSAFE_LANGUAGE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;

function requestError(message) {
  return new Error(`Invalid Jam Code command: ${message}.`);
}

function sourceValue(value) {
  if (typeof value !== 'string' || value.length > MAX_JAM_CODE_SOURCE_CODE_UNITS) {
    throw requestError(`source must be a string of at most ${MAX_JAM_CODE_SOURCE_CODE_UNITS} code units`);
  }
  return value;
}

function languageValue(value) {
  const language = String(value ?? DEFAULT_JAM_CODE_LANGUAGE).toUpperCase();
  if (language.length > MAX_JAM_CODE_LANGUAGE_CODE_UNITS
    || UNSAFE_LANGUAGE_CONTROLS.test(language)) {
    throw requestError(`language must contain at most ${MAX_JAM_CODE_LANGUAGE_CODE_UNITS} safe code units`);
  }
  return language;
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

export function parseJamCodeRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'code') {
    throw new Error('Expected a jam code command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Code arguments must be strings.');
  }
  let language = DEFAULT_JAM_CODE_LANGUAGE;
  let position = { x: null, y: null };
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal) {
      let matched = false;
      for (const [field, option] of [['lang', '--lang'], ['at', '--at']]) {
        const inline = token.startsWith(`${option}=`) ? token.slice(option.length + 1) : null;
        if (token !== option && inline === null) continue;
        if (seen.has(field)) throw requestError(`${option} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, option, inline);
        index = item.index;
        if (field === 'lang') language = languageValue(item.value);
        else position = positionValue(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('source is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return Object.freeze({
    source: sourceValue(positionals[0]), language, x: position.x, y: position.y,
  });
}

export function acceptsJamCodeArgv(args) {
  try { parseJamCodeRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Code request must be an object.');
  }
  const allowed = ['source', 'language', 'lang', 'at', 'x', 'y'];
  if (Object.keys(request).some((key) => !allowed.includes(key))) {
    throw requestError('request contains an unknown field');
  }
  if (request.language !== undefined && request.lang !== undefined) {
    throw requestError('use either language or lang, not both');
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
  return {
    source: sourceValue(request.source),
    language: languageValue(request.language ?? request.lang),
    ...position,
  };
}

export function jamCodeArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'jam', 'code',
    ...(input.language === DEFAULT_JAM_CODE_LANGUAGE ? [] : [`--lang=${input.language}`]),
    ...(input.x === null ? [] : [`--at=${input.x},${input.y}`]),
    '--', input.source,
  ];
  parseJamCodeRequest(args);
  return args;
}
