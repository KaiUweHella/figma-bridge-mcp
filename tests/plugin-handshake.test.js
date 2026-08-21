// The plugin panel cannot import modules — it is a single inlined HTML file
// loaded by Figma — so it carries its OWN SHA-256/HMAC and its own copy of the
// handshake transcript format. Two implementations of one protocol is exactly
// the setup where a silent drift ships: the daemon would keep rejecting proofs
// and the only symptom would be "Access key rejected".
//
// These tests pull the real functions out of plugin/ui.html, run them, and
// compare against Node's crypto and against engine/src/lib/plugin-handshake.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createHmac, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HANDSHAKE_PROTO,
  pluginTranscript,
  daemonTranscript,
  sign,
  verify,
  makeNonce,
  isNonce,
} from '../engine/src/lib/plugin-handshake.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI = readFileSync(join(ROOT, 'plugin', 'ui.html'), 'utf8');
const PLUGIN_CODE = readFileSync(join(ROOT, 'plugin', 'code.js'), 'utf8');

// Lift the panel's crypto out of the HTML and evaluate it standalone. Slicing
// on the real function boundaries means a rename or a move breaks the test
// loudly instead of silently testing a stale copy.
//
// The `new Function` below compiles a slice of OUR OWN checked-in ui.html —
// the same bytes npm ships — with no external input anywhere in the string.
// Running the real code is the whole point: a re-implementation here could
// agree with Node while the shipped panel drifted.
function loadPluginCrypto() {
  const start = UI.indexOf('const SHA_K = new Uint32Array([');
  const endMarker = 'const PORTS =';
  const end = UI.indexOf(endMarker);
  assert.ok(start > 0, 'SHA_K table not found in ui.html — did the crypto block move?');
  assert.ok(end > start, 'PORTS marker not found after the crypto block');
  const source = UI.slice(start, end);
  for (const needed of ['function sha256', 'function hmacSha256Hex', 'function proofEquals']) {
    assert.ok(source.includes(needed), `${needed} missing from the extracted block`);
  }
  const factory = new Function(`${source}; return { sha256, hmacSha256Hex, toHex, proofEquals };`);
  return factory();
}

const plugin = loadPluginCrypto();

function loadPluginReconnect() {
  const start = UI.indexOf('function scanPorts(');
  const end = UI.indexOf('function connectParallel(', start);
  assert.ok(start > 0, 'scanPorts() not found in ui.html');
  assert.ok(end > start, 'connectParallel() marker not found after scanPorts()');
  const source = UI.slice(start, end);
  const factory = new Function(
    'PORTS',
    'MAX_INITIAL_WS_SCANS',
    'HEALTH_DISCOVERY_MS',
    `${source}; return { scanPorts, reconnectDelay, recoveryStrategy, isBridgeReadyPayload, probeBridgePort };`,
  );
  return factory([3456, 3457, 3458, 3459, 3460], 3, 3000);
}

test('plugin HMAC matches Node crypto across sizes and key lengths', () => {
  const cases = [
    ['k', ''],
    ['short-key', 'hello'],
    ['test-access-key-0123456789', 'figma-bridge-mcp/handshake/v2|plugin|abc|def|3456|3.0.0'],
    // Key longer than the 64-byte block, which HMAC must hash down first.
    ['x'.repeat(200), 'y'.repeat(500)],
    // Message spanning several SHA-256 blocks, incl. a length near a boundary.
    ['key', 'z'.repeat(55)],
    ['key', 'z'.repeat(56)],
    ['key', 'z'.repeat(64)],
    ['key', 'z'.repeat(1000)],
    // Non-ASCII: both sides must agree on UTF-8 encoding.
    ['schlüssel', 'nachricht mit ümlauten — und einem Emoji 🔌'],
  ];
  for (const [key, msg] of cases) {
    assert.equal(
      plugin.hmacSha256Hex(key, msg),
      createHmac('sha256', key).update(msg).digest('hex'),
      `HMAC drift for key=${key.slice(0, 12)}… msg len ${msg.length}`,
    );
  }
});

test('plugin HMAC matches on random inputs', () => {
  for (let i = 0; i < 50; i++) {
    const key = randomBytes(1 + (i % 90)).toString('hex');
    const msg = randomBytes(i * 7).toString('hex');
    assert.equal(
      plugin.hmacSha256Hex(key, msg),
      createHmac('sha256', key).update(msg).digest('hex'),
    );
  }
});

