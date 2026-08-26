import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonClient, DaemonClientError } from '../src/lib/daemon-client.js';

const FIGMA = Object.freeze({ expectedEditor: 'figma' });

function response(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return typeof value === 'string' ? value : JSON.stringify(value); },
  };
}

test('daemon client concentrates signed execution and explicit file targeting', async () => {
  const calls = [];
  const client = createDaemonClient({
    readToken: () => 'secret-token',
    getPort: () => 3456,
    defaultFileKey: () => 'DEFAULT_FILE',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { result: 'ok' });
    },
  });

  assert.equal(await client.evaluate('1 + 1', {
    fileKey: 'EXPLICIT_FILE', timeoutMs: 54321, expectedEditor: 'figma',
  }), 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3456/exec');
  const executionBody = JSON.parse(calls[0].options.body);
  assert.ok(executionBody.deadlineAt > Date.now());
  delete executionBody.deadlineAt;
  assert.deepEqual(executionBody, {
    action: 'eval', code: '1 + 1', expectedEditor: 'figma', fileKey: 'EXPLICIT_FILE', timeoutMs: 54321,
  });
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.ok(calls[0].options.headers['X-Daemon-Auth']);
  assert.doesNotMatch(JSON.stringify(calls[0]), /secret-token/);
});

test('metadata-aware eval preserves daemon-owned Capture freshness facts', async () => {
  const bodies = [];
  const metadata = {
    connectionId: 'CONN_A', fileKey: 'FILE_A',
    documentRevisionBefore: 7, documentRevisionAfter: 7,
  };
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return response(200, { result: { ok: true }, metadata });
    },
  });
  assert.deepEqual(await client.evaluateWithMetadata('capture()', FIGMA), {
    value: { ok: true }, metadata,
  });
  assert.deepEqual(await client.evaluate('capture()', FIGMA), { ok: true }, 'value-only Adapter stays compatible');
  assert.equal(bodies[0].requireDocumentRevision, true,
    'metadata-aware reads explicitly pay for the document-wide revision proof');
  assert.equal(Object.hasOwn(bodies[1], 'requireDocumentRevision'), false,
    'ordinary eval retains Figma dynamic-page loading');
});

test('daemon client sends Semantic Render Plans as structured authenticated payloads', async () => {
  let body;
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response(200, { result: { id: '1:2' } }); },
  });
  const plan = { kind: 'figma-bridge/semantic-render-plan', version: 1, adapter: 'jsx', root: {}, diagnostics: {} };
  assert.deepEqual(await client.renderPlan(plan, {
    ...FIGMA, renderOptions: { smart: false, x: -10, y: 20 },
  }), { id: '1:2' });
  assert.ok(body.deadlineAt > Date.now());
  delete body.deadlineAt;
  assert.deepEqual(body, {
    action: 'render-plan', plan, options: { smart: false, x: -10, y: 20 },
    expectedEditor: 'figma', timeoutMs: 90000,
  });
});

test('daemon client sends native Semantic Render Plan batches without JavaScript code', async () => {
  let body;
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response(200, { result: { frames: [] } }); },
  });
  const plans = [{ kind: 'figma-bridge/semantic-render-plan', version: 1 }];
  assert.deepEqual(await client.renderPlanBatch(plans, { gap: 20, vertical: false }, FIGMA), { frames: [] });
  assert.ok(body.deadlineAt > Date.now());
  delete body.deadlineAt;
  assert.deepEqual(body, {
    action: 'render-plan-batch', plans, options: { gap: 20, vertical: false }, expectedEditor: 'figma', timeoutMs: 90000,
  });
});

test('daemon client sends closed typed reads and falls back only before dispatch', async () => {
  const bodies = [];
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body);
      if (body.action === 'typed-read') return response(500, { bridgeError: {
        schema: 1, kind: 'plugin-capability', phase: 'plugin-dispatch',
        outcome: 'not-dispatched', dispatchState: 'not-dispatched', message: 'typed-read unavailable',
      } });
      return response(200, { result: 'fallback-result' });
    },
  });
  const request = { style: 'Surface', type: null, limit: 100, after: null };
  assert.equal(await client.typedReadWithFallback(
    'style-consumers-v1', request, '(async()=>"ok")()', FIGMA,
  ), 'fallback-result');
  assert.equal(bodies[0].action, 'typed-read');
  assert.equal(Object.hasOwn(bodies[0], 'code'), false);
  assert.equal(bodies[1].action, 'eval');
  await assert.rejects(() => client.typedRead('future', request, FIGMA), /unsupported/);
});

test('daemon client signs the stable selection path while targeting through the query', async () => {
  let seen;
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3457,
    fetchImpl: async (url, options) => { seen = { url, options }; return response(200, { selection: [] }); },
  });
  const result = await client.selection({ fileKey: 'FILE A', readAfterWrite: true });
  assert.equal(result.data.selection.length, 0);
  assert.equal(seen.url, 'http://127.0.0.1:3457/selection?fileKey=FILE+A&consistency=after-write');
  assert.ok(seen.options.headers['X-Daemon-Auth']);
});

test('daemon client requests authenticated plugin self-recovery', async () => {
  const seen = [];
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3458,
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      if (url.endsWith('/health')) return response(200, { status: 'ok', plugin: true });
      if (url.endsWith('/shutdown')) return response(200, { ok: true });
      return response(200, { ok: true, hadPlugin: true, reloaded: 1, forcedClosed: 0 });
    },
  });
  const health = await client.health({ timeoutMs: 1000 });
  const reconnect = await client.reconnect({ timeoutMs: 6000 });
  const shutdown = await client.shutdown({ timeoutMs: 1000 });
  assert.equal(health.data.plugin, true);
  assert.equal(reconnect.data.reloaded, 1);
  assert.equal(shutdown.data.ok, true);
  assert.deepEqual(seen.map(({ url }) => url), [
    'http://127.0.0.1:3458/health',
    'http://127.0.0.1:3458/reconnect',
    'http://127.0.0.1:3458/shutdown',
  ]);
  for (const call of seen) {
    assert.equal(call.options.method, 'GET');
    assert.ok(call.options.headers['X-Daemon-Auth']);
  }
});

