// Closed request Interface for enabled Team Library Variable reads.

export const LIBRARY_READ_ACTIONS = Object.freeze(['collections', 'variables']);
export const LIBRARY_VARIABLE_TYPES = Object.freeze([
  'BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING',
]);
export const MAX_LIBRARY_QUERY_CODE_UNITS = 1_024;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) { return new Error(`Invalid Library Read command: ${message}.`); }
function actionValue(value) {
  if (!LIBRARY_READ_ACTIONS.includes(value)) throw requestError('action must be collections or variables');
  return value;
}
function collectionValue(value) {
  if (typeof value !== 'string') throw requestError('collection must be a string');
  const collection = value.trim();
  if (!collection.length || collection.length > MAX_LIBRARY_QUERY_CODE_UNITS) throw requestError('collection has an invalid bounded length');
  if (UNSAFE.test(collection)) throw requestError('collection contains unsafe control characters');
  return collection;
}
function typeValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const type = String(value).trim().toUpperCase();
  if (!LIBRARY_VARIABLE_TYPES.includes(type)) throw requestError(`type must be one of: ${LIBRARY_VARIABLE_TYPES.join(', ')}`);
  return type;
}
function normalizedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Library Read request must be an object.');
  const action = actionValue(request.action);
  if (action === 'collections') return { action, collection: null, type: null };
  return { action, collection: collectionValue(request.collection), type: typeValue(request.type) };
}
function parsedArgv(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new TypeError('Library Read arguments must be strings.');
  if (args[0] !== 'library' || !LIBRARY_READ_ACTIONS.includes(args[1])) throw new Error('Expected a Library Read command.');
  const action = actionValue(args[1]); const positionals = []; let type = null; let typeSeen = false; let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      if (action !== 'variables') throw requestError(`unknown option ${token}`);
      let value;
      if (token === '-t' || token === '--type') value = args[++index];
      else if (token.startsWith('--type=')) value = token.slice('--type='.length);
      else if (token.startsWith('-t') && token.length > 2) value = token.slice(2);
      else throw requestError(`unknown option ${token}`);
      if (typeSeen) throw requestError('--type may be provided only once');
      if (value === undefined || value === '--' || !value.length) throw requestError('--type requires a value');
      typeSeen = true; type = typeValue(value); continue;
    }
    positionals.push(token);
  }
  if (action === 'collections') {
    if (positionals.length) throw requestError(`unexpected argument ${positionals[0]}`);
    return normalizedRequest({ action });
  }
  if (positionals.length !== 1) throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'collection is required');
  return normalizedRequest({ action, collection: positionals[0], type });
}
function projected(input) { return { action: input.action, collection: input.collection, type: input.type }; }
function argvFrom(input) {
  if (input.action === 'collections') return ['library', 'collections'];
  return ['library', 'variables', ...(input.type ? ['--type', input.type] : []), '--', input.collection];
}

export function parseLibraryReadRequest(args) { return projected(parsedArgv(args)); }
export function acceptsLibraryReadArgv(args) { try { parsedArgv(args); return true; } catch { return false; } }
export function libraryReadArgvFromRequest(request) { const args = argvFrom(normalizedRequest(request)); parseLibraryReadRequest(args); return args; }
