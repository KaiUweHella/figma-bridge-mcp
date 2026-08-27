import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  ASSET_STREAM_CHUNK_BYTES,
  assetStreamRequestValidationError,
  assetStreamSha256,
  readAssetStreamSource,
} from "../src/lib/asset-stream-protocol.js";

test("asset stream request grammar is closed and source-specific", () => {
  assert.equal(assetStreamRequestValidationError({ kind: "image", ref: "hash" }), null);
  assert.equal(assetStreamRequestValidationError({ kind: "svg", ref: "12:34" }), null);
  assert.match(assetStreamRequestValidationError({ kind: "svg", ref: "name" }), /node id/);
  assert.match(
    assetStreamRequestValidationError({ kind: "image", ref: "hash", extra: true }),
    /only kind and ref/
  );
});

for (const length of [1, 55, 56, 63, 64, 65, ASSET_STREAM_CHUNK_BYTES + 17]) {
  test(`bounded-memory Plugin SHA-256 matches Node for ${length} bytes`, async () => {
    const bytes = randomBytes(length);
    assert.equal(
      await assetStreamSha256(bytes),
      createHash("sha256").update(bytes).digest("hex")
    );
  });
}

test("large Plugin SHA-256 hashing yields cooperatively and checks its deadline", async () => {
  const bytes = randomBytes(2 * 1024 * 1024);
  let checkpoints = 0;
  let yields = 0;
  await assert.rejects(
    assetStreamSha256(bytes, {
      checkpoint() {
        checkpoints += 1;
        if (checkpoints === 2) throw new Error("deadline elapsed");
      },
      async yieldControl() {
        yields += 1;
      },
    }),
    /deadline elapsed/
  );
  assert.equal(checkpoints, 2);
  assert.equal(yields, 1);
});

test("typed image and SVG reads preserve source bytes and bounded details", async () => {
  const imageBytes = new Uint8Array([1, 2, 3]);
  const svgBytes = new Uint8Array([4, 5, 6]);
  const figma = {
    getImageByHash: () => ({
      getBytesAsync: async () => imageBytes,
      getSizeAsync: async () => ({ width: 2, height: 3 }),
    }),
    getNodeByIdAsync: async () => ({ exportAsync: async () => svgBytes }),
  };
  assert.deepEqual(await readAssetStreamSource(figma, { kind: "image", ref: "hash" }), {
    bytes: imageBytes,
    details: { kind: "image", size: { width: 2, height: 3 } },
  });
  assert.deepEqual(await readAssetStreamSource(figma, { kind: "svg", ref: "1:2" }), {
    bytes: svgBytes,
    details: { kind: "svg" },
  });
});
