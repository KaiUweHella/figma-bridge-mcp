// Closed request Interface for `var set-value`.

export const MAX_VARIABLE_SET_VALUE_QUERY_CODE_UNITS = 512;
export const MAX_VARIABLE_SET_VALUE_LITERAL_CODE_UNITS = 65_536;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid var set-value command: ${message}.`);
}

function queryValue(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${field} is required`);
  if (value.length > MAX_VARIABLE_SET_VALUE_QUERY_CODE_UNITS) {
    throw requestError(`${field} must be at most ${MAX_VARIABLE_SET_VALUE_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError(`${field} contains unsupported control characters`);
  }
  return value;
}

function literalValue(value) {
  if (typeof value !== 'string') throw requestError('value must be text');
  if (value.length > MAX_VARIABLE_SET_VALUE_LITERAL_CODE_UNITS) {
    throw requestError(`value must be at most ${MAX_VARIABLE_SET_VALUE_LITERAL_CODE_UNITS} code units`);
  }
  return value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || !['var', 'variables'].includes(args[0])
    || args[1] !== 'set-value') throw new Error('Expected a var set-value command.');
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Set Value arguments must be strings.');
  }
  const values = {};
  const seen = new Set();
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const definitions = [
      ['mode', '--mode', '-m'], ['collection', '--collection', '-c'], ['alias', '--alias', null],
    ];
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
        if (optionValue === undefined || optionValue === '') {
          throw requestError(`${long} requires a value`);
        }
        values[field] = optionValue;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (!seen.has('mode')) throw requestError('--mode is required');
  if (positionals.length === 0) throw requestError('variable is required');
  const hasAlias = seen.has('alias');
  if (hasAlias && positionals.length > 1) {
    throw requestError('provide either a literal value or --alias, not both');
  }
  if (!hasAlias && positionals.length < 2) throw requestError('provide a value or --alias');
  if (positionals.length > 2) throw requestError('only one variable and value are accepted');
  return {
    variable: queryValue(positionals[0], 'variable'),
    collection: seen.has('collection') ? queryValue(values.collection, 'collection') : null,
    mode: queryValue(values.mode, 'mode'),
    value: hasAlias ? null : literalValue(positionals[1]),
    alias: hasAlias ? queryValue(values.alias, 'alias') : null,
  };
}

export function parseVariableSetValueRequest(args) {
  return parsedRequest(args);
}

export function acceptsVariableSetValueArgv(args) {
  try { parseVariableSetValueRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Set Value request must be an object.');
  }
  const hasValue = request.value !== undefined && request.value !== null;
  const hasAlias = request.alias !== undefined && request.alias !== null;
  if (hasValue === hasAlias) throw requestError('provide either a literal value or --alias');
  return {
    variable: queryValue(request.variable, 'variable'),
    collection: request.collection == null ? null : queryValue(request.collection, 'collection'),
    mode: queryValue(request.mode, 'mode'),
    value: hasValue ? literalValue(request.value) : null,
    alias: hasAlias ? queryValue(request.alias, 'alias') : null,
  };
}

export function variableSetValueArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'var', 'set-value', '--mode', input.mode,
    ...(input.collection === null ? [] : ['--collection', input.collection]),
    ...(input.alias === null ? [] : ['--alias', input.alias]),
    '--', input.variable,
    ...(input.value === null ? [] : [input.value]),
  ];
}

export const variableSetValuePlanningArgvFromRequest = variableSetValueArgvFromRequest;
