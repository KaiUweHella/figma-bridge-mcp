// Closed request Interface for `col update`.

export const MAX_COLLECTION_UPDATE_QUERY_CODE_UNITS = 512;
export const MAX_COLLECTION_UPDATE_NAME_CODE_UNITS = 1024;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid col update command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('collection is required');
  if (value.length > MAX_COLLECTION_UPDATE_QUERY_CODE_UNITS) {
    throw requestError(`collection must be at most ${MAX_COLLECTION_UPDATE_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(value)) {
    throw requestError('collection contains unsupported control characters');
  }
  return value;
}

function nameValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('name is required');
  const name = value.trim();
  if (name.length > MAX_COLLECTION_UPDATE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_COLLECTION_UPDATE_NAME_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(name)) {
    throw requestError('name contains unsupported control characters');
  }
  return name;
}

function hiddenValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' || !/^(true|false)$/i.test(value)) {
    throw requestError('hidden must be true or false');
  }
  return value.toLowerCase() === 'true';
}

export function parseCollectionUpdateRequest(args) {
  if (!Array.isArray(args) || !['col', 'collections'].includes(args[0])
    || args[1] !== 'update') throw new Error('Expected a col update command.');
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Collection Update arguments must be strings.');
  }
  const definitions = [['name', '--name', '-n'], ['hidden', '--hidden', null]];
  const values = {};
  const seen = new Set();
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    let matched = false;
    if (!literal) {
      for (const [field, long, short] of definitions) {
        const longInline = token.startsWith(`${long}=`) ? token.slice(long.length + 1) : null;
        const shortInline = short && token.startsWith(short) && token !== short
          ? token.slice(short.length) : null;
        if (token !== long && token !== short && longInline === null && shortInline === null) continue;
        if (seen.has(field)) throw requestError(`${long} may be provided only once`);
        seen.add(field);
        const inline = longInline ?? shortInline ?? undefined;
        const optionValue = inline === undefined ? args[++index] : inline;
        if (optionValue === undefined) throw requestError(`${long} requires a value`);
        values[field] = optionValue;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) throw requestError('exactly one collection is required');
  if (seen.size === 0) throw requestError('provide --name or --hidden');
  return {
    collection: queryValue(positionals[0]),
    name: seen.has('name') ? nameValue(values.name) : undefined,
    hidden: seen.has('hidden') ? hiddenValue(values.hidden) : undefined,
  };
}

export function acceptsCollectionUpdateArgv(args) {
  try { parseCollectionUpdateRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Collection Update request must be an object.');
  }
  const hasName = request.name !== undefined;
  const hasHidden = request.hidden !== undefined;
  if (!hasName && !hasHidden) throw requestError('provide --name or --hidden');
  return {
    collection: queryValue(request.collection),
    name: hasName ? nameValue(request.name) : undefined,
    hidden: hasHidden ? hiddenValue(request.hidden) : undefined,
  };
}

export function collectionUpdateArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'col', 'update',
    ...(input.name === undefined ? [] : ['--name', input.name]),
    ...(input.hidden === undefined ? [] : ['--hidden', String(input.hidden)]),
    '--', input.collection,
  ];
}

export const collectionUpdatePlanningArgvFromRequest = collectionUpdateArgvFromRequest;
