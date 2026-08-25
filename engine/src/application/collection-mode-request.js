// Closed request Interface for Collection mode mutations.

export const MAX_COLLECTION_MODE_QUERY_CODE_UNITS = 512;
export const MAX_COLLECTION_MODE_NAME_CODE_UNITS = 1024;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid col mode command: ${message}.`);
}

function queryValue(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${field} is required`);
  if (value.length > MAX_COLLECTION_MODE_QUERY_CODE_UNITS) {
    throw requestError(`${field} must be at most ${MAX_COLLECTION_MODE_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(value)) {
    throw requestError(`${field} contains unsupported control characters`);
  }
  return value;
}

function nameValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('name is required');
  const name = value.trim();
  if (name.length > MAX_COLLECTION_MODE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_COLLECTION_MODE_NAME_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(name)) {
    throw requestError('name contains unsupported control characters');
  }
  return name;
}

function route(args) {
  const subcommand = args?.[1];
  if (subcommand === 'mode-add') return { action: 'add', positionals: 2 };
  if (subcommand === 'mode-rename') return { action: 'rename', positionals: 3 };
  if (subcommand === 'mode-remove') return { action: 'remove', positionals: 2 };
  return null;
}

export function parseCollectionModeRequest(args) {
  if (!Array.isArray(args) || !['col', 'collections'].includes(args[0]) || !route(args)) {
    throw new Error('Expected a col mode-add, mode-rename, or mode-remove command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Collection Mode arguments must be strings.');
  }
  const operation = route(args);
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== operation.positionals) {
    throw requestError(`${args[1]} requires exactly ${operation.positionals} values`);
  }
  return {
    action: operation.action,
    collection: queryValue(positionals[0], 'collection'),
    mode: operation.action === 'add' ? null : queryValue(positionals[1], 'mode'),
    name: operation.action === 'remove'
      ? null : nameValue(positionals[operation.action === 'add' ? 1 : 2]),
  };
}

export function acceptsCollectionModeArgv(args) {
  try { parseCollectionModeRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Collection Mode request must be an object.');
  }
  if (!['add', 'rename', 'remove'].includes(request.action)) {
    throw requestError('action must be add, rename, or remove');
  }
  return {
    action: request.action,
    collection: queryValue(request.collection, 'collection'),
    mode: request.action === 'add' ? null : queryValue(request.mode, 'mode'),
    name: request.action === 'remove' ? null : nameValue(request.name),
  };
}

export function collectionModeArgvFromRequest(request) {
  const input = typedRequest(request);
  const subcommand = `mode-${input.action}`;
  const positionals = [
    input.collection,
    ...(input.mode === null ? [] : [input.mode]),
    ...(input.name === null ? [] : [input.name]),
  ];
  return ['col', subcommand, '--', ...positionals];
}

export const collectionModePlanningArgvFromRequest = collectionModeArgvFromRequest;
