// Host-side Remote Storybook Policy.
//
// This module intentionally does not use global fetch: native HTTP(S) requests
// let it validate every resolved address, pin the connection to that address,
// preserve the approved Host/TLS identity, and re-run policy on redirects.
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_LOCAL_ORIGINS = Object.freeze(['http://localhost:6006', 'http://127.0.0.1:6006', 'http://[::1]:6006']);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_CONFIGURED_ORIGINS = 32;
const MAX_ORIGIN_CONFIG_BYTES = 8 * 1024;

export const STORYBOOK_REMOTE_LIMITS = Object.freeze({
  connectTimeoutMs: 1_500,
  headersTimeoutMs: 3_000,
  bodyTimeoutMs: 5_000,
  totalTimeoutMs: 8_000,
  maxRedirects: 3,
  maxHeaderBytes: 16 * 1024,
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
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function syntacticLoopback(hostname) {
  const host = unbracket(hostname).toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) return Number(host.split('.')[0]) === 127;
  const bytes = isIP(host) === 6 ? ipv6Bytes(host) : null;
  return bytes ? isLoopbackV6(bytes) || isMappedLoopback(bytes) : false;
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
      'configured values must be exact origins without path, query, or fragment'
    );
  }
  return url.origin;
}

function originEntries(value, scope) {
  if (!value) return [];
  if (Buffer.byteLength(String(value), 'utf8') > MAX_ORIGIN_CONFIG_BYTES) {
    throw rejected('STORYBOOK_ORIGIN_CONFIG', 'configured origin policy is too large');
  }
  const entries = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > MAX_CONFIGURED_ORIGINS) {
    throw rejected('STORYBOOK_ORIGIN_CONFIG', `configured origin policy exceeds ${MAX_CONFIGURED_ORIGINS} entries`);
  }
  return entries.map((entry) => [parseConfiguredOrigin(entry, scope), scope]);
}

export function createStorybookRemotePolicy(env = process.env) {
  const origins = new Map(DEFAULT_LOCAL_ORIGINS.map((origin) => [origin, 'local']));
  for (const [origin, scope] of originEntries(env.FIGMA_BRIDGE_STORYBOOK_ORIGINS, 'public')) {
    if (!origins.has(origin)) origins.set(origin, scope);
  }
  for (const [origin, scope] of originEntries(env.FIGMA_BRIDGE_STORYBOOK_PRIVATE_ORIGINS, 'private')) {
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
    origins: Object.freeze([...origins.entries()].map(([origin, scope]) => Object.freeze({ origin, scope }))),
  });
}

