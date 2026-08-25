// Closed request Interface for `var visualize`.

export const MAX_VARIABLE_VISUALIZATION_QUERY_CODE_UNITS = 1024;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid var visualize command: ${message}.`);
}

function queryValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > MAX_VARIABLE_VISUALIZATION_QUERY_CODE_UNITS) {
    throw requestError(`${label} must be at most ${MAX_VARIABLE_VISUALIZATION_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(value)) throw requestError(`${label} contains unsupported control characters`);
  return value;
}

export function parseVariableVisualizationRequest(args) {
  if (!Array.isArray(args) || !['var', 'variables'].includes(args[0])
    || args[1] !== 'visualize') throw new Error('Expected a var visualize command.');
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Visualization arguments must be strings.');
  }
  let mode = null;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '-m' || token === '--mode'
      || token.startsWith('-m') || token.startsWith('--mode='))) {
      if (mode !== null) throw requestError('--mode may be provided only once');
      const inline = token.startsWith('--mode=') ? token.slice(7)
        : (token.startsWith('-m') && token !== '-m' ? token.slice(2) : undefined);
      const value = inline === undefined ? args[++index] : inline;
      if (value === undefined || value === '') throw requestError('--mode requires a value');
      mode = queryValue(value, 'mode');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError('only one Collection is accepted');
  return {
    collection: positionals.length ? queryValue(positionals[0], 'collection') : null,
    mode,
  };
}

export function acceptsVariableVisualizationArgv(args) {
  try { parseVariableVisualizationRequest(args); return true; } catch { return false; }
}

export function variableVisualizationArgvFromRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Visualization request must be an object.');
  }
  const collection = request.collection == null ? null : queryValue(request.collection, 'collection');
  const mode = request.mode == null ? null : queryValue(request.mode, 'mode');
  return [
    'var', 'visualize', ...(mode === null ? [] : [`--mode=${mode}`]),
    ...(collection === null ? [] : ['--', collection]),
  ];
}

export const variableVisualizationPlanningArgvFromRequest = variableVisualizationArgvFromRequest;
