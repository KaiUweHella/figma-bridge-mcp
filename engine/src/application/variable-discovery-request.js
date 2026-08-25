// Closed request Interface for `var list` and `var find`.

export const DEFAULT_VARIABLE_DISCOVERY_LIMIT = 500;
export const MAX_VARIABLE_DISCOVERY_RESULTS = 1000;
export const MAX_VARIABLE_DISCOVERY_PATTERN_CODE_UNITS = 512;
const UNSAFE_PATTERN_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function requestError(action, message) {
  return new Error(`Invalid var ${action} command: ${message}.`);
}

function actionValue(value) {
  if (!['list', 'find'].includes(value)) throw new Error('Expected a var list or var find command.');
  return value;
}

function patternValue(value, action) {
  if (action === 'list') {
    if (value != null) throw requestError(action, 'pattern is not supported');
    return null;
  }
  if (typeof value !== 'string' || !value.length) throw requestError(action, 'pattern is required');
  if (value.length > MAX_VARIABLE_DISCOVERY_PATTERN_CODE_UNITS) {
    throw requestError(action, `pattern must be at most ${MAX_VARIABLE_DISCOVERY_PATTERN_CODE_UNITS} code units`);
  }
  if (UNSAFE_PATTERN_CONTROLS.test(value)) {
    throw requestError(action, 'pattern contains unsupported control characters');
  }
  return value;
}

function limitValue(value, action) {
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw requestError(action, `limit must be an integer between 1 and ${MAX_VARIABLE_DISCOVERY_RESULTS}`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_VARIABLE_DISCOVERY_RESULTS) {
    throw requestError(action, `limit must be an integer between 1 and ${MAX_VARIABLE_DISCOVERY_RESULTS}`);
  }
  return limit;
}

export function parseVariableDiscoveryRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'var') {
    throw new Error('Expected a var list or var find command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Discovery arguments must be strings.');
  }
  const action = actionValue(args[1]);
  const positionals = [];
  let limit = DEFAULT_VARIABLE_DISCOVERY_LIMIT;
  let limitSeen = false;
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-l' || token === '--limit')) {
      if (limitSeen) throw requestError(action, 'limit may be provided only once');
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw requestError(action, `${token} requires a limit`);
      }
      limit = limitValue(value, action);
      limitSeen = true;
      index++;
      continue;
    }
    if (!literal && (token.startsWith('-l') || token.startsWith('--limit='))) {
      if (limitSeen) throw requestError(action, 'limit may be provided only once');
      const value = token.startsWith('--limit=') ? token.slice(8) : token.replace(/^-l=?/, '');
      limit = limitValue(value, action);
      limitSeen = true;
      continue;
    }
    if (!literal && token === '--json') {
      if (json) throw requestError(action, '--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(action, `unknown option ${token}`);
    positionals.push(token);
  }
  if (action === 'list' && positionals.length) throw requestError(action, 'no positional values are accepted');
  if (action === 'find' && positionals.length === 0) throw requestError(action, 'pattern is required');
  if (action === 'find' && positionals.length > 1) throw requestError(action, 'only one pattern is accepted');
  return { action, pattern: patternValue(positionals[0] ?? null, action), limit, json };
}

export function acceptsVariableDiscoveryArgv(args) {
  try {
    parseVariableDiscoveryRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Discovery request must be an object.');
  }
  const action = actionValue(request.action);
  return {
    action,
    pattern: patternValue(request.pattern ?? null, action),
    limit: limitValue(request.limit ?? DEFAULT_VARIABLE_DISCOVERY_LIMIT, action),
    json: request.json === true,
  };
}

export function variableDiscoveryArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'var', input.action,
    '--limit', String(input.limit),
    ...(input.json ? ['--json'] : []),
    ...(input.pattern?.startsWith('-') ? ['--'] : []),
    ...(input.pattern === null ? [] : [input.pattern]),
  ];
}

export const variableDiscoveryPlanningArgvFromRequest = variableDiscoveryArgvFromRequest;
