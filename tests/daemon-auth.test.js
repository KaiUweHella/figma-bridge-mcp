// Security-core tests for the vendored daemon's authentication.
//
// Spawns engine/src/daemon.js on a scratch port with temp token/key/pid files
// (all env-overridable) so nothing touches the user's real ~/.figma-bridge-mcp
// state, then exercises the signed-request HTTP gate and the WebSocket
// access-key gate. HTTP auth is per-request HMAC signing (X-Daemon-Ts/-Nonce/
// -Auth) — the session token itself never crosses the wire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRequest, verifyRequest } from '../engine/src/lib/daemon-auth.js';
import {
  HANDSHAKE_PROTO,
  makeNonce,
  pluginTranscript,
  daemonTranscript,
  sign as signHandshake,
  verify as verifyHandshake,
} from '../engine/src/lib/plugin-handshake.js';
import { PLUGIN_BUILD_VERSION } from '../engine/src/lib/plugin-version.js';
import {
  MAX_EXEC_BODY_BYTES,
  MAX_PLUGIN_MESSAGE_BYTES,
  MAX_PROTOCOL_ERROR_BYTES,
  MAX_PROTOCOL_VALUE_BYTES,
} from '../engine/src/lib/protocol-contract.js';
import { BRIDGE_DAEMON_ERROR_SCHEMA } from '../engine/src/lib/daemon-error-envelope.js';
import { createDaemonClient } from '../engine/src/lib/daemon-client.js';
import { FigmaClient } from '../engine/src/lib/jsx-render.js';
import { terminalDispatchReceipt } from '../engine/src/lib/dispatch-receipt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, '..', 'engine', 'src', 'daemon.js');

const PORT = 34567; // scratch port, outside the 3456–3460 plugin range
const TOKEN = 'test-daemon-token-abcdef';
const KEY = 'test-access-key-0123456789';

let tmp;
let child;
let childStderr = '';

// Fresh signed headers per call — nonces are single-use by design.
function auth(method, path, body = '', token = TOKEN) {
  return signRequest(token, method, path, body);
}

function httpHealth(headers = {}) {
  return fetch(`http://127.0.0.1:${PORT}/health`, { headers });
}

function httpHealthV6(headers = {}) {
  return fetch(`http://[::1]:${PORT}/health`, { headers });
}

function assertBridgeError(payload, expected) {
  assert.equal(payload.error, payload.bridgeError.message, 'legacy and structured messages must agree');
  assert.deepEqual(
    {
      schema: payload.bridgeError.schema,
      kind: payload.bridgeError.kind,
      phase: payload.bridgeError.phase,
      outcome: payload.bridgeError.outcome,
    },
    { schema: BRIDGE_DAEMON_ERROR_SCHEMA, ...expected },
  );
}

function assertForwardedDeadline(message, timeoutMs) {
  assert.equal(message.timeoutMs, timeoutMs,
    'the normalized HTTP budget must reach the authenticated Plugin socket');
  assert.equal(Number.isFinite(message.deadlineAt), true,
    'the Plugin socket message must carry an absolute deadline');
  const remainingMs = message.deadlineAt - Date.now();
  assert.ok(remainingMs > 0 && remainingMs <= timeoutMs,
    `forwarded deadline must retain at most its ${timeoutMs}ms owning budget (got ${remainingMs}ms)`);
}

function waitForListen(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const res = await httpHealth(auth('GET', '/health'));
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) {
        const detail = childStderr.trim();
        return reject(new Error(`daemon did not start${detail ? `: ${detail}` : ''}`));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Open a plugin WebSocket and run an interaction. `origin` is optional.
function openWs(origin) {
  const opts = origin ? { origin } : {};
  return new WebSocket(`ws://127.0.0.1:${PORT}/plugin`, opts);
}

const PLUGIN_VERSION = PLUGIN_BUILD_VERSION;
const PLUGIN_CAPABILITIES = Object.freeze([
  'asset-stream-v1',
  'dispatch-receipt-v1',
  'eval-v1',
  'execution-deadline-v1',
  'read-lane-v1',
  'reload-ui-v1',
  'render-plan-batch-v1',
  'render-plan-v1',
  'typed-read-v1',
  'write-lane-v1',
]);

function pluginResult(message, {
  result,
  error = null,
  metadata = null,
  state = error == null ? 'completed' : 'failed',
  reason = error == null ? null : 'execution-error',
} = {}) {
  return {
    type: 'result',
    id: message.id,
    ...(result === undefined ? {} : { result }),
    ...(error == null ? {} : { error }),
    ...(metadata == null ? {} : { metadata }),
    dispatchReceipt: terminalDispatchReceipt(message.dispatchReceipt, state, reason),
  };
}

/**
 * Play the plugin's side of the proto-4 handshake: wait for the daemon's
 * challenge, answer with a proof, and return everything both sides exchanged.
 * `mutate` gets the outgoing hello and may sabotage any field — that is how the
 * negative tests below forge protos, nonces, ports and proofs.
 */
function handshake(ws, {
  mutate = (h) => h,
  key = KEY,
  timeoutMs = 3000,
  version = PLUGIN_VERSION,
  capabilities = PLUGIN_CAPABILITIES,
} = {}) {
  return new Promise((resolve, reject) => {
    const seen = [];
    let challenge = null;
    let pluginNonce = null;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      seen.push(m);
      if (m.type === 'challenge') {
        challenge = m;
        pluginNonce = makeNonce();
        const hello = {
          type: 'hello',
          proto: HANDSHAKE_PROTO,
          version,
          capabilities,
          nonce: pluginNonce,
          proof: signHandshake(key, pluginTranscript({
            daemonNonce: m.nonce,
            pluginNonce,
            port: m.port,
            version,
            capabilities,
          })),
        };
        ws.send(JSON.stringify(mutate(hello, m)));
        return;
      }
      if (m.type === 'hello-ack') resolve({ ack: m, challenge, pluginNonce, seen });
      if (m.type === 'auth-error') reject(new Error('auth-error: ' + m.reason));
    });
    ws.on('close', (c) => reject(new Error('closed ' + c)));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('handshake timeout')), timeoutMs);
  });
}

/** Resolve with the close code / auth-error reason instead of throwing. */
function expectRejection(ws, opts) {
  return new Promise((resolve, reject) => {
    let reason = null;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'auth-error') reason = m.reason;
    });
    ws.on('close', (code) => resolve({ code, reason }));
    ws.on('error', () => {});
    handshake(ws, opts).then(
      () => reject(new Error('handshake unexpectedly succeeded')),
      () => {},
    );
    setTimeout(() => reject(new Error('socket was not closed')), 3000);
  });
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'figma-bridge-daemon-'));
  const tokenFile = join(tmp, 'token');
  const keyFile = join(tmp, 'key');
  const pidFile = join(tmp, 'pid');
  writeFileSync(tokenFile, TOKEN);
  writeFileSync(keyFile, KEY);

  child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      DAEMON_PORT: String(PORT),
      DAEMON_TOKEN_FILE: tokenFile,
      DAEMON_PID_FILE: pidFile,
      // Keep the test daemon's published-port file out of ~/.figma-bridge-mcp —
      // a SIGKILLed test run must never leave a stale real port file behind.
      DAEMON_PORT_FILE: join(tmp, 'port'),
      DAEMON_ASSET_TRANSFER_DIR: join(tmp, 'asset-transfers'),
      PLUGIN_KEY_FILE: keyFile,
      DAEMON_IDLE_TIMEOUT: '600000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { childStderr += chunk.toString(); });
  await waitForListen();
});

