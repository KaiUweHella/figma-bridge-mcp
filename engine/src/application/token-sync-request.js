// Closed request Interface for `tokens sync`.

export const MAX_TOKEN_SYNC_PATH_CODE_UNITS = 4_096;
export const MAX_TOKEN_SYNC_COLLECTION_CODE_UNITS = 512;
const UNSAFE_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid tokens sync command: ${message}.`);
}

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value) throw requestError(`${label} is required`);
  if (value.length > maximum) throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_CONTROLS.test(value)) throw requestError(`${label} contains unsupported control characters`);
  return value;
}

function optionValue(args, index, token, names) {
  for (const name of names) {
    if (token === name) {
      const value = args[index + 1];
      if (typeof value !== 'string' || !value || value === '--' || value.startsWith('-')) {
        throw requestError(`${name} requires a value; option-looking values must use ${name}=<value>`);
      }
      return { value, consumed: 1 };
    }
    if (token.startsWith(`${name}=`)) {
      const value = token.slice(name.length + 1);
      if (!value) throw requestError(`${name} requires a value`);
      return { value, consumed: 0 };
    }
    if (name.length === 2 && token.startsWith(name) && token.length > 2) {
      const value = token.slice(2).replace(/^=/, '');
      if (!value) throw requestError(`${name} requires a value`);
      return { value, consumed: 0 };
    }
  }
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'tokens' || args[1] !== 'sync') {
    throw new Error('Expected a tokens sync command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Token Sync arguments must be strings.');
  }
  const values = {
    collection: 'Design Tokens', lockfile: null,
    apply: false, prune: false, ours: false, theirs: false,
  };
  const seen = new Set();
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const flag = new Map([
        ['--apply', 'apply'], ['--prune', 'prune'],
        ['--ours', 'ours'], ['--theirs', 'theirs'],
      ]).get(token);
      if (flag) {
        if (seen.has(flag)) throw requestError(`${token} may be provided only once`);
        seen.add(flag); values[flag] = true; continue;
      }
      const options = [
        { key: 'collection', names: ['-c', '--collection'] },
        { key: 'lockfile', names: ['--lockfile'] },
      ];
      let matched = null;
      for (const option of options) {
        const value = optionValue(args, index, token, option.names);
        if (value) { matched = { ...option, ...value }; break; }
      }
      if (!matched) throw requestError(`unknown option ${token}`);
      const publicName = matched.names.at(-1);
      if (seen.has(matched.key)) throw requestError(`${publicName} may be provided only once`);
      seen.add(matched.key); values[matched.key] = matched.value;
      index += matched.consumed;
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('file is required');
  if (positionals.length > 1) throw requestError('only one file is accepted');
  if (values.ours && values.theirs) throw requestError('--ours and --theirs are mutually exclusive');
  return Object.freeze({
    file: text(positionals[0], 'file', MAX_TOKEN_SYNC_PATH_CODE_UNITS),
    collection: text(values.collection, 'collection', MAX_TOKEN_SYNC_COLLECTION_CODE_UNITS),
    apply: values.apply,
    prune: values.prune,
    ours: values.ours,
    theirs: values.theirs,
    lockfile: values.lockfile === null ? null
      : text(values.lockfile, 'lockfile', MAX_TOKEN_SYNC_PATH_CODE_UNITS),
  });
}

export function parseTokenSyncRequest(args) { return parsedRequest(args); }

export function acceptsTokenSyncArgv(args) {
  try { parseTokenSyncRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  const keys = ['file', 'collection', 'apply', 'prune', 'ours', 'theirs', 'lockfile'];
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !keys.includes(key))) {
    throw new TypeError('Token Sync request must be a closed object.');
  }
  for (const key of ['apply', 'prune', 'ours', 'theirs']) {
    if (request[key] !== undefined && typeof request[key] !== 'boolean') {
      throw new TypeError(`Token Sync ${key} must be a boolean.`);
    }
  }
  if (typeof request.file !== 'string'
    || (request.collection !== undefined && typeof request.collection !== 'string')
    || (request.lockfile !== undefined && request.lockfile !== null
      && typeof request.lockfile !== 'string')) {
    throw new TypeError('Token Sync path and collection fields must preserve their declared types.');
  }
  return parsedRequest([
    'tokens', 'sync', `--collection=${request.collection ?? 'Design Tokens'}`,
    ...(request.apply === true ? ['--apply'] : []),
    ...(request.prune === true ? ['--prune'] : []),
    ...(request.ours === true ? ['--ours'] : []),
    ...(request.theirs === true ? ['--theirs'] : []),
    ...(request.lockfile == null ? [] : [`--lockfile=${request.lockfile}`]),
    '--', request.file,
  ]);
}

export function tokenSyncArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'tokens', 'sync', `--collection=${input.collection}`,
    ...(input.apply ? ['--apply'] : []),
    ...(input.prune ? ['--prune'] : []),
    ...(input.ours ? ['--ours'] : []),
    ...(input.theirs ? ['--theirs'] : []),
    ...(input.lockfile === null ? [] : [`--lockfile=${input.lockfile}`]),
    '--', input.file,
  ];
}

export const tokenSyncPlanningArgvFromRequest = tokenSyncArgvFromRequest;
