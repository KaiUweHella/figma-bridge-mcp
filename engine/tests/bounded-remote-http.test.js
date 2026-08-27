import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  BOUNDED_REMOTE_HTTP_LIMITS,
  classifyRemoteAddress,
  readBoundedRemoteHttp,
} from '../src/lib/bounded-remote-http.js';

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function closeAfter(t, ...servers) {
  t.after(async () => {
    await Promise.all(servers.map((server) =>
      new Promise((resolvePromise) => server.close(resolvePromise))));
  });
}

function exactOriginPolicy(entries) {
  const origins = new Map(entries);
  return (input) => {
    const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
    if (url.username || url.password) throw new Error('credentials are not allowed');
    const scope = origins.get(url.origin);
    if (!scope) throw new Error('origin is not approved');
    return Object.freeze({ url, origin: url.origin, scope });
  };
}

test('bounded remote HTTP classifies public, private, loopback and forbidden ranges', () => {
  assert.equal(classifyRemoteAddress('93.184.216.34'), 'public');
  assert.equal(classifyRemoteAddress('10.0.0.1'), 'private');
  assert.equal(classifyRemoteAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyRemoteAddress('169.254.169.254'), 'forbidden');
  assert.equal(classifyRemoteAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyRemoteAddress('::192.168.1.1'), 'private');
  assert.equal(classifyRemoteAddress('64:ff9b::7f00:1'), 'forbidden');
  assert.equal(classifyRemoteAddress('64:ff9b:1::a00:1'), 'forbidden');
  assert.equal(classifyRemoteAddress('2002:7f00:1::'), 'forbidden');
  assert.equal(classifyRemoteAddress('2001::1'), 'forbidden');
  assert.equal(classifyRemoteAddress('2001:db8::1'), 'forbidden');
});

test('bounded remote HTTP pins an approved address and returns exact identity bytes', async (t) => {
  let receivedHost = '';
  const server = createServer((request, response) => {
    receivedHost = request.headers.host;
    response.setHeader('content-type', 'image/png');
    response.end(Buffer.from([1, 2, 3, 4]));
  });
  const origin = await listen(server);
  closeAfter(t, server);
  const alias = `http://asset.test:${new URL(origin).port}/image.png?signature=secret`;
  const result = await readBoundedRemoteHttp(alias, {
    authorize: exactOriginPolicy([[new URL(alias).origin, 'private']]),
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.contentType, 'image/png');
  assert.deepEqual(result.bytes, Buffer.from([1, 2, 3, 4]));
  assert.equal(receivedHost, `asset.test:${new URL(origin).port}`);
});

test('bounded remote HTTP rejects DNS rebinding before requesting', async () => {
  let requested = false;
  await assert.rejects(() => readBoundedRemoteHttp('https://asset.example/image.png', {
    authorize: exactOriginPolicy([['https://asset.example', 'public']]),
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    request: async () => {
      requested = true;
      throw new Error('must not request');
    },
  }), /network range/i);
  assert.equal(requested, false);
});

test('bounded remote HTTP reauthorizes redirects and rejects compression and byte excess', async (t) => {
  let blockedRequests = 0;
  const blocked = createServer((_request, response) => {
    blockedRequests++;
    response.end('blocked');
  });
  const blockedOrigin = await listen(blocked);
  const redirect = createServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader('location', `${blockedOrigin}/private?secret=hidden`);
    response.end();
  });
  const compressed = createServer((_request, response) => {
    response.setHeader('content-encoding', 'gzip');
    response.end('compressed');
  });
  const large = createServer((_request, response) => response.end('123456789'));
  const redirectOrigin = await listen(redirect);
  const compressedOrigin = await listen(compressed);
  const largeOrigin = await listen(large);
  closeAfter(t, blocked, redirect, compressed, large);

  await assert.rejects(() => readBoundedRemoteHttp(`${redirectOrigin}/image.png`, {
    authorize: exactOriginPolicy([[redirectOrigin, 'private']]),
  }), /approved/i);
  assert.equal(blockedRequests, 0);

  await assert.rejects(() => readBoundedRemoteHttp(`${compressedOrigin}/image.png`, {
    authorize: exactOriginPolicy([[compressedOrigin, 'private']]),
  }), /compressed/i);

  await assert.rejects(() => readBoundedRemoteHttp(`${largeOrigin}/image.png`, {
    authorize: exactOriginPolicy([[largeOrigin, 'private']]),
    limits: { ...BOUNDED_REMOTE_HTTP_LIMITS, maxBytes: 8 },
  }), /exceeds 8 bytes/i);
});
