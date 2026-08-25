// Closed request Interface for `style publish-status`.

export const MAX_STYLE_PUBLISH_STATUS_QUERY_CODE_UNITS = 512;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);

function requestError(message) {
  return new Error(`Invalid style publish-status command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string') throw requestError('style must be a string');
  if (value.length === 0) throw requestError('style is required');
  if (value.length > MAX_STYLE_PUBLISH_STATUS_QUERY_CODE_UNITS) {
    throw requestError(`style exceeds ${MAX_STYLE_PUBLISH_STATUS_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError('style contains unsafe control characters');
  }
  return value;
}

function typeValue(value, option = '--type') {
  if (typeof value !== 'string' || value.length === 0) {
    throw requestError(`${option} requires a value`);
  }
  const type = value.toUpperCase();
  if (!STYLE_TYPES.has(type)) {
    throw requestError(`${option} must be PAINT, TEXT, EFFECT, or GRID`);
  }
  return type;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || args[1] !== 'publish-status') {
    throw new Error('Expected a style publish-status command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Style Publish Status arguments must be strings.');
  }

  const positionals = [];
  let type = null;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-t' || token === '--type')) {
      if (type !== null) throw requestError('--type may be provided only once');
      if (typeof args[index + 1] !== 'string' || args[index + 1].startsWith('-')) {
        throw requestError(`${token} requires a value`);
      }
      type = typeValue(args[++index], token);
      continue;
    }
    if (!literal) {
      const long = token.match(/^--type=(.*)$/s);
      const short = token.match(/^-t(.+)$/s);
      if (long || short) {
        if (type !== null) throw requestError('--type may be provided only once');
        type = typeValue((long || short)[1], long ? '--type' : '-t');
        continue;
      }
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('style is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { style: queryValue(positionals[0]), type };
}

export function parseStylePublishStatusRequest(args) {
  return parsedRequest(args);
}

export function acceptsStylePublishStatusArgv(args) {
  try {
    parseStylePublishStatusRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Style Publish Status request must be an object.');
  }
  return {
    style: queryValue(request.style),
    type: request.type == null ? null : typeValue(request.type),
  };
}

export function stylePublishStatusArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'style',
    'publish-status',
    ...(input.type ? ['--type', input.type] : []),
    '--',
    input.style,
  ];
}

export function stylePublishStatusPlanningArgvFromRequest(request) {
  return stylePublishStatusArgvFromRequest(request);
}
