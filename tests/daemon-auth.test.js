// Security-core tests for the vendored daemon's authentication.
//
// Spawns engine/src/daemon.js on a scratch port with temp token/key/pid files
// (all env-overridable) so nothing touches the user's real ~/.figma-safe-mcp
// state, then exercises the signed-request HTTP gate and the WebSocket
// access-key gate. HTTP auth is per-request HMAC signing (X-Daemon-Ts/-Nonce/
// -Auth) — the session token itself never crosses the wire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, '..', 'engine', 'src', 'daemon.js');

const PORT = 34567; // scratch port, outside the 3456–3460 plugin range
const TOKEN = 'test-daemon-token-abcdef';
const KEY = 'test-access-key-0123456789';

let tmp;
let child;

// Fresh signed headers per call — nonces are single-use by design.
function auth(method, path, body = '', token = TOKEN) {
  return signRequest(token, method, path, body);
}

function httpHealth(headers = {}) {
  return fetch(`http://127.0.0.1:${PORT}/health`, { headers });
}

function waitForListen(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const res = await httpHealth(auth('GET', '/health'));
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error('daemon did not start'));
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

const PLUGIN_VERSION = 't';

/**
 * Play the plugin's side of the proto-2 handshake: wait for the daemon's
 * challenge, answer with a proof, and return everything both sides exchanged.
 * `mutate` gets the outgoing hello and may sabotage any field — that is how the
 * negative tests below forge protos, nonces, ports and proofs.
 */
function handshake(ws, { mutate = (h) => h, key = KEY, timeoutMs = 3000 } = {}) {
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
          version: PLUGIN_VERSION,
          nonce: pluginNonce,
          proof: signHandshake(key, pluginTranscript({
            daemonNonce: m.nonce,
            pluginNonce,
            port: m.port,
            version: PLUGIN_VERSION,
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
  tmp = mkdtempSync(join(tmpdir(), 'figma-safe-daemon-'));
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
      // Keep the test daemon's published-port file out of ~/.figma-safe-mcp —
      // a SIGKILLed test run must never leave a stale real port file behind.
      DAEMON_PORT_FILE: join(tmp, 'port'),
      PLUGIN_KEY_FILE: keyFile,
      DAEMON_IDLE_TIMEOUT: '600000',
    },
    stdio: 'ignore',
  });
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

test('HTTP /health with a valid signature succeeds and reports Safe-Mode shape', async () => {
  const res = await httpHealth(auth('GET', '/health'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cdp, false);
  assert.equal(body.keyConfigured, true);
  assert.equal(body.plugin, false); // no plugin connected yet
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

test('HTTP /exec without signed headers is rejected (403)', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'eval', code: '1' }),
  });
  assert.equal(res.status, 403);
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
    }), ack.proof),
    'daemon proof must verify under the shared key',
  );

  // /health now reports an authenticated plugin.
  const res = await httpHealth(auth('GET', '/health'));
  const body = await res.json();
  assert.equal(body.plugin, true);
  assert.equal(body.pluginAuthenticated, true);
  ws.close();
});

test('the access key never appears on the wire', async () => {
  // The whole point of proto 2: a squatter that records every frame of a
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

test('second window supersedes the first: old socket gets notified and closed with 4409', async () => {
  await withAuthedWs(async (first) => {
    const displaced = new Promise((resolve, reject) => {
      let sawMessage = false;
      first.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'superseded') sawMessage = true;
      });
      first.on('close', (code) => resolve({ code, sawMessage }));
      setTimeout(() => reject(new Error('first socket was not displaced')), 3000);
    });
    // Second window authenticates → last hello wins.
    await withAuthedWs(async () => {
      const { code, sawMessage } = await displaced;
      assert.equal(code, 4409, 'displaced socket must close with 4409');
      assert.equal(sawMessage, true, 'displaced socket must receive the superseded message');
      // The daemon now routes to the SECOND socket: health still shows a plugin.
      const body = await (await httpHealth(auth('GET', '/health'))).json();
      assert.equal(body.plugin, true);
    });
  });
});

test('/selection: plugin push is cached and served with auth', async () => {
  // Before any push: null selection.
  const empty = await (await fetch(`http://127.0.0.1:${PORT}/selection`, {
    headers: auth('GET', '/selection'),
  })).json();
  assert.equal(empty.selection, null);

  await withAuthedWs(async (ws) => {
    ws.send(JSON.stringify({
      type: 'selection',
      selection: { page: 'Page 1', total: 2, nodes: [
        { id: '1:2', name: 'Hero', type: 'FRAME', width: 100, height: 50 },
        // Component identity fields must pass the whitelist; junk must not,
        // and over-length keys are truncated.
        { id: '1:3', name: 'CTA', type: 'INSTANCE',
          componentKey: 'k'.repeat(200), setKey: 'sk1', mainName: 'Primary', setName: 'Button',
          evil: 'dropped', __proto__injection: 'dropped' },
      ] },
    }));
    await new Promise((r) => setTimeout(r, 150)); // let the daemon process it
  });

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

  // Unauthenticated read is rejected like every other route.
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/selection`);
  assert.equal(noAuth.status, 403);
});

test('/reconnect: closes the plugin socket and reports hadPlugin', async () => {
  // Without a plugin: ok:true, hadPlugin:false.
  const idle = await (await fetch(`http://127.0.0.1:${PORT}/reconnect`, {
    headers: auth('GET', '/reconnect'),
  })).json();
  assert.equal(idle.ok, true);
  assert.equal(idle.hadPlugin, false);

  // With an authenticated plugin: socket gets closed by the daemon.
  const closedByDaemon = await withAuthedWs(async (ws) => {
    const closed = new Promise((resolve) => ws.on('close', () => resolve(true)));
    const body = await (await fetch(`http://127.0.0.1:${PORT}/reconnect`, {
      headers: auth('GET', '/reconnect'),
    })).json();
    assert.equal(body.ok, true);
    assert.equal(body.hadPlugin, true);
    return Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 2000))]);
  });
  assert.equal(closedByDaemon, true);
});
