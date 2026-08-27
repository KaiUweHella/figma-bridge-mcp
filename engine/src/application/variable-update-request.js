// Closed request Interface for `var update`.

import {
  MAX_VARIABLE_DESCRIPTION_CODE_UNITS,
  normalizeVariableDescription,
  normalizeVariableHidden,
  normalizeVariableScopes,
} from '../lib/variable-management.js';

export const MAX_VARIABLE_UPDATE_QUERY_CODE_UNITS = 512;
export const MAX_VARIABLE_UPDATE_NAME_CODE_UNITS = 1024;
export const MAX_VARIABLE_UPDATE_DESCRIPTION_CODE_UNITS = MAX_VARIABLE_DESCRIPTION_CODE_UNITS;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid var update command: ${message}.`);
}

function queryValue(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${field} is required`);
  if (value.length > MAX_VARIABLE_UPDATE_QUERY_CODE_UNITS) {
    throw requestError(`${field} must be at most ${MAX_VARIABLE_UPDATE_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError(`${field} contains unsupported control characters`);
  }
  return value;
}

function nameValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('name is required');
  const name = value.trim();
  if (name.length > MAX_VARIABLE_UPDATE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_VARIABLE_UPDATE_NAME_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(name)) {
    throw requestError('name contains unsupported control characters');
  }
  return name;
}

function descriptionValue(value) {
  try { return normalizeVariableDescription(value); }
  catch (error) { throw requestError(error.message); }
}

function hiddenValue(value) {
  try { return normalizeVariableHidden(value); }
  catch (error) { throw requestError(error.message); }
}

function scopesValue(value) {
  try { return normalizeVariableScopes(value); }
  catch (error) { throw requestError(error.message); }
}

export function parseVariableUpdateRequest(args) {
  if (!Array.isArray(args) || !['var', 'variables'].includes(args[0])
    || args[1] !== 'update') throw new Error('Expected a var update command.');
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Update arguments must be strings.');
  }
  const definitions = [
    ['collection', '--collection', '-c'], ['name', '--name', '-n'],
    ['description', '--description', '-d'], ['hidden', '--hidden', null],
    ['scopes', '--scopes', null],
  ];
  const values = {};
  const seen = new Set();
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    let matched = false;
    if (!literal) {
      for (const [field, long, short] of definitions) {
        const longInline = token.startsWith(`${long}=`) ? token.slice(long.length + 1) : null;
        const shortInline = short && token.startsWith(short) && token !== short
          ? token.slice(short.length) : null;
        if (token !== long && token !== short && longInline === null && shortInline === null) continue;
        if (seen.has(field)) throw requestError(`${long} may be provided only once`);
        seen.add(field);
        const inline = longInline ?? shortInline ?? undefined;
        const optionValue = inline === undefined ? args[++index] : inline;
        if (optionValue === undefined) throw requestError(`${long} requires a value`);
        values[field] = optionValue;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) throw requestError('exactly one variable is required');
  if (![...seen].some((field) => field !== 'collection')) {
    throw requestError('provide --name, --description, --hidden, or --scopes');
  }
  return {
    variable: queryValue(positionals[0], 'variable'),
    collection: seen.has('collection') ? queryValue(values.collection, 'collection') : null,
    name: seen.has('name') ? nameValue(values.name) : undefined,
    description: seen.has('description') ? descriptionValue(values.description) : undefined,
    hidden: seen.has('hidden') ? hiddenValue(values.hidden) : undefined,
    scopes: seen.has('scopes') ? scopesValue(values.scopes) : undefined,
  };
}

export function acceptsVariableUpdateArgv(args) {
  try { parseVariableUpdateRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Update request must be an object.');
  }
  const has = (field) => request[field] !== undefined;
  if (!['name', 'description', 'hidden', 'scopes'].some(has)) {
    throw requestError('provide --name, --description, --hidden, or --scopes');
  }
  return {
    variable: queryValue(request.variable, 'variable'),
    collection: request.collection == null ? null : queryValue(request.collection, 'collection'),
    name: has('name') ? nameValue(request.name) : undefined,
    description: has('description') ? descriptionValue(request.description) : undefined,
    hidden: has('hidden') ? hiddenValue(request.hidden) : undefined,
    scopes: has('scopes') ? scopesValue(request.scopes) : undefined,
  };
}

export function variableUpdateArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'var', 'update',
    ...(input.collection === null ? [] : ['--collection', input.collection]),
    ...(input.name === undefined ? [] : ['--name', input.name]),
    ...(input.description === undefined ? [] : ['--description', input.description]),
    ...(input.hidden === undefined ? [] : ['--hidden', String(input.hidden)]),
    ...(input.scopes === undefined ? [] : ['--scopes', input.scopes.join(',')]),
    '--', input.variable,
  ];
}

export const variableUpdatePlanningArgvFromRequest = variableUpdateArgvFromRequest;
