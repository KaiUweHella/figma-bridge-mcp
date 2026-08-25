// Closed request Interface for `col create`.

export const MAX_COLLECTION_CREATE_NAME_CODE_UNITS = 512;
const UNSAFE_NAME_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid col create command: ${message}.`);
}

function nameValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('name is required');
  if (value.length > MAX_COLLECTION_CREATE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_COLLECTION_CREATE_NAME_CODE_UNITS} code units`);
  }
  if (UNSAFE_NAME_CONTROLS.test(value)) {
    throw requestError('name contains unsupported control characters');
  }
  return value;
}

export function parseCollectionCreateRequest(args) {
  if (!Array.isArray(args) || !['col', 'collections'].includes(args[0]) || args[1] !== 'create') {
    throw new Error('Expected a col create command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Collection Create arguments must be strings.');
  }
  const positionals = [];
  let allowDuplicate = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token === '--allow-duplicate') {
      if (allowDuplicate) throw requestError('--allow-duplicate may be provided only once');
      allowDuplicate = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('name is required');
  if (positionals.length > 1) throw requestError('only one name is accepted');
  return { name: nameValue(positionals[0]), allowDuplicate };
}

export function acceptsCollectionCreateArgv(args) {
  try {
    parseCollectionCreateRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Collection Create request must be an object.');
  }
  return { name: nameValue(request.name), allowDuplicate: request.allowDuplicate === true };
}

export function collectionCreateArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'col', 'create',
    ...(input.allowDuplicate ? ['--allow-duplicate'] : []),
    '--', input.name,
  ];
}

export const collectionCreatePlanningArgvFromRequest = collectionCreateArgvFromRequest;
