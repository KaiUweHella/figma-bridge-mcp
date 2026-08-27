import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** @typedef {{connectTimeoutMs:number,headersTimeoutMs:number,bodyTimeoutMs:number,totalTimeoutMs:number,maxRedirects:number,maxHeaderBytes:number,maxBytes:number}} BoundedRemoteHttpLimits */

/** @type {Readonly<BoundedRemoteHttpLimits>} */
export const BOUNDED_REMOTE_HTTP_LIMITS = Object.freeze({
  connectTimeoutMs: 1_500,
  headersTimeoutMs: 3_000,
  bodyTimeoutMs: 5_000,
  totalTimeoutMs: 8_000,
  maxRedirects: 3,
  maxHeaderBytes: 16 * 1024,
  maxBytes: 8 * 1024 * 1024,
});

export class BoundedRemoteHttpError extends Error {
  constructor(code, reason) {
    super(`Bounded remote read rejected: ${reason}.`);
    this.name = 'BoundedRemoteHttpError';
    this.code = code;
    this.kind = 'bounded-remote-http';
  }
}

function rejected(code, reason) {
  return new BoundedRemoteHttpError(code, reason);
}

function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function ipv4Bytes(address) {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts : null;
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
  return bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff;
}

function isCompatibleV4(bytes) {
  return bytes.slice(0, 12).every((byte) => byte === 0);
}

function isNat64(bytes) {
  const wellKnown = bytes[0] === 0x00 && bytes[1] === 0x64
    && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes.slice(4, 12).every((byte) => byte === 0);
  const localUse = bytes[0] === 0x00 && bytes[1] === 0x64
    && bytes[2] === 0xff && bytes[3] === 0x9b
    && bytes[4] === 0x00 && bytes[5] === 0x01;
  return wellKnown || localUse;
}

function classifyIpv4(bytes) {
  const [a, b, c, d] = bytes;
  if (a === 127) return 'loopback';
  if (a === 0
    || (a === 169 && b === 254)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || b === 51) && (b !== 51 || c === 100))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
    || (a === 255 && b === 255 && c === 255 && d === 255)) return 'forbidden';
  if (a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)) return 'private';
  return 'public';
}

export function classifyRemoteAddress(address) {
  const v4 = ipv4Bytes(address);
  if (v4) return classifyIpv4(v4);
  const v6 = ipv6Bytes(address);
  if (!v6) return 'forbidden';
  if (isMappedV4(v6)) return classifyIpv4(v6.slice(12));
  if (isLoopbackV6(v6)) return 'loopback';
  if (isCompatibleV4(v6)) return classifyIpv4(v6.slice(12));
  if (v6.every((byte) => byte === 0)
    || v6[0] === 0xff
    || (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80)
    || isNat64(v6)
    || (v6[0] === 0x20 && v6[1] === 0x02)
    || (v6[0] === 0x20 && v6[1] === 0x01 && (v6[2] & 0xfe) === 0)
    || (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8)) return 'forbidden';
  if ((v6[0] & 0xfe) === 0xfc
    || (v6[0] === 0xfe && (v6[1] & 0xc0) === 0xc0)) return 'private';
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
      },
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
    if (error instanceof BoundedRemoteHttpError) throw error;
    throw rejected('REMOTE_DNS', 'approved origin could not be resolved');
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw rejected('REMOTE_DNS', 'approved origin resolved to no usable address');
  }
  const deduped = new Map();
  for (const record of records) {
    const family = Number(record?.family) || isIP(record?.address || '');
    const address = String(record?.address || '');
    if (![4, 6].includes(family) || isIP(address) !== family) {
      throw rejected('REMOTE_DNS', 'approved origin returned an invalid address');
    }
    const classification = classifyRemoteAddress(address);
    const permitted = approved.scope === 'local'
      ? classification === 'loopback'
      : approved.scope === 'public'
        ? classification === 'public'
        : classification === 'private' || classification === 'loopback';
    if (!permitted) {
      throw rejected('REMOTE_NETWORK_RANGE', 'resolved destination network range is not approved');
    }
    deduped.set(`${family}:${address}`, Object.freeze({ address, family }));
  }
  return Object.freeze([...deduped.values()]);
}

