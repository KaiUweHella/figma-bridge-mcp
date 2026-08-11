import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { DEFAULT_RASTER_SCALE, optimizePngForUsages } from '../src/lib/raster-optimize.js';

const noisyPng = (width, height) => {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    const p = i / 4;
    png.data[i] = p % 251;
    png.data[i + 1] = (p * 7) % 253;
    png.data[i + 2] = (p * 13) % 255;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
};

test('PNG optimization keeps 2x pixels for the largest Figma usage', () => {
  assert.equal(DEFAULT_RASTER_SCALE, 2);
  const source = noisyPng(400, 300);
  const result = optimizePngForUsages(source, [{ w: 35, h: 35 }, { w: 100, h: 50 }], 2);
  assert.equal(result.optimized, true);
  assert.equal(result.width, 200);
  assert.equal(result.height, 150);
  assert.ok(result.buffer.length < source.length);
});

test('PNG scale 0 keeps originals and optimization never upscales', () => {
  const source = noisyPng(40, 30);
  assert.equal(optimizePngForUsages(source, [{ w: 10, h: 10 }], 0).optimized, false);
  const largerUsage = optimizePngForUsages(source, [{ w: 100, h: 100 }], 2);
  assert.equal(largerUsage.optimized, false);
  assert.deepEqual(largerUsage.buffer, source);
});

test('PNG optimization leaves non-PNG bytes untouched', () => {
  const source = Buffer.from('not an image');
  const result = optimizePngForUsages(source, [{ w: 35, h: 35 }], 2);
  assert.equal(result.optimized, false);
  assert.deepEqual(result.buffer, source);
});
