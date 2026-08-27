// Closed request Interface for `var create`.

import {
  normalizeVariableDescription,
  normalizeVariableHidden,
  normalizeVariableScopes,
  normalizeVariableValue,
  parseVariableType,
} from '../lib/variable-management.js';

export const MAX_VARIABLE_CREATE_NAME_CODE_UNITS = 512;
export const MAX_VARIABLE_CREATE_COLLECTION_CODE_UNITS = 1024;
export const MAX_VARIABLE_CREATE_STRING_VALUE_CODE_UNITS = 16_384;
const UNSAFE_IDENTITY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid var create command: ${message}.`);
}

function identityValue(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > maximum) throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_IDENTITY_CONTROLS.test(value)) {
    throw requestError(`${label} contains unsupported control characters`);
  }
  return value;
}

function typeValue(value) {
  try { return parseVariableType(value); }
  catch (error) { throw requestError(error.message); }
}

function initialValue(value, type) {
  if (value === undefined) return undefined;
  try {
    const normalized = normalizeVariableValue(value, type);
    if (type === 'STRING' && normalized.length > MAX_VARIABLE_CREATE_STRING_VALUE_CODE_UNITS) {
      throw new Error(`STRING value must be at most ${MAX_VARIABLE_CREATE_STRING_VALUE_CODE_UNITS} code units`);
    }
    return normalized;
  } catch (error) {
    throw requestError(error.message);
  }
}

function valueLiteral(value, type) {
  if (type === 'STRING') return value;
  if (type === 'BOOLEAN' || type === 'FLOAT' || type === 'TIMING') return String(value);
  if (type === 'EASING') return JSON.stringify(value);
  const channel = (number) => Math.round(number * 255).toString(16).padStart(2, '0');
  return `#${channel(value.r)}${channel(value.g)}${channel(value.b)}${value.a === undefined ? '' : channel(value.a)}`;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || !['var', 'variables'].includes(args[0]) || args[1] !== 'create') {
    throw new Error('Expected a var create command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Create arguments must be strings.');
  }
  let collection;
  let type;
  let rawValue;
  let description;
  let hidden;
  let scopes;
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
    const options = [
      { key: 'collection', aliases: ['--collection', '-c'] },
      { key: 'type', aliases: ['--type', '-t'] },
      { key: 'value', aliases: ['--value', '-v'] },
      { key: 'description', aliases: ['--description', '-d'] },
      { key: 'hidden', aliases: ['--hidden'] },
      { key: 'scopes', aliases: ['--scopes'] },
    ];
    let matched = null;
    for (const option of options) {
      for (const alias of option.aliases) {
        if (token === alias) matched = { option, inline: undefined };
        else if (alias.startsWith('--') && token.startsWith(`${alias}=`)) {
          matched = { option, inline: token.slice(alias.length + 1) };
        } else if (/^-[^-]$/.test(alias) && token.startsWith(alias) && token.length > 2) {
          matched = { option, inline: token.slice(alias.length) };
        }
        if (matched) break;
      }
      if (matched) break;
    }
    if (matched && !literal) {
      const key = matched.option.key;
      if (seen.has(key)) throw requestError(`--${key} may be provided only once`);
      seen.add(key);
      const optionValue = matched.inline === undefined ? args[++index] : matched.inline;
      if (optionValue === undefined
        || (optionValue === '' && !['description', 'scopes'].includes(key))) {
        throw requestError(`--${key} requires a value`);
      }
      if (key === 'collection') collection = optionValue;
      else if (key === 'type') type = optionValue;
      else if (key === 'value') rawValue = optionValue;
      else if (key === 'description') description = optionValue;
      else if (key === 'hidden') hidden = optionValue;
      else scopes = optionValue;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('name is required');
  if (positionals.length > 1) throw requestError('only one name is accepted');
  if (collection === undefined) throw requestError('--collection is required');
  if (type === undefined) throw requestError('--type is required');
  const normalizedType = typeValue(type);
  const request = {
    name: identityValue(positionals[0], 'name', MAX_VARIABLE_CREATE_NAME_CODE_UNITS),
    collection: identityValue(collection, 'collection', MAX_VARIABLE_CREATE_COLLECTION_CODE_UNITS),
    type: normalizedType,
    value: initialValue(rawValue, normalizedType),
    allowDuplicate,
  };
  try {
    if (description !== undefined) request.description = normalizeVariableDescription(description);
    if (hidden !== undefined) request.hidden = normalizeVariableHidden(hidden);
    if (scopes !== undefined) request.scopes = normalizeVariableScopes(scopes, normalizedType);
  } catch (error) { throw requestError(error.message); }
  return request;
}

export function parseVariableCreateRequest(args) {
  return parsedRequest(args);
}

export function acceptsVariableCreateArgv(args) {
  try { parseVariableCreateRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Create request must be an object.');
  }
  const type = typeValue(request.type);
  const input = {
    name: identityValue(request.name, 'name', MAX_VARIABLE_CREATE_NAME_CODE_UNITS),
    collection: identityValue(request.collection, 'collection', MAX_VARIABLE_CREATE_COLLECTION_CODE_UNITS),
    type,
    value: initialValue(request.value, type),
    allowDuplicate: request.allowDuplicate === true,
  };
  try {
    if (request.description !== undefined) {
      input.description = normalizeVariableDescription(request.description);
    }
    if (request.hidden !== undefined) input.hidden = normalizeVariableHidden(request.hidden);
    if (request.scopes !== undefined) input.scopes = normalizeVariableScopes(request.scopes, type);
  } catch (error) { throw requestError(error.message); }
  return input;
}

export function variableCreateArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'var', 'create', '--collection', input.collection, '--type', input.type,
    ...(input.value === undefined ? [] : ['--value', valueLiteral(input.value, input.type)]),
    ...(input.description === undefined ? [] : ['--description', input.description]),
    ...(input.hidden === undefined ? [] : ['--hidden', String(input.hidden)]),
    ...(input.scopes === undefined ? [] : ['--scopes', input.scopes.join(',')]),
    ...(input.allowDuplicate ? ['--allow-duplicate'] : []),
    '--', input.name,
  ];
}

export const variableCreatePlanningArgvFromRequest = variableCreateArgvFromRequest;