after(() => {
  try { child.kill('SIGTERM'); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('HTTP /health without signed headers is rejected (403)', async () => {
  const res = await httpHealth();
  assert.equal(res.status, 403);
});

test('HTTP /plugin-ready exposes only a CORS-scoped, non-sensitive discovery beacon', async () => {
  const accepted = await fetch(`http://127.0.0.1:${PORT}/plugin-ready`, {
    headers: { Origin: 'null' },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('access-control-allow-origin'), 'null');
  assert.deepEqual(await accepted.json(), {
    bridge: 'figma-bridge-mcp',
    ready: true,
    port: PORT,
  });

  const rejected = await fetch(`http://127.0.0.1:${PORT}/plugin-ready`, {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(rejected.status, 403);
});

test('HTTP /health with a valid signature succeeds and reports Safe-Mode shape', async () => {
  const res = await httpHealth(auth('GET', '/health'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cdp, false);
  assert.equal(body.keyConfigured, true);
  assert.equal(body.plugin, false); // no plugin connected yet
});

test('probed health distinguishes a socket from a responsive Plugin main thread', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'HEALTH_PROBE_FILE' });
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action !== 'typed-read' || message.operation !== 'bridge-health-v1') return;
      ws.send(JSON.stringify(pluginResult(message, {
        result: JSON.stringify({ schemaVersion: 1, responsive: true, editorType: 'figma' }),
      })));
    });
    const response = await fetch(`http://127.0.0.1:${PORT}/health?probe=1`, {
      headers: auth('GET', '/health'),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.plugin, true);
    assert.equal(body.pluginResponsive, true);
    assert.equal(body.connections.length, 1);
    assert.equal(body.connections[0].responsiveness, 'responsive');
    assert.equal(typeof body.connections[0].lastProbeAt, 'string');
  });
});

test('probed health reports an authenticated but unresponsive Plugin within a bound', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'UNRESPONSIVE_PROBE_FILE' });
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${PORT}/health?probe=1&fileKey=UNRESPONSIVE_PROBE_FILE`, {
      headers: auth('GET', '/health'),
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.plugin, true);
    assert.equal(body.pluginResponsive, false);
    assert.equal(body.connections[0].responsiveness, 'unresponsive');
    assert.ok(elapsed >= 1000 && elapsed < 2500, `probe must be bounded, got ${elapsed}ms`);
  });
});

test('disconnect, reconnect and a main-thread probe recover stale safe reads without replay', async () => {
  const first = openWs();
  let firstDispatches = 0;
  try {
    await handshake(first);
    await pushSelection(first, { fileKey: 'READ_RECOVERY_FILE' });
    const dispatched = new Promise((resolve) => {
      first.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.action !== 'typed-read' || message.operation !== 'bridge-health-v1') return;
        firstDispatches++;
        resolve();
      });
    });
    const firstRequest = postExec({
      action: 'typed-read', operation: 'bridge-health-v1', request: {},
      fileKey: 'READ_RECOVERY_FILE', expectedEditor: 'figma', timeoutMs: 1000,
    });
    await dispatched;
    first.close();
    const failed = await firstRequest;
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).bridgeError.outcome, 'unknown-after-dispatch');
  } finally {
    try { first.close(); } catch {}
  }

  const second = openWs();
  let recoveredReadDispatches = 0;
  try {
    await handshake(second);
    await pushSelection(second, { fileKey: 'READ_RECOVERY_FILE' });
    second.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action !== 'typed-read' || message.operation !== 'bridge-health-v1') return;
      recoveredReadDispatches++;
      second.send(JSON.stringify(pluginResult(message, {
        result: JSON.stringify({ schemaVersion: 1, responsive: true, editorType: 'figma' }),
      })));
    });
    const probed = await fetch(`http://127.0.0.1:${PORT}/health?probe=1`, {
      headers: auth('GET', '/health'),
    });
    assert.equal((await probed.json()).pluginResponsive, true);
    const recovered = await postExec({
      action: 'typed-read', operation: 'bridge-health-v1', request: {},
      fileKey: 'READ_RECOVERY_FILE', expectedEditor: 'figma', timeoutMs: 1000,
    });
    assert.equal(recovered.status, 200);
    assert.equal(firstDispatches, 1, 'the disconnected read is never replayed');
    assert.equal(recoveredReadDispatches, 2, 'one explicit probe and one caller read run');
  } finally {
    try { second.close(); } catch {}
  }
});

test('IPv6 localhost reaches the same authenticated loopback daemon', async () => {
  const res = await httpHealthV6(auth('GET', '/health'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cdp, false);
  assert.equal(body.keyConfigured, true);
});

test('the raw session token no longer authenticates (legacy header dead)', async () => {
  const res = await httpHealth({ 'X-Daemon-Token': TOKEN });
  assert.equal(res.status, 403);
});

test('replayed signed headers are rejected (nonce cache)', async () => {
  const headers = auth('GET', '/health');
  const first = await httpHealth(headers);
  assert.equal(first.status, 200);
  const replay = await httpHealth(headers);
  assert.equal(replay.status, 403, 'verbatim replay must be rejected');
  const body = await replay.json();
  assert.match(body.error, /Unauthorized/);
});

test('signature is bound to method and path', async () => {
  // Signed for POST — used on a GET route.
  const wrongMethod = await httpHealth(auth('POST', '/health'));
  assert.equal(wrongMethod.status, 403);
  // Signed for another path.
  const wrongPath = await httpHealth(auth('GET', '/selection'));
  assert.equal(wrongPath.status, 403);
});

test('signature is bound to the exact body (POST /exec)', async () => {
  const body = JSON.stringify({ action: 'eval', code: '1' });
  const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
    body: JSON.stringify({ action: 'eval', code: '2' }), // tampered
  });
  assert.equal(res.status, 403);
});

test('a signed request at the supported value limit keeps exact-body authentication', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'MAX_BODY_FILE' });
    const command = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route maximum eval')), 10_000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.action !== 'eval') return;
        clearTimeout(timer);
        assert.equal(Buffer.byteLength(msg.code, 'utf8'), MAX_PROTOCOL_VALUE_BYTES);
        ws.send(JSON.stringify(pluginResult(msg, { result: 'accepted-at-limit' })));
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'eval',
      code: 'x'.repeat(MAX_PROTOCOL_VALUE_BYTES),
      fileKey: 'MAX_BODY_FILE',
      expectedEditor: 'figma',
    });
    assert.ok(Buffer.byteLength(body, 'utf8') <= MAX_EXEC_BODY_BYTES);
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await command;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result, 'accepted-at-limit');
  });
});

test('HTTP /exec without signed headers is rejected (403)', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'eval', code: '1' }),
  });
  assert.equal(res.status, 403);
  assertBridgeError(await res.json(), {
    kind: 'authentication',
    phase: 'request-authentication',
    outcome: 'not-dispatched',
  });
});

test('HTTP /exec validation failures are structured before Plugin dispatch', async () => {
  const body = JSON.stringify({ action: 'eval', code: '' });
  const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
    body,
  });
  assert.equal(res.status, 400);
  assertBridgeError(await res.json(), {
    kind: 'validation',
    phase: 'request-validation',
    outcome: 'not-dispatched',
  });
});

test('HTTP /exec reports a missing Plugin before dispatch', async () => {
  const body = JSON.stringify({ action: 'eval', code: '1', expectedEditor: 'figma' });
  const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
    body,
  });
  assert.equal(res.status, 500);
  assertBridgeError(await res.json(), {
    kind: 'plugin-unavailable',
    phase: 'target-resolution',
    outcome: 'not-dispatched',
  });
});

test('oversized chunked HTTP /exec is rejected before authentication or JSON parsing', async () => {
  const body = Readable.from([
    Buffer.alloc(MAX_EXEC_BODY_BYTES, 0x78),
    Buffer.from('x'),
  ]);
  const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  });
  assert.equal(res.status, 413);
  const payload = await res.json();
  assert.match(payload.error, /payload too large/i);
  assertBridgeError(payload, {
    kind: 'validation',
    phase: 'request-validation',
    outcome: 'not-dispatched',
  });

  const health = await httpHealth(auth('GET', '/health'));
  assert.equal(health.status, 200, 'oversize rejection must leave the daemon healthy');
});

test('verifyRequest (unit): freshness window and header shape', () => {
  const headers = Object.fromEntries(
    Object.entries(signRequest(TOKEN, 'GET', '/health')).map(([k, v]) => [k.toLowerCase(), v]),
  );
  assert.equal(verifyRequest(TOKEN, headers, 'GET', '/health'), true);
  // Stale: same headers judged from 10 minutes in the future.
  assert.equal(
    verifyRequest(TOKEN, headers, 'GET', '/health', '', { now: Date.now() + 10 * 60 * 1000 }),
    false,
  );
  // Wrong token.
  assert.equal(verifyRequest('other-token', headers, 'GET', '/health'), false);
  // Malformed headers.
  assert.equal(verifyRequest(TOKEN, { ...headers, 'x-daemon-auth': 'zz' }, 'GET', '/health'), false);
  assert.equal(verifyRequest(TOKEN, {}, 'GET', '/health'), false);
});

