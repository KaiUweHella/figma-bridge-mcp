// Closed request Interface for Variable and Collection publish-status reads.

export const MAX_TOKEN_PUBLISH_STATUS_QUERY_CODE_UNITS = 512;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(kind, message) {
  return new Error(`Invalid ${kind === 'variable' ? 'var' : 'col'} publish-status command: ${message}.`);
}

function kindValue(value) {
  if (!['variable', 'collection'].includes(value)) {
    throw new Error('Expected a var or col publish-status command.');
  }
  return value;
}

function queryValue(value, kind, field) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(kind, `${field} is required`);
  if (value.length > MAX_TOKEN_PUBLISH_STATUS_QUERY_CODE_UNITS) {
    throw requestError(kind, `${field} must be at most ${MAX_TOKEN_PUBLISH_STATUS_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError(kind, `${field} contains unsupported control characters`);
  }
  return value;
}

export function parseTokenPublishStatusRequest(args) {
  if (!Array.isArray(args) || !['var', 'col', 'collections'].includes(args[0])
    || args[1] !== 'publish-status') {
    throw new Error('Expected a var or col publish-status command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Token Publish Status arguments must be strings.');
  }
  const kind = args[0] === 'var' ? 'variable' : 'collection';
  const positionals = [];
  let collection = null;
  let collectionSeen = false;
  let literal = false;
  const assignCollection = (value, option, inline = false) => {
    if (kind !== 'variable') throw requestError(kind, `${option} is not supported`);
    if (collectionSeen) throw requestError(kind, '--collection may be provided only once');
    if (typeof value !== 'string' || !value || (!inline && value.startsWith('-'))) {
      throw requestError(kind, `${option} requires a value`);
    }
    collection = queryValue(value, kind, 'collection');
    collectionSeen = true;
  };
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-c' || token === '--collection')) {
      assignCollection(args[++index], token);
      continue;
    }
    if (!literal) {
      const long = token.match(/^--collection=(.*)$/s);
      const short = token.match(/^-c(?:=)?(.+)$/s);
      if (long || short) {
        assignCollection((long || short)[1], long ? '--collection' : '-c', true);
        continue;
      }
      if (token.startsWith('-')) throw requestError(kind, `unknown option ${token}`);
    }
    positionals.push(token);
  }
  const field = kind === 'variable' ? 'variable' : 'collection';
  if (positionals.length === 0) throw requestError(kind, `${field} is required`);
  if (positionals.length > 1) throw requestError(kind, `only one ${field} is accepted`);
  return { kind, query: queryValue(positionals[0], kind, field), collection };
}

export function acceptsTokenPublishStatusArgv(args) {
  try {
    parseTokenPublishStatusRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Token Publish Status request must be an object.');
  }
  const kind = kindValue(request.kind);
  const field = kind === 'variable' ? 'variable' : 'collection';
  const collection = request.collection == null
    ? null : queryValue(request.collection, kind, 'collection');
  if (kind === 'collection' && collection !== null) {
    throw requestError(kind, 'collection scope is not supported');
  }
  return { kind, query: queryValue(request.query, kind, field), collection };
}

export function tokenPublishStatusArgvFromRequest(request) {
  const input = typedRequest(request);
  const root = input.kind === 'variable' ? 'var' : 'col';
  const collectionArgs = input.collection === null ? [] : (
    input.collection.startsWith('-')
      ? [`--collection=${input.collection}`]
      : ['--collection', input.collection]
  );
  return [root, 'publish-status', ...collectionArgs, '--', input.query];
}

export const tokenPublishStatusPlanningArgvFromRequest = tokenPublishStatusArgvFromRequest;
