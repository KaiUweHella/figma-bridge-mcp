// Closed request Interface for exact `var delete`.

export const MAX_VARIABLE_DELETE_TARGETS = 256;
export const MAX_VARIABLE_DELETE_QUERY_CODE_UNITS = 512;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid var delete command: ${message}.`);
}

function boundedValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > MAX_VARIABLE_DELETE_QUERY_CODE_UNITS) {
    throw requestError(`${label} must be at most ${MAX_VARIABLE_DELETE_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(value)) throw requestError(`${label} contains unsupported control characters`);
  return value;
}

function namesValue(value) {
  if (!Array.isArray(value) || value.length < 1) throw requestError('at least one exact name or id is required');
  if (value.length > MAX_VARIABLE_DELETE_TARGETS) {
    throw requestError(`at most ${MAX_VARIABLE_DELETE_TARGETS} names or ids are accepted`);
  }
  const names = value.map((item) => boundedValue(item, 'name or id'));
  if (new Set(names).size !== names.length) throw requestError('duplicate names or ids are not accepted');
  return names;
}

export function parseVariableDeleteRequest(args) {
  if (!Array.isArray(args) || !['var', 'variables'].includes(args[0]) || args[1] !== 'delete') {
    throw new Error('Expected a var delete command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Deletion arguments must be strings.');
  }
  const names = [];
  let collection = null;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '-c' || token === '--collection')) {
      if (collection !== null) throw requestError('--collection may be provided only once');
      const value = args[++index];
      if (value === undefined || value === '--' || value.startsWith('-')) {
        throw requestError(`${token} requires a value`);
      }
      collection = boundedValue(value, 'collection');
      continue;
    }
    if (!literal && token.startsWith('--collection=')) {
      if (collection !== null) throw requestError('--collection may be provided only once');
      collection = boundedValue(token.slice('--collection='.length), 'collection');
      continue;
    }
    if (!literal && token.startsWith('-c') && token.length > 2) {
      if (collection !== null) throw requestError('--collection may be provided only once');
      collection = boundedValue(token.slice(2), 'collection');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    names.push(token);
  }
  return { names: namesValue(names), collection };
}

export function acceptsVariableDeleteArgv(args) {
  try { parseVariableDeleteRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Deletion request must be an object.');
  }
  return {
    names: namesValue(request.names),
    collection: request.collection == null ? null : boundedValue(request.collection, 'collection'),
  };
}

export function variableDeleteArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'var', 'delete',
    ...(input.collection === null ? [] : [`--collection=${input.collection}`]),
    '--', ...input.names,
  ];
}

export const variableDeletePlanningArgvFromRequest = variableDeleteArgvFromRequest;
