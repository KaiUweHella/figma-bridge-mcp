import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStorybookRemotePolicy,
  classifyStorybookAddress,
  fetchRemoteStorybookIndex,
  STORYBOOK_REMOTE_LIMITS,
} from '../src/code-import/storybook-remote.js';
import { fetchStorybookIndex } from '../src/code-import/storybook.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'code-import');

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function closeAfter(t, ...servers) {
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolvePromise) => server.close(resolvePromise))));
  });
}

function privateEnv(...origins) {
  return { FIGMA_BRIDGE_STORYBOOK_PRIVATE_ORIGINS: origins.join(',') };
}

test('remote Storybook policy keeps conventional localhost zero-config and canonicalizes numeric aliases', () => {
  const policy = createStorybookRemotePolicy({});
  assert.equal(policy.authorize('http://localhost:6006').origin, 'http://localhost:6006');
  assert.equal(policy.authorize('http://127.0.0.1:6006').origin, 'http://127.0.0.1:6006');
  assert.equal(policy.authorize('http://[::1]:6006').origin, 'http://[::1]:6006');
  assert.equal(policy.authorize('http://2130706433:6006').origin, 'http://127.0.0.1:6006');
  assert.equal(policy.authorize('http://0x7f000001:6006').origin, 'http://127.0.0.1:6006');
  assert.equal(policy.authorize('http://0177.0.0.1:6006').origin, 'http://127.0.0.1:6006');
  assert.throws(() => policy.authorize('http://127.0.0.1:6007'), /approved origin/i);
});

test('remote Storybook policy requires exact HTTPS public origins and rejects credentials', () => {
  const policy = createStorybookRemotePolicy({
    FIGMA_BRIDGE_STORYBOOK_ORIGINS: 'https://storybook.example.com',
  });
  assert.equal(policy.authorize('https://storybook.example.com/design-system').origin, 'https://storybook.example.com');
  assert.throws(() => policy.authorize('http://storybook.example.com'), /HTTPS/i);
  assert.throws(() => policy.authorize('https://storybook.example.com.evil.test'), /approved origin/i);
  const credentialUrl = ['https://', 'fixture-user', ':', 'test-secret', '@storybook.example.com'].join('');
  assert.throws(() => policy.authorize(credentialUrl), /credentials/i);
  assert.throws(() => policy.authorize('https://storybook.example.com/?token=secret'), /query|fragment/i);
});

test('remote Storybook classifies loopback, private, link-local, mapped, multicast, and reserved addresses', () => {
  assert.equal(classifyStorybookAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyStorybookAddress('10.0.0.1'), 'private');
  assert.equal(classifyStorybookAddress('100.64.0.1'), 'private');
  assert.equal(classifyStorybookAddress('169.254.169.254'), 'forbidden');
  assert.equal(classifyStorybookAddress('224.0.0.1'), 'forbidden');
  assert.equal(classifyStorybookAddress('192.0.2.1'), 'forbidden');
  assert.equal(classifyStorybookAddress('::1'), 'loopback');
  assert.equal(classifyStorybookAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyStorybookAddress('fc00::1'), 'private');
  assert.equal(classifyStorybookAddress('fe80::1'), 'forbidden');
  assert.equal(classifyStorybookAddress('ff02::1'), 'forbidden');
  assert.equal(classifyStorybookAddress('2001:db8::1'), 'forbidden');
});

test('remote Storybook rejects public-origin DNS rebinding and always-forbidden network ranges', async () => {
  let requested = false;
  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex('https://storybook.example.com', {
        env: { FIGMA_BRIDGE_STORYBOOK_ORIGINS: 'https://storybook.example.com' },
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
        request: async () => {
          requested = true;
          throw new Error('must not run');
        },
      }),
    /network range/i
  );
  assert.equal(requested, false);

  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex('http://metadata.internal:6006', {
        env: privateEnv('http://metadata.internal:6006'),
        lookup: async () => [{ address: '169.254.169.254', family: 4 }],
        request: async () => {
          requested = true;
          throw new Error('must not run');
        },
      }),
    /network range/i
  );
  assert.equal(requested, false);
});

