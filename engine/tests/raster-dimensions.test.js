import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rasterDimensions } from '../src/lib/raster-dimensions.js';

describe('bounded raster dimensions', () => {
  it('reads PNG, JPEG, GIF and WEBP headers without decoding pixels', () => {
    const png = Buffer.alloc(24);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(360, 20);

    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x07, 0x08, 0x01, 0xe0, 0x02, 0x80,
      0xff, 0xd9,
    ]);
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    webp.write('VP8X', 12, 'ascii');
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);

    assert.deepEqual(rasterDimensions(png, 'png'), { width: 640, height: 360 });
    assert.deepEqual(rasterDimensions(jpeg, 'jpeg'), { width: 640, height: 480 });
    assert.deepEqual(rasterDimensions(gif, 'gif'), { width: 320, height: 240 });
    assert.deepEqual(rasterDimensions(webp, 'webp'), { width: 800, height: 600 });
  });

  it('rejects absent, truncated and implausibly large dimensions', () => {
    assert.throws(() => rasterDimensions(Buffer.from('short'), 'png'), /IHDR/);
    assert.throws(() => rasterDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpeg'), /Start Of Frame/);
    const huge = Buffer.alloc(24);
    huge.write('IHDR', 12, 'ascii');
    huge.writeUInt32BE(100_001, 16);
    huge.writeUInt32BE(1, 20);
    assert.throws(() => rasterDimensions(huge, 'png'), /invalid intrinsic dimensions/);
  });
});
