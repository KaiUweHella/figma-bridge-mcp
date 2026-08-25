// Closed request Interface for `tokens add`.

import {
  normalizeVariableValue,
  parseVariableType,
} from '../lib/variable-management.js';

export const MAX_TOKEN_ADD_NAME_CODE_UNITS = 512;
export const MAX_TOKEN_ADD_COLLECTION_CODE_UNITS = 512;
export const MAX_TOKEN_ADD_VALUE_CODE_UNITS = 16_384;
const UNSAFE_IDENTITY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid tokens add command: ${message}.`);
}

function identity(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > maximum) throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_IDENTITY_CONTROLS.test(value)) {
    throw requestError(`${label} contains unsupported control characters`);
  }
  return value;
}

function inferredType(value) {
  if (value.startsWith('#')) return 'COLOR';
  if (!Number.isNaN(Number(value))) return 'FLOAT';
  if (/^(true|false)$/i.test(value)) return 'BOOLEAN';
  return 'STRING';
}

function normalizedValue(value, type) {
  if (typeof value !== 'string') throw requestError('value must be text');
  if (value.length > MAX_TOKEN_ADD_VALUE_CODE_UNITS) {
    throw requestError(`value must be at most ${MAX_TOKEN_ADD_VALUE_CODE_UNITS} code units`);
  }
  try { return normalizeVariableValue(value, type); }
  catch (error) { throw requestError(error.message); }
}

function normalizedTypedValue(value, type) {
  if (typeof value === 'string' && value.length > MAX_TOKEN_ADD_VALUE_CODE_UNITS) {
    throw requestError(`value must be at most ${MAX_TOKEN_ADD_VALUE_CODE_UNITS} code units`);
  }
  try {
    const normalized = normalizeVariableValue(value, type);
    if (type === 'STRING' && normalized.length > MAX_TOKEN_ADD_VALUE_CODE_UNITS) {
      throw new Error(`value must be at most ${MAX_TOKEN_ADD_VALUE_CODE_UNITS} code units`);
    }
    return normalized;
  } catch (error) { throw requestError(error.message); }
}

function normalizedType(value) {
  try { return parseVariableType(value); }
  catch (error) { throw requestError(error.message); }
}

function valueLiteral(value, type) {
  if (type === 'STRING') return value;
  if (type === 'BOOLEAN' || type === 'FLOAT' || type === 'TIMING') return String(value);
  if (type === 'EASING') return JSON.stringify(value);
  const channel = (number) => Math.round(number * 255).toString(16).padStart(2, '0');
  return `#${channel(value.r)}${channel(value.g)}${channel(value.b)}${value.a === undefined ? '' : channel(value.a)}`;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'tokens' || args[1] !== 'add') {
    throw new Error('Expected a tokens add command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Token Add arguments must be strings.');
  }
  let collection = 'Tokens';
  let type = null;
  let allowDuplicate = false;
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--allow-duplicate') {
      if (allowDuplicate) throw requestError('--allow-duplicate may be provided only once');
      allowDuplicate = true;
      continue;
    }
    let matched = null;
    for (const [field, long, short] of [
      ['collection', '--collection', '-c'], ['type', '--type', '-t'],
    ]) {
      const longInline = token.startsWith(`${long}=`) ? token.slice(long.length + 1) : null;
      const shortInline = token.startsWith(short) && token !== short ? token.slice(short.length) : null;
      if (token === long || token === short || longInline !== null || shortInline !== null) {
        matched = { field, long, inline: longInline ?? shortInline ?? undefined };
        break;
      }
    }
    if (matched && !literal) {
      if (seen.has(matched.field)) throw requestError(`${matched.long} may be provided only once`);
      seen.add(matched.field);
      const optionValue = matched.inline === undefined ? args[++index] : matched.inline;
      if (optionValue === undefined || optionValue === '') {
        throw requestError(`${matched.long} requires a value`);
      }
      if (matched.field === 'collection') collection = optionValue;
      else type = optionValue;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('name is required');
  if (positionals.length < 2) throw requestError('value is required');
  if (positionals.length > 2) throw requestError('only name and value are accepted');
  const resolvedType = normalizedType(type ?? inferredType(positionals[1]));
  return {
    name: identity(positionals[0], 'name', MAX_TOKEN_ADD_NAME_CODE_UNITS),
    value: normalizedValue(positionals[1], resolvedType),
    collection: identity(collection, 'collection', MAX_TOKEN_ADD_COLLECTION_CODE_UNITS),
    type: resolvedType,
    allowDuplicate,
  };
}

export function parseTokenAddRequest(args) {
  return parsedRequest(args);
}

export function acceptsTokenAddArgv(args) {
  try { parseTokenAddRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) =>
      !['name', 'value', 'collection', 'type', 'allowDuplicate'].includes(key))) {
    throw new TypeError('Token Add request must be a closed object.');
  }
  if (request.type === undefined && typeof request.value !== 'string') {
    throw requestError('value must be text when type is inferred');
  }
  const type = normalizedType(request.type ?? inferredType(request.value));
  return {
    name: identity(request.name, 'name', MAX_TOKEN_ADD_NAME_CODE_UNITS),
    value: normalizedTypedValue(request.value, type),
    collection: identity(request.collection ?? 'Tokens', 'collection',
      MAX_TOKEN_ADD_COLLECTION_CODE_UNITS),
    type,
    allowDuplicate: request.allowDuplicate === true,
  };
}

export function tokenAddArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'tokens', 'add', `--collection=${input.collection}`, `--type=${input.type}`,
    ...(input.allowDuplicate ? ['--allow-duplicate'] : []),
    '--', input.name, valueLiteral(input.value, input.type),
  ];
}

export const tokenAddPlanningArgvFromRequest = tokenAddArgvFromRequest;
