import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createRemoteRenderImagePolicy,
  materializeRemoteRenderImage,
} from '../src/lib/remote-render-assets.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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

test('remote image policy requires explicit exact origins and HTTPS for public hosts', () => {
  const policy = createRemoteRenderImagePolicy({
    FIGMA_BRIDGE_IMAGE_ORIGINS: 'https://images.example',
  });
  assert.equal(policy.authorize('https://images.example/photo.png?signature=secret').scope, 'public');
  assert.throws(() => policy.authorize('https://images.example.evil/photo.png'), /approved/i);
  assert.throws(() => createRemoteRenderImagePolicy({
    FIGMA_BRIDGE_IMAGE_ORIGINS: 'http://images.example',
  }), /HTTPS/i);
});

test('remote image materializes verified bytes with redacted provenance and content identity', async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'image/png');
    response.end(PNG_1X1);
  });
  const origin = await listen(server);
  closeAfter(t, server);
  const asset = await materializeRemoteRenderImage(`${origin}/photo.png?signature=secret`, {
    env: { FIGMA_BRIDGE_IMAGE_PRIVATE_ORIGINS: origin },
  });

  assert.equal(asset.kind, 'embedded-raster');
  assert.equal(asset.width, 1);
  assert.equal(asset.height, 1);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(asset.source, { kind: 'remote-http', label: `${origin}/photo.png` });
  assert.doesNotMatch(JSON.stringify(asset.source), /signature|secret/);
  assert.deepEqual(Buffer.from(asset.base64, 'base64'), PNG_1X1);
});

test('remote image rejects MIME mismatch and deduplicates through stable content hashes', async (t) => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', request.url.startsWith('/bad') ? 'image/jpeg' : 'image/png');
    response.end(PNG_1X1);
  });
  const origin = await listen(server);
  closeAfter(t, server);
  const options = { env: { FIGMA_BRIDGE_IMAGE_PRIVATE_ORIGINS: origin } };
  await assert.rejects(() => materializeRemoteRenderImage(`${origin}/bad.png`, options), /Content-Type/i);
  const first = await materializeRemoteRenderImage(`${origin}/a.png`, options);
  const second = await materializeRemoteRenderImage(`${origin}/b.png`, options);
  assert.equal(first.sha256, second.sha256);
});

test('remote image refuses to outlive its owning Command Plan deadline', async () => {
  await assert.rejects(
    () => materializeRemoteRenderImage('https://images.example/photo.png', {
      env: { FIGMA_BRIDGE_IMAGE_ORIGINS: 'https://images.example' },
      remainingMs: () => 0,
    }),
    (error) => error?.code === 'IMAGE_TIMEOUT'
      && /Command Plan deadline expired/i.test(error.message),
  );
});

test('remote image rejects invalid intrinsic dimensions with a stable policy code', async (t) => {
  const invalidDimensions = Buffer.from(PNG_1X1);
  invalidDimensions.writeUInt32BE(0, 16);
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'image/png');
    response.end(invalidDimensions);
  });
  const origin = await listen(server);
  closeAfter(t, server);
  await assert.rejects(
    () => materializeRemoteRenderImage(`${origin}/invalid.png`, {
      env: { FIGMA_BRIDGE_IMAGE_PRIVATE_ORIGINS: origin },
    }),
    (error) => error?.code === 'IMAGE_DIMENSIONS'
      && /intrinsic dimensions/i.test(error.message),
  );
});