test('request authentication rejects an adversarial header corpus without throwing', () => {
  const valid = Object.fromEntries(
    Object.entries(signRequest(TOKEN, 'GET', '/health')).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const attacks = [
    { 'x-daemon-ts': [] },
    { 'x-daemon-ts': '-1' },
    { 'x-daemon-ts': '1e6' },
    { 'x-daemon-ts': '9'.repeat(17) },
    { 'x-daemon-nonce': {} },
    { 'x-daemon-nonce': valid['x-daemon-nonce'].toUpperCase() },
    { 'x-daemon-nonce': `${valid['x-daemon-nonce']}00` },
    { 'x-daemon-auth': ['a'.repeat(64)] },
    { 'x-daemon-auth': 'a'.repeat(63) },
    { 'x-daemon-auth': 'a'.repeat(64).toUpperCase() },
    { 'x-daemon-auth': `${'a'.repeat(32)}\0${'a'.repeat(31)}` },
  ];
  for (const attack of attacks) {
    const headers = { ...valid, ...attack };
    assert.doesNotThrow(() => verifyRequest(TOKEN, headers, 'GET', '/health'));
    assert.equal(verifyRequest(TOKEN, headers, 'GET', '/health'), false, JSON.stringify(attack));
  }
});

test('WS challenge-response authenticates and the daemon proves itself back', async () => {
  const ws = openWs();
  const { ack, challenge, pluginNonce, seen } = await handshake(ws);

  // The daemon speaks first, and its challenge carries the bound port.
  assert.equal(seen[0].type, 'challenge', 'daemon must challenge before anything else');
  assert.equal(challenge.proto, HANDSHAKE_PROTO);
  assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
  assert.equal(challenge.port, PORT, 'challenge must name the port it is bound to');

  // The ack is a real proof of key possession, not a bare acknowledgement.
  assert.ok(
    verifyHandshake(KEY, daemonTranscript({
      daemonNonce: challenge.nonce,
      pluginNonce,
      port: PORT,
      connectionEpoch: ack.connectionEpoch,
    }), ack.proof),
    'daemon proof must verify under the shared key',
  );
  assert.match(ack.connectionEpoch, /^[0-9a-f-]{36}$/i);
  assert.equal(ack.bundledPluginVersion, PLUGIN_BUILD_VERSION);
  assert.equal(ack.pluginVersion, PLUGIN_BUILD_VERSION);
  assert.equal(ack.pluginUpdateAvailable, false);

  // /health now reports an authenticated plugin.
  const res = await httpHealth(auth('GET', '/health'));
  const body = await res.json();
  assert.equal(body.plugin, true);
  assert.equal(body.pluginAuthenticated, true);
  assert.equal(body.connections[0].pluginVersion, PLUGIN_BUILD_VERSION);
  assert.equal(body.connections[0].pluginUpdateAvailable, false);
  ws.close();
});

test('oversized WebSocket messages close the unauthenticated peer with 1009', async () => {
  const ws = openWs();
  await new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'challenge') resolve();
      else reject(new Error(`unexpected first frame: ${message.type}`));
    });
    ws.once('error', reject);
  });

  const closed = new Promise((resolve, reject) => {
    ws.once('close', (code) => resolve(code));
    ws.once('error', (error) => {
      if (error?.code !== 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') reject(error);
    });
    setTimeout(() => reject(new Error('oversized WebSocket message was not closed')), 3000);
  });
  ws.send(Buffer.alloc(MAX_PLUGIN_MESSAGE_BYTES + 1, 0x78));
  assert.equal(await closed, 1009);

  const health = await httpHealth(auth('GET', '/health'));
  assert.equal(health.status, 200, 'oversize WebSocket rejection must leave the daemon healthy');
});

test('the handshake exposes a cached older Figma plugin build', async () => {
  const ws = openWs();
  const { ack } = await handshake(ws, { version: '3.0.0' });
  assert.equal(ack.pluginVersion, '3.0.0');
  assert.equal(ack.bundledPluginVersion, PLUGIN_BUILD_VERSION);
  assert.equal(ack.pluginUpdateAvailable, true);

  const body = await (await httpHealth(auth('GET', '/health'))).json();
  const connection = body.connections.find((item) => item.pluginVersion === '3.0.0');
  assert.ok(connection, 'health must expose the imported plugin build');
  assert.equal(connection.pluginUpdateAvailable, true);
  ws.close();
});

test('the access key never appears on the wire', async () => {
  // The key-secrecy property retained by proto 4: a squatter that records every frame of a
  // successful handshake still cannot connect afterwards.
  const ws = openWs();
  const sent = [];
  const realSend = ws.send.bind(ws);
  ws.send = (data) => { sent.push(String(data)); return realSend(data); };
  const { seen } = await handshake(ws);
  const transcript = [...sent, ...seen.map((m) => JSON.stringify(m))].join('\n');
  assert.ok(transcript.length > 0, 'frames were captured');
  assert.equal(transcript.includes(KEY), false, 'the access key must never be transmitted');
  ws.close();
});

test('WS hello proved with the wrong key is closed with 4401', async () => {
  const ws = openWs();
  const { code, reason } = await expectRejection(ws, { key: 'WRONG-KEY' });
  assert.equal(code, 4401);
  assert.equal(reason, 'invalid-key');
});

test('a proto-1 hello (raw key, no proof) is rejected by name', async () => {
  // A stale plugin install must be told to re-import, not silently downgraded.
  const ws = openWs();
  const { code, reason } = await expectRejection(ws, {
    mutate: () => ({ type: 'hello', version: 't', key: KEY }),
  });
  assert.equal(code, 4401);
  assert.equal(reason, 'proto-mismatch');
});

test('a proto-2 proof is rejected after the channel-binding protocol bump', async () => {
  const ws = openWs();
  const { code, reason } = await expectRejection(ws, {
    mutate: (hello) => ({ ...hello, proto: 2 }),
  });
  assert.equal(code, 4401);
  assert.equal(reason, 'proto-mismatch');
});

test('a proof for a DIFFERENT port is rejected (relay defence)', async () => {
  // A squatter on another range port that forwards frames to the real daemon
  // makes the plugin sign the port it reached — which is not the port the
  // daemon bound. The channel binding is what breaks that relay.
  const ws = openWs();
  const { code, reason } = await expectRejection(ws, {
    mutate: (hello, challenge) => ({
      ...hello,
      proof: signHandshake(KEY, pluginTranscript({
        daemonNonce: challenge.nonce,
        pluginNonce: hello.nonce,
        port: challenge.port + 1, // reached us via a relay on a neighbouring port
        version: PLUGIN_VERSION,
        capabilities: hello.capabilities,
      })),
    }),
  });
  assert.equal(code, 4401);
  assert.equal(reason, 'invalid-key');
});

test('a proof for a different version is rejected', async () => {
  const ws = openWs();
  const { code } = await expectRejection(ws, {
    mutate: (hello) => ({ ...hello, version: 'spoofed' }), // proof still covers 't'
  });
  assert.equal(code, 4401);
});

test('a capability claim changed after signing is rejected', async () => {
  const ws = openWs();
  const { code, reason } = await expectRejection(ws, {
    mutate: (hello) => ({
      ...hello,
      capabilities: [...hello.capabilities, 'forged-write-capability'],
    }),
  });
  assert.equal(code, 4401);
  assert.equal(reason, 'invalid-key');
});

test('a malformed or reused nonce is rejected', async () => {
  const short = openWs();
  const bad = await expectRejection(short, {
    mutate: (hello) => ({ ...hello, nonce: 'too-short' }),
  });
  assert.equal(bad.code, 4401);

  // Reusing a nonce that already authenticated once must not work again, even
  // with a proof that is internally consistent.
  const first = openWs();
  const { pluginNonce } = await handshake(first);
  first.close();
  const replay = openWs();
  const { code, reason } = await expectRejection(replay, {
    mutate: (hello, challenge) => ({
      ...hello,
      nonce: pluginNonce,
      proof: signHandshake(KEY, pluginTranscript({
        daemonNonce: challenge.nonce,
        pluginNonce,
        port: challenge.port,
        version: PLUGIN_VERSION,
        capabilities: hello.capabilities,
      })),
    }),
  });
  assert.equal(code, 4401);
  assert.equal(reason, 'invalid-key');
});

