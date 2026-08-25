// Closed request Interface for `tokens import`.

export const MAX_TOKEN_IMPORT_PATH_CODE_UNITS = 4_096;
export const MAX_TOKEN_IMPORT_COLLECTION_CODE_UNITS = 512;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid tokens import command: ${message}.`);
}

function identity(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > maximum) throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_CONTROLS.test(value)) throw requestError(`${label} contains unsupported control characters`);
  return value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'tokens' || args[1] !== 'import') {
    throw new Error('Expected a tokens import command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Token Import arguments must be strings.');
  }
  let collection = 'Imported Tokens';
  let forceSlash = false;
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--force-slash') {
      if (forceSlash) throw requestError('--force-slash may be provided only once');
      forceSlash = true;
      continue;
    }
    let value;
    if (!literal && (token === '--collection' || token === '-c')) value = args[++index];
    else if (!literal && token.startsWith('--collection=')) value = token.slice(13);
    else if (!literal && token.startsWith('-c') && token !== '-c') value = token.slice(2);
    if (value !== undefined) {
      if (seen.has('collection')) throw requestError('--collection may be provided only once');
      seen.add('collection');
      if (!value || value === '--' || value.startsWith('-')) {
        throw requestError('--collection requires a value; option-looking names must use --collection=<name>');
      }
      collection = value;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('file is required');
  if (positionals.length > 1) throw requestError('only one file is accepted');
  const normalizedCollection = identity(collection, 'collection', MAX_TOKEN_IMPORT_COLLECTION_CODE_UNITS);
  if (normalizedCollection.includes('/') && !forceSlash) {
    throw requestError('collection contains "/"; pass --force-slash intentionally because Figma Collections are flat');
  }
  return {
    file: identity(positionals[0], 'file', MAX_TOKEN_IMPORT_PATH_CODE_UNITS),
    collection: normalizedCollection,
    forceSlash,
  };
}

export function parseTokenImportRequest(args) { return parsedRequest(args); }

export function acceptsTokenImportArgv(args) {
  try { parseTokenImportRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['file', 'collection', 'forceSlash'].includes(key))) {
    throw new TypeError('Token Import request must be a closed object.');
  }
  return parsedRequest([
    'tokens', 'import', `--collection=${request.collection ?? 'Imported Tokens'}`,
    ...(request.forceSlash === true ? ['--force-slash'] : []), '--', request.file,
  ]);
}

export function tokenImportArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'tokens', 'import', `--collection=${input.collection}`,
    ...(input.forceSlash ? ['--force-slash'] : []), '--', input.file,
  ];
}

export const tokenImportPlanningArgvFromRequest = tokenImportArgvFromRequest;
