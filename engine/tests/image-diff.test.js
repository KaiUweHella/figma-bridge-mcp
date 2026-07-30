// image-diff: the pure core of `verify-build --compare` (build screenshot vs
// design render). Images are hand-built { width, height, data } RGBA objects —
// repo convention, no binary fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenAlpha, scaleImage, diffImages, describeRegions } from '../src/lib/image-diff.js';

/** Solid-color image; painter(x, y) can override per pixel with [r,g,b,a]. */
function makeImage(width, height, rgba, painter) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (painter && painter(x, y)) || rgba;
      data.set(px, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];

test('diffImages: identical images → 0% and no regions', () => {
  const a = makeImage(64, 64, WHITE);
  const b = makeImage(64, 64, WHITE);
  const r = diffImages(a, b);
  assert.equal(r.diffPct, 0);
  assert.deepEqual(r.regions, []);
  assert.equal(r.heightMismatch, null);
});

test('diffImages: red square on white → one region with the right bbox in design px', () => {
  const design = makeImage(128, 128, WHITE);
  const build = makeImage(128, 128, WHITE, (x, y) =>
    (x >= 32 && x < 64 && y >= 32 && y < 64) ? RED : null);
  const r = diffImages(design, build, { cellSize: 16 });
  assert.ok(r.diffPct > 5 && r.diffPct < 10, `25/4 % expected, got ${r.diffPct}`);
  assert.equal(r.regions.length, 1);
  const reg = r.regions[0];
  // bbox is cell-aligned (16px cells) and must cover the 32..64 square.
  assert.ok(reg.x0 <= 32 && reg.x1 >= 64 && reg.y0 <= 32 && reg.y1 >= 64,
    `region ${JSON.stringify(reg)} must cover the square`);
  assert.ok(reg.diffPct > 90, 'the region itself is nearly all-different');
  // The diff image marks the differing pixels red.
  const i = (40 * r.compare.width + 40) * 4;
  assert.equal(r.diffImage.data[i], 255);
});

test('diffImages: 2x-scaled variant of the same image ≈ 0% (width normalization)', () => {
  const painter = (x, y) => ((x + y) % 7 === 0) ? [0, 80, 200, 255] : null;
  const small = makeImage(60, 40, WHITE, painter);
  // Nearest-neighbor 2x of the same content.
  const big = { width: 120, height: 80, data: new Uint8Array(120 * 80 * 4) };
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 120; x++) {
      const src = ((y >> 1) * 60 + (x >> 1)) * 4;
      big.data.set(small.data.subarray(src, src + 4), (y * 120 + x) * 4);
    }
  }
  const r = diffImages(big, small);
  // Downscaling the 2x image loses a little at pattern edges — but the
  // images show the SAME content, so the diff must stay marginal.
  assert.ok(r.diffPct < 5, `expected near-zero diff, got ${r.diffPct}%`);
  assert.equal(r.compare.width, 60, 'never upscale: common width is the smaller one');
});

test('diffImages: slight color noise under the threshold → 0%', () => {
  const a = makeImage(32, 32, [100, 100, 100, 255]);
  const b = makeImage(32, 32, [110, 105, 95, 255]); // dist ≈ 12.2 < 25
  assert.equal(diffImages(a, b).diffPct, 0);
});

test('diffImages: transparent design pixels equal a white build (alpha flattening)', () => {
  const design = makeImage(32, 32, [0, 0, 0, 0]); // fully transparent
  const build = makeImage(32, 32, WHITE);
  assert.equal(diffImages(design, build).diffPct, 0);
});

test('diffImages: height mismatch is a finding, diff runs on the overlap only', () => {
  const design = makeImage(64, 100, WHITE);
  const build = makeImage(64, 130, WHITE);
  const r = diffImages(design, build);
  assert.ok(r.heightMismatch);
  assert.equal(r.heightMismatch.direction, 'taller');
  assert.equal(r.heightMismatch.deltaPct, 30);
  assert.equal(r.diffPct, 0, 'overlapping rows are identical');
  assert.equal(r.compare.height, 100);
});

test('diffImages: maxWidth caps the comparison space; regions still map to design px', () => {
  const design = makeImage(400, 100, WHITE, (x) => x >= 300 ? RED : null);
  const build = makeImage(400, 100, WHITE);
  const r = diffImages(design, build, { maxWidth: 200 });
  assert.equal(r.compare.width, 200);
  assert.equal(r.designScale, 0.5);
  const reg = r.regions[0];
  // The red strip lives at design x 300..400 — the region must COVER it in
  // design px (cell-aligned, so the bbox may round outward by up to one
  // cell = 64 design px here).
  assert.ok(reg.x0 <= 300 && reg.x0 >= 300 - 64 && reg.x1 >= 390,
    `region ${JSON.stringify(reg)} must map back to design space`);
});

test('scaleImage: exact target dimensions, identity fast-path', () => {
  const img = makeImage(10, 6, RED);
  const scaled = scaleImage(img, 5, 3);
  assert.equal(scaled.width, 5);
  assert.equal(scaled.height, 3);
  assert.equal(scaleImage(img, 10, 6), img, 'same size returns the same object');
  // Solid color survives resampling exactly.
  assert.deepEqual([...scaled.data.subarray(0, 4)], RED);
});

test('flattenAlpha: 50% black over implicit white → mid gray', () => {
  const img = makeImage(1, 1, [0, 0, 0, 128]);
  const flat = flattenAlpha(img);
  const v = flat.data[0];
  assert.ok(v > 125 && v < 130, `expected ≈127, got ${v}`);
  assert.equal(flat.data[3], 255);
});

test('describeRegions: design-pixel lines, worst first', () => {
  const lines = describeRegions({
    regions: [{ x0: 0, y0: 1800, x1: 256, y1: 2100, diffPct: 34 }],
  });
  assert.deepEqual(lines, ['x:0-256 y:1800-2100 — 34% of the area differs']);
});
