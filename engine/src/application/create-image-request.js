// Closed request Interface for host-materialized remote image creation.

export const MAX_CREATE_IMAGE_URL_CODE_UNITS = 8_192;
export const MAX_CREATE_IMAGE_NAME_CODE_UNITS = 1_024;
export const MAX_CREATE_IMAGE_DIMENSION = 1_000_000;
export const MAX_CREATE_IMAGE_COORDINATE = 100_000_000;

const VALUE_OPTIONS = Object.freeze(new Map([
  ['-w', '--width'], ['--width', '--width'],
  ['-h', '--height'], ['--height', '--height'],
  ['-x', '--x'], ['--x', '--x'], ['-y', '--y'], ['--y', '--y'],
  ['-n', '--name'], ['--name', '--name'],
  ['--spacing', '--spacing'],
]));

function requestError(message) {
  return new Error(`Invalid create image command: ${message}.`);
}

function finiteNumber(value, label, { fallback = null, min, max, optional = false }) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof candidate === 'string'
    && !/^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(candidate)) {
    throw requestError(`${label} must be a finite number`);
  }
  const number = Number(candidate);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw requestError(`${label} must be between ${min} and ${max}`);
  }
  return Object.is(number, -0) ? 0 : number;
}

function boundedName(value) {
  if (value === undefined || value === null) return 'Image';
  if (typeof value !== 'string' || !value.length || value.length > MAX_CREATE_IMAGE_NAME_CODE_UNITS
    || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(value)) {
    throw requestError('name must be bounded non-control text');
  }
  return value;
}

function remoteUrl(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_CREATE_IMAGE_URL_CODE_UNITS) {
    throw requestError('url must be a bounded HTTP(S) URL');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw requestError('url must be a bounded HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw requestError('url must be a credential-free HTTP(S) URL without a fragment');
  }
  return parsed.href;
}

function optionToken(token) {
  if (VALUE_OPTIONS.has(token)) return { name: VALUE_OPTIONS.get(token), inline: null };
  for (const [alias, name] of VALUE_OPTIONS) {
    if (alias.startsWith('--') && token.startsWith(`${alias}=`)) {
      return { name, inline: token.slice(alias.length + 1) };
    }
    if (alias.length === 2 && alias.startsWith('-') && !alias.startsWith('--')
      && token.startsWith(alias) && token.length > 2) {
      const value = token.slice(2);
      return { name, inline: value.startsWith('=') ? value.slice(1) : value };
    }
  }
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('create image arguments must be strings.');
  }
  if (args[0] !== 'create' || args[1] !== 'image') {
    throw new Error('Expected a create image command.');
  }
  const positionals = [];
  const options = new Map();
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const option = optionToken(token);
      if (!option) throw requestError(`unknown option ${token}`);
      if (options.has(option.name)) throw requestError(`${option.name} may be provided only once`);
      let value = option.inline;
      if (value === null) {
        value = args[index + 1];
        if (value === undefined || value === '--' || optionToken(value)) {
          throw requestError(`${option.name} requires a value`);
        }
        index++;
      }
      if (!value.length) throw requestError(`${option.name} requires a value`);
      options.set(option.name, value);
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'url is required');
  }
  return Object.freeze({
    url: remoteUrl(positionals[0]),
    width: finiteNumber(options.get('--width'), 'width', {
      min: Number.MIN_VALUE, max: MAX_CREATE_IMAGE_DIMENSION, optional: true,
    }),
    height: finiteNumber(options.get('--height'), 'height', {
      min: Number.MIN_VALUE, max: MAX_CREATE_IMAGE_DIMENSION, optional: true,
    }),
    x: finiteNumber(options.get('--x'), 'x', {
      min: -MAX_CREATE_IMAGE_COORDINATE, max: MAX_CREATE_IMAGE_COORDINATE, optional: true,
    }),
    y: finiteNumber(options.get('--y'), 'y', {
      fallback: 0, min: -MAX_CREATE_IMAGE_COORDINATE, max: MAX_CREATE_IMAGE_COORDINATE,
    }),
    name: boundedName(options.get('--name')),
    spacing: finiteNumber(options.get('--spacing'), 'spacing', {
      fallback: 100, min: 0, max: MAX_CREATE_IMAGE_COORDINATE,
    }),
  });
}

export function parseCreateImageRequest(args) { return parsedRequest(args); }
export function acceptsCreateImageArgv(args) {
  try { parsedRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('create image request must be an object.');
  }
  return Object.freeze({
    url: remoteUrl(request.url),
    width: finiteNumber(request.width, 'width', {
      min: Number.MIN_VALUE, max: MAX_CREATE_IMAGE_DIMENSION, optional: true,
    }),
    height: finiteNumber(request.height, 'height', {
      min: Number.MIN_VALUE, max: MAX_CREATE_IMAGE_DIMENSION, optional: true,
    }),
    x: finiteNumber(request.x, 'x', {
      min: -MAX_CREATE_IMAGE_COORDINATE, max: MAX_CREATE_IMAGE_COORDINATE, optional: true,
    }),
    y: finiteNumber(request.y, 'y', {
      fallback: 0, min: -MAX_CREATE_IMAGE_COORDINATE, max: MAX_CREATE_IMAGE_COORDINATE,
    }),
    name: boundedName(request.name),
    spacing: finiteNumber(request.spacing, 'spacing', {
      fallback: 100, min: 0, max: MAX_CREATE_IMAGE_COORDINATE,
    }),
  });
}

export function createImageArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['create', 'image', input.url];
  if (input.width !== null) args.push(`--width=${input.width}`);
  if (input.height !== null) args.push(`--height=${input.height}`);
  if (input.x !== null) args.push(`--x=${input.x}`);
  if (input.y !== 0) args.push(`--y=${input.y}`);
  if (input.name !== 'Image') args.push(`--name=${input.name}`);
  if (input.spacing !== 100) args.push(`--spacing=${input.spacing}`);
  parseCreateImageRequest(args);
  return args;
}
