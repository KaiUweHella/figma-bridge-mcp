// Private one-shot storage for authenticated Plugin asset streams.
//
// Asset chunks never enter the generic 5 MiB JSON result or the Audit Trail.
// The daemon verifies sequence, declared length and SHA-256 while writing one
// mode-restricted file. A successful transfer may be consumed exactly once;
// recognised residue is removed when the daemon starts again.
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { STATE_DIR } from "./state-dir.js";

export const MAX_ASSET_TRANSFER_BYTES = 512 * 1024 * 1024;
export const MAX_ASSET_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const MAX_READY_ASSET_TRANSFERS = 8;
export const ASSET_TRANSFER_TTL_MS = 2 * 60 * 1000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TRANSFER_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(part|bin)$/u;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export class AssetTransferError extends Error {
  constructor(message, code = "ASSET_TRANSFER_REJECTED") {
    super(`Asset transfer rejected: ${message}.`);
    this.name = "AssetTransferError";
    this.code = code;
    this.kind = "asset-transfer";
  }
}

function reject(message, code) {
  throw new AssetTransferError(message, code);
}

function exactChild(root, candidate) {
  const rel = relative(root, candidate);
  return rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !rel.includes("/") && !rel.includes("\\");
}

function remove(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function close(fd) {
  try {
    closeSync(fd);
  } catch {}
}

function decodeChunk(base64) {
  if (
    typeof base64 !== "string" ||
    base64.length > Math.ceil(MAX_ASSET_TRANSFER_CHUNK_BYTES / 3) * 4 + 4 ||
    !CANONICAL_BASE64.test(base64)
  ) {
    reject("chunk is not canonical bounded Base64", "ASSET_TRANSFER_CHUNK");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 1 || bytes.length > MAX_ASSET_TRANSFER_CHUNK_BYTES) {
    reject("chunk byte length is outside the bounded range", "ASSET_TRANSFER_CHUNK");
  }
  if (bytes.toString("base64") !== base64) {
    reject("chunk Base64 is not canonical", "ASSET_TRANSFER_CHUNK");
  }
  return bytes;
}

function privateDirectory(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = realpathSync.native(root);
  const metadata = statSync(canonical);
  if (!metadata.isDirectory()) reject("private root is not a directory");
  chmodSync(canonical, 0o700);
  return canonical;
}

function cleanupRecognisedFiles(root) {
  const directory = opendirSync(root, { bufferSize: 1 });
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!TRANSFER_FILE.test(entry.name) || !entry.isFile()) continue;
      const path = join(root, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isFile() && !metadata.isSymbolicLink()) remove(path);
    }
  } finally {
    directory.closeSync();
  }
}