test('a plugin proof cannot be replayed back as a daemon proof', async () => {
  // Role labels and nonce order differ between the two transcripts, so a
  // squatter that captured a plugin proof cannot echo it to look like us.
  const ws = openWs();
  const { challenge, pluginNonce, ack } = await handshake(ws);
  const pluginProof = signHandshake(KEY, pluginTranscript({
    daemonNonce: challenge.nonce, pluginNonce, port: challenge.port, version: PLUGIN_VERSION,
    capabilities: PLUGIN_CAPABILITIES,
  }));
  assert.notEqual(ack.proof, pluginProof);
  ws.close();
});

test('WS non-hello first message is closed', async () => {
  const ws = openWs();
  const closed = await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'eval', id: 1, code: '1' })));
    ws.on('close', () => resolve(true));
    ws.on('error', () => {});
    setTimeout(() => reject(new Error('not closed')), 3000);
  });
  assert.equal(closed, true);
});

test('WS with a disallowed browser Origin is rejected by verifyClient', async () => {
  const ws = openWs('https://evil.example');
  const rejected = await new Promise((resolve) => {
    ws.on('open', () => resolve(false)); // should NOT open
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode === 401));
    ws.on('error', () => resolve(true)); // handshake failure also counts
    setTimeout(() => resolve(false), 3000);
  });
  assert.equal(rejected, true);
});

test('token rotation under a LIVE daemon heals: new token accepted without restart', async () => {
  // startDaemon() rotates the token file before every spawn; a lost spawn
  // race used to wedge the surviving daemon on the old in-memory token
  // (permanent 403). The daemon re-reads the file per request.
  const ROTATED = 'rotated-token-xyz';
  writeFileSync(join(tmp, 'token'), ROTATED);
  try {
    const resNew = await httpHealth(auth('GET', '/health', '', ROTATED));
    assert.equal(resNew.status, 200, 'signature under the rotated token must be accepted live');
    const resOld = await httpHealth(auth('GET', '/health', '', TOKEN));
    assert.equal(resOld.status, 403, 'signature under the old token must now be rejected');
  } finally {
    writeFileSync(join(tmp, 'token'), TOKEN); // restore for later tests
  }
});

// Authenticate a scratch plugin socket and run `fn` with it.
async function withAuthedWs(fn) {
  const ws = openWs();
  try {
    await handshake(ws);
    return await fn(ws);
  } finally {
    try { ws.close(); } catch {}
  }
}

/** Announce a socket's file identity the way the plugin does — via selection. */
function pushSelection(ws, { fileKey, fileName = 'Test File', page = 'Page 1', nodes = [] }) {
  ws.send(JSON.stringify({
    type: 'selection',
    selection: { page, total: nodes.length, nodes, fileKey, fileName, editorType: 'figma' },
  }));
  return new Promise((r) => setTimeout(r, 150)); // let the daemon process it
}

function postExec(payload, { signal } = {}) {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
    body,
    ...(signal ? { signal } : {}),
  });
}

test('/exec binds page revision metadata to the authenticated daemon connection', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'REV_FILE' });
    const command = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route eval')), 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.action !== 'eval') return;
        clearTimeout(timer);
        assert.equal(msg.requireDocumentRevision, true,
          'the authenticated daemon must preserve the explicit revision-proof request');
        assert.deepEqual(msg.revisionObservation, { scope: 'page', nodeId: '1:2' });
        ws.send(JSON.stringify({
          type: 'selection',
          selection: {
            page: 'Moved', total: 0, nodes: [], fileKey: 'REV_FILE_MOVED',
            fileName: 'Moved after dispatch', editorType: 'figma',
          },
        }));
        ws.send(JSON.stringify(pluginResult(msg, {
          result: { captured: true },
          metadata: {
            connectionId: 'FORGED_BY_PLUGIN',
            documentRevisionBefore: null,
            documentRevisionAfter: null,
            revisionObservation: {
              scope: 'page', pageId: '0:1', revisionBefore: 9, revisionAfter: 9,
            },
            executionTiming: {
              schema: 'figma-bridge/plugin-execution-timing',
              version: 1,
              queuedMs: 3,
              executionMs: 11,
              totalMs: 14,
            },
          },
        })));
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'eval', code: 'capture()', fileKey: 'REV_FILE', expectedEditor: 'figma',
      requireDocumentRevision: true,
      revisionObservation: { scope: 'page', nodeId: '1:2' },
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await command;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.result, { captured: true });
    assert.match(payload.metadata.connectionId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(payload.metadata.connectionId, 'FORGED_BY_PLUGIN');
    assert.equal(payload.metadata.fileKey, 'REV_FILE');
    assert.equal(payload.metadata.pluginVersion, PLUGIN_BUILD_VERSION);
    assert.equal(payload.metadata.documentRevisionBefore, null);
    assert.equal(payload.metadata.documentRevisionAfter, null);
    assert.deepEqual(payload.metadata.revisionObservation, {
      scope: 'page', pageId: '0:1', revisionBefore: 9, revisionAfter: 9,
    });
    assert.deepEqual(payload.metadata.pluginExecutionTiming, {
      schema: 'figma-bridge/plugin-execution-timing',
      version: 1,
      queuedMs: 3,
      executionMs: 11,
      totalMs: 14,
    });
    assert.equal(payload.metadata.bridgeExecutionTiming.schema, 'figma-bridge/bridge-execution-timing');
    assert.equal(payload.metadata.bridgeExecutionTiming.version, 1);
    assert.ok(payload.metadata.bridgeExecutionTiming.preResponseMs >= 0);
    const health = await (await httpHealth(auth('GET', '/health'))).json();
    const connection = health.connections.find((item) => item.fileKey === 'REV_FILE_MOVED');
    assert.match(connection.lastResponseAt, /^\d{4}-\d{2}-\d{2}T/,
      'health must distinguish a merely open socket from a plugin that has answered');
  });
});

test('/exec rejects a bounded-but-invalid Plugin response without waiting for timeout', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'INVALID_RESPONSE_FILE' });
    const command = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route eval')), 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.action !== 'eval') return;
        clearTimeout(timer);
        ws.send(JSON.stringify({
          type: 'result',
          id: msg.id,
          error: 'x'.repeat(MAX_PROTOCOL_ERROR_BYTES + 1),
          dispatchReceipt: terminalDispatchReceipt(msg.dispatchReceipt, 'failed', 'execution-error'),
        }));
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'eval', code: 'capture()', fileKey: 'INVALID_RESPONSE_FILE', expectedEditor: 'figma',
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await command;
    const response = await responsePromise;
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.match(payload.error, /Plugin protocol error:.*error.*limit/i);
    assertBridgeError(payload, {
      kind: 'plugin-protocol',
      phase: 'plugin-response',
      outcome: 'unknown-after-dispatch',
    });
  });
});

test('/exec preserves a failed Structured Render mutation report without weakening dispatch uncertainty', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'MUTATION_REPORT_FILE' });
    const mutationReport = {
      version: 1,
      outcome: 'partial-residue',
      created: 2,
      removed: 1,
      residueCount: 1,
      residue: [{ kind: 'image-resource', handle: 'image:bounded', reason: 'no-removal-api' }],
      residueTruncated: false,
    };
    const command = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route Structured Render')), 3000);
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.action !== 'render-plan') return;
        clearTimeout(timer);
        ws.send(JSON.stringify(pluginResult(message, {
          error: 'Structured render failed; mutation outcome=partial-residue',
          result: { executor: 'structured-v1', mutationOutcome: 'partial-residue', mutationReport },
        })));
        resolve();
      });
    });
    const plan = new FigmaClient().planJSX('<Frame name="Mutation report" />');
    const body = JSON.stringify({
      action: 'render-plan', plan, fileKey: 'MUTATION_REPORT_FILE', expectedEditor: 'figma',
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await command;
    const response = await responsePromise;
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.bridgeError.outcome, 'unknown-after-dispatch');
    assert.equal(payload.bridgeError.dispatchState, 'failed');
    assert.deepEqual(payload.bridgeError.mutationReport, mutationReport);
  });
});

