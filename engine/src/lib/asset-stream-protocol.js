// Canonical typed Plugin operation for large Asset Export payloads. The pure
// runtime inside the markers is synchronized into plugin/code.js.

// BEGIN ASSET STREAM RUNTIME
export const ASSET_STREAM_CAPABILITY = "asset-stream-v1";
export const ASSET_STREAM_CHUNK_BYTES = 256 * 1024;
export const ASSET_STREAM_MAX_BYTES = 512 * 1024 * 1024;
export const ASSET_STREAM_HASH_BLOCKS_PER_YIELD = 16 * 1024;

const ASSET_STREAM_SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function assetStreamRotate(value, count) {
  return ((value >>> count) | (value << (32 - count))) >>> 0;
}

export function assetStreamRequestValidationError(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "asset stream request must be an object";
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "ref") {
    return "asset stream request must contain only kind and ref";
  }
  if (!['image', 'svg'].includes(value.kind)) {
    return 'asset stream kind must be "image" or "svg"';
  }
  if (typeof value.ref !== "string" || value.ref.length < 1 || value.ref.length > 1024) {
    return "asset stream ref must be a 1-1024 character string";
  }
  if (value.kind === "svg" && !/^I?\d+:\d+(;\d+:\d+)*$/u.test(value.ref)) {
    return "asset stream SVG ref must be a canonical Figma node id";
  }
  return null;
}

// SHA-256 reads virtual padding bytes instead of allocating a second buffer
// proportional to the asset. Figma's API already returns one Uint8Array; the
// stream protocol adds only one 64-word schedule and one bounded chunk view.
export async function assetStreamSha256(bytes, {
  checkpoint = () => {},
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Asset stream SHA-256 requires Uint8Array bytes.");
  }
  const length = bytes.length;
  if (length < 1 || length > ASSET_STREAM_MAX_BYTES) {
    throw new Error("Asset stream bytes exceed the bounded single-asset range.");
  }
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const bitHigh = Math.floor((length * 8) / 0x100000000) >>> 0;
  const bitLow = (length * 8) >>> 0;
  const paddingByte = (index) => {
    if (index < length) return bytes[index];
    if (index === length) return 0x80;
    if (index < paddedLength - 8) return 0;
    const shift = (7 - (index - (paddedLength - 8))) * 8;
    return shift >= 32
      ? (bitHigh >>> (shift - 32)) & 0xff
      : (bitLow >>> shift) & 0xff;
  };
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f,
    0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  let blocksSinceYield = 0;
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] =
        (paddingByte(at) << 24) |
        (paddingByte(at + 1) << 16) |
        (paddingByte(at + 2) << 8) |
        paddingByte(at + 3);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const s0 =
        assetStreamRotate(left, 7) ^
        assetStreamRotate(left, 18) ^
        (left >>> 3);
      const s1 =
        assetStreamRotate(right, 17) ^
        assetStreamRotate(right, 19) ^
        (right >>> 10);
      words[index] =
        (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const upper =
        assetStreamRotate(e, 6) ^
        assetStreamRotate(e, 11) ^
        assetStreamRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first =
        (h + upper + choice + ASSET_STREAM_SHA_K[index] + words[index]) >>> 0;
      const lower =
        assetStreamRotate(a, 2) ^
        assetStreamRotate(a, 13) ^
        assetStreamRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
    blocksSinceYield += 1;
    if (
      blocksSinceYield >= ASSET_STREAM_HASH_BLOCKS_PER_YIELD &&
      offset + 64 < paddedLength
    ) {
      checkpoint();
      await yieldControl();
      blocksSinceYield = 0;
    }
  }
  checkpoint();
  return Array.from(hash, (value) => value.toString(16).padStart(8, "0")).join("");
}

export async function readAssetStreamSource(figmaApi, request) {
  const error = assetStreamRequestValidationError(request);
  if (error) throw new Error(error);
  if (request.kind === "image") {
    const image = figmaApi.getImageByHash(request.ref);
    if (!image) throw new Error("image not found");
    const bytes = await image.getBytesAsync();
    let size = null;
    try {
      size = await image.getSizeAsync();
    } catch {}
    return { bytes, details: { kind: "image", size } };
  }
  const node = await figmaApi.getNodeByIdAsync(request.ref);
  if (!node) throw new Error("node not found");
  if (!("exportAsync" in node)) throw new Error("node cannot be exported");
  return {
    bytes: await node.exportAsync({ format: "SVG" }),
    details: { kind: "svg" },
  };
}
// END ASSET STREAM RUNTIME
