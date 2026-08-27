const MAX_RASTER_DIMENSION = 100_000;

export function rasterKind(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Raster kind requires a Buffer');
  if (bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 6
    && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function checked(width, height, kind) {
  if (!Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1
    || width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION) {
    throw new Error(`${kind.toUpperCase()} raster has invalid intrinsic dimensions`);
  }
  return Object.freeze({ width, height });
}

function jpegDimensions(bytes) {
  let offset = 2;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker)) {
      if (length < 7) break;
      return checked(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), 'jpeg');
    }
    offset += length;
  }
  throw new Error('JPEG raster has no bounded Start Of Frame dimensions');
}

function webpDimensions(bytes) {
  if (bytes.length < 30) throw new Error('WEBP raster is too short for intrinsic dimensions');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    return checked(width, height, 'webp');
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f || bytes.length < 25) throw new Error('WEBP lossless header is invalid');
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return checked(1 + b0 + ((b1 & 0x3f) << 8), 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10), 'webp');
  }
  if (chunk === 'VP8 ') {
    for (let offset = 20; offset + 9 < bytes.length && offset < 64; offset++) {
      if (bytes[offset + 3] === 0x9d && bytes[offset + 4] === 0x01 && bytes[offset + 5] === 0x2a) {
        return checked(bytes.readUInt16LE(offset + 6) & 0x3fff, bytes.readUInt16LE(offset + 8) & 0x3fff, 'webp');
      }
    }
    throw new Error('WEBP lossy frame header is invalid');
  }
  throw new Error(`WEBP raster uses unsupported ${chunk || 'unknown'} dimensions`);
}

/** Read only bounded container headers; never decompress untrusted pixels. */
export function rasterDimensions(bytes, kind) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Raster dimensions require a Buffer');
  if (kind === 'png') {
    if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('PNG raster has no mandatory IHDR dimensions');
    }
    return checked(bytes.readUInt32BE(16), bytes.readUInt32BE(20), kind);
  }
  if (kind === 'jpeg') return jpegDimensions(bytes);
  if (kind === 'gif') {
    if (bytes.length < 10) throw new Error('GIF raster has no logical screen dimensions');
    return checked(bytes.readUInt16LE(6), bytes.readUInt16LE(8), kind);
  }
  if (kind === 'webp') return webpDimensions(bytes);
  throw new Error(`Unsupported raster kind ${String(kind || 'missing')}`);
}