test('/exec treats a valid but target-mismatched terminal receipt as outcome unknown', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'MISMATCHED_RECEIPT_FILE' });
    const command = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route receipt mismatch eval')), 3000);
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.action !== 'eval') return;
        clearTimeout(timer);
        const completed = terminalDispatchReceipt(message.dispatchReceipt, 'completed');
        ws.send(JSON.stringify({
          type: 'result',
          id: message.id,
          result: 'must-not-settle',
          dispatchReceipt: {
            ...completed,
            target: { kind: 'file-key', value: 'OTHER_FILE' },
          },
        }));
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'eval', code: 'capture()', fileKey: 'MISMATCHED_RECEIPT_FILE', expectedEditor: 'figma',
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await command;
    const response = await responsePromise;
    assert.equal(response.status, 500);
    assertBridgeError(await response.json(), {
      kind: 'plugin-protocol',
      phase: 'plugin-response',
      outcome: 'unknown-after-dispatch',
    });
  });
});

test('/exec keeps domain token failures as execution errors after Plugin dispatch', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'DOMAIN_ERROR_FILE' });
    const command = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route domain-error eval')), 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.action !== 'eval') return;
        clearTimeout(timer);
        ws.send(JSON.stringify(pluginResult(msg, {
          error: 'Token alias could not be resolved',
        })));
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'eval', code: 'resolveAlias()', fileKey: 'DOMAIN_ERROR_FILE', expectedEditor: 'figma',
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await command;
    const response = await responsePromise;
    assert.equal(response.status, 500);
    assertBridgeError(await response.json(), {
      kind: 'execution',
      phase: 'plugin-execution',
      outcome: 'unknown-after-dispatch',
    });
  });
});

test('/exec reports Plugin timeout as outcome unknown after dispatch', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'TIMEOUT_FILE' });
    const routed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route timeout eval')), 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.action !== 'eval') return;
        clearTimeout(timer);
        assertForwardedDeadline(msg, 1000);
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'eval',
      code: 'slowOperation()',
      fileKey: 'TIMEOUT_FILE',
      expectedEditor: 'figma',
      timeoutMs: 1000,
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await routed;
    const response = await responsePromise;
    assert.equal(response.status, 500);
    assertBridgeError(await response.json(), {
      kind: 'plugin-timeout',
      phase: 'plugin-execution',
      outcome: 'unknown-after-dispatch',
    });
  });
});

test('/exec reports an elapsed client deadline as not dispatched', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'ELAPSED_DEADLINE_FILE' });
    let dispatched = false;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.action === 'eval') dispatched = true;
    });
    const body = JSON.stringify({
      action: 'eval',
      code: 'mustNotRun()',
      fileKey: 'ELAPSED_DEADLINE_FILE',
      expectedEditor: 'figma',
      timeoutMs: 1000,
      deadlineAt: Date.now() - 1,
    });
    const response = await fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    assert.equal(response.status, 500);
    assertBridgeError(await response.json(), {
      kind: 'timeout',
      phase: 'plugin-dispatch',
      outcome: 'not-dispatched',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dispatched, false);
  });
});

test('/exec refuses a stale Plugin without deadline-aware write-lane capability', async () => {
  const ws = openWs();
  try {
    await handshake(ws, {
      version: '3.3.6',
      capabilities: [
        'dispatch-receipt-v1', 'eval-v1', 'execution-deadline-v1',
        'render-plan-batch-v1', 'render-plan-v1',
      ],
    });
    await pushSelection(ws, { fileKey: 'STALE_DEADLINE_PLUGIN' });
    let dispatched = false;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.action === 'eval') dispatched = true;
    });
    const body = JSON.stringify({
      action: 'eval', code: 'mustNotRun()', fileKey: 'STALE_DEADLINE_PLUGIN', expectedEditor: 'figma', timeoutMs: 1000,
    });
    const response = await fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assertBridgeError(payload, {
      kind: 'plugin-capability',
      phase: 'plugin-dispatch',
      outcome: 'not-dispatched',
    });
    assert.match(payload.error, /write-lane-v1/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dispatched, false);
  } finally {
    try { ws.close(); } catch {}
  }
});

test('/exec routes a validated Semantic Render Plan through the authenticated plugin socket', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'PLAN_FILE' });
    const plan = {
      kind: 'figma-bridge/semantic-render-plan', version: 1, adapter: 'jsx',
      root: { path: 'root', name: 'Card', source: { kind: 'jsx', type: 'frame', props: { name: 'Card' } }, children: [] },
      diagnostics: {},
    };
    const command = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route render-plan')), 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.action !== 'render-plan') return;
        clearTimeout(timer);
        assert.deepEqual(msg.plan, plan);
        assertForwardedDeadline(msg, 4321);
        ws.send(JSON.stringify(pluginResult(msg, {
          result: { id: '9:9', executor: 'structured-v1' },
        })));
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'render-plan', plan, fileKey: 'PLAN_FILE', expectedEditor: 'figma', timeoutMs: 4321,
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) }, body,
    });
    await command;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, { id: '9:9', executor: 'structured-v1' });
  });
});

test('/exec routes a validated Semantic Render Plan batch without generated code', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'BATCH_FILE' });
    const plan = {
      kind: 'figma-bridge/semantic-render-plan', version: 1, adapter: 'jsx',
      root: { path: 'root', name: 'Card', source: { kind: 'jsx', type: 'frame', props: { name: 'Card' } }, children: [] },
      diagnostics: {},
    };
    const command = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route render-plan-batch')), 3000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.action !== 'render-plan-batch') return;
        clearTimeout(timer);
        assert.deepEqual(msg.plans, [plan, plan]);
        assert.deepEqual(msg.options, { gap: 24, vertical: true });
        assertForwardedDeadline(msg, 5432);
        assert.equal('code' in msg, false);
        ws.send(JSON.stringify(pluginResult(msg, {
          result: { frames: [{ id: '9:10' }], executor: 'structured-batch-v1' },
        })));
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'render-plan-batch',
      plans: [plan, plan],
      options: { gap: 24, vertical: true },
      fileKey: 'BATCH_FILE',
      expectedEditor: 'figma',
      timeoutMs: 5432,
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) }, body,
    });
    await command;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.executor, 'structured-batch-v1');
  });
});

test('two windows on DIFFERENT files coexist and are both listed', async () => {
  const a = openWs();
  await handshake(a);
  const b = openWs();
  await handshake(b);
  try {
    await pushSelection(a, { fileKey: 'FILE_A', fileName: 'Alpha' });
    await pushSelection(b, { fileKey: 'FILE_B', fileName: 'Beta' });

    const body = await (await httpHealth(auth('GET', '/health'))).json();
    assert.equal(body.plugin, true);
    assert.equal(body.connections.length, 2);
    assert.deepEqual(
      body.connections.map((c) => c.fileKey).sort(),
      ['FILE_A', 'FILE_B'],
    );
  } finally {
    a.close(); b.close();
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('a second window on the SAME file supersedes the first (4409)', async () => {
  // Two windows on one file are indistinguishable for routing, so the newcomer
  // takes over — the same last-one-wins rule as before, now scoped per file.
  const first = openWs();
  try {
    await handshake(first);
    await pushSelection(first, { fileKey: 'FILE_SAME' });

    const displaced = new Promise((resolve, reject) => {
      let sawMessage = false;
      first.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'superseded') sawMessage = true;
      });
      first.on('close', (code) => resolve({ code, sawMessage }));
      setTimeout(() => reject(new Error('first socket was not displaced')), 3000);
    });

    const second = openWs();
    await handshake(second);
    await pushSelection(second, { fileKey: 'FILE_SAME' });

    const { code, sawMessage } = await displaced;
    assert.equal(code, 4409, 'displaced socket must close with 4409');
    assert.equal(sawMessage, true, 'displaced socket must receive the superseded message');

    const body = await (await httpHealth(auth('GET', '/health'))).json();
    assert.equal(body.connections.filter((c) => c.fileKey === 'FILE_SAME').length, 1);
    second.close();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    try { first.close(); } catch {}
  }
});