export function createAssetTransferStore({
  root = join(STATE_DIR, "asset-transfers"),
  now = () => Date.now(),
  maxBytes = MAX_ASSET_TRANSFER_BYTES,
  maxReady = MAX_READY_ASSET_TRANSFERS,
  ttlMs = ASSET_TRANSFER_TTL_MS,
} = {}) {
  const canonicalRoot = privateDirectory(root);
  cleanupRecognisedFiles(canonicalRoot);
  const active = new Map();
  const ready = new Map();

  function pathFor(id, suffix) {
    if (!UUID.test(id || "")) reject("transfer id is invalid");
    const path = join(canonicalRoot, `${id}.${suffix}`);
    if (!exactChild(canonicalRoot, path)) reject("transfer path escaped its private root");
    return path;
  }

  function pruneExpired() {
    const cutoff = now() - ttlMs;
    for (const [id, item] of ready) {
      if (item.createdAt <= cutoff) {
        ready.delete(id);
        remove(item.path);
      }
    }
  }

  function begin({ id = randomUUID(), totalBytes, sha256, details = null } = {}) {
    pruneExpired();
    if (!UUID.test(id) || active.has(id) || ready.has(id)) {
      reject("transfer id is invalid or already active");
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > maxBytes) {
      reject(`declared length must be 1-${maxBytes} bytes`, "ASSET_TRANSFER_SIZE");
    }
    if (typeof sha256 !== "string" || !DIGEST.test(sha256)) {
      reject("declared SHA-256 is invalid", "ASSET_TRANSFER_DIGEST");
    }
    if (ready.size >= maxReady) {
      reject("too many completed transfers await consumption", "ASSET_TRANSFER_LIMIT");
    }
    const partPath = pathFor(id, "part");
    const fd = openSync(
      partPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o600
    );
    const state = {
      id,
      fd,
      partPath,
      totalBytes,
      sha256,
      details,
      receivedBytes: 0,
      nextSequence: 0,
      hash: createHash("sha256"),
      settled: false,
    };
    active.set(id, state);

    const abort = () => {
      if (state.settled) return false;
      state.settled = true;
      active.delete(id);
      close(state.fd);
      remove(state.partPath);
      return true;
    };

    return Object.freeze({
      id,
      write(sequence, base64) {
        if (state.settled || active.get(id) !== state) {
          reject("transfer is no longer active");
        }
        if (sequence !== state.nextSequence) {
          abort();
          reject("chunk sequence is not contiguous", "ASSET_TRANSFER_SEQUENCE");
        }
        let bytes;
        try {
          bytes = decodeChunk(base64);
        } catch (error) {
          abort();
          throw error;
        }
        if (state.receivedBytes + bytes.length > state.totalBytes) {
          abort();
          reject("chunks exceed the declared length", "ASSET_TRANSFER_SIZE");
        }
        let offset = 0;
        while (offset < bytes.length) {
          offset += writeSync(state.fd, bytes, offset, bytes.length - offset);
        }
        state.hash.update(bytes);
        state.receivedBytes += bytes.length;
        state.nextSequence += 1;
        return { receivedBytes: state.receivedBytes, nextSequence: state.nextSequence };
      },
      finish({ chunks } = {}) {
        if (state.settled || active.get(id) !== state) {
          reject("transfer is no longer active");
        }
        if (chunks !== state.nextSequence) {
          abort();
          reject("final chunk count does not match", "ASSET_TRANSFER_SEQUENCE");
        }
        if (state.receivedBytes !== state.totalBytes) {
          abort();
          reject("received length does not match declaration", "ASSET_TRANSFER_SIZE");
        }
        const actualDigest = state.hash.digest("hex");
        if (actualDigest !== state.sha256) {
          abort();
          reject("final SHA-256 does not match declaration", "ASSET_TRANSFER_DIGEST");
        }
        const opened = fstatSync(state.fd);
        if (!opened.isFile() || opened.size !== state.totalBytes) {
          abort();
          reject("private transfer file changed during write");
        }
        const finalPath = pathFor(id, "bin");
        close(state.fd);
        try {
          renameSync(state.partPath, finalPath);
          chmodSync(finalPath, 0o600);
        } catch (error) {
          state.settled = true;
          active.delete(id);
          remove(state.partPath);
          remove(finalPath);
          throw error;
        }
        state.settled = true;
        active.delete(id);
        const descriptor = Object.freeze({
          id,
          totalBytes: state.totalBytes,
          sha256: state.sha256,
          details: state.details,
          createdAt: now(),
          path: finalPath,
        });
        ready.set(id, descriptor);
        return Object.freeze({
          id,
          totalBytes: descriptor.totalBytes,
          sha256: descriptor.sha256,
          details: descriptor.details,
        });
      },
      abort,
    });
  }

  function consume(id) {
    pruneExpired();
    const item = ready.get(id);
    if (!item) reject("transfer is missing or already consumed", "ASSET_TRANSFER_MISSING");
    ready.delete(id);
    const metadata = lstatSync(item.path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== item.totalBytes) {
      remove(item.path);
      reject("completed transfer changed before consumption");
    }
    let released = false;
    return Object.freeze({
      id,
      totalBytes: item.totalBytes,
      sha256: item.sha256,
      details: item.details,
      stream: createReadStream(item.path, {
        flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
        highWaterMark: MAX_ASSET_TRANSFER_CHUNK_BYTES,
      }),
      release() {
        if (released) return false;
        released = true;
        remove(item.path);
        return true;
      },
    });
  }

  function abortAll() {
    for (const state of [...active.values()]) {
      state.settled = true;
      close(state.fd);
      remove(state.partPath);
    }
    active.clear();
    for (const item of ready.values()) remove(item.path);
    ready.clear();
  }

  return Object.freeze({
    root: canonicalRoot,
    begin,
    consume,
    pruneExpired,
    abortAll,
    facts: () => Object.freeze({ active: active.size, ready: ready.size }),
  });
}
