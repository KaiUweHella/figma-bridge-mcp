// Host-side Remote Storybook Policy. Network transport and address pinning are
// shared with other bounded host reads; this module owns only Storybook origin
// configuration, endpoint selection and error vocabulary.
import { isIP } from 'node:net';
import {
  BOUNDED_REMOTE_HTTP_LIMITS,
  BoundedRemoteHttpError,
  classifyRemoteAddress,
  readBoundedRemoteHttp,
} from '../lib/bounded-remote-http.js';

const DEFAULT_LOCAL_ORIGINS = Object.freeze([
  'http://localhost:6006',
  'http://127.0.0.1:6006',
  'http://[::1]:6006',
]);
const MAX_CONFIGURED_ORIGINS = 32;
const MAX_ORIGIN_CONFIG_BYTES = 8 * 1024;

export const STORYBOOK_REMOTE_LIMITS = Object.freeze({
  ...BOUNDED_REMOTE_HTTP_LIMITS,
  maxBytes: 8 * 1024 * 1024,
});

export class RemoteStorybookError extends Error {
  constructor(code, reason) {
    super(`Remote Storybook rejected: ${reason}.`);
    this.name = 'RemoteStorybookError';
    this.code = code;
    this.kind = 'remote-storybook-policy';
  }
}

function rejected(code, reason) {
  return new RemoteStorybookError(code, reason);
}

function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1) : hostname;
}

function syntacticLoopback(hostname) {
  const host = unbracket(hostname).toLowerCase();
  if (host === 'localhost') return true;
  return Boolean(isIP(host)) && classifyRemoteAddress(host) === 'loopback';
}

function parseConfiguredOrigin(value, scope) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw rejected('STORYBOOK_ORIGIN_CONFIG', 'a configured origin is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw rejected('STORYBOOK_ORIGIN_CONFIG', 'configured origins must use HTTP or HTTPS');
  }
  if (scope === 'public' && url.protocol !== 'https:') {
    throw rejected('STORYBOOK_ORIGIN_CONFIG', 'public configured origins require HTTPS');
  }
  if (url.username || url.password) {
    throw rejected('STORYBOOK_ORIGIN_CONFIG', 'configured origins cannot contain credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw rejected(
      'STORYBOOK_ORIGIN_CONFIG',
      'configured values must be exact origins without path, query, or fragment',
    );
  }
  return url.origin;
}

function originEntries(value, scope) {
  if (!value) return [];
  if (Buffer.byteLength(String(value), 'utf8') > MAX_ORIGIN_CONFIG_BYTES) {
    throw rejected('STORYBOOK_ORIGIN_CONFIG', 'configured origin policy is too large');
  }
  const entries = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_CONFIGURED_ORIGINS) {
    throw rejected(
      'STORYBOOK_ORIGIN_CONFIG',
      `configured origin policy exceeds ${MAX_CONFIGURED_ORIGINS} entries`,
    );
  }
  return entries.map((entry) => [parseConfiguredOrigin(entry, scope), scope]);
}

export function createStorybookRemotePolicy(env = process.env) {
  const origins = new Map(DEFAULT_LOCAL_ORIGINS.map((origin) => [origin, 'local']));
  for (const [origin, scope] of originEntries(env.FIGMA_BRIDGE_STORYBOOK_ORIGINS, 'public')) {
    if (!origins.has(origin)) origins.set(origin, scope);
  }
  for (const [origin, scope] of originEntries(
    env.FIGMA_BRIDGE_STORYBOOK_PRIVATE_ORIGINS,
    'private',
  )) {
    if (!origins.has(origin)) origins.set(origin, scope);
  }

  function authorize(input, { redirect = false } = {}) {
    let url;
    try {
      url = input instanceof URL ? new URL(input.href) : new URL(String(input));
    } catch {
      throw rejected('STORYBOOK_URL', 'URL is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw rejected('STORYBOOK_URL', 'URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw rejected('STORYBOOK_CREDENTIALS', 'URL credentials are not allowed');
    }
    if (!redirect && (url.search || url.hash)) {
      throw rejected('STORYBOOK_URL', 'base URL query parameters and fragments are not supported');
    }
    const scope = origins.get(url.origin);
    if (!scope) {
      if (url.protocol === 'http:' && !syntacticLoopback(url.hostname)) {
        throw rejected('STORYBOOK_HTTPS', 'non-loopback public origins require HTTPS');
      }
      throw rejected('STORYBOOK_ORIGIN', 'origin is not an approved origin');
    }
    return Object.freeze({ url, origin: url.origin, scope });
  }

  return Object.freeze({
    authorize,
    origins: Object.freeze([...origins.entries()].map(([origin, scope]) =>
      Object.freeze({ origin, scope }))),
  });
}

export function classifyStorybookAddress(address) {
  return classifyRemoteAddress(address);
}

function endpointUrl(baseUrl, filename) {
  const url = new URL(baseUrl.href);
  const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `${prefix}/${filename}`;
  url.search = '';
  url.hash = '';
  return url;
}

function remoteReason(error) {
  return String(error?.message || 'approved origin could not be read safely')
    .replace(/^Bounded remote read rejected:\s*/i, '')
    .replace(/\.$/, '');
}

export async function fetchRemoteStorybookIndex(baseUrl, options = {}) {
  const policy = createStorybookRemotePolicy(options.env || process.env);
  const base = policy.authorize(baseUrl).url;
  const read = (url) => readBoundedRemoteHttp(url, {
    lookup: options.lookup,
    request: options.request,
    requestFactory: options.requestFactory,
    createConnection: options.createConnection,
    limits: { ...STORYBOOK_REMOTE_LIMITS, ...(options.limits || {}) },
    accept: 'application/json',
    userAgent: 'figma-bridge-mcp/storybook-index',
    authorize: policy.authorize,
    isAuthorizationError: (error) => error instanceof RemoteStorybookError,
  });

  try {
    let result = await read(endpointUrl(base, 'index.json'));
    if (result.statusCode === 404) result = await read(endpointUrl(base, 'stories.json'));
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw rejected('STORYBOOK_STATUS', `approved origin returned status ${result.statusCode}`);
    }
    return result.bytes.toString('utf8');
  } catch (error) {
    if (error instanceof RemoteStorybookError) throw error;
    if (error instanceof BoundedRemoteHttpError) {
      throw rejected(`STORYBOOK_${error.code}`, remoteReason(error));
    }
    throw rejected('STORYBOOK_REMOTE', 'approved origin could not be read safely');
  }
}