test('with several windows, /exec must name a file — and there is no "all"', async () => {
  const a = openWs();
  await handshake(a);
  const b = openWs();
  await handshake(b);
  try {
    await pushSelection(a, { fileKey: 'FILE_A' });
    await pushSelection(b, { fileKey: 'FILE_B' });

    const body = JSON.stringify({ action: 'eval', code: '1', expectedEditor: 'figma' });
    const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    assert.equal(res.status, 500);
    const payload = await res.json();
    assertBridgeError(payload, {
      kind: 'targeting',
      phase: 'target-resolution',
      outcome: 'not-dispatched',
    });
    const err = payload.error;
    assert.match(err, /name one with fileKey/);
    // The connected files are listed, so the caller can act on the error.
    assert.match(err, /FILE_A/);
    assert.match(err, /FILE_B/);
    assert.match(err, /no "all files" option/);

    // An unknown key is rejected the same way rather than falling back.
    const body2 = JSON.stringify({
      action: 'eval', code: '1', fileKey: 'NOPE', expectedEditor: 'figma',
    });
    const res2 = await fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body2) },
      body: body2,
    });
    const payload2 = await res2.json();
    assert.match(payload2.error, /No connected Figma window has file key "NOPE"/);
    assertBridgeError(payload2, {
      kind: 'targeting',
      phase: 'target-resolution',
      outcome: 'not-dispatched',
    });
  } finally {
    a.close(); b.close();
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('a single window still needs no fileKey', async () => {
  // The common case must not get harder just because the daemon can hold more.
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'ONLY_ONE' });
    const routed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('implicit target was not routed')), 3000);
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.action !== 'eval') return;
        clearTimeout(timer);
        assert.equal(message.dispatchReceipt.target.kind, 'file-key');
        assert.equal(message.dispatchReceipt.target.value, 'ONLY_ONE');
        ws.send(JSON.stringify(pluginResult(message, { result: 1 })));
        resolve();
      });
    });
    const body = JSON.stringify({
      action: 'eval', code: '1', expectedEditor: 'figma', timeoutMs: 3000,
    });
    const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await routed;
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result, 1);
  });
});

test('/selection: plugin push is served with auth, per connection', async () => {
  // Before any push: null selection.
  const empty = await (await fetch(`http://127.0.0.1:${PORT}/selection`, {
    headers: auth('GET', '/selection'),
  })).json();
  assert.equal(empty.selection, null);

  // The selection now lives WITH its connection rather than in one global
  // slot, so it is read while the window is still connected — a selection
  // from a window the user has since closed would be a stale answer.
  await withAuthedWs(async (ws) => {
    ws.send(JSON.stringify({
      type: 'selection',
      selection: { page: 'Page 1', total: 2, fileKey: 'SELFILE', nodes: [
        { id: '1:2', name: 'Hero', type: 'FRAME', width: 100, height: 50 },
        // Component identity fields must pass the whitelist; junk must not,
        // and over-length keys are truncated.
        { id: '1:3', name: 'CTA', type: 'INSTANCE',
          componentKey: 'k'.repeat(200), setKey: 'sk1', mainName: 'Primary', setName: 'Button',
          evil: 'dropped', __proto__injection: 'dropped' },
      ] },
    }));
    await new Promise((r) => setTimeout(r, 150)); // let the daemon process it

    const res = await fetch(`http://127.0.0.1:${PORT}/selection`, {
      headers: auth('GET', '/selection'),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.selection.page, 'Page 1');
    assert.equal(body.selection.total, 2);
    assert.equal(body.selection.nodes.length, 2);
    assert.deepEqual(body.selection.nodes[0], { id: '1:2', name: 'Hero', type: 'FRAME', width: 100, height: 50 });
    const inst = body.selection.nodes[1];
    assert.equal(inst.componentKey, 'k'.repeat(128)); // truncated to cap
    assert.equal(inst.setKey, 'sk1');
    assert.equal(inst.mainName, 'Primary');
    assert.equal(inst.setName, 'Button');
    assert.ok(!('evil' in inst), 'unknown fields are dropped');
    assert.ok(body.selection.receivedAt);

    // Naming the file explicitly reaches the same connection.
    const byKey = await (await fetch(`http://127.0.0.1:${PORT}/selection?fileKey=SELFILE`, {
      headers: auth('GET', '/selection'),
    })).json();
    assert.equal(byKey.selection.page, 'Page 1');
  });

  // After the window closed, there is nothing to report — better a null than
  // a selection from a file that may no longer be open.
  const after = await (await fetch(`http://127.0.0.1:${PORT}/selection`, {
    headers: auth('GET', '/selection'),
  })).json();
  assert.equal(after.selection, null);

  // Unauthenticated read is rejected like every other route.
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/selection`);
  assert.equal(noAuth.status, 403);
});

test('a terminal response from an old connection epoch cannot settle a newer execution', async () => {
  const oldSocket = openWs();
  const oldHandshake = await handshake(oldSocket);
  await pushSelection(oldSocket, { fileKey: 'EPOCH_FILE' });
  let oldReceipt;
  const oldRouted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('old epoch request was not routed')), 3000);
    oldSocket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action !== 'eval') return;
      clearTimeout(timer);
      oldReceipt = message.dispatchReceipt;
      oldSocket.send(JSON.stringify(pluginResult(message, { result: 'old-complete' })));
      resolve();
    });
  });
  const oldBody = JSON.stringify({
    action: 'eval', code: 'old()', fileKey: 'EPOCH_FILE', expectedEditor: 'figma', timeoutMs: 3000,
  });
  const oldResponse = await fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', oldBody) },
    body: oldBody,
  });
  await oldRouted;
  assert.equal(oldResponse.status, 200);
  oldSocket.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const newSocket = openWs();
  try {
    const newHandshake = await handshake(newSocket);
    assert.notEqual(newHandshake.ack.connectionEpoch, oldHandshake.ack.connectionEpoch);
    await pushSelection(newSocket, { fileKey: 'EPOCH_FILE' });
    let staleCouldSettle = true;
    const newRouted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('new epoch request was not routed')), 3000);
      newSocket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.action !== 'eval') return;
        clearTimeout(timer);
        newSocket.send(JSON.stringify({
          type: 'result',
          id: message.id,
          result: 'stale-result',
          dispatchReceipt: terminalDispatchReceipt(oldReceipt, 'completed'),
        }));
        setTimeout(() => {
          staleCouldSettle = false;
          newSocket.send(JSON.stringify(pluginResult(message, { result: 'new-complete' })));
          resolve();
        }, 50);
      });
    });
    const newBody = JSON.stringify({
      action: 'eval', code: 'new()', fileKey: 'EPOCH_FILE', expectedEditor: 'figma', timeoutMs: 3000,
    });
    const newResponse = await fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', newBody) },
      body: newBody,
    });
    await newRouted;
    assert.equal(staleCouldSettle, false, 'the stale receipt must remain pending until the exact new receipt answers');
    assert.equal(newResponse.status, 200);
    assert.equal((await newResponse.json()).result, 'new-complete');
  } finally {
    newSocket.close();
  }
});

test('/reconnect: reloads a responsive plugin UI instead of dropping its socket', async () => {
  // Without a plugin: ok:true, hadPlugin:false.
  const idle = await (await fetch(`http://127.0.0.1:${PORT}/reconnect`, {
    headers: auth('GET', '/reconnect'),
  })).json();
  assert.equal(idle.ok, true);
  assert.equal(idle.hadPlugin, false);

  // With an authenticated plugin: ask its still-running main thread to reload
  // only the iframe. This preserves the Figma plugin runtime and lets the new
  // iframe run a clean discovery/authentication cycle.
  const recovery = await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'RECONNECT_FILE' });
    const reload = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not request UI reload')), 3000);
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.action !== 'reload-ui') return;
        clearTimeout(timer);
        ws.send(JSON.stringify(pluginResult(message, { result: { reloading: true } })));
        resolve(message);
      });
    });
    const responsePromise = fetch(`http://127.0.0.1:${PORT}/reconnect`, {
      headers: auth('GET', '/reconnect'),
    });
    await reload;
    const body = await (await responsePromise).json();
    return { body, readyState: ws.readyState };
  });
  assert.equal(recovery.body.ok, true);
  assert.equal(recovery.body.hadPlugin, true);
  assert.equal(recovery.body.reloaded, 1);
  assert.equal(recovery.body.forcedClosed, 0);
  assert.equal(recovery.readyState, WebSocket.OPEN);
});

