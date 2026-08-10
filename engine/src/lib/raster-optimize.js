import { PNG } from 'pngjs';
import { scaleImage } from './image-diff.js';

/**
 * Downsample an oversized PNG while retaining enough source pixels for every
 * Figma usage at the requested device-pixel ratio. The source aspect ratio is
 * preserved; CSS/Figma IMAGE fill crop semantics therefore stay outside this
 * operation. If decoding fails or recompression does not save bytes, the
 * original is returned unchanged.
 */
export function optimizePngForUsages(buffer, usages = [], rasterScale = 0) {
  const original = Buffer.from(buffer);
  const scale = Number(rasterScale);
  if (!Number.isFinite(scale) || scale <= 0 || !usages.length) {
    return { buffer: original, optimized: false };
  }
  let png;
  try {
    png = PNG.sync.read(original);
  } catch {
    return { buffer: original, optimized: false };
  }
  const targetW = Math.max(0, ...usages.map((use) => Number(use.w) || 0)) * scale;
  const targetH = Math.max(0, ...usages.map((use) => Number(use.h) || 0)) * scale;
  if (!targetW || !targetH) return { buffer: original, optimized: false };

  // Both dimensions must retain the requested density. This matters when the
  // same portrait source appears in a wide crop and a square avatar.
  const ratio = Math.min(1, Math.max(targetW / png.width, targetH / png.height));
  if (ratio >= 1) {
    return { buffer: original, optimized: false, width: png.width, height: png.height };
  }
  const width = Math.max(1, Math.round(png.width * ratio));
  const height = Math.max(1, Math.round(png.height * ratio));
  const scaled = scaleImage(png, width, height);
  const output = new PNG({ width, height });
  output.data = Buffer.from(scaled.data);
  const encoded = PNG.sync.write(output);
  if (encoded.length >= original.length) {
    return { buffer: original, optimized: false, width: png.width, height: png.height };
  }
  return {
    buffer: encoded,
    optimized: true,
    width,
    height,
    sourceWidth: png.width,
    sourceHeight: png.height,
    savedBytes: original.length - encoded.length,
  };
}
