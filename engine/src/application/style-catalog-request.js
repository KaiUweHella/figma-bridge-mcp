// Closed request Interface and versioned cursor for `style list`.

export const DEFAULT_STYLE_CATALOG_LIMIT = 100;
export const MAX_STYLE_CATALOG_LIMIT = 500;
export const MAX_STYLE_CATALOG_CURSOR_CODE_UNITS = 4096;
const MAX_STYLE_CATALOG_LABEL_CODE_UNITS = 1024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function requestError(message) {
  return new Error(`Invalid style list command: ${message}.`);
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

function limitValue(value, option = '--limit') {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw requestError(`${option} must be an integer from 1 to ${MAX_STYLE_CATALOG_LIMIT}`);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_STYLE_CATALOG_LIMIT) {
    throw requestError(`${option} must be an integer from 1 to ${MAX_STYLE_CATALOG_LIMIT}`);
  }
  return limit;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validAnchor(value) {
  return exactKeys(value, ['type', 'name', 'id'])
    && STYLE_TYPES.has(value.type)
    && [value.name, value.id].every((item) => typeof item === 'string'
      && item.length <= MAX_STYLE_CATALOG_LABEL_CODE_UNITS)
    && value.id.length > 0;
}

export function encodeStyleCatalogCursor(scope, anchor) {
  const normalizedScope = scope == null ? 'ALL' : typeValue(scope, 'cursor scope');
  if (!validAnchor(anchor)) throw requestError('cursor anchor is invalid');
  return Buffer.from(JSON.stringify({ v: 1, scope: normalizedScope, after: anchor }))
    .toString('base64url');
}

export function decodeStyleCatalogCursor(value, expectedScope = null) {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_STYLE_CATALOG_CURSOR_CODE_UNITS || !BASE64URL.test(value)) {
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
  const scope = expectedScope == null ? 'ALL' : typeValue(expectedScope);
  if (!exactKeys(parsed, ['v', 'scope', 'after']) || parsed.v !== 1
    || parsed.scope !== scope || !validAnchor(parsed.after)) {
    throw requestError('cursor does not match this Style Catalog scope');
  }
  return Object.freeze({
    value,
    scope,
    after: Object.freeze({ ...parsed.after }),
  });
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || args[1] !== 'list') {
    throw new Error('Expected a style list command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Style Catalog arguments must be strings.');
  }

  let type = null;
  let limit = DEFAULT_STYLE_CATALOG_LIMIT;
  let cursor = null;
  let literal = false;
  const seen = new Set();
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (literal) throw requestError(`unexpected argument ${token}`);
    const long = token.match(/^(--type|--limit|--cursor)=(.*)$/s);
    const shortType = token.match(/^-t(.+)$/s);
    const option = long?.[1] || (shortType ? '-t' : token);
    if (['-t', '--type', '--limit', '--cursor'].includes(option)) {
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
    if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    throw requestError(`unexpected argument ${token}`);
  }
  const decodedCursor = cursor === null ? null : decodeStyleCatalogCursor(cursor, type);
  return { type, limit, cursor: decodedCursor };
}

export function parseStyleCatalogRequest(args) {
  const input = parsedRequest(args);
  return {
    type: input.type,
    limit: input.limit,
    cursor: input.cursor?.value || null,
    after: input.cursor?.after || null,
  };
}

export function acceptsStyleCatalogArgv(args) {
  try {
    parseStyleCatalogRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Style Catalog request must be an object.');
  }
  const type = request.type == null ? null : typeValue(request.type);
  const limit = request.limit == null
    ? DEFAULT_STYLE_CATALOG_LIMIT
    : limitValue(String(request.limit));
  const cursor = request.cursor == null ? null : decodeStyleCatalogCursor(request.cursor, type);
  return { type, limit, cursor };
}

export function styleCatalogArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'style', 'list',
    ...(input.type ? ['--type', input.type] : []),
    '--limit', String(input.limit),
    ...(input.cursor ? ['--cursor', input.cursor.value] : []),
  ];
}

export function styleCatalogPlanningArgvFromRequest(request) {
  return styleCatalogArgvFromRequest(request);
}