test('Plugin write lanes order one file while different files progress independently', async () => {
  const wsA = openWs();
  const wsB = openWs();
  try {
    await Promise.all([handshake(wsA), handshake(wsB)]);
    await Promise.all([
      pushSelection(wsA, { fileKey: 'LANE_ORDER_A' }),
      pushSelection(wsB, { fileKey: 'LANE_ORDER_B' }),
    ]);
    const events = [];
    let firstA = null;
    let secondADispatched = false;
    let resolveFirstA;
    let resolveSecondA;
    let resolveB;
    const firstASeen = new Promise((resolve) => { resolveFirstA = resolve; });
    const secondASeen = new Promise((resolve) => { resolveSecondA = resolve; });
    const bSeen = new Promise((resolve) => { resolveB = resolve; });
    wsA.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action !== 'eval') return;
      if (message.code === 'laneA1()') {
        events.push('A1');
        firstA = message;
        resolveFirstA();
      } else if (message.code === 'laneA2()') {
        events.push('A2');
        secondADispatched = true;
        wsA.send(JSON.stringify(pluginResult(message, { result: 'A2' })));
        resolveSecondA();
      }
    });
    wsB.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action !== 'eval' || message.code !== 'laneB1()') return;
      events.push('B1');
      wsB.send(JSON.stringify(pluginResult(message, { result: 'B1' })));
      resolveB();
    });

    const first = postExec({
      action: 'eval', code: 'laneA1()', fileKey: 'LANE_ORDER_A', expectedEditor: 'figma', timeoutMs: 2000,
    });
    await firstASeen;
    const second = postExec({
      action: 'eval', code: 'laneA2()', fileKey: 'LANE_ORDER_A', expectedEditor: 'figma', timeoutMs: 2000,
    });
    const other = postExec({
      action: 'eval', code: 'laneB1()', fileKey: 'LANE_ORDER_B', expectedEditor: 'figma', timeoutMs: 2000,
    });
    await bSeen;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(secondADispatched, false, 'same-file write must remain behind the active dispatch');
    wsA.send(JSON.stringify(pluginResult(firstA, { result: 'A1' })));
    await secondASeen;
    const responses = await Promise.all([first, second, other]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
    assert.deepEqual(events, ['A1', 'B1', 'A2']);
  } finally {
    try { wsA.close(); } catch {}
    try { wsB.close(); } catch {}
  }
});

test('a held same-file typed read does not consume the Plugin mutation lane', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'READ_LANE_FILE' });
    let readMessage;
    let resolveRead;
    let resolveWrite;
    const readSeen = new Promise((resolve) => { resolveRead = resolve; });
    const writeSeen = new Promise((resolve) => { resolveWrite = resolve; });
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action === 'typed-read') {
        readMessage = message;
        resolveRead();
      }
      if (message.action === 'eval' && message.code === 'sameFileWrite()') {
        ws.send(JSON.stringify(pluginResult(message, { result: 'write-complete' })));
        resolveWrite();
      }
    });
    const read = postExec({
      action: 'typed-read', operation: 'style-consumers-v1',
      request: { style: 'Surface', type: null, limit: 100, after: null },
      fileKey: 'READ_LANE_FILE', expectedEditor: 'figma', timeoutMs: 2000,
    });
    await readSeen;
    const write = postExec({
      action: 'eval', code: 'sameFileWrite()', fileKey: 'READ_LANE_FILE',
      expectedEditor: 'figma', timeoutMs: 2000,
    });
    await writeSeen;
    const writeResponse = await write;
    assert.equal(writeResponse.status, 200);
    ws.send(JSON.stringify(pluginResult(readMessage, { result: JSON.stringify({ ok: true }) })));
    const readResponse = await read;
    assert.equal(readResponse.status, 200);
    const readBody = await readResponse.json();
    assert.equal(readBody.metadata.bridgeExecutionTiming.version, 2);
    assert.equal(readBody.metadata.bridgeExecutionTiming.dispatchLane, 'read');
  });
});

test('queued deadline and HTTP cancellation never reach the Plugin write boundary', async () => {
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'LANE_CANCEL_FILE' });
    let activeMessage = null;
    const dispatchedCodes = [];
    let resolveActive;
    const activeSeen = new Promise((resolve) => { resolveActive = resolve; });
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action !== 'eval') return;
      dispatchedCodes.push(message.code);
      if (message.code === 'activeWrite()') {
        activeMessage = message;
        resolveActive();
      }
    });

    const active = postExec({
      action: 'eval', code: 'activeWrite()', fileKey: 'LANE_CANCEL_FILE', expectedEditor: 'figma', timeoutMs: 2000,
    });
    await activeSeen;
    let consistentReadSettled = false;
    const consistentRead = fetch(
      `http://127.0.0.1:${PORT}/selection?fileKey=LANE_CANCEL_FILE&consistency=after-write`,
      { headers: auth('GET', '/selection') },
    ).then((response) => {
      consistentReadSettled = true;
      return response;
    });
    const expired = postExec({
      action: 'eval', code: 'expiredWrite()', fileKey: 'LANE_CANCEL_FILE', expectedEditor: 'figma',
      timeoutMs: 2000, deadlineAt: Date.now() + 40,
    });
    const controller = new AbortController();
    const cancelled = postExec({
      action: 'eval', code: 'cancelledWrite()', fileKey: 'LANE_CANCEL_FILE', expectedEditor: 'figma', timeoutMs: 2000,
    }, { signal: controller.signal });
    const cancelledResult = assert.rejects(cancelled, /abort/i);
    setTimeout(() => controller.abort(), 20);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(consistentReadSettled, false, 'read-after-write selection must wait behind the active mutation');
    await cancelledResult;
    const expiredResponse = await expired;
    assert.equal(expiredResponse.status, 500);
    assertBridgeError(await expiredResponse.json(), {
      kind: 'timeout', phase: 'plugin-dispatch', outcome: 'not-dispatched',
    });
    ws.send(JSON.stringify(pluginResult(activeMessage, { result: 'done' })));
    assert.equal((await active).status, 200);
    assert.equal((await consistentRead).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(dispatchedCodes, ['activeWrite()']);
  });
});

test('unknown write quarantine survives reconnect until the exact lane settlement replays', async () => {
  const firstWs = openWs();
  let unknownReceipt;
  try {
    await handshake(firstWs);
    await pushSelection(firstWs, { fileKey: 'LANE_RECOVERY_FILE' });
    let resolveFirst;
    const firstSeen = new Promise((resolve) => { resolveFirst = resolve; });
    firstWs.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action !== 'eval' || message.code !== 'uncertainWrite()') return;
      unknownReceipt = terminalDispatchReceipt(message.dispatchReceipt, 'unknown', 'execution-timeout');
      firstWs.send(JSON.stringify({
        type: 'result', id: message.id, error: 'Execution timeout', dispatchReceipt: unknownReceipt,
      }));
      resolveFirst();
    });
    const firstResponsePromise = postExec({
      action: 'eval', code: 'uncertainWrite()', fileKey: 'LANE_RECOVERY_FILE', expectedEditor: 'figma', timeoutMs: 2000,
    });
    await firstSeen;
    const firstResponse = await firstResponsePromise;
    assert.equal(firstResponse.status, 500);
    assert.equal((await firstResponse.json()).bridgeError.dispatchState, 'unknown');
  } finally {
    try { firstWs.close(); } catch {}
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  const reconnect = openWs();
  try {
    await handshake(reconnect);
    await pushSelection(reconnect, { fileKey: 'LANE_RECOVERY_FILE' });
    let secondDispatched = false;
    let resolveSecond;
    const secondSeen = new Promise((resolve) => { resolveSecond = resolve; });
    reconnect.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.action !== 'eval' || message.code !== 'afterRecovery()') return;
      secondDispatched = true;
      reconnect.send(JSON.stringify(pluginResult(message, { result: 'recovered' })));
      resolveSecond();
    });
    const secondResponsePromise = postExec({
      action: 'eval', code: 'afterRecovery()', fileKey: 'LANE_RECOVERY_FILE', expectedEditor: 'figma', timeoutMs: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondDispatched, false, 'reconnect alone must not clear an uncertain old runtime');

    reconnect.send(JSON.stringify({
      type: 'lane-settled',
      dispatchReceipt: { ...unknownReceipt, requestId: '99999999-9999-4999-8999-999999999999' },
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondDispatched, false, 'a different receipt cannot release quarantine');
    reconnect.send(JSON.stringify({ type: 'lane-settled', dispatchReceipt: unknownReceipt }));
    await secondSeen;
    const secondResponse = await secondResponsePromise;
    assert.equal(secondResponse.status, 200);
    assert.equal((await secondResponse.json()).result, 'recovered');
  } finally {
    try { reconnect.close(); } catch {}
  }
});

