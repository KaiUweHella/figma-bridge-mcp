// Closed request Interface for `tokens overlap`.

export const DEFAULT_TOKEN_OVERLAP_LIMIT = 200;
export const MAX_TOKEN_OVERLAP_LIMIT = 1_000;
export const MAX_TOKEN_OVERLAP_COLLECTIONS = 32;
export const MAX_TOKEN_OVERLAP_QUERY_CODE_UNITS = 512;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid tokens overlap command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('Collection query is required');
  if (value.length > MAX_TOKEN_OVERLAP_QUERY_CODE_UNITS) {
    throw requestError(`Collection query must be at most ${MAX_TOKEN_OVERLAP_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(value)) throw requestError('Collection query contains unsupported controls');
  return value;
}

function limitValue(value) {
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw requestError(`limit must be an integer between 1 and ${MAX_TOKEN_OVERLAP_LIMIT}`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_TOKEN_OVERLAP_LIMIT) {
    throw requestError(`limit must be an integer between 1 and ${MAX_TOKEN_OVERLAP_LIMIT}`);
  }
  return limit;
}

function normalizedQueries(values) {
  if (!Array.isArray(values) || values.length < 2) {
    throw requestError('at least two Collection queries are required');
  }
  if (values.length > MAX_TOKEN_OVERLAP_COLLECTIONS) {
    throw requestError(`at most ${MAX_TOKEN_OVERLAP_COLLECTIONS} Collection queries are accepted`);
  }
  const queries = values.map(queryValue);
  const folded = queries.map((query) => query.toLocaleLowerCase('en-US'));
  if (new Set(folded).size !== folded.length) {
    throw requestError('duplicate Collection queries are not accepted');
  }
  return queries;
}

export function parseTokenOverlapRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'tokens' || args[1] !== 'overlap') {
    throw new Error('Expected a tokens overlap command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Token Overlap arguments must be strings.');
  }
  let limit = DEFAULT_TOKEN_OVERLAP_LIMIT;
  let limitSeen = false;
  let json = false;
  let literal = false;
  const queries = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    const long = !literal ? token.match(/^--limit=(.*)$/s) : null;
    const short = !literal ? token.match(/^-l(?:=)?(.+)$/s) : null;
    if (!literal && (token === '--limit' || token === '-l' || long || short)) {
      if (limitSeen) throw requestError('--limit may be provided only once');
      const value = (long || short)?.[1] ?? args[++index];
      if (value === undefined || value === '') throw requestError('--limit requires a value');
      limit = limitValue(value);
      limitSeen = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    queries.push(token);
  }
  return { queries: normalizedQueries(queries), limit, json };
}

export function acceptsTokenOverlapArgv(args) {
  try { parseTokenOverlapRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['queries', 'limit', 'json'].includes(key))) {
    throw new TypeError('Token Overlap request must be a closed object.');
  }
  return {
    queries: normalizedQueries(request.queries),
    limit: limitValue(request.limit ?? DEFAULT_TOKEN_OVERLAP_LIMIT),
    json: request.json === true,
  };
}

export function tokenOverlapArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['tokens', 'overlap', '--limit', String(input.limit),
    ...(input.json ? ['--json'] : []), '--', ...input.queries];
}

export const tokenOverlapPlanningArgvFromRequest = tokenOverlapArgvFromRequest;
