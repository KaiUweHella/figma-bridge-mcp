// Mutual challenge-response handshake for the plugin WebSocket.
//
// Proto 1 sent the raw access key as the first frame ({type:'hello', key}).
// A local process that bound a range port BEFORE the daemon could accept the
// connection and read the key straight off the wire — the residual risk the
// README documented. Proto 2 removed that: the key is only ever used as an
// HMAC secret, and both sides prove possession of it. Proto 3 closes the
// remaining relay gap by requiring the plugin to verify the port it really
// connected to and by authenticating its canonical capability claim.
//
//   daemon → plugin   {type:'challenge', proto:3, nonce:<dNonce>, port:<bound>}
//   plugin → daemon   {type:'hello', proto:3, nonce:<pNonce>, version, capabilities, proof}
//   daemon → plugin   {type:'hello-ack', proof, restTokenConfigured}
//
// Four properties fall out of the transcript below:
//
//   1. The key never crosses the wire in either direction. A squatter that
//      accepts the socket learns one HMAC over nonces it will never see again.
//   2. The daemon proves itself too. Before proto 2 the plugin trusted whoever
//      answered and would run any `eval` frame it was sent — a fake daemon on a
//      range port could drive the document without knowing the key at all.
//   3. The bound PORT is inside both proofs (channel binding), and the plugin
//      rejects a challenge that names a port other than its actual socket.
//      That kills a transparent relay between two approved range ports.
//   4. The canonical capability list is inside the plugin proof. A relay cannot
//      add a security-sensitive capability to an older plugin's hello.
//
// Both ends ship in this repo and are installed together by figma_connect, so
// there is no older-protocol fallback — a stale plugin gets a named error
// telling it to re-import, not a silently weaker handshake.
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

export const HANDSHAKE_PROTO = 3;

// Domain separator. Keeps these HMACs from ever colliding with the request
// signatures in daemon-auth.js, which are keyed with a different secret.
const PREFIX = 'figma-bridge-mcp/handshake/v3';

/** 32 random bytes, hex. Same shape both sides must validate. */
export function makeNonce() {
  return randomBytes(32).toString('hex');
}

/** Nonce wire-format check — 64 lowercase hex chars. */
export function isNonce(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** Proof wire-format check — SHA-256 hex. */
export function isProof(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * Canonicalize the capability claim before signing or storing it. Order and
 * duplicates carry no protocol meaning, so they must not create distinct
 * transcripts.
 */
export function canonicalPluginCapabilities(capabilities = []) {
  if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== 'string')) {
    throw new TypeError('Plugin capabilities must be an array of strings');
  }
  return [...new Set(capabilities)].sort();
}

/**
 * Transcript the PLUGIN signs. Binds both nonces, the port the plugin actually
 * connected to, the plugin version and its canonical capability claim.
 */
export function pluginTranscript({ daemonNonce, pluginNonce, port, version, capabilities = [] }) {
  const canonicalCapabilities = canonicalPluginCapabilities(capabilities);
  return JSON.stringify([
    PREFIX,
    'plugin',
    daemonNonce,
    pluginNonce,
    port,
    String(version),
    canonicalCapabilities,
  ]);
}

/**
 * Transcript the DAEMON signs. Nonces in the opposite order so a plugin proof
 * can never be replayed back as a daemon proof.
 */
export function daemonTranscript({ daemonNonce, pluginNonce, port }) {
  return `${PREFIX}|daemon|${pluginNonce}|${daemonNonce}|${port}`;
}

/** HMAC-SHA256(key, transcript) as hex. */
export function sign(key, transcript) {
  return createHmac('sha256', key).update(transcript).digest('hex');
}

/** Constant-time proof comparison. Rejects anything malformed. */
export function verify(key, transcript, provided) {
  if (!key || !isProof(provided)) return false;
  const expected = Buffer.from(sign(key, transcript), 'hex');
  const got = Buffer.from(provided, 'hex');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}
