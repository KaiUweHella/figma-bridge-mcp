import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ASSET_TRANSFER_CHUNK_BYTES,
  createAssetTransferStore,
} from "../src/lib/asset-transfer-store.js";
import { assertPosixMode } from "../../test-support/posix-permissions.js";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "asset-transfer-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: createAssetTransferStore({ root, ...options }) };
}

async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("a completed asset transfer verifies sequence, length and digest before one-shot consumption", async (t) => {
  const { root, store } = fixture(t);
  const bytes = Buffer.concat([
    Buffer.alloc(MAX_ASSET_TRANSFER_CHUNK_BYTES, 0x61),
    Buffer.from("bounded tail"),
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const writer = store.begin({ totalBytes: bytes.length, sha256, details: { kind: "svg" } });
  writer.write(0, bytes.subarray(0, MAX_ASSET_TRANSFER_CHUNK_BYTES).toString("base64"));
  writer.write(1, bytes.subarray(MAX_ASSET_TRANSFER_CHUNK_BYTES).toString("base64"));
  const descriptor = writer.finish({ chunks: 2 });

  assert.equal(descriptor.totalBytes, bytes.length);
  assert.equal(store.facts().ready, 1);
  const transfer = store.consume(descriptor.id);
  assert.deepEqual(await read(transfer.stream), bytes);
  assert.equal(transfer.release(), true);
  assert.equal(transfer.release(), false);
  assert.equal(readdirSync(root).length, 0);
  assert.throws(() => store.consume(descriptor.id), /missing or already consumed/);
});

for (const [label, mutate, pattern] of [
  ["out-of-order chunks", (writer, bytes) => writer.write(1, bytes.toString("base64")), /sequence/],
  ["declared-length overflow", (writer, bytes) => writer.write(0, Buffer.concat([bytes, Buffer.from("x")]).toString("base64")), /declared length/],
  ["malformed Base64", (writer) => writer.write(0, "not base64"), /canonical bounded Base64/],
]) {
  test(`${label} aborts and removes the private partial file`, (t) => {
    const { root, store } = fixture(t);
    const bytes = Buffer.from("asset");
    const writer = store.begin({
      totalBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    assert.throws(() => mutate(writer, bytes), pattern);
    assert.deepEqual(readdirSync(root), []);
    assert.deepEqual(store.facts(), { active: 0, ready: 0 });
  });
}

test("length and digest mismatches never become consumable", (t) => {
  const { root, store } = fixture(t);
  const bytes = Buffer.from("asset");
  const wrongDigest = "0".repeat(64);
  const digestWriter = store.begin({ totalBytes: bytes.length, sha256: wrongDigest });
  digestWriter.write(0, bytes.toString("base64"));
  assert.throws(() => digestWriter.finish({ chunks: 1 }), /SHA-256/);

  const lengthWriter = store.begin({
    totalBytes: bytes.length + 1,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  lengthWriter.write(0, bytes.toString("base64"));
  assert.throws(() => lengthWriter.finish({ chunks: 1 }), /received length/);
  assert.deepEqual(readdirSync(root), []);
});

test("private permissions and restart cleanup retain no recognised transfer bytes", (t) => {
  const { root, store } = fixture(t);
  const bytes = Buffer.from("private");
  const writer = store.begin({
    totalBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  writer.write(0, bytes.toString("base64"));
  const descriptor = writer.finish({ chunks: 1 });
  const file = join(root, `${descriptor.id}.bin`);
  assertPosixMode(root, 0o700);
  assertPosixMode(file, 0o600);

  const unknown = join(root, "maintainer-note.txt");
  writeFileSync(unknown, "leave me");
  createAssetTransferStore({ root });
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(unknown), true);
});

test("expired and excess ready transfers are bounded", (t) => {
  let time = 1_000;
  const { root, store } = fixture(t, {
    now: () => time,
    ttlMs: 50,
    maxReady: 1,
  });
  const bytes = Buffer.from("x");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const first = store.begin({ id: randomUUID(), totalBytes: 1, sha256 });
  first.write(0, bytes.toString("base64"));
  first.finish({ chunks: 1 });
  assert.throws(
    () => store.begin({ totalBytes: 1, sha256 }),
    /too many completed transfers/
  );
  time += 51;
  store.pruneExpired();
  assert.equal(store.facts().ready, 0);
  assert.deepEqual(readdirSync(root), []);
});
