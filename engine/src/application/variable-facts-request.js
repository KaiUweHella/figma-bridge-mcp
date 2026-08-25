// Closed request Interface for `var show`.

export const MAX_VARIABLE_FACTS_QUERY_CODE_UNITS = 512;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function requestError(message) {
  return new Error(`Invalid var show command: ${message}.`);
}

function queryValue(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw requestError(`${field} is required`);
  }
  if (value.length > MAX_VARIABLE_FACTS_QUERY_CODE_UNITS) {
    throw requestError(`${field} must be at most ${MAX_VARIABLE_FACTS_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError(`${field} contains unsupported control characters`);
  }
  // Figma permits names that are distinct only by surrounding spaces. The
  // request validates emptiness but preserves the exact identifier as data.
  return value;
}

function parsedVariableFactsRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'var' || args[1] !== 'show') {
    throw new Error('Expected a var show command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Facts arguments must be strings.');
  }

  const positionals = [];
  let collection = null;
  let collectionSeen = false;
  let literal = false;
  const assignCollection = (value, option, { inline = false } = {}) => {
    if (collectionSeen) throw requestError('--collection may be provided only once');
    if (typeof value !== 'string' || !value.length || (!inline && value.startsWith('-'))) {
      throw requestError(`${option} requires a value`);
    }
    collection = queryValue(value, 'collection');
    collectionSeen = true;
  };

  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-c' || token === '--collection')) {
      assignCollection(args[index + 1], token);
      index++;
      continue;
    }
    if (!literal) {
      const long = token.match(/^--collection=(.*)$/s);
      if (long) {
        assignCollection(long[1], '--collection', { inline: true });
        continue;
      }
      const short = token.match(/^-c(?:=)?(.+)$/s);
      if (short) {
        assignCollection(short[1], '-c', { inline: true });
        continue;
      }
      if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }

  if (positionals.length === 0) throw requestError('variable is required');
  if (positionals.length > 1) throw requestError('only one variable is accepted');
  return {
    variable: queryValue(positionals[0], 'variable'),
    collection,
  };
}

export function parseVariableFactsRequest(args) {
  return parsedVariableFactsRequest(args);
}

export function acceptsVariableFactsArgv(args) {
  try {
    parseVariableFactsRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Facts request must be an object.');
  }
  return {
    variable: queryValue(request.variable, 'variable'),
    collection: request.collection == null ? null : queryValue(request.collection, 'collection'),
  };
}

export function variableFactsArgvFromRequest(request) {
  const input = typedRequest(request);
  const collectionArgs = input.collection === null ? [] : (
    input.collection.startsWith('-')
      ? [`--collection=${input.collection}`]
      : ['--collection', input.collection]
  );
  if (input.variable.startsWith('-')) {
    return ['var', 'show', ...collectionArgs, '--', input.variable];
  }
  return [
    'var', 'show', input.variable,
    ...collectionArgs,
  ];
}
