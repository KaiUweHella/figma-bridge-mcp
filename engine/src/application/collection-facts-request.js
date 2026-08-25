// Closed request Interface for `col show`.

export const MAX_COLLECTION_FACTS_QUERY_CODE_UNITS = 512;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function requestError(message) {
  return new Error(`Invalid col show command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('collection is required');
  if (value.length > MAX_COLLECTION_FACTS_QUERY_CODE_UNITS) {
    throw requestError(`collection must be at most ${MAX_COLLECTION_FACTS_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError('collection contains unsupported control characters');
  }
  return value;
}

export function parseCollectionFactsRequest(args) {
  if (!Array.isArray(args) || !['col', 'collections'].includes(args[0]) || args[1] !== 'show') {
    throw new Error('Expected a col show command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Collection Facts arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('collection is required');
  if (positionals.length > 1) throw requestError('only one collection is accepted');
  return { collection: queryValue(positionals[0]) };
}

export function acceptsCollectionFactsArgv(args) {
  try {
    parseCollectionFactsRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Collection Facts request must be an object.');
  }
  return { collection: queryValue(request.collection) };
}

export function collectionFactsArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['col', 'show', ...(input.collection.startsWith('-') ? ['--'] : []), input.collection];
}
