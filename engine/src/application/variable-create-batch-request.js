// Closed request Interface for `var create-batch`.

import {
  normalizeVariableDescription,
  normalizeVariableHidden,
  normalizeVariableScopes,
  normalizeVariableValue,
  parseVariableType,
} from '../lib/variable-management.js';

export const MAX_VARIABLE_CREATE_BATCH_ITEMS = 256;
export const MAX_VARIABLE_CREATE_BATCH_JSON_CODE_UNITS = 262_144;
export const MAX_VARIABLE_CREATE_BATCH_NAME_CODE_UNITS = 512;
export const MAX_VARIABLE_CREATE_BATCH_QUERY_CODE_UNITS = 1024;
export const MAX_VARIABLE_CREATE_BATCH_STRING_VALUE_CODE_UNITS = 16_384;
const UNSAFE_IDENTITY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid var create-batch command: ${message}.`);
}

function boundedIdentity(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > maximum) throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_IDENTITY_CONTROLS.test(value)) {
    throw requestError(`${label} contains unsupported control characters`);
  }
  return value;
}

function normalizedItem(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw requestError(`item ${index + 1} must be an object`);
  }
  const allowed = new Set([
    'name', 'type', 'value', 'alias', 'aliasCollection',
    'description', 'hidden', 'scopes',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw requestError(`item ${index + 1} contains unknown fields: ${unknown.join(', ')}`);
  }
  const name = boundedIdentity(value.name, `item ${index + 1} name`,
    MAX_VARIABLE_CREATE_BATCH_NAME_CODE_UNITS);
  let type;
  try { type = parseVariableType(value.type === undefined ? 'COLOR' : value.type); }
  catch (error) { throw requestError(`item ${index + 1}: ${error.message}`); }
  const hasValue = Object.hasOwn(value, 'value');
  const hasAlias = Object.hasOwn(value, 'alias');
  if (hasValue && hasAlias) {
    throw requestError(`item ${index + 1} must not contain both value and alias`);
  }
  if (Object.hasOwn(value, 'aliasCollection') && !hasAlias) {
    throw requestError(`item ${index + 1} aliasCollection requires alias`);
  }
  let initialValue;
  if (hasValue) {
    try { initialValue = normalizeVariableValue(value.value, type); }
    catch (error) { throw requestError(`item ${index + 1}: ${error.message}`); }
    if (type === 'STRING'
      && initialValue.length > MAX_VARIABLE_CREATE_BATCH_STRING_VALUE_CODE_UNITS) {
      throw requestError(`item ${index + 1}: STRING value must be at most ${MAX_VARIABLE_CREATE_BATCH_STRING_VALUE_CODE_UNITS} code units`);
    }
  }
  const alias = hasAlias ? boundedIdentity(value.alias, `item ${index + 1} alias`,
    MAX_VARIABLE_CREATE_BATCH_QUERY_CODE_UNITS) : undefined;
  const aliasCollection = Object.hasOwn(value, 'aliasCollection')
    ? boundedIdentity(value.aliasCollection, `item ${index + 1} aliasCollection`,
      MAX_VARIABLE_CREATE_BATCH_QUERY_CODE_UNITS) : undefined;
  let description;
  let hidden;
  let scopes;
  try {
    if (Object.hasOwn(value, 'description')) {
      description = normalizeVariableDescription(value.description);
    }
    if (Object.hasOwn(value, 'hidden')) hidden = normalizeVariableHidden(value.hidden);
    if (Object.hasOwn(value, 'scopes')) {
      scopes = normalizeVariableScopes(value.scopes, type);
    }
  } catch (error) { throw requestError(`item ${index + 1}: ${error.message}`); }
  return {
    name,
    type,
    ...(initialValue === undefined ? {} : { value: initialValue }),
    ...(alias === undefined ? {} : { alias }),
    ...(aliasCollection === undefined ? {} : { aliasCollection }),
    ...(description === undefined ? {} : { description }),
    ...(hidden === undefined ? {} : { hidden }),
    ...(scopes === undefined ? {} : { scopes }),
  };
}

function normalizedItems(value, allowDuplicate) {
  if (!Array.isArray(value) || value.length < 1) {
    throw requestError('JSON must be a non-empty array');
  }
  if (value.length > MAX_VARIABLE_CREATE_BATCH_ITEMS) {
    throw requestError(`at most ${MAX_VARIABLE_CREATE_BATCH_ITEMS} items are accepted`);
  }
  const items = value.map(normalizedItem);
  if (!allowDuplicate && new Set(items.map((item) => item.name)).size !== items.length) {
    throw requestError('duplicate names in one batch require --allow-duplicate');
  }
  return items;
}

function parseJson(value) {
  if (typeof value !== 'string') throw requestError('JSON must be text');
  if (value.length > MAX_VARIABLE_CREATE_BATCH_JSON_CODE_UNITS) {
    throw requestError(`JSON must be at most ${MAX_VARIABLE_CREATE_BATCH_JSON_CODE_UNITS} code units`);
  }
  try { return JSON.parse(value); }
  catch { throw requestError('JSON must be valid'); }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || !['var', 'variables'].includes(args[0])
    || args[1] !== 'create-batch') throw new Error('Expected a var create-batch command.');
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Batch Creation arguments must be strings.');
  }
  let collection;
  let mode = null;
  let allowDuplicate = false;
  let literal = false;
  const positionals = [];
  const seen = new Set();
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
      ['collection', '--collection', '-c'], ['mode', '--mode', '-m'],
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
      else mode = optionValue;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (collection === undefined) throw requestError('--collection is required');
  if (positionals.length < 1) throw requestError('JSON is required');
  if (positionals.length > 1) throw requestError('only one JSON value is accepted');
  const normalizedCollection = boundedIdentity(collection, 'collection',
    MAX_VARIABLE_CREATE_BATCH_QUERY_CODE_UNITS);
  const normalizedMode = mode === null ? null : boundedIdentity(mode, 'mode',
    MAX_VARIABLE_CREATE_BATCH_QUERY_CODE_UNITS);
  return {
    items: normalizedItems(parseJson(positionals[0]), allowDuplicate),
    collection: normalizedCollection,
    mode: normalizedMode,
    allowDuplicate,
  };
}

export function parseVariableCreateBatchRequest(args) {
  return parsedRequest(args);
}

export function acceptsVariableCreateBatchArgv(args) {
  try { parseVariableCreateBatchRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Batch Creation request must be an object.');
  }
  const allowDuplicate = request.allowDuplicate === true;
  return {
    items: normalizedItems(request.items, allowDuplicate),
    collection: boundedIdentity(request.collection, 'collection',
      MAX_VARIABLE_CREATE_BATCH_QUERY_CODE_UNITS),
    mode: request.mode == null ? null : boundedIdentity(request.mode, 'mode',
      MAX_VARIABLE_CREATE_BATCH_QUERY_CODE_UNITS),
    allowDuplicate,
  };
}

export function variableCreateBatchArgvFromRequest(request) {
  const input = typedRequest(request);
  const json = JSON.stringify(input.items);
  if (json.length > MAX_VARIABLE_CREATE_BATCH_JSON_CODE_UNITS) {
    throw requestError(`JSON must be at most ${MAX_VARIABLE_CREATE_BATCH_JSON_CODE_UNITS} code units`);
  }
  return [
    'var', 'create-batch', `--collection=${input.collection}`,
    ...(input.mode === null ? [] : [`--mode=${input.mode}`]),
    ...(input.allowDuplicate ? ['--allow-duplicate'] : []),
    '--', json,
  ];
}

export const variableCreateBatchPlanningArgvFromRequest = variableCreateBatchArgvFromRequest;
