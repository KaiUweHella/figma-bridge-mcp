// Closed request Interface for top-level `import <source>`.

export const MAX_DESIGN_SOURCE_PATH_CODE_UNITS = 4_096;
export const MAX_DESIGN_SOURCE_COLLECTION_CODE_UNITS = 512;
const SOURCE_TYPES = new Set(['tailwind', 'css', 'tokens', 'storybook', 'designmd']);
const UNSAFE_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid design source import command: ${message}.`);
}

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > maximum) throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_CONTROLS.test(value)) throw requestError(`${label} contains unsupported control characters`);
  return value;
}

function optionValue(args, index, names) {
  const token = args[index];
  if (names.includes(token)) return { value: args[index + 1], consumed: 1 };
  for (const name of names.filter((candidate) => candidate.startsWith('--'))) {
    if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), consumed: 0 };
  }
  if (names.includes('-c') && token.startsWith('-c') && token !== '-c') {
    return { value: token.slice(2), consumed: 0 };
  }
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'import') {
    throw new Error('Expected a design source import command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Design Source Import arguments must be strings.');
  }
  let collection = null;
  let printContext = false;
  let save = null;
  let type = null;
  let forceSlash = false;
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--print-context') {
      if (printContext) throw requestError('--print-context may be provided only once');
      printContext = true;
      continue;
    }
    if (!literal && token === '--force-slash') {
      if (forceSlash) throw requestError('--force-slash may be provided only once');
      forceSlash = true;
      continue;
    }
    const option = !literal && optionValue(args, index,
      ['--collection', '-c', '--save', '--type']);
    if (option) {
      const name = token === '-c' || token.startsWith('-c') ? 'collection'
        : token.replace(/^--/, '').split('=')[0];
      if (seen.has(name)) throw requestError(`--${name} may be provided only once`);
      seen.add(name);
      index += option.consumed;
      if (!option.value || option.value === '--' || option.value.startsWith('-')) {
        throw requestError(`--${name} requires a value; option-looking values must use --${name}=<value>`);
      }
      if (name === 'collection') collection = text(option.value, 'collection', MAX_DESIGN_SOURCE_COLLECTION_CODE_UNITS);
      else if (name === 'save') save = text(option.value, 'save', MAX_DESIGN_SOURCE_PATH_CODE_UNITS);
      else {
        if (!SOURCE_TYPES.has(option.value)) {
          throw requestError('--type must be tailwind, css, tokens, storybook, or designmd');
        }
        type = option.value;
      }
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('source is required');
  if (positionals.length > 1) throw requestError('only one source is accepted');
  if (collection?.includes('/') && !forceSlash) {
    throw requestError('collection contains "/"; pass --force-slash intentionally because Figma Collections are flat');
  }
  if (printContext && forceSlash) {
    throw requestError('--force-slash cannot be used with --print-context');
  }
  return Object.freeze({
    source: text(positionals[0], 'source', MAX_DESIGN_SOURCE_PATH_CODE_UNITS),
    collection,
    printContext,
    save,
    type,
    forceSlash,
  });
}

export function parseDesignSourceImportRequest(args) { return parsedRequest(args); }

export function acceptsDesignSourceImportArgv(args) {
  try { parseDesignSourceImportRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => ![
      'source', 'collection', 'printContext', 'save', 'type', 'forceSlash',
    ].includes(key))) {
    throw new TypeError('Design Source Import request must be a closed object.');
  }
  if (typeof request.source !== 'string'
    || (request.collection != null && typeof request.collection !== 'string')
    || (request.printContext !== undefined && typeof request.printContext !== 'boolean')
    || (request.save != null && typeof request.save !== 'string')
    || (request.type != null && typeof request.type !== 'string')
    || (request.forceSlash !== undefined && typeof request.forceSlash !== 'boolean')) {
    throw new TypeError('Design Source Import request fields must preserve their declared types.');
  }
  return parsedRequest([
    'import',
    ...(request.collection == null ? [] : [`--collection=${request.collection}`]),
    ...(request.printContext === true ? ['--print-context'] : []),
    ...(request.save == null ? [] : [`--save=${request.save}`]),
    ...(request.type == null ? [] : [`--type=${request.type}`]),
    ...(request.forceSlash === true ? ['--force-slash'] : []),
    '--', request.source,
  ]);
}

export function designSourceImportArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'import',
    ...(input.collection == null ? [] : [`--collection=${input.collection}`]),
    ...(input.printContext ? ['--print-context'] : []),
    ...(input.save == null ? [] : [`--save=${input.save}`]),
    ...(input.type == null ? [] : [`--type=${input.type}`]),
    ...(input.forceSlash ? ['--force-slash'] : []),
    '--', input.source,
  ];
}

export const designSourceImportPlanningArgvFromRequest = designSourceImportArgvFromRequest;