function ipv4Bytes(address) {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function ipv6Bytes(address) {
  let input = unbracket(address).toLowerCase();
  if (input.includes('%')) return null;
  const embedded = input.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const v4 = ipv4Bytes(embedded[2]);
    if (!v4) return null;
    input = `${embedded[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  if ((input.match(/::/g) || []).length > 1) return null;
  const [leftText, rightText = null] = input.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((rightText === null && missing !== 0) || missing < 0) return null;
  const groups = rightText === null ? left : [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function isLoopbackV6(bytes) {
  return bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
}

function isMappedV4(bytes) {
  return bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

function isMappedLoopback(bytes) {
  return isMappedV4(bytes) && bytes[12] === 127;
}

function classifyIpv4(bytes) {
  const [a, b, c, d] = bytes;
  if (a === 127) return 'loopback';
  if (
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51) && (b !== 51 || c === 100)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  )
    return 'forbidden';
  if (a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
    return 'private';
  return 'public';
}

export function classifyStorybookAddress(address) {
  const v4 = ipv4Bytes(address);
  if (v4) return classifyIpv4(v4);
  const v6 = ipv6Bytes(address);
  if (!v6) return 'forbidden';
  if (isMappedV4(v6)) return classifyIpv4(v6.slice(12));
  if (isLoopbackV6(v6)) return 'loopback';
  if (
    v6.every((byte) => byte === 0) ||
    v6[0] === 0xff ||
    (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) ||
    (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8)
  )
    return 'forbidden';
  if ((v6[0] & 0xfe) === 0xfc || (v6[0] === 0xfe && (v6[1] & 0xc0) === 0xc0)) return 'private';
  return 'public';
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, rejectPromise) => {
    const aborted = () => rejectPromise(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        rejectPromise(error);
      }
    );
  });
}

async function resolveApprovedTarget(approved, { lookup, signal }) {
  const hostname = unbracket(approved.url.hostname);
  const literalFamily = isIP(hostname);
  let records;
  try {
    records = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof RemoteStorybookError) throw error;
    throw rejected('STORYBOOK_DNS', 'approved origin could not be resolved');
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw rejected('STORYBOOK_DNS', 'approved origin resolved to no usable address');
  }
  const deduped = new Map();
  for (const record of records) {
    const family = Number(record?.family) || isIP(record?.address || '');
    const address = String(record?.address || '');
    if (![4, 6].includes(family) || isIP(address) !== family) {
      throw rejected('STORYBOOK_DNS', 'approved origin returned an invalid address');
    }
    const classification = classifyStorybookAddress(address);
    const permitted =
      approved.scope === 'local'
        ? classification === 'loopback'
        : approved.scope === 'public'
          ? classification === 'public'
          : classification === 'private' || classification === 'loopback';
    if (!permitted) {
      throw rejected('STORYBOOK_NETWORK_RANGE', 'resolved destination network range is not approved');
    }
    deduped.set(`${family}:${address}`, Object.freeze({ address, family }));
  }
  return Object.freeze([...deduped.values()]);
}

function requestOneAddress(url, address, { signal, limits, createConnection, requestFactory }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const transport = url.protocol === 'https:' ? https : http;
    let connectTimer;
    let headersTimer;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      callback();
    };
    const options = {
      agent: false,
      autoSelectFamily: false,
      createConnection,
      family: address.family,
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        connection: 'close',
        'user-agent': 'figma-bridge-mcp/storybook-index',
      },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      maxHeaderSize: limits.maxHeaderBytes,
      method: 'GET',
      signal,
    };
    if (!createConnection) delete options.createConnection;
    const request = requestFactory(transport, url, options, (response) => {
      finish(() => resolvePromise(response));
    });
    headersTimer = setTimeout(() => {
      request.destroy(rejected('STORYBOOK_HEADERS_TIMEOUT', 'headers deadline exceeded'));
    }, limits.headersTimeoutMs);
    request.once('socket', (socket) => {
      if (!socket.connecting) return;
      const connectedEvent = url.protocol === 'https:' ? 'secureConnect' : 'connect';
      connectTimer = setTimeout(() => {
        request.destroy(rejected('STORYBOOK_CONNECT_TIMEOUT', 'connect deadline exceeded'));
      }, limits.connectTimeoutMs);
      socket.once(connectedEvent, () => clearTimeout(connectTimer));
      socket.once('error', () => clearTimeout(connectTimer));
    });
    request.once('error', (error) => {
      finish(() => {
        if (signal.aborted) rejectPromise(signal.reason);
        else if (error instanceof RemoteStorybookError) rejectPromise(error);
        else rejectPromise(rejected('STORYBOOK_CONNECT', 'approved origin could not be reached'));
      });
    });
    request.end();
  });
}

async function requestApproved(url, addresses, context) {
  let lastError;
  for (const address of addresses) {
    try {
      return await requestOneAddress(url, address, context);
    } catch (error) {
      lastError = error;
      if (!['STORYBOOK_CONNECT', 'STORYBOOK_CONNECT_TIMEOUT'].includes(error?.code)) throw error;
    }
  }
  throw lastError || rejected('STORYBOOK_CONNECT', 'approved origin could not be reached');
}

function destroyResponse(response) {
  response.destroy();
}

async function requestFollowingRedirects(initialUrl, context) {
  let current = initialUrl;
  for (let redirects = 0; ; redirects++) {
    const approved = context.policy.authorize(current, { redirect: redirects > 0 });
    const addresses = await resolveApprovedTarget(approved, context);
    const response = await context.request(approved.url, addresses, context);
    if (!REDIRECT_STATUS.has(response.statusCode)) return response;
    const location = response.headers.location;
    destroyResponse(response);
    if (!location) throw rejected('STORYBOOK_REDIRECT', 'redirect omitted its destination');
    if (redirects >= context.limits.maxRedirects) {
      throw rejected('STORYBOOK_REDIRECT', 'redirect limit exceeded');
    }
    try {
      current = new URL(location, approved.url);
    } catch {
      throw rejected('STORYBOOK_REDIRECT', 'redirect destination is invalid');
    }
    // Fail before another DNS lookup or request and without retaining the URL.
    context.policy.authorize(current, { redirect: true });
  }
}

function endpointUrl(baseUrl, filename) {
  const url = new URL(baseUrl.href);
  const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `${prefix}/${filename}`;
  url.search = '';
  url.hash = '';
  return url;
}

function readBoundedBody(response, { signal, limits }) {
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') {
    destroyResponse(response);
    return Promise.reject(rejected('STORYBOOK_ENCODING', 'compressed response encoding is not accepted'));
  }
  const rawLength = response.headers['content-length'];
  if (rawLength !== undefined && (!/^\d+$/.test(String(rawLength)) || Number(rawLength) > limits.maxBytes)) {
    destroyResponse(response);
    return Promise.reject(rejected('STORYBOOK_BYTE_LIMIT', `index exceeds ${limits.maxBytes} bytes`));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let terminalError = null;
    const bodyTimer = setTimeout(() => {
      terminalError = rejected('STORYBOOK_BODY_TIMEOUT', 'body deadline exceeded');
      response.destroy(terminalError);
    }, limits.bodyTimeoutMs);
    const aborted = () => {
      terminalError = signal.reason;
      response.destroy(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(bodyTimer);
      signal.removeEventListener('abort', aborted);
      callback();
    };
    response.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limits.maxBytes) {
        terminalError = rejected('STORYBOOK_BYTE_LIMIT', `index exceeds ${limits.maxBytes} bytes`);
        response.destroy(terminalError);
        return;
      }
      chunks.push(buffer);
    });
    response.once('end', () => finish(() => resolvePromise(Buffer.concat(chunks).toString('utf8'))));
    response.once('aborted', () =>
      finish(() =>
        rejectPromise(
          terminalError ||
            (signal.aborted ? signal.reason : rejected('STORYBOOK_BODY', 'response body ended unexpectedly'))
        )
      )
    );
    response.once('error', (error) =>
      finish(() => {
        if (signal.aborted) rejectPromise(signal.reason);
        else if (terminalError) rejectPromise(terminalError);
        else if (error instanceof RemoteStorybookError) rejectPromise(error);
        else rejectPromise(rejected('STORYBOOK_BODY', 'response body could not be read safely'));
      })
    );
  });
}

export async function fetchRemoteStorybookIndex(
  baseUrl,
  {
    env = process.env,
    lookup = dnsLookup,
    request = requestApproved,
    requestFactory = (transport, url, options, onResponse) => transport.request(url, options, onResponse),
    createConnection,
    limits = STORYBOOK_REMOTE_LIMITS,
  } = {}
) {
  const effectiveLimits = Object.freeze({ ...STORYBOOK_REMOTE_LIMITS, ...limits });
  const policy = createStorybookRemotePolicy(env);
  const base = policy.authorize(baseUrl).url;
  const controller = new AbortController();
  const totalTimer = setTimeout(() => {
    controller.abort(rejected('STORYBOOK_TOTAL_TIMEOUT', 'total deadline exceeded'));
  }, effectiveLimits.totalTimeoutMs);
  const context = {
    createConnection,
    limits: effectiveLimits,
    lookup,
    policy,
    request,
    requestFactory,
    signal: controller.signal,
  };

  try {
    let response = await requestFollowingRedirects(endpointUrl(base, 'index.json'), context);
    if (response.statusCode === 404) {
      destroyResponse(response);
      response = await requestFollowingRedirects(endpointUrl(base, 'stories.json'), context);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const status = response.statusCode;
      destroyResponse(response);
      throw rejected('STORYBOOK_STATUS', `approved origin returned status ${status}`);
    }
    return await readBoundedBody(response, context);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof RemoteStorybookError) throw error;
    throw rejected('STORYBOOK_REMOTE', 'approved origin could not be read safely');
  } finally {
    clearTimeout(totalTimer);
  }
}