test('remote Storybook pins the validated address and ignores proxy environment variables', async (t) => {
  let targetRequests = 0;
  let proxyRequests = 0;
  let receivedHost = '';
  const target = createServer((request, response) => {
    targetRequests++;
    receivedHost = request.headers.host;
    response.setHeader('content-type', 'application/json');
    response.end('{"v":5,"entries":{}}');
  });
  const proxy = createServer((_request, response) => {
    proxyRequests++;
    response.statusCode = 502;
    response.end('proxy must not be used');
  });
  const targetOrigin = await listen(target);
  const proxyOrigin = await listen(proxy);
  closeAfter(t, target, proxy);
  const targetPort = new URL(targetOrigin).port;
  const approvedOrigin = `http://storybook.test:${targetPort}`;
  let lookups = 0;

  const text = await fetchRemoteStorybookIndex(approvedOrigin, {
    env: {
      ...privateEnv(approvedOrigin),
      HTTP_PROXY: proxyOrigin,
      HTTPS_PROXY: proxyOrigin,
      ALL_PROXY: proxyOrigin,
    },
    lookup: async () => {
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });

  assert.equal(JSON.parse(text).v, 5);
  assert.equal(lookups, 1);
  assert.equal(targetRequests, 1);
  assert.equal(proxyRequests, 0);
  assert.equal(receivedHost, `storybook.test:${targetPort}`);
});

test('remote Storybook revalidates every redirect and never contacts an unapproved target', async (t) => {
  let approvedRequests = 0;
  let blockedRequests = 0;
  const approvedTarget = createServer((_request, response) => {
    approvedRequests++;
    response.end('{"v":5,"entries":{}}');
  });
  const blockedTarget = createServer((_request, response) => {
    blockedRequests++;
    response.end('{"v":5,"entries":{}}');
  });
  const redirector = createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader('location', `${blockedOrigin}/private?secret=hidden`);
    response.end();
  });
  const approvedOrigin = await listen(approvedTarget);
  const blockedOrigin = await listen(blockedTarget);
  const redirectOrigin = await listen(redirector);
  closeAfter(t, approvedTarget, blockedTarget, redirector);

  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex(redirectOrigin, {
        env: privateEnv(redirectOrigin, approvedOrigin),
      }),
    (error) => {
      assert.match(error.message, /redirect|approved origin/i);
      assert.doesNotMatch(error.message, /private|secret|127\.0\.0\.1|user/i);
      return true;
    }
  );
  assert.equal(approvedRequests, 0);
  assert.equal(blockedRequests, 0);
});

test('remote Storybook accepts only an approved credential-free redirect', async (t) => {
  const target = createServer((_request, response) => {
    response.end('{"v":5,"entries":{}}');
  });
  let targetOrigin = await listen(target);
  const redirector = createServer((_request, response) => {
    response.statusCode = 307;
    response.setHeader('location', `${targetOrigin}/relocated-index.json`);
    response.end();
  });
  const redirectOrigin = await listen(redirector);
  closeAfter(t, target, redirector);
  const text = await fetchRemoteStorybookIndex(redirectOrigin, {
    env: privateEnv(redirectOrigin, targetOrigin),
  });
  assert.equal(JSON.parse(text).v, 5);

  targetOrigin = targetOrigin.replace('http://', ['http://', 'fixture-user', ':', 'test-secret', '@'].join(''));
  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex(redirectOrigin, {
        env: privateEnv(redirectOrigin, new URL(targetOrigin).origin),
      }),
    /credentials/i
  );
});

test('remote Storybook preserves a hosted base path and falls back to stories.json', async (t) => {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    if (request.url === '/design-system/index.json') {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.end('{"v":3,"stories":{}}');
  });
  const origin = await listen(server);
  closeAfter(t, server);
  const text = await fetchRemoteStorybookIndex(`${origin}/design-system`, {
    env: privateEnv(origin),
  });
  assert.equal(JSON.parse(text).v, 3);
  assert.deepEqual(paths, ['/design-system/index.json', '/design-system/stories.json']);
});

test('remote Storybook enforces the byte limit in the native response path', async (t) => {
  const server = createServer((_request, response) => {
    response.write('123456');
    response.end('789012');
  });
  const origin = await listen(server);
  closeAfter(t, server);
  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex(origin, {
        env: privateEnv(origin),
        limits: { ...STORYBOOK_REMOTE_LIMITS, maxBytes: 10 },
      }),
    /exceeds 10 bytes/i
  );
});

test('remote Storybook enforces connect, header, body, and total deadlines', async (t) => {
  const headerServer = createServer(() => {});
  const bodyServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
  });
  const headerOrigin = await listen(headerServer);
  const bodyOrigin = await listen(bodyServer);
  closeAfter(t, headerServer, bodyServer);

  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex(headerOrigin, {
        env: privateEnv(headerOrigin),
        limits: { ...STORYBOOK_REMOTE_LIMITS, headersTimeoutMs: 30, totalTimeoutMs: 250 },
      }),
    /headers deadline/i
  );
  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex(bodyOrigin, {
        env: privateEnv(bodyOrigin),
        limits: { ...STORYBOOK_REMOTE_LIMITS, bodyTimeoutMs: 30, totalTimeoutMs: 250 },
      }),
    /body deadline/i
  );

  const pendingSocket = new EventEmitter();
  pendingSocket.connecting = true;
  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex('http://127.0.0.1:6006', {
        requestFactory: (_transport, _url, _options, _onResponse) => {
          const request = new EventEmitter();
          request.end = () => queueMicrotask(() => request.emit('socket', pendingSocket));
          request.destroy = (error) => queueMicrotask(() => request.emit('error', error));
          return request;
        },
        limits: {
          ...STORYBOOK_REMOTE_LIMITS,
          connectTimeoutMs: 20,
          headersTimeoutMs: 100,
          totalTimeoutMs: 250,
        },
      }),
    /connect deadline/i
  );

  await assert.rejects(
    () =>
      fetchRemoteStorybookIndex('http://localhost:6006', {
        lookup: () =>
          new Promise((resolvePromise) => setTimeout(() => resolvePromise([{ address: '127.0.0.1', family: 4 }]), 100)),
        limits: { ...STORYBOOK_REMOTE_LIMITS, totalTimeoutMs: 20 },
      }),
    /total deadline/i
  );
});

test('local Storybook directory imports keep working through Workspace I/O', async () => {
  const text = await fetchStorybookIndex(join(FIX, 'storybook-local'));
  assert.equal(JSON.parse(text).v, 5);
});
