// Closed request Interface for `map storybook <urlOrPath>`.

export const MAX_STORYBOOK_MAP_SOURCE_CODE_UNITS = 4_096;
export const MAX_STORYBOOK_MAP_OUTPUT_CODE_UNITS = 16_384;
const UNSAFE_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid map storybook command: ${message}.`);
}

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} is required`);
  if (value.length > maximum) throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_CONTROLS.test(value)) throw requestError(`${label} contains unsupported control characters`);
  return value;
}

function outputOption(args, index) {
  const token = args[index];
  if (token === '-o' || token === '--output') return { value: args[index + 1], consumed: 1 };
  if (token.startsWith('--output=')) return { value: token.slice('--output='.length), consumed: 0 };
  if (token.startsWith('-o') && token !== '-o') return { value: token.slice(2), consumed: 0 };
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'map' || args[1] !== 'storybook') {
    throw new Error('Expected a map storybook command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Storybook Map arguments must be strings.');
  }
  let output = 'figma-map.json';
  let json = false;
  let currentPage = false;
  let literal = false;
  let outputSeen = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token === '--current-page') {
      if (currentPage) throw requestError('--current-page may be provided only once');
      currentPage = true;
      continue;
    }
    const option = !literal && outputOption(args, index);
    if (option) {
      if (outputSeen) throw requestError('--output may be provided only once');
      outputSeen = true;
      index += option.consumed;
      if (!option.value || option.value === '--' || option.value.startsWith('-')) {
        throw requestError('--output requires a value; option-looking values must use --output=<value>');
      }
      output = text(option.value, 'output', MAX_STORYBOOK_MAP_OUTPUT_CODE_UNITS);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('Storybook source is required');
  if (positionals.length > 1) throw requestError('only one Storybook source is accepted');
  return Object.freeze({
    source: text(positionals[0], 'Storybook source', MAX_STORYBOOK_MAP_SOURCE_CODE_UNITS),
    output: text(output, 'output', MAX_STORYBOOK_MAP_OUTPUT_CODE_UNITS),
    json,
    currentPage,
  });
}

export function parseStorybookMapRequest(args) { return parsedRequest(args); }

export function acceptsStorybookMapArgv(args) {
  try { parseStorybookMapRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['source', 'output', 'json', 'currentPage'].includes(key))) {
    throw new TypeError('Storybook Map request must be a closed object.');
  }
  if (typeof request.source !== 'string'
    || (request.output !== undefined && typeof request.output !== 'string')
    || (request.json !== undefined && typeof request.json !== 'boolean')
    || (request.currentPage !== undefined && typeof request.currentPage !== 'boolean')) {
    throw new TypeError('Storybook Map request fields must preserve their declared types.');
  }
  return parsedRequest([
    'map', 'storybook',
    ...(request.output === undefined ? [] : [`--output=${request.output}`]),
    ...(request.json === true ? ['--json'] : []),
    ...(request.currentPage === true ? ['--current-page'] : []),
    '--', request.source,
  ]);
}

export function storybookMapArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'map', 'storybook', '--output', input.output,
    ...(input.json ? ['--json'] : []),
    ...(input.currentPage ? ['--current-page'] : []),
    '--', input.source,
  ];
}

export const storybookMapPlanningArgvFromRequest = storybookMapArgvFromRequest;

export function storybookMapSourceIsRemote(source) {
  return typeof source === 'string' && /^https?:\/\//i.test(source);
}
