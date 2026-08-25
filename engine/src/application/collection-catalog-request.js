// Closed request Interface for `col list`.

export const DEFAULT_COLLECTION_CATALOG_LIMIT = 500;
export const MAX_COLLECTION_CATALOG_LIMIT = 1000;

function requestError(message) {
  return new Error(`Invalid col list command: ${message}.`);
}

function limitValue(value) {
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw requestError(`limit must be an integer between 1 and ${MAX_COLLECTION_CATALOG_LIMIT}`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_COLLECTION_CATALOG_LIMIT) {
    throw requestError(`limit must be an integer between 1 and ${MAX_COLLECTION_CATALOG_LIMIT}`);
  }
  return limit;
}

export function parseCollectionCatalogRequest(args) {
  if (!Array.isArray(args) || !['col', 'collections'].includes(args[0]) || args[1] !== 'list') {
    throw new Error('Expected a col list command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Collection Catalog arguments must be strings.');
  }
  let limit = DEFAULT_COLLECTION_CATALOG_LIMIT;
  let limitSeen = false;
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (literal) throw requestError(`unexpected argument ${token}`);
    if (token === '-l' || token === '--limit') {
      if (limitSeen) throw requestError('--limit may be provided only once');
      const value = args[++index];
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw requestError(`${token} requires a limit`);
      }
      limit = limitValue(value);
      limitSeen = true;
      continue;
    }
    const long = token.match(/^--limit=(.*)$/s);
    const short = token.match(/^-l(?:=)?(.+)$/s);
    if (long || short) {
      if (limitSeen) throw requestError('--limit may be provided only once');
      limit = limitValue((long || short)[1]);
      limitSeen = true;
      continue;
    }
    if (token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    throw requestError(`unexpected argument ${token}`);
  }
  return { limit, json };
}

export function acceptsCollectionCatalogArgv(args) {
  try {
    parseCollectionCatalogRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Collection Catalog request must be an object.');
  }
  return {
    limit: limitValue(request.limit ?? DEFAULT_COLLECTION_CATALOG_LIMIT),
    json: request.json === true,
  };
}

export function collectionCatalogArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['col', 'list', '--limit', String(input.limit), ...(input.json ? ['--json'] : [])];
}

export const collectionCatalogPlanningArgvFromRequest = collectionCatalogArgvFromRequest;