test('daemon client exposes stable error kinds for adapter fallback decisions', async () => {
  const missing = createDaemonClient({ readToken: () => null, getPort: () => 3456, fetchImpl: async () => response(200, {}) });
  await assert.rejects(() => missing.evaluate('x', FIGMA), (error) => {
    assert.ok(error instanceof DaemonClientError);
    assert.equal(error.kind, 'missing-token');
    return true;
  });

  let unavailableCalls = 0;
  const unavailable = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => { unavailableCalls++; throw new TypeError('fetch failed'); },
  });
  await assert.rejects(() => unavailable.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'unavailable');
    assert.match(error.message, /Daemon not reachable/);
    return true;
  });
  assert.equal(unavailableCalls, 1, 'uncertain daemon execution must never be retried');

  const pluginDown = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => response(503, { error: 'Plugin not connected' }),
  });
  await assert.rejects(() => pluginDown.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'plugin-unavailable');
    assert.match(error.message, /Plugins → Development/);
    return true;
  });

  const pluginDropped = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => response(503, { error: 'Plugin disconnected' }),
  });
  await assert.rejects(() => pluginDropped.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'plugin-unavailable');
    assert.match(error.message, /reconnect/i);
    assert.match(error.message, /may have completed/);
    assert.match(error.message, /do not repeat it automatically/);
    assert.doesNotMatch(error.message, /retry/i);
    return true;
  });

  const pluginStalled = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => response(503, { error: 'Plugin execution timeout (25s)' }),
  });
  await assert.rejects(() => pluginStalled.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'plugin-timeout');
    assert.match(error.message, /foreground/i);
    assert.match(error.message, /socket is open/i);
    assert.match(error.message, /may have completed/);
    assert.match(error.message, /do not repeat it automatically/);
    assert.doesNotMatch(error.message, /retry/i);
    return true;
  });

  const authFailure = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456, tokenFile: '/state/.daemon-token',
    fetchImpl: async () => response(403, { error: 'Unauthorized request token' }),
  });
  await assert.rejects(() => authFailure.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'authentication');
    assert.equal(error.status, 403);
    assert.match(error.message, /Token file: \/state\/\.daemon-token/);
    return true;
  });
});

test('daemon client preserves actionable multi-window target details', async () => {
  const client = createDaemonClient({
    readToken: () => 'token',
    getPort: () => 3456,
    fetchImpl: async () => response(500, {
      error: '2 Figma windows are connected — name one with fileKey. Connected:\n'
        + '  FILE_A  Alpha\n'
        + '  FILE_B  Beta\n'
        + 'There is no "all files" option: each file is targeted explicitly.',
    }),
  });

  await assert.rejects(() => client.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'targeting');
    assert.equal(error.phase, 'target-resolution');
    assert.equal(error.outcome, 'not-dispatched');
    assert.equal(error.legacy, true);
    assert.match(error.message, /name one with fileKey/);
    assert.match(error.message, /FILE_A  Alpha/);
    assert.match(error.message, /FILE_B  Beta/);
    assert.match(error.message, /no "all files" option/);
    return true;
  });
});

test('daemon client trusts structured execution facts instead of domain prose', async () => {
  const mutationReport = {
    version: 1,
    outcome: 'rolled-back',
    created: 2,
    removed: 2,
    residueCount: 0,
    residue: [],
    residueTruncated: false,
  };
  const client = createDaemonClient({
    readToken: () => 'token',
    getPort: () => 3456,
    fetchImpl: async () => response(500, {
      error: 'Token alias could not be resolved',
      bridgeError: {
        schema: 1,
        kind: 'execution',
        phase: 'plugin-execution',
        outcome: 'unknown-after-dispatch',
        dispatchState: 'failed',
        message: 'Token alias could not be resolved',
        mutationReport,
      },
    }),
  });

  await assert.rejects(() => client.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'execution');
    assert.equal(error.phase, 'plugin-execution');
    assert.equal(error.outcome, 'unknown-after-dispatch');
    assert.equal(error.dispatchState, 'failed');
    assert.equal(error.legacy, false);
    assert.deepEqual(error.mutationReport, mutationReport);
    assert.doesNotMatch(error.message, /Token file:/);
    return true;
  });
});

test('legacy string-only daemon errors stay compatible without token substring auth inference', async () => {
  const domain = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => response(500, { error: 'Token alias could not be resolved' }),
  });
  await assert.rejects(() => domain.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'execution');
    assert.equal(error.outcome, 'unknown-after-dispatch');
    assert.equal(error.legacy, true);
    return true;
  });
});

test('legacy daemon error bodies are bounded before they become client messages', async () => {
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => response(500, 'x'.repeat(40_000)),
  });
  await assert.rejects(() => client.evaluate('x', FIGMA), (error) => {
    assert.equal(error.kind, 'execution');
    assert.equal(error.legacy, true);
    assert.ok(Buffer.byteLength(error.message, 'utf8') <= 16 * 1024);
    return true;
  });
});

test('daemon client refuses execution without the Command Plan editor identity', async () => {
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => assert.fail('invalid execution must not reach the daemon'),
  });
  await assert.rejects(
    () => client.evaluate('x'),
    /requires expectedEditor from the Command Plan/,
  );
});
