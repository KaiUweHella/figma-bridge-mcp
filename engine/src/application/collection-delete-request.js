// Closed request Interface for `col delete`.

export const MAX_COLLECTION_DELETE_QUERY_CODE_UNITS = 512;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid col delete command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('collection is required');
  if (value.length > MAX_COLLECTION_DELETE_QUERY_CODE_UNITS) {
    throw requestError(`collection must be at most ${MAX_COLLECTION_DELETE_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError('collection contains unsupported control characters');
  }
  return value;
}

export function parseCollectionDeleteRequest(args) {
  if (!Array.isArray(args) || !['col', 'collections'].includes(args[0])
    || args[1] !== 'delete') throw new Error('Expected a col delete command.');
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Collection Delete arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  let onlyIfEmpty = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--only-if-empty') {
      if (onlyIfEmpty) throw requestError('duplicate option --only-if-empty');
      onlyIfEmpty = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) throw requestError('exactly one collection is required');
  return { collection: queryValue(positionals[0]), onlyIfEmpty };
}

export function acceptsCollectionDeleteArgv(args) {
  try { parseCollectionDeleteRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Collection Delete request must be an object.');
  }
  if (request.onlyIfEmpty !== undefined && typeof request.onlyIfEmpty !== 'boolean') {
    throw new TypeError('Collection Delete onlyIfEmpty must be a boolean.');
  }
  return {
    collection: queryValue(request.collection),
    onlyIfEmpty: request.onlyIfEmpty === true,
  };
}

export function collectionDeleteArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'col', 'delete',
    ...(input.onlyIfEmpty ? ['--only-if-empty'] : []),
    '--', input.collection,
  ];
}

export const collectionDeletePlanningArgvFromRequest = collectionDeleteArgvFromRequest;
