// Closed request Interface for `var set-value-batch`.

import {
  parseVariableSetValueRequest,
  variableSetValueArgvFromRequest,
} from './variable-set-value-request.js';

export const MAX_VARIABLE_SET_VALUE_BATCH_ITEMS = 64;
export const MAX_VARIABLE_SET_VALUE_BATCH_JSON_CODE_UNITS = 262_144;
export const VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY = 'best-effort-rollback';

const ITEM_FIELDS = ['variable', 'collection', 'mode', 'value', 'alias'];

function requestError(message) {
  return new Error(`Invalid var set-value-batch command: ${message}.`);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function literalText(value, index) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (plainObject(value)) {
    let serialized;
    try { serialized = JSON.stringify(value); } catch {}
    if (typeof serialized === 'string') return serialized;
  }
  throw requestError(`item ${index + 1} value must be text, a finite number, a boolean, or an object`);
}

function normalizedItem(value, index) {
  if (!plainObject(value)) throw requestError(`item ${index + 1} must be an object`);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !ITEM_FIELDS.includes(key));
  if (unknown.length) {
    throw requestError(`item ${index + 1} contains unknown fields: ${unknown.join(', ')}`);
  }
  for (const required of ['variable', 'mode']) {
    if (!Object.hasOwn(value, required)) {
      throw requestError(`item ${index + 1} ${required} is required`);
    }
  }
  if (Object.hasOwn(value, 'collection') && value.collection !== null
    && typeof value.collection !== 'string') {
    throw requestError(`item ${index + 1} collection must be text or null`);
  }
  const hasValue = Object.hasOwn(value, 'value') && value.value !== null;
  const hasAlias = Object.hasOwn(value, 'alias') && value.alias !== null;
  if (hasValue === hasAlias) {
    throw requestError(`item ${index + 1} must contain exactly one of value or alias`);
  }
  let normalized;
  try {
    normalized = parseVariableSetValueRequest(variableSetValueArgvFromRequest({
      variable: value.variable,
      collection: Object.hasOwn(value, 'collection') ? value.collection : null,
      mode: value.mode,
      ...(hasValue ? { value: literalText(value.value, index) } : { alias: value.alias }),
    }));
  } catch (error) {
    throw requestError(`item ${index + 1}: ${String(error?.message || error)}`);
  }
  return normalized;
}

function normalizedItems(value) {
  if (!Array.isArray(value) || value.length < 1) {
    throw requestError('JSON must be a non-empty array');
  }
  if (value.length > MAX_VARIABLE_SET_VALUE_BATCH_ITEMS) {
    throw requestError(`at most ${MAX_VARIABLE_SET_VALUE_BATCH_ITEMS} items are accepted`);
  }
  const items = value.map(normalizedItem);
  const requestedPairs = items.map((item) =>
    JSON.stringify([item.collection, item.variable, item.mode]));
  if (new Set(requestedPairs).size !== requestedPairs.length) {
    throw requestError('duplicate Variable/mode pairs are not accepted');
  }
  return items;
}

function parseJson(value) {
  if (typeof value !== 'string') throw requestError('JSON must be text');
  if (value.length > MAX_VARIABLE_SET_VALUE_BATCH_JSON_CODE_UNITS) {
    throw requestError(`JSON must be at most ${MAX_VARIABLE_SET_VALUE_BATCH_JSON_CODE_UNITS} code units`);
  }
  try { return JSON.parse(value); }
  catch { throw requestError('JSON must be valid'); }
}

export function parseVariableSetValueBatchRequest(args) {
  if (!Array.isArray(args) || !['var', 'variables'].includes(args[0])
    || args[1] !== 'set-value-batch') {
    throw new Error('Expected a var set-value-batch command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Set Value Batch arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) throw requestError('exactly one JSON value is required');
  return {
    policy: VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY,
    items: normalizedItems(parseJson(positionals[0])),
  };
}

export function acceptsVariableSetValueBatchArgv(args) {
  try { parseVariableSetValueBatchRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!plainObject(request)
    || !Object.hasOwn(request, 'items')
    || Object.keys(request).some((key) => !['items', 'policy'].includes(key))) {
    throw new TypeError('Variable Set Value Batch request must contain items and optional policy only.');
  }
  if (request.policy !== undefined
    && request.policy !== VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY) {
    throw requestError(`policy must be ${VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY}`);
  }
  return {
    policy: VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY,
    items: normalizedItems(request.items),
  };
}

export function variableSetValueBatchArgvFromRequest(request) {
  const input = typedRequest(request);
  const json = JSON.stringify(input.items);
  if (json.length > MAX_VARIABLE_SET_VALUE_BATCH_JSON_CODE_UNITS) {
    throw requestError(`JSON must be at most ${MAX_VARIABLE_SET_VALUE_BATCH_JSON_CODE_UNITS} code units`);
  }
  return ['var', 'set-value-batch', '--', json];
}

export const variableSetValueBatchPlanningArgvFromRequest = variableSetValueBatchArgvFromRequest;
