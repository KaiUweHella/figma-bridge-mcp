// Closed request Interface and versioned cursor for `style consumers`.

export const DEFAULT_STYLE_CONSUMER_LIMIT = 100;
export const MAX_STYLE_CONSUMER_LIMIT = 500;
export const MAX_STYLE_CONSUMER_QUERY_CODE_UNITS = 512;
export const MAX_STYLE_CONSUMER_CURSOR_CODE_UNITS = 4096;
const MAX_STYLE_CONSUMER_LABEL_CODE_UNITS = 1024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const INHERITED_STYLE_FIELDS = new Set([
  'fillStyleId', 'strokeStyleId', 'backgroundStyleId', 'textStyleId',
  'effectStyleId', 'gridStyleId',
]);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid style consumers command: ${message}.`);
}

function queryValue(value) {
  if (typeof value !== 'string' || value.length === 0) throw requestError('style is required');
  if (value.length > MAX_STYLE_CONSUMER_QUERY_CODE_UNITS) {
    throw requestError(`style exceeds ${MAX_STYLE_CONSUMER_QUERY_CODE_UNITS} code units`);
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

function limitValue(value, option = '--limit') {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw requestError(`${option} must be an integer from 1 to ${MAX_STYLE_CONSUMER_LIMIT}`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_STYLE_CONSUMER_LIMIT) {
    throw requestError(`${option} must be an integer from 1 to ${MAX_STYLE_CONSUMER_LIMIT}`);
  }
  return limit;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validAnchor(value) {
  return exactKeys(value, ['nodeId', 'fields'])
    && typeof value.nodeId === 'string' && value.nodeId.length > 0
    && value.nodeId.length <= MAX_STYLE_CONSUMER_LABEL_CODE_UNITS
    && Array.isArray(value.fields) && value.fields.length > 0
    && value.fields.length <= INHERITED_STYLE_FIELDS.size
    && value.fields.every((field) => INHERITED_STYLE_FIELDS.has(field))
    && new Set(value.fields).size === value.fields.length
    && value.fields.every((field, index) => index === 0 || value.fields[index - 1] < field);
}

function cursorScope(query, type) {
  return { query: queryValue(query), type: type == null ? null : typeValue(type) };
}

export function encodeStyleConsumerCursor(query, type, anchor) {
  const scope = cursorScope(query, type);
  if (!validAnchor(anchor)) throw requestError('cursor anchor is invalid');
  return Buffer.from(JSON.stringify({ v: 1, scope, after: anchor })).toString('base64url');
}

export function decodeStyleConsumerCursor(value, query, type) {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_STYLE_CONSUMER_CURSOR_CODE_UNITS || !BASE64URL.test(value)) {
    throw requestError('cursor is malformed or too long');
  }
  let parsed;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('non-canonical');
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw requestError('cursor is malformed or too long');
  }
  const scope = cursorScope(query, type);
  if (!exactKeys(parsed, ['v', 'scope', 'after']) || parsed.v !== 1
    || !exactKeys(parsed.scope, ['query', 'type'])
    || parsed.scope.query !== scope.query || parsed.scope.type !== scope.type
    || !validAnchor(parsed.after)) {
    throw requestError('cursor does not match this Style Consumer scope');
  }
  return Object.freeze({ value, after: Object.freeze({
    nodeId: parsed.after.nodeId,
    fields: Object.freeze([...parsed.after.fields]),
  }) });
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || args[1] !== 'consumers') {
    throw new Error('Expected a style consumers command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Style Consumer arguments must be strings.');
  }
  const positionals = [];
  let type = null;
  let limit = DEFAULT_STYLE_CONSUMER_LIMIT;
  let cursor = null;
  let literal = false;
  const seen = new Set();
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const long = !literal ? token.match(/^(--type|--limit|--cursor)=(.*)$/s) : null;
    const shortType = !literal ? token.match(/^-t(.+)$/s) : null;
    const option = long?.[1] || (shortType ? '-t' : token);
    if (!literal && ['-t', '--type', '--limit', '--cursor'].includes(option)) {
      const canonical = option === '-t' ? '--type' : option;
      if (seen.has(canonical)) throw requestError(`${canonical} may be provided only once`);
      seen.add(canonical);
      const inlineValue = long?.[2] ?? shortType?.[1];
      const value = inlineValue === undefined ? args[++index] : inlineValue;
      if (typeof value !== 'string' || value.length === 0
        || (inlineValue === undefined && value.startsWith('-'))) {
        throw requestError(`${option} requires a value`);
      }
      if (canonical === '--type') type = typeValue(value, option);
      else if (canonical === '--limit') limit = limitValue(value, option);
      else cursor = value;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('style is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  const query = queryValue(positionals[0]);
  const decodedCursor = cursor === null ? null : decodeStyleConsumerCursor(cursor, query, type);
  return { query, type, limit, cursor: decodedCursor };
}

export function parseStyleConsumerRequest(args) {
  const input = parsedRequest(args);
  return {
    style: input.query,
    type: input.type,
    limit: input.limit,
    cursor: input.cursor?.value || null,
    after: input.cursor?.after || null,
  };
}

export function acceptsStyleConsumerArgv(args) {
  try { parseStyleConsumerRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Style Consumer request must be an object.');
  }
  const query = queryValue(request.style);
  const type = request.type == null ? null : typeValue(request.type);
  const limit = request.limit == null
    ? DEFAULT_STYLE_CONSUMER_LIMIT : limitValue(String(request.limit));
  const cursor = request.cursor == null
    ? null : decodeStyleConsumerCursor(request.cursor, query, type);
  return { query, type, limit, cursor };
}

export function styleConsumerArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'style', 'consumers',
    ...(input.type ? ['--type', input.type] : []),
    '--limit', String(input.limit),
    ...(input.cursor ? ['--cursor', input.cursor.value] : []),
    '--', input.query,
  ];
}

export function styleConsumerPlanningArgvFromRequest(request) {
  return styleConsumerArgvFromRequest(request);
}