test('proofEquals accepts equal strings and rejects length or content mismatch', () => {
  assert.equal(plugin.proofEquals('abc', 'abc'), true);
  assert.equal(plugin.proofEquals('abc', 'abd'), false);
  assert.equal(plugin.proofEquals('abc', 'ab'), false);
  assert.equal(plugin.proofEquals('abc', ''), false);
  assert.equal(plugin.proofEquals(undefined, 'abc'), false);
});

test('ui.html and the engine lib agree on proto version and transcript prefix', () => {
  assert.match(
    UI,
    new RegExp(`const HANDSHAKE_PROTO = ${HANDSHAKE_PROTO};`),
    'plugin HANDSHAKE_PROTO out of step with engine/src/lib/plugin-handshake.js',
  );
  // The prefix is baked into both transcripts; derive it from the lib rather
  // than repeating the literal here, so there is exactly one source of truth.
  const prefix = pluginTranscript({ daemonNonce: 'D', pluginNonce: 'P', port: 1, version: 'V' }).split('|')[0];
  assert.ok(UI.includes(`const HANDSHAKE_PREFIX = '${prefix}';`), `plugin prefix must be ${prefix}`);
});

test('plugin builds the exact transcripts the daemon verifies', () => {
  const daemonNonce = makeNonce();
  const pluginNonce = makeNonce();
  const port = 3457;
  const version = '3.0.0';
  const KEY = 'the-access-key';

  // Rebuild the strings exactly as ui.html concatenates them.
  const prefix = pluginTranscript({ daemonNonce: 'D', pluginNonce: 'P', port: 1, version: 'V' }).split('|')[0];
  const asPlugin = `${prefix}|plugin|${daemonNonce}|${pluginNonce}|${port}|${version}`;
  const asDaemon = `${prefix}|daemon|${pluginNonce}|${daemonNonce}|${port}`;

  assert.equal(asPlugin, pluginTranscript({ daemonNonce, pluginNonce, port, version }));
  assert.equal(asDaemon, daemonTranscript({ daemonNonce, pluginNonce, port }));

  // And the proof the panel would send verifies with the daemon's checker.
  const proof = plugin.hmacSha256Hex(KEY, asPlugin);
  assert.ok(verify(KEY, pluginTranscript({ daemonNonce, pluginNonce, port, version }), proof));

  // The daemon's ack verifies with the panel's checker.
  const ack = sign(KEY, daemonTranscript({ daemonNonce, pluginNonce, port }));
  assert.ok(plugin.proofEquals(plugin.hmacSha256Hex(KEY, asDaemon), ack));
});

test('plugin advertises structured rendering only after the authenticated hello', () => {
  assert.match(UI, /capabilities: \['render-plan-v1', 'render-plan-batch-v1'\]/);
  assert.ok(UI.indexOf("capabilities: ['render-plan-v1', 'render-plan-batch-v1']") > UI.indexOf("type: 'hello'"));
});

test('the two transcripts are not interchangeable', () => {
  const daemonNonce = makeNonce();
  const pluginNonce = makeNonce();
  const KEY = 'k';
  const p = sign(KEY, pluginTranscript({ daemonNonce, pluginNonce, port: 3456, version: 'v' }));
  // A harvested plugin proof must not pass as a daemon proof (nonce order and
  // role label differ) — otherwise a squatter could echo it back and be trusted.
  assert.equal(verify(KEY, daemonTranscript({ daemonNonce, pluginNonce, port: 3456 }), p), false);
});

test('the port is bound into the proof, which is what kills a relaying squatter', () => {
  const daemonNonce = makeNonce();
  const pluginNonce = makeNonce();
  const KEY = 'k';
  // Plugin connected to 3456; the real daemon is on 3457. Its proof must fail.
  const proofFor3456 = sign(KEY, pluginTranscript({ daemonNonce, pluginNonce, port: 3456, version: 'v' }));
  assert.equal(
    verify(KEY, pluginTranscript({ daemonNonce, pluginNonce, port: 3457, version: 'v' }), proofFor3456),
    false,
  );
});

