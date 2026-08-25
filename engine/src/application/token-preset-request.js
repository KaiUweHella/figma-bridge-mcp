// Closed request Interface for neutral `tokens spacing|radii` presets.

export const TOKEN_PRESETS = Object.freeze(['spacing', 'radii']);
export const MAX_TOKEN_PRESET_COLLECTION_CODE_UNITS = 512;
const UNSAFE_IDENTITY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid tokens preset command: ${message}.`);
}

function collectionName(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('collection name is required');
  if (value.length > MAX_TOKEN_PRESET_COLLECTION_CODE_UNITS) {
    throw requestError(`collection name must be at most ${MAX_TOKEN_PRESET_COLLECTION_CODE_UNITS} code units`);
  }
  if (UNSAFE_IDENTITY_CONTROLS.test(value)) {
    throw requestError('collection name contains unsupported control characters');
  }
  return value;
}

function defaultCollection(preset) {
  return preset === 'spacing' ? 'Spacing' : 'Radii';
}

export function parseTokenPresetRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'tokens' || !TOKEN_PRESETS.includes(args[1])) {
    throw new Error('Expected a tokens spacing or tokens radii command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Token Preset arguments must be strings.');
  }
  const preset = args[1];
  let collection = defaultCollection(preset);
  let literal = false;
  let seenCollection = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const longInline = !literal && token.startsWith('--collection=')
      ? token.slice('--collection='.length) : null;
    const shortInline = !literal && token.startsWith('-c') && token !== '-c'
      ? token.slice(2) : null;
    if (!literal && (token === '--collection' || token === '-c'
      || longInline !== null || shortInline !== null)) {
      if (seenCollection) throw requestError('--collection may be provided only once');
      seenCollection = true;
      const value = longInline ?? shortInline ?? args[++index];
      if (value === undefined || value === '') throw requestError('--collection requires a value');
      collection = value;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length) throw requestError('no positional values are accepted');
  return { preset, collection: collectionName(collection) };
}

export function acceptsTokenPresetArgv(args) {
  try { parseTokenPresetRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['preset', 'collection'].includes(key))) {
    throw new TypeError('Token Preset request must be a closed object.');
  }
  if (!TOKEN_PRESETS.includes(request.preset)) throw requestError('preset must be spacing or radii');
  return {
    preset: request.preset,
    collection: collectionName(request.collection ?? defaultCollection(request.preset)),
  };
}

export function tokenPresetArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['tokens', input.preset, `--collection=${input.collection}`];
}

export const tokenPresetPlanningArgvFromRequest = tokenPresetArgvFromRequest;