test('malformed Asset Stream order fails integrity and removes its private partial file', async () => {
  const bytes = Buffer.from('asset');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'ASSET_STREAM_INVALID_FILE' });
    let command = null;
    const malformedSent = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('malformed asset stream was not routed')), 3000);
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(String(raw));
          if (message.action === 'asset-stream') {
            command = message;
            ws.send(JSON.stringify({
              type: 'asset-stream-start', id: message.id,
              totalBytes: bytes.length, sha256, details: { kind: 'svg' },
              dispatchReceipt: message.dispatchReceipt,
            }));
            return;
          }
          if (message.type === 'asset-stream-ack' && message.sequence === -1 && command) {
            ws.send(JSON.stringify({
              type: 'asset-stream-chunk', id: command.id,
              sequence: 1, base64: bytes.toString('base64'),
            }));
            clearTimeout(timer);
            resolve();
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    const responsePromise = postExec({
      action: 'asset-stream', asset: { kind: 'svg', ref: '1:2' },
      fileKey: 'ASSET_STREAM_INVALID_FILE', expectedEditor: 'figma', timeoutMs: 3000,
    });
    await malformedSent;
    const response = await responsePromise;
    assert.equal(response.status, 500);
    const body = await response.json();
    assertBridgeError(body, {
      kind: 'plugin-protocol', phase: 'plugin-response', outcome: 'unknown-after-dispatch',
    });
    ws.send(JSON.stringify({
      type: 'lane-settled',
      dispatchReceipt: terminalDispatchReceipt(command.dispatchReceipt, 'failed', 'execution-error'),
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(readdirSync(join(tmp, 'asset-transfers')), []);
  });
});

test('Plugin disconnect during Asset Stream removes its private partial file', async () => {
  const bytes = Buffer.alloc(256 * 1024, 0x61);
  const declaredBytes = bytes.length + 1;
  const sha256 = createHash('sha256').update(Buffer.concat([bytes, Buffer.from('b')])).digest('hex');
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'ASSET_STREAM_DISCONNECT_FILE' });
    let command = null;
    const disconnected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('disconnect asset stream was not routed')), 3000);
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(String(raw));
          if (message.action === 'asset-stream') {
            command = message;
            ws.send(JSON.stringify({
              type: 'asset-stream-start', id: message.id,
              totalBytes: declaredBytes, sha256, details: { kind: 'svg' },
              dispatchReceipt: message.dispatchReceipt,
            }));
            return;
          }
          if (message.type === 'asset-stream-ack' && message.sequence === -1 && command) {
            ws.send(JSON.stringify({
              type: 'asset-stream-chunk', id: command.id,
              sequence: 0, base64: bytes.toString('base64'),
            }));
            return;
          }
          if (message.type === 'asset-stream-ack' && message.sequence === 0) {
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    const responsePromise = postExec({
      action: 'asset-stream', asset: { kind: 'svg', ref: '1:2' },
      fileKey: 'ASSET_STREAM_DISCONNECT_FILE', expectedEditor: 'figma', timeoutMs: 3000,
    });
    await disconnected;
    const response = await responsePromise;
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.bridgeError.kind, 'plugin-unavailable');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(readdirSync(join(tmp, 'asset-transfers')), []);
  });
});

test('authenticated Asset Stream carries bytes above the JSON ceiling with backpressure and no residue', async () => {
  const bytes = Buffer.alloc(6 * 1024 * 1024, 0x5a);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const chunkBytes = 256 * 1024;
  await withAuthedWs(async (ws) => {
    await pushSelection(ws, { fileKey: 'ASSET_STREAM_FILE' });
    let command = null;
    let nextSequence = 0;
    const pluginFlow = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('asset stream protocol timed out')), 10_000);
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(String(raw));
          if (message.action === 'asset-stream') {
            command = message;
            assert.deepEqual(message.asset, { kind: 'svg', ref: '1:2' });
            assert.deepEqual(message.revisionObservation, { scope: 'page', nodeId: '1:2' });
            assert.ok(message.timeoutMs > 9_000 && message.timeoutMs <= 10_000,
              `the Plugin receives the remaining owner budget, got ${message.timeoutMs}ms`);
            assert.ok(message.deadlineAt > Date.now() && message.deadlineAt <= Date.now() + 10_000);
            ws.send(JSON.stringify({
              type: 'asset-stream-start',
              id: message.id,
              totalBytes: bytes.length,
              sha256,
              details: { kind: 'svg' },
              dispatchReceipt: message.dispatchReceipt,
            }));
            return;
          }
          if (message.type !== 'asset-stream-ack' || !command) return;
          assert.equal(message.sequence, nextSequence - 1);
          if (nextSequence * chunkBytes < bytes.length) {
            const chunk = bytes.subarray(
              nextSequence * chunkBytes,
              Math.min(bytes.length, (nextSequence + 1) * chunkBytes),
            );
            ws.send(JSON.stringify({
              type: 'asset-stream-chunk',
              id: command.id,
              sequence: nextSequence,
              base64: chunk.toString('base64'),
            }));
            nextSequence += 1;
            return;
          }
          ws.send(JSON.stringify({
            type: 'asset-stream-end',
            id: command.id,
            chunks: nextSequence,
            metadata: {
              revisionObservation: {
                scope: 'page', pageId: '0:1', revisionBefore: 4, revisionAfter: 4,
              },
            },
            dispatchReceipt: terminalDispatchReceipt(command.dispatchReceipt, 'completed'),
          }));
          clearTimeout(timer);
          resolve();
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    const client = createDaemonClient({ readToken: () => TOKEN, getPort: () => PORT });
    const streamed = await client.assetStream(
      { kind: 'svg', ref: '1:2' },
      {
        expectedEditor: 'figma',
        fileKey: 'ASSET_STREAM_FILE',
        revisionObservation: { scope: 'page', nodeId: '1:2' },
        timeoutMs: 10_000,
      },
    );
    await pluginFlow;
    assert.deepEqual(streamed.bytes, bytes);
    assert.equal(streamed.totalBytes, bytes.length);
    assert.equal(streamed.sha256, sha256);
    assert.deepEqual(streamed.details, { kind: 'svg' });
    assert.deepEqual(streamed.metadata.revisionObservation, {
      scope: 'page', pageId: '0:1', revisionBefore: 4, revisionAfter: 4,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(readdirSync(join(tmp, 'asset-transfers')), [],
      'the one-shot authenticated download must remove its private transfer file');
  });
});

test('Daemon Client shutdown drains an in-flight execution before closing the Plugin socket', async () => {
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon did not exit after graceful shutdown')), 3000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await withAuthedWs(async (ws) => {
    let dispatched;
    const routed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon did not route the in-flight eval')), 3000);
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.action !== 'eval') return;
        clearTimeout(timer);
        dispatched = message;
        resolve();
      });
    });
    const body = JSON.stringify({ action: 'eval', code: 'longRead()', expectedEditor: 'figma' });
    const execution = fetch(`http://127.0.0.1:${PORT}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth('POST', '/exec', body) },
      body,
    });
    await routed;

    const client = createDaemonClient({
      readToken: () => TOKEN,
      getPort: () => PORT,
    });
    const shutdown = await client.shutdown({ timeoutMs: 1000 });
    assert.equal(shutdown.ok, true);
    assert.equal(shutdown.data.ok, true);
    assert.equal(ws.readyState, WebSocket.OPEN,
      'accepted shutdown must keep the Plugin socket open while execution is in flight');

    await new Promise((resolve) => setTimeout(resolve, 200));
    ws.send(JSON.stringify(pluginResult(dispatched, { result: { drained: true } })));
    const response = await execution;
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, { drained: true });
  });
  assert.equal(await exited, 0);
});
