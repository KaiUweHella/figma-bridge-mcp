// Closed request Interface for `style delete`.

export const MAX_STYLE_DELETE_QUERY_CODE_UNITS = 512;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);

function requestError(message) {
  return new Error(`Invalid style delete command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || value.length === 0) throw requestError('style is required');
  if (value.length > MAX_STYLE_DELETE_QUERY_CODE_UNITS) {
    throw requestError(`style exceeds ${MAX_STYLE_DELETE_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) throw requestError('style contains unsafe control characters');
  return value;
}

function typeValue(value, option = '--type') {
  if (typeof value !== 'string' || value.length === 0) throw requestError(`${option} requires a value`);
  const type = value.toUpperCase();
  if (!STYLE_TYPES.has(type)) throw requestError(`${option} must be PAINT, TEXT, EFFECT, or GRID`);
  return type;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || args[1] !== 'delete') {
    throw new Error('Expected a style delete command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Style Delete arguments must be strings.');
  }
  const positionals = [];
  let type = null;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const long = !literal ? token.match(/^--type=(.*)$/s) : null;
    const short = !literal ? token.match(/^-t(.+)$/s) : null;
    if (!literal && (token === '--type' || token === '-t' || long || short)) {
      if (type !== null) throw requestError('--type may be provided only once');
      const inline = long?.[1] ?? short?.[1];
      const value = inline === undefined ? args[++index] : inline;
      type = typeValue(value, token === '-t' || short ? '-t' : '--type');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('style is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { style: queryValue(positionals[0]), type };
}

export function parseStyleDeleteRequest(args) { return parsedRequest(args); }
export function acceptsStyleDeleteArgv(args) {
  try { parsedRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Style Delete request must be an object.');
  }
  return {
    style: queryValue(request.style),
    type: request.type == null ? null : typeValue(request.type),
  };
}

export function styleDeleteArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['style', 'delete', ...(input.type ? ['--type', input.type] : []), '--', input.style];
}

export const styleDeletePlanningArgvFromRequest = styleDeleteArgvFromRequest;