test('nonces are 32 bytes of hex and do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const n = makeNonce();
    assert.ok(isNonce(n), `${n} is not a valid nonce`);
    assert.equal(seen.has(n), false, 'nonce repeated');
    seen.add(n);
  }
  assert.equal(isNonce('short'), false);
  assert.equal(isNonce('A'.repeat(64)), false, 'uppercase hex must be rejected');
});

test('the shipped plugin scripts parse', () => {
  // Nothing else compiles these: plugin/ui.html and plugin/code.js are copied
  // verbatim into ~/.figma-bridge-mcp/plugin and only ever parsed by Figma. A
  // syntax slip would otherwise ship and surface as a blank plugin panel.
  const script = UI.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'ui.html must contain a <script> block');
  new Script(script[1], { filename: 'plugin/ui.html' });
  new Script(PLUGIN_CODE, { filename: 'plugin/code.js' });
});

test('the shipped plugin UI opens Setup for a missing key and scans after receiving a stored key', () => {
  // Parsing alone does not catch stale renamed constants: the previous build
  // parsed successfully, then threw only when the stored-key message entered
  // connectParallel(), leaving the real panel stuck on "Starting…". Exercise
  // that exact browser-side path with the smallest DOM/socket harness.
  const script = UI.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'ui.html must contain a <script> block');

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      const attributes = new Map();
      elements.set(id, {
        id,
        value: '',
        textContent: '',
        className: '',
        hidden: false,
        focused: false,
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          toggle(name, force) {
            if (force === true) classes.add(name);
            else if (force === false) classes.delete(name);
            else if (classes.has(name)) classes.delete(name);
            else classes.add(name);
            return classes.has(name);
          },
          contains(name) { return classes.has(name); },
        },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        focus() { this.focused = true; },
      });
    }
    return elements.get(id);
  };
  const posted = [];
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }
    close() {}
    send() {}
  }
  const window = { crypto: null, scrollY: 0, onmessage: null };
  const context = {
    window,
    document: {
      getElementById: element,
      body: { children: [] },
      createElement: () => element('created'),
    },
    parent: { postMessage: (message) => posted.push(message) },
    WebSocket: FakeWebSocket,
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    fetch: async () => ({ ok: false }),
    console: { log() {}, warn() {}, error() {} },
  };

  new Script(script[1], { filename: 'plugin/ui.html' }).runInNewContext(context);
  assert.equal(posted.at(-1)?.pluginMessage?.type, 'get-key');
  assert.equal(typeof window.onmessage, 'function');

  window.onmessage({ data: { pluginMessage: { type: 'key', value: '' } } });
  assert.equal(elements.get('status').textContent, 'Enter your access key');
  assert.equal(elements.get('setupPanel').classList.contains('show'), true);
  assert.equal(elements.get('setupBtn').getAttribute('aria-expanded'), 'true');
  assert.equal(elements.get('keyPanel').classList.contains('attention'), true);
  assert.equal(elements.get('keyInput').focused, true);

  window.onmessage({ data: { pluginMessage: { type: 'key', value: 'stored-test-key' } } });
  assert.equal(elements.get('status').textContent, 'Scanning…');
  assert.deepEqual(sockets.map((socket) => socket.url), [
    'ws://localhost:3456/plugin',
    'ws://localhost:3457/plugin',
    'ws://localhost:3458/plugin',
    'ws://localhost:3459/plugin',
    'ws://localhost:3460/plugin',
  ]);
});

