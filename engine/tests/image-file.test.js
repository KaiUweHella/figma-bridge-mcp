import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_HARD_LIMIT,
  IMAGE_WARN_LIMIT,
  INBOUND_MEDIA_HEADROOM_BYTES,
} from '../src/lib/image-file.js';
import { SLIDES_MEDIA_HARD_LIMIT } from '../src/application/slides-media-request.js';
import { MAX_PROTOCOL_VALUE_BYTES } from '../src/lib/protocol-contract.js';

// Inbound image bytes have exactly one way into Figma: base64 inside the
// plugin payload, which the protocol caps at MAX_PROTOCOL_VALUE_BYTES. The
// asset stream is an export path only. An advertised ceiling the transport can
// never carry is worse than none, because the user gets a protocol error
// instead of the command's own guidance.
test('the image hard limit is reachable through the protocol after base64 inflation', () => {
  const base64Bytes = Math.ceil(IMAGE_HARD_LIMIT / 3) * 4;
  assert.ok(
    base64Bytes + INBOUND_MEDIA_HEADROOM_BYTES <= MAX_PROTOCOL_VALUE_BYTES,
    `${IMAGE_HARD_LIMIT} bytes become ${base64Bytes} bytes of base64, which cannot fit the `
      + `${MAX_PROTOCOL_VALUE_BYTES} byte protocol value with ${INBOUND_MEDIA_HEADROOM_BYTES} bytes of headroom`,
  );
  assert.ok(IMAGE_HARD_LIMIT > IMAGE_WARN_LIMIT);
  assert.ok(INBOUND_MEDIA_HEADROOM_BYTES >= 256 * 1024, 'code or plan JSON around the bytes needs room');
});

test('Slides media and the Design image commands share one inbound ceiling', () => {
  assert.equal(SLIDES_MEDIA_HARD_LIMIT, IMAGE_HARD_LIMIT);
});
