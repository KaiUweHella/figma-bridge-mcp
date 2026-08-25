// Closed request Interface for `var code-syntax`.

export const MAX_VARIABLE_CODE_SYNTAX_QUERY_CODE_UNITS = 512;
export const MAX_VARIABLE_CODE_SYNTAX_VALUE_CODE_UNITS = 65_536;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid var code-syntax command: ${message}.`);
}

function queryValue(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${field} is required`);
  if (value.length > MAX_VARIABLE_CODE_SYNTAX_QUERY_CODE_UNITS) {
    throw requestError(`${field} must be at most ${MAX_VARIABLE_CODE_SYNTAX_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError(`${field} contains unsupported control characters`);
  }
  return value;
}

function syntaxValue(value) {
  if (typeof value !== 'string') throw requestError('value must be text');
  if (value.length > MAX_VARIABLE_CODE_SYNTAX_VALUE_CODE_UNITS) {
    throw requestError(`value must be at most ${MAX_VARIABLE_CODE_SYNTAX_VALUE_CODE_UNITS} code units`);
  }
  return value;
}

function platformValue(value) {
  const platform = { web: 'WEB', android: 'ANDROID', ios: 'iOS' }[
    queryValue(value, 'platform').toLowerCase()
  ];
  if (!platform) throw requestError('platform must be WEB, ANDROID, or iOS');
  return platform;
}

export function parseVariableCodeSyntaxRequest(args) {
  if (!Array.isArray(args) || !['var', 'variables'].includes(args[0])
    || args[1] !== 'code-syntax') throw new Error('Expected a var code-syntax command.');
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Code Syntax arguments must be strings.');
  }
  let collection = null;
  let remove = false;
  let collectionSeen = false;
  let removeSeen = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '--remove')) {
      if (removeSeen) throw requestError('--remove may be provided only once');
      removeSeen = true;
      remove = true;
      continue;
    }
    if (!literal && (token === '--collection' || token === '-c'
      || token.startsWith('--collection=') || (token.startsWith('-c') && token !== '-c'))) {
      if (collectionSeen) throw requestError('--collection may be provided only once');
      collectionSeen = true;
      const inline = token.startsWith('--collection=') ? token.slice(13)
        : token.startsWith('-c') && token !== '-c' ? token.slice(2) : undefined;
      const value = inline === undefined ? args[++index] : inline;
      if (value === undefined || value === '') throw requestError('--collection requires a value');
      collection = queryValue(value, 'collection');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('variable and platform are required');
  if (positionals.length > 3) throw requestError('only one variable, platform, and value are accepted');
  if (remove && positionals.length === 3) {
    throw requestError('value cannot be combined with --remove');
  }
  if (!remove && positionals.length < 3) throw requestError('provide a value or --remove');
  return {
    variable: queryValue(positionals[0], 'variable'),
    collection,
    platform: platformValue(positionals[1]),
    value: remove ? null : syntaxValue(positionals[2]),
    remove,
  };
}

export function acceptsVariableCodeSyntaxArgv(args) {
  try { parseVariableCodeSyntaxRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Code Syntax request must be an object.');
  }
  if (typeof request.remove !== 'boolean' && request.remove !== undefined) {
    throw requestError('remove must be boolean');
  }
  const remove = request.remove === true;
  const hasValue = request.value !== undefined && request.value !== null;
  if (remove === hasValue) throw requestError('provide exactly one value or --remove');
  return {
    variable: queryValue(request.variable, 'variable'),
    collection: request.collection == null ? null : queryValue(request.collection, 'collection'),
    platform: platformValue(request.platform),
    value: remove ? null : syntaxValue(request.value),
    remove,
  };
}

export function variableCodeSyntaxArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'var', 'code-syntax',
    ...(input.collection === null ? [] : ['--collection', input.collection]),
    ...(input.remove ? ['--remove'] : []), '--', input.variable, input.platform,
    ...(input.value === null ? [] : [input.value]),
  ];
}

export const variableCodeSyntaxPlanningArgvFromRequest = variableCodeSyntaxArgvFromRequest;