test('Capture revision metadata crosses both plugin threads', () => {
  assert.match(PLUGIN_CODE, /figma\.on\('documentchange'/);
  assert.match(PLUGIN_CODE, /documentRevisionBefore/);
  assert.match(PLUGIN_CODE, /documentRevisionAfter/);
  assert.match(UI, /metadata: msg\.metadata/);
});

test('verify rejects malformed proofs instead of throwing', () => {
  const t = daemonTranscript({ daemonNonce: 'a', pluginNonce: 'b', port: 1 });
  assert.equal(verify('k', t, undefined), false);
  assert.equal(verify('k', t, 'not-hex'), false);
  assert.equal(verify('k', t, 'ab'), false);
  assert.equal(verify('', t, sign('k', t)), false, 'no key ⇒ no trust');
});

test('plugin retries as soon as every localhost port refuses the scan', () => {
  const reconnect = loadPluginReconnect();
  const sockets = [];
  let exhausted = 0;
  let fallback = null;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    close() {}
  }

  reconnect.scanPorts({
    ports: [3456, 3457, 3458],
    WebSocketCtor: FakeWebSocket,
    timeoutMs: 750,
    isCurrent: () => true,
    onOpen: () => assert.fail('no fake socket should open'),
    onExhausted: () => { exhausted++; },
    setTimer: (fn) => { fallback = fn; return 1; },
    clearTimer: () => {},
  });

  assert.equal(exhausted, 0);
  assert.deepEqual(sockets.map((socket) => socket.url), [
    'ws://localhost:3456/plugin',
    'ws://localhost:3457/plugin',
    'ws://localhost:3458/plugin',
  ]);
  for (const socket of sockets) {
    socket.onerror();
    // Browsers commonly emit error + close; count once. The final error may
    // already finish the round and clear its close handler during cleanup.
    if (socket.onclose) socket.onclose();
  }
  assert.equal(exhausted, 1, 'must not wait for the fallback timeout');
  fallback();
  assert.equal(exhausted, 1, 'fallback timer must not exhaust twice');
});

test('plugin bounds failed WebSocket scans and hands recovery to quiet HTTP discovery', async () => {
  const reconnect = loadPluginReconnect();
  assert.ok(reconnect.reconnectDelay(1) <= 150, 'initial retries should be near-immediate');
  assert.deepEqual(reconnect.recoveryStrategy(1), { kind: 'websocket', delayMs: 120 });
  assert.deepEqual(reconnect.recoveryStrategy(3), { kind: 'health', delayMs: 3000 });
  assert.equal(reconnect.isBridgeReadyPayload({ bridge: 'figma-bridge-mcp', ready: true, port: 3456 }), true);
  assert.equal(reconnect.isBridgeReadyPayload({ bridge: 'another-local-service', ready: true, port: 3456 }), false);
  let requestedUrl = null;
  assert.deepEqual(
    await reconnect.probeBridgePort(3456, async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({ bridge: 'figma-bridge-mcp', ready: true, port: 3456 }),
      };
    }),
    { port: 3456 },
  );
  assert.equal(requestedUrl, 'http://localhost:3456/plugin-ready');
  assert.match(UI, /fetchImpl\(`http:\/\/localhost:\$\{port\}\/plugin-ready`/);
});

test('manual reconnect stays visible and restarts the whole connection state', () => {
  assert.match(
    UI,
    /<button id="reconnectBtn" class="icon" type="button" aria-label="Reconnect now" title="Reconnect now">/,
    'the user must always have an immediate reconnect action',
  );
  const statusCard = UI.slice(UI.indexOf('<div class="card">'), UI.indexOf('<div id="selInfo">'));
  assert.match(statusCard, /id="reconnectBtn"/, 'manual reconnect belongs in the connection status card');
  assert.match(statusCard, /<svg[\s\S]*?<path d="M481\.54-180/, 'the supplied reload icon must remain embedded');

  const start = UI.indexOf('function forceReconnect()');
  const end = UI.indexOf('// ============ Selection display', start);
  assert.ok(start > 0, 'forceReconnect() not found in ui.html');
  assert.ok(end > start, 'selection marker not found after forceReconnect()');
  const source = UI.slice(start, end);
  assert.match(source, /teardown\(\)/, 'manual reconnect must cancel an open socket and in-flight scan');
  assert.match(source, /failedScans\s*=\s*0/, 'manual reconnect must restore the fast retry state');
  assert.match(source, /connectParallel\(\)/, 'manual reconnect must scan immediately');
  assert.match(source, /reconnectBtn\.onclick\s*=\s*forceReconnect/);
});

test('daemon recovery can reload only the Figma plugin iframe', () => {
  assert.match(
    UI,
    /msg\.action === 'reload-ui'[\s\S]*?pluginMessage:\s*\{\s*type:\s*'reload-ui',\s*id:\s*msg\.id/,
    'the authenticated socket must be able to ask the plugin main thread for a clean UI reload',
  );
  assert.match(
    PLUGIN_CODE,
    /msg\.type === 'reload-ui'[\s\S]*?figma\.ui\.postMessage\(\{\s*type:\s*'result'[\s\S]*?figma\.showUI\(__html__/,
    'the main thread must acknowledge the request before replacing the iframe',
  );
});