function requestOneAddress(url, address, context) {
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
      family: address.family,
      headers: {
        accept: context.accept,
        'accept-encoding': 'identity',
        connection: 'close',
        'user-agent': context.userAgent,
      },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      maxHeaderSize: context.limits.maxHeaderBytes,
      method: 'GET',
      signal: context.signal,
    };
    if (context.createConnection) options.createConnection = context.createConnection;
    const request = context.requestFactory(transport, url, options, (response) => {
      finish(() => resolvePromise(response));
    });
    headersTimer = setTimeout(() => {
      request.destroy(rejected('REMOTE_HEADERS_TIMEOUT', 'headers deadline exceeded'));
    }, context.limits.headersTimeoutMs);
    request.once('socket', (socket) => {
      if (!socket.connecting) return;
      const connectedEvent = url.protocol === 'https:' ? 'secureConnect' : 'connect';
      connectTimer = setTimeout(() => {
        request.destroy(rejected('REMOTE_CONNECT_TIMEOUT', 'connect deadline exceeded'));
      }, context.limits.connectTimeoutMs);
      socket.once(connectedEvent, () => clearTimeout(connectTimer));
      socket.once('error', () => clearTimeout(connectTimer));
    });
    request.once('error', (error) => {
      finish(() => {
        if (context.signal.aborted) rejectPromise(context.signal.reason);
        else if (error instanceof BoundedRemoteHttpError) rejectPromise(error);
        else rejectPromise(rejected('REMOTE_CONNECT', 'approved origin could not be reached'));
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
      if (!['REMOTE_CONNECT', 'REMOTE_CONNECT_TIMEOUT'].includes(error?.code)) throw error;
    }
  }
  throw lastError || rejected('REMOTE_CONNECT', 'approved origin could not be reached');
}

function destroyResponse(response) {
  response.destroy();
}

async function requestFollowingRedirects(initialUrl, context) {
  let current = initialUrl;
  for (let redirects = 0; ; redirects++) {
    const approved = context.authorize(current, { redirect: redirects > 0 });
    const addresses = await resolveApprovedTarget(approved, context);
    const response = await context.request(approved.url, addresses, context);
    if (!REDIRECT_STATUS.has(response.statusCode)) {
      return { response, finalUrl: approved.url };
    }
    const location = response.headers.location;
    destroyResponse(response);
    if (!location) throw rejected('REMOTE_REDIRECT', 'redirect omitted its destination');
    if (redirects >= context.limits.maxRedirects) {
      throw rejected('REMOTE_REDIRECT', 'redirect limit exceeded');
    }
    try {
      current = new URL(location, approved.url);
    } catch {
      throw rejected('REMOTE_REDIRECT', 'redirect destination is invalid');
    }
    context.authorize(current, { redirect: true });
  }
}

function readBoundedBody(response, context) {
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') {
    destroyResponse(response);
    return Promise.reject(rejected('REMOTE_ENCODING', 'compressed response encoding is not accepted'));
  }
  const rawLength = response.headers['content-length'];
  if (rawLength !== undefined
    && (!/^\d+$/.test(String(rawLength)) || Number(rawLength) > context.limits.maxBytes)) {
    destroyResponse(response);
    return Promise.reject(rejected('REMOTE_BYTE_LIMIT', `response exceeds ${context.limits.maxBytes} bytes`));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let terminalError = null;
    const bodyTimer = setTimeout(() => {
      terminalError = rejected('REMOTE_BODY_TIMEOUT', 'body deadline exceeded');
      response.destroy(terminalError);
    }, context.limits.bodyTimeoutMs);
    const aborted = () => {
      terminalError = context.signal.reason;
      response.destroy(context.signal.reason);
    };
    context.signal.addEventListener('abort', aborted, { once: true });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(bodyTimer);
      context.signal.removeEventListener('abort', aborted);
      callback();
    };
    response.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > context.limits.maxBytes) {
        terminalError = rejected('REMOTE_BYTE_LIMIT', `response exceeds ${context.limits.maxBytes} bytes`);
        response.destroy(terminalError);
        return;
      }
      chunks.push(buffer);
    });
    response.once('end', () => finish(() => resolvePromise(Buffer.concat(chunks))));
    response.once('aborted', () => finish(() => rejectPromise(terminalError
      || (context.signal.aborted ? context.signal.reason
        : rejected('REMOTE_BODY', 'response body ended unexpectedly')))));
    response.once('error', (error) => finish(() => {
      if (context.signal.aborted) rejectPromise(context.signal.reason);
      else if (terminalError) rejectPromise(terminalError);
      else if (error instanceof BoundedRemoteHttpError) rejectPromise(error);
      else rejectPromise(rejected('REMOTE_BODY', 'response body could not be read safely'));
    }));
  });
}

export async function readBoundedRemoteHttp(input, {
  authorize = null,
  isAuthorizationError = (_error) => Boolean(false),
  lookup = dnsLookup,
  request = requestApproved,
  requestFactory = (transport, url, options, onResponse) =>
    transport.request(url, options, onResponse),
  createConnection = null,
  limits = BOUNDED_REMOTE_HTTP_LIMITS,
  accept = 'application/octet-stream',
  userAgent = 'figma-bridge-mcp/bounded-remote-read',
} = {}) {
  if (typeof authorize !== 'function') {
    throw new TypeError('Bounded remote HTTP requires an exact-origin authorize function');
  }
  const effectiveLimits = Object.freeze({ ...BOUNDED_REMOTE_HTTP_LIMITS, ...limits });
  const controller = new AbortController();
  const totalTimer = setTimeout(() => {
    controller.abort(rejected('REMOTE_TOTAL_TIMEOUT', 'total deadline exceeded'));
  }, effectiveLimits.totalTimeoutMs);
  const context = {
    accept, authorize, createConnection, limits: effectiveLimits, lookup, request,
    requestFactory, signal: controller.signal, userAgent,
  };
  try {
    const initial = input instanceof URL ? new URL(input.href) : new URL(String(input));
    const { response, finalUrl } = await requestFollowingRedirects(initial, context);
    const statusCode = Number(response.statusCode);
    const contentType = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    const bytes = await readBoundedBody(response, context);
    return Object.freeze({ statusCode, contentType, bytes, finalUrl });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof BoundedRemoteHttpError) throw error;
    if (isAuthorizationError(error)) throw error;
    if (error instanceof TypeError && /Invalid URL/i.test(error.message)) {
      throw rejected('REMOTE_URL', 'URL is invalid');
    }
    throw rejected('REMOTE_READ', 'approved origin could not be read safely');
  } finally {
    clearTimeout(totalTimer);
  }
}
