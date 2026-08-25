// Closed request Interface for `col extend`.

export const MAX_COLLECTION_EXTEND_QUERY_CODE_UNITS = 512;
export const MAX_COLLECTION_EXTEND_NAME_CODE_UNITS = 512;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid col extend command: ${message}.`);
}

function boundedValue(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > maximum) throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_CONTROLS.test(value)) throw requestError(`${label} contains unsupported control characters`);
  return value;
}

function collectionValue(value) {
  return boundedValue(value, 'collection or published key', MAX_COLLECTION_EXTEND_QUERY_CODE_UNITS);
}

function nameValue(value) {
  return boundedValue(value, 'name', MAX_COLLECTION_EXTEND_NAME_CODE_UNITS);
}

export function parseCollectionExtendRequest(args) {
  if (!Array.isArray(args) || !['col', 'collections'].includes(args[0]) || args[1] !== 'extend') {
    throw new Error('Expected a col extend command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Collection Extension arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('collection or published key is required');
  if (positionals.length < 2) throw requestError('name is required');
  if (positionals.length > 2) throw requestError('only one collection or key and one name are accepted');
  return { collection: collectionValue(positionals[0]), name: nameValue(positionals[1]) };
}

export function acceptsCollectionExtendArgv(args) {
  try { parseCollectionExtendRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Collection Extension request must be an object.');
  }
  return { collection: collectionValue(request.collection), name: nameValue(request.name) };
}

export function collectionExtendArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['col', 'extend', '--', input.collection, input.name];
}

export const collectionExtendPlanningArgvFromRequest = collectionExtendArgvFromRequest;
