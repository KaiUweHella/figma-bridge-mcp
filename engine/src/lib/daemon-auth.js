// Per-request HMAC signing between CLI/MCP layer and the local daemon.
//
// Previously every request carried the session token in cleartext
// (X-Daemon-Token). Because the CLI resolves the daemon port dynamically, a
// local attacker binding a range port could harvest the token from the first
// health probe and replay it against the real daemon. With signing, the token
// never crosses the wire: each request carries a timestamp, a random nonce and
// an HMAC-SHA256 over (ts, nonce, method, path, body-hash), keyed with the
// session token. A squatter port sees only a signature that is useless for any
// other (ts, nonce, method, path, body) tuple, and the daemon's nonce cache
// rejects verbatim replays inside the freshness window.
//
// Both ends live in this repo and restart together (figma_connect rotates the
// token and respawns the daemon), so there is no cleartext-token back-compat.
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'crypto';

// Freshness window (±). Client and daemon share the same machine clock, so
// this only needs to absorb scheduling delay, not clock skew.
export const AUTH_WINDOW_MS = 30000;

function hmacHex(token, ts, nonce, method, path, body) {
  const bodyHash = createHash('sha256').update(body || '').digest('hex');
  return createHmac('sha256', token)
    .update(`${ts}.${nonce}.${String(method).toUpperCase()}.${path}.${bodyHash}`)
    .digest('hex');
}

/**
 * Build the signed auth headers for one request.
 * @param {string} token - daemon session token (never sent itself)
 * @param {string} method - HTTP method the request will use
 * @param {string} path - URL path (no host, no query), e.g. "/exec"
 * @param {string} [body] - exact request body ('' for GET)
 * @returns {{'X-Daemon-Ts': string, 'X-Daemon-Nonce': string, 'X-Daemon-Auth': string}}
 */
export function signRequest(token, method, path, body = '') {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  return {
    'X-Daemon-Ts': ts,
    'X-Daemon-Nonce': nonce,
    'X-Daemon-Auth': hmacHex(token, ts, nonce, method, path, body),
  };
}

/**
 * Verify a request's signed headers. Pure check — replay protection (nonce
 * cache) is the caller's job, since it needs process-lifetime state.
 * @param {string} token
 * @param {object} headers - lower-cased header map (Node's req.headers)
 * @param {string} method
 * @param {string} path
 * @param {string} [body]
 * @param {{now?: number, windowMs?: number}} [opts]
 * @returns {boolean}
 */
export function verifyRequest(token, headers, method, path, body = '', { now = Date.now(), windowMs = AUTH_WINDOW_MS } = {}) {
  const ts = headers['x-daemon-ts'];
  const nonce = headers['x-daemon-nonce'];
  const sig = headers['x-daemon-auth'];
  if (typeof ts !== 'string' || !/^\d{1,16}$/.test(ts)) return false;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return false;
  if (typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(now - Number(ts)) > windowMs) return false;
  const expected = Buffer.from(hmacHex(token, ts, nonce, method, path, body), 'hex');
  const provided = Buffer.from(sig, 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
