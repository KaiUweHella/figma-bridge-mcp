// Closed request Interface for top-level `find`.
//
// Commander and figma_run share this parser so the literal query, optional
// type filter and result bound are decided before Plugin readiness.

export const DEFAULT_NODE_DISCOVERY_LIMIT = 20;
export const MAX_NODE_DISCOVERY_RESULTS = 200;
export const MAX_NODE_DISCOVERY_QUERY_CODE_UNITS = 1024;
export const MAX_NODE_DISCOVERY_TYPE_CODE_UNITS = 64;

function requestError(message) {
  return new Error(`Invalid find command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string') throw requestError('query must be a string');
  if (value.length > MAX_NODE_DISCOVERY_QUERY_CODE_UNITS) {
    throw requestError(`query must not exceed ${MAX_NODE_DISCOVERY_QUERY_CODE_UNITS} code units`);
  }
  return value;
}

function typeValue(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length < 1
    || value.length > MAX_NODE_DISCOVERY_TYPE_CODE_UNITS
    || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw requestError('type must be a bounded Figma node type name');
  }
  return value.toUpperCase();
}

function limitValue(value) {
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw requestError(`limit must be an integer between 1 and ${MAX_NODE_DISCOVERY_RESULTS}`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_NODE_DISCOVERY_RESULTS) {
    throw requestError(`limit must be an integer between 1 and ${MAX_NODE_DISCOVERY_RESULTS}`);
  }
  return limit;
}

function inlineValue(token, shortName, longName) {
  if (token.startsWith(`${longName}=`)) return token.slice(longName.length + 1);
  if (token.startsWith(shortName) && token.length > shortName.length) {
    return token.slice(shortName.length);
  }
  return null;
}

export function parseNodeDiscoveryRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'find') {
    throw new Error('Expected a find command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Discovery arguments must be strings.');
  }

  const positionals = [];
  let type = null;
  let limit = DEFAULT_NODE_DISCOVERY_LIMIT;
  let typeSeen = false;
  let limitSeen = false;
  let literal = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-t' || token === '--type')) {
      if (typeSeen) throw requestError('type may be provided only once');
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw requestError(`${token} requires a type`);
      }
      type = typeValue(value);
      typeSeen = true;
      index++;
      continue;
    }
    if (!literal && (token.startsWith('-t') || token.startsWith('--type='))) {
      if (typeSeen) throw requestError('type may be provided only once');
      type = typeValue(inlineValue(token, '-t', '--type'));
      typeSeen = true;
      continue;
    }
    if (!literal && (token === '-l' || token === '--limit')) {
      if (limitSeen) throw requestError('limit may be provided only once');
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw requestError(`${token} requires a limit`);
      }
      limit = limitValue(value);
      limitSeen = true;
      index++;
      continue;
    }
    if (!literal && (token.startsWith('-l') || token.startsWith('--limit='))) {
      if (limitSeen) throw requestError('limit may be provided only once');
      limit = limitValue(inlineValue(token, '-l', '--limit'));
      limitSeen = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('query is required');
  if (positionals.length > 1) throw requestError('only one query is accepted');
  return { query: queryValue(positionals[0]), type, limit };
}

export function acceptsNodeDiscoveryArgv(args) {
  try {
    parseNodeDiscoveryRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node Discovery request must be an object.');
  }
  return {
    query: queryValue(request.query),
    type: typeValue(request.type),
    limit: limitValue(request.limit ?? DEFAULT_NODE_DISCOVERY_LIMIT),
  };
}

export function nodeDiscoveryArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'find',
    ...(input.type ? ['--type', input.type] : []),
    '--limit', String(input.limit),
    ...(input.query.startsWith('-') ? ['--'] : []),
    input.query,
  ];
}

export const nodeDiscoveryPlanningArgvFromRequest = nodeDiscoveryArgvFromRequest;
