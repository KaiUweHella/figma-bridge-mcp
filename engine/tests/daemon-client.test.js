import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonClient, DaemonClientError } from '../src/lib/daemon-client.js';

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

  assert.equal(await client.evaluate('1 + 1', { fileKey: 'EXPLICIT_FILE' }), 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3456/exec');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    action: 'eval', code: '1 + 1', fileKey: 'EXPLICIT_FILE',
  });
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.ok(calls[0].options.headers['X-Daemon-Auth']);
  assert.doesNotMatch(JSON.stringify(calls[0]), /secret-token/);
});

test('metadata-aware eval preserves daemon-owned Capture freshness facts', async () => {
  const metadata = {
    connectionId: 'CONN_A', fileKey: 'FILE_A',
    documentRevisionBefore: 7, documentRevisionAfter: 7,
  };
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => response(200, { result: { ok: true }, metadata }),
  });
  assert.deepEqual(await client.evaluateWithMetadata('capture()'), {
    value: { ok: true }, metadata,
  });
  assert.deepEqual(await client.evaluate('capture()'), { ok: true }, 'value-only Adapter stays compatible');
});

test('daemon client sends Semantic Render Plans as structured authenticated payloads', async () => {
  let body;
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response(200, { result: { id: '1:2' } }); },
  });
  const plan = { kind: 'figma-bridge/semantic-render-plan', version: 1, adapter: 'jsx', root: {}, diagnostics: {} };
  assert.deepEqual(await client.renderPlan(plan), { id: '1:2' });
  assert.deepEqual(body, { action: 'render-plan', plan });
});

test('daemon client sends native Semantic Render Plan batches without JavaScript code', async () => {
  let body;
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response(200, { result: { frames: [] } }); },
  });
  const plans = [{ kind: 'figma-bridge/semantic-render-plan', version: 1 }];
  assert.deepEqual(await client.renderPlanBatch(plans, { gap: 20, vertical: false }), { frames: [] });
  assert.deepEqual(body, { action: 'render-plan-batch', plans, options: { gap: 20, vertical: false } });
});

test('daemon client signs the stable selection path while targeting through the query', async () => {
  let seen;
  const client = createDaemonClient({
    readToken: () => 'token', getPort: () => 3457,
    fetchImpl: async (url, options) => { seen = { url, options }; return response(200, { selection: [] }); },
  });
  const result = await client.selection({ fileKey: 'FILE A' });
  assert.equal(result.data.selection.length, 0);
  assert.equal(seen.url, 'http://127.0.0.1:3457/selection?fileKey=FILE%20A');
  assert.ok(seen.options.headers['X-Daemon-Auth']);
});

test('daemon client exposes stable error kinds for adapter fallback decisions', async () => {
  const missing = createDaemonClient({ readToken: () => null, getPort: () => 3456, fetchImpl: async () => response(200, {}) });
  await assert.rejects(() => missing.evaluate('x'), (error) => {
    assert.ok(error instanceof DaemonClientError);
    assert.equal(error.kind, 'missing-token');
    return true;
  });

  let unavailableCalls = 0;
  const unavailable = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => { unavailableCalls++; throw new TypeError('fetch failed'); },
  });
  await assert.rejects(() => unavailable.evaluate('x'), (error) => {
    assert.equal(error.kind, 'unavailable');
    assert.match(error.message, /Daemon not reachable/);
    return true;
  });
  assert.equal(unavailableCalls, 1, 'uncertain daemon execution must never be retried');

  const pluginDown = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => response(503, { error: 'Plugin not connected' }),
  });
  await assert.rejects(() => pluginDown.evaluate('x'), (error) => {
    assert.equal(error.kind, 'plugin-unavailable');
    assert.match(error.message, /Plugins → Development/);
    return true;
  });

  const pluginStalled = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456,
    fetchImpl: async () => response(503, { error: 'Plugin execution timeout (25s)' }),
  });
  await assert.rejects(() => pluginStalled.evaluate('x'), (error) => {
    assert.equal(error.kind, 'plugin-timeout');
    assert.match(error.message, /foreground/i);
    assert.match(error.message, /socket is open/i);
    return true;
  });

  const authFailure = createDaemonClient({
    readToken: () => 'token', getPort: () => 3456, tokenFile: '/state/.daemon-token',
    fetchImpl: async () => response(403, { error: 'Unauthorized request token' }),
  });
  await assert.rejects(() => authFailure.evaluate('x'), (error) => {
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

  await assert.rejects(() => client.evaluate('x'), (error) => {
    assert.equal(error.kind, 'response');
    assert.match(error.message, /name one with fileKey/);
    assert.match(error.message, /FILE_A  Alpha/);
    assert.match(error.message, /FILE_B  Beta/);
    assert.match(error.message, /no "all files" option/);
    return true;
  });
});
