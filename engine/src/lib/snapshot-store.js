// Private bounded storage for structural snapshots.
//
// A store instance owns one exact shared-state root. Callers may resolve only
// refs returned from that store; raw host paths never cross the read Interface.
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseBoundedJson } from './workspace-io.js';
import { STATE_DIR } from './state-dir.js';

export const DEFAULT_KEEP = 20;
export const DEFAULT_BUDGET_BYTES = 50 * 1024 * 1024;
export const MAX_SNAPSHOT_COMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOT_EXPANDED_BYTES = 32 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 256;
const MAX_SNAPSHOT_ENTRIES = 250_000;
const MAX_SNAPSHOT_DEPTH = 64;
const SNAPSHOT_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json\.gz$/;
const SAFE_REF = /^[A-Za-z0-9_.-]{1,128}$/;

export class SnapshotStoreError extends Error {
  constructor(reason, code = 'SNAPSHOT_STORE_REJECTED') {
    super(`Structural snapshot rejected: ${reason}.`);
    this.name = 'SnapshotStoreError';
    this.code = code;
    this.kind = 'shared-state-policy';
  }
}

function reject(reason, code) {
  throw new SnapshotStoreError(reason, code);
}

function inodeMatches(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  });
}

function fileMatches(metadata, identity) {
  return inodeMatches(metadata, identity)
    && metadata.size === identity.size
    && metadata.mtimeMs === identity.mtimeMs
    && metadata.ctimeMs === identity.ctimeMs;
}

function safeKey(fileKey) {
  const key = String(fileKey || 'local');
  if (/^[A-Za-z0-9_-]{1,64}$/.test(key)) return key;
  return `key-${createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
}

function fileNameFor(takenAt) {
  if (typeof takenAt !== 'string' || takenAt.length !== 24) {
    reject('takenAt must be one canonical UTC timestamp');
  }
  let canonical;
  try { canonical = new Date(takenAt).toISOString(); } catch { canonical = ''; }
  if (canonical !== takenAt) reject('takenAt must be one canonical UTC timestamp');
  const name = `${takenAt.replace(/[:.]/g, '-')}.json.gz`;
  if (!SNAPSHOT_FILE.test(name)) reject('timestamp did not produce a canonical snapshot filename');
  return name;
}

function validatedCount(value, fallback, label, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    reject(`${label} must be between 1 and ${max}`);
  }
  return number;
}

/** Create one authority for an exact private snapshot root. */
export function createSnapshotStore({ root = STATE_DIR, limits = {} } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) reject('root must be absolute');
  const lexicalRoot = path.resolve(root);
  const effective = Object.freeze({
    compressedBytes: limits.compressedBytes ?? MAX_SNAPSHOT_COMPRESSED_BYTES,
    expandedBytes: limits.expandedBytes ?? MAX_SNAPSHOT_EXPANDED_BYTES,
    files: limits.files ?? MAX_SNAPSHOT_FILES,
    entries: limits.entries ?? MAX_SNAPSHOT_ENTRIES,
    depth: limits.depth ?? MAX_SNAPSHOT_DEPTH,
  });
  validatedCount(effective.compressedBytes, MAX_SNAPSHOT_COMPRESSED_BYTES, 'compressed byte limit', MAX_SNAPSHOT_COMPRESSED_BYTES);
  validatedCount(effective.expandedBytes, MAX_SNAPSHOT_EXPANDED_BYTES, 'expanded byte limit', MAX_SNAPSHOT_EXPANDED_BYTES);
  validatedCount(effective.files, MAX_SNAPSHOT_FILES, 'file limit', MAX_SNAPSHOT_FILES);
  validatedCount(effective.entries, MAX_SNAPSHOT_ENTRIES, 'entry limit', MAX_SNAPSHOT_ENTRIES);
  validatedCount(effective.depth, MAX_SNAPSHOT_DEPTH, 'depth limit', MAX_SNAPSHOT_DEPTH);

  const descriptors = new WeakSet();
  const directory = (fileKey) => path.join(lexicalRoot, 'snapshots', safeKey(fileKey));

  function rootMetadata({ create = false } = {}) {
    if (!existsSync(lexicalRoot)) {
      if (!create) return null;
      mkdirSync(lexicalRoot, { recursive: true, mode: 0o700 });
    }
    const lexical = lstatSync(lexicalRoot);
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) reject('root is not an exact private directory');
    const canonical = realpathSync.native(lexicalRoot);
    if (create) chmodSync(lexicalRoot, 0o700);
    return { path: canonical, stat: lstatSync(canonical) };
  }

  function ownedDirectory(fileKey, { create = false } = {}) {
    const rootInfo = rootMetadata({ create });
    if (!rootInfo) return null;
    const snapshots = path.join(lexicalRoot, 'snapshots');
    const target = directory(fileKey);
    if (create) {
      for (const candidate of [snapshots, target]) {
        try { mkdirSync(candidate, { mode: 0o700 }); }
        catch (error) { if (error?.code !== 'EEXIST') reject('private snapshot directory could not be created'); }
        const metadata = lstatSync(candidate);
        const expectedCanonical = path.join(rootInfo.path, path.relative(lexicalRoot, candidate));
        if (!metadata.isDirectory() || metadata.isSymbolicLink()
          || realpathSync.native(candidate) !== expectedCanonical) {
          reject('snapshot directory escaped its private namespace');
        }
        chmodSync(candidate, 0o700);
      }
    } else if (!existsSync(target)) {
      return null;
    }
    for (const candidate of [snapshots, target]) {
      const metadata = lstatSync(candidate);
      const expectedCanonical = path.join(rootInfo.path, path.relative(lexicalRoot, candidate));
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || realpathSync.native(candidate) !== expectedCanonical) {
        reject('snapshot directory escaped its private namespace');
      }
    }
    return { path: target, stat: lstatSync(target), root: rootInfo };
  }

  function descriptor(fileKey, dir, entry) {
    const full = path.join(dir.path, entry.name);
    const metadata = lstatSync(full);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const value = Object.freeze({
      file: entry.name,
      path: full,
      bytes: metadata.size,
      fileKey: safeKey(fileKey),
      fileStat: fileIdentity(metadata),
      directoryStat: Object.freeze({ dev: dir.stat.dev, ino: dir.stat.ino }),
    });
    descriptors.add(value);
    return value;
  }

  function list(fileKey) {
    const dir = ownedDirectory(fileKey);
    if (!dir) return [];
    const entries = readdirSync(dir.path, { withFileTypes: true });
    if (entries.length > effective.files) reject('snapshot directory exceeds the file limit', 'SNAPSHOT_FILE_LIMIT');
    return Object.freeze(entries
      .filter((entry) => SNAPSHOT_FILE.test(entry.name))
      .map((entry) => descriptor(fileKey, dir, entry))
      .filter(Boolean)
      .sort((left, right) => right.file.localeCompare(left.file)));
  }

  function resolve(ref, fileKey) {
    const items = list(fileKey);
    const text = String(ref ?? '').trim();
    if (!text || text === 'latest') return items[0] ?? null;
    if (text === 'previous') return items[1] ?? null;
    if (/^\d{1,3}$/.test(text)) return items[Number(text)] ?? null;
    if (!SAFE_REF.test(text) || text === '.' || text === '..'
      || path.isAbsolute(text) || text.includes('/') || text.includes('\\')) {
      reject('snapshot ref rejected before path resolution');
    }
    const exact = items.find((item) => item.file === text);
    if (exact) return exact;
    const matches = items.filter((item) => item.file.startsWith(text));
    if (matches.length > 1) reject('snapshot ref is ambiguous');
    return matches[0] ?? null;
  }

  function read(ref) {
    if (!ref || typeof ref !== 'object' || !descriptors.has(ref)) {
      reject('read requires a ref resolved by this Snapshot Store');
    }
    const dir = ownedDirectory(ref.fileKey);
    if (!dir || !inodeMatches(dir.stat, ref.directoryStat)) reject('snapshot directory changed before read');
    let fd;
    let compressed;
    try {
      fd = openSync(ref.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = fstatSync(fd);
      const current = lstatSync(ref.path);
      const currentDir = lstatSync(dir.path);
      if (!opened.isFile() || !fileMatches(opened, ref.fileStat)
        || !fileMatches(current, ref.fileStat)
        || !inodeMatches(currentDir, ref.directoryStat)) {
        reject('snapshot changed while it was opened');
      }
      if (opened.size > effective.compressedBytes) {
        reject('compressed byte limit exceeded', 'SNAPSHOT_COMPRESSED_BYTE_LIMIT');
      }
      compressed = readFileSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    let expanded;
    try {
      expanded = gunzipSync(compressed, { maxOutputLength: effective.expandedBytes });
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|larger than/i.test(error?.message || '')) {
        reject('expanded byte limit exceeded', 'SNAPSHOT_EXPANDED_BYTE_LIMIT');
      }
      reject('snapshot compression is invalid');
    }
    if (expanded.length > effective.expandedBytes) {
      reject('expanded byte limit exceeded', 'SNAPSHOT_EXPANDED_BYTE_LIMIT');
    }
    let value;
    try {
      value = parseBoundedJson(expanded.toString('utf8'), {
        role: 'structural-snapshot',
        limits: {
          jsonBytes: effective.expandedBytes,
          textBytes: effective.expandedBytes,
          binaryBytes: effective.compressedBytes,
          nestingDepth: effective.depth,
          collectionEntries: effective.entries,
          yamlAliases: 0,
        },
      });
    } catch (error) {
      if (error?.kind === 'workspace-policy') reject('snapshot JSON exceeds its structural limits');
      reject('snapshot JSON is invalid');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject('snapshot JSON must be an object');
    return value;
  }

  function removeOwned(item) {
    if (!descriptors.has(item)) return false;
    try {
      const parent = lstatSync(path.dirname(item.path));
      const current = lstatSync(item.path);
      if (!parent.isDirectory() || parent.isSymbolicLink()
        || !inodeMatches(parent, item.directoryStat)
        || !current.isFile() || current.isSymbolicLink()
        || !fileMatches(current, item.fileStat)) return false;
      unlinkSync(item.path);
      return true;
    } catch { return false; }
  }

  function prune(fileKey, { keep, budgetBytes }) {
    const items = [...list(fileKey)];
    const pruned = [];
    const survivors = [];
    items.forEach((item, index) => {
      if (index >= keep) {
        if (removeOwned(item)) pruned.push(item.file);
      } else survivors.push(item);
    });
    let total = 0;
    for (const item of survivors) {
      total += item.bytes;
      if (total > budgetBytes && item !== survivors[0] && removeOwned(item)) pruned.push(item.file);
    }
    return pruned;
  }

  function save(snapshot, options = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) reject('snapshot must be an object');
    const keep = validatedCount(options.keep, DEFAULT_KEEP, 'keep', effective.files);
    const budgetBytes = validatedCount(options.budgetBytes, DEFAULT_BUDGET_BYTES, 'budgetBytes', 1024 * 1024 * 1024);
    const filename = fileNameFor(snapshot.takenAt);
    let json;
    try { json = JSON.stringify(snapshot); } catch { reject('snapshot is not serializable'); }
    try {
      parseBoundedJson(json, {
        role: 'structural-snapshot',
        limits: {
          jsonBytes: effective.expandedBytes,
          textBytes: effective.expandedBytes,
          binaryBytes: effective.compressedBytes,
          nestingDepth: effective.depth,
          collectionEntries: effective.entries,
          yamlAliases: 0,
        },
      });
    } catch { reject('snapshot exceeds its structural limits'); }
    const payload = gzipSync(Buffer.from(json, 'utf8'));
    if (payload.length > effective.compressedBytes) reject('compressed byte limit exceeded', 'SNAPSHOT_COMPRESSED_BYTE_LIMIT');

    const dir = ownedDirectory(snapshot.fileKey, { create: true });
    if (list(snapshot.fileKey).length >= effective.files) {
      reject('snapshot directory reached the file limit', 'SNAPSHOT_FILE_LIMIT');
    }
    const destination = path.join(dir.path, filename);
    let fd;
    let opened;
    let ownsLeaf = false;
    try {
      fd = openSync(destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
        0o600);
      opened = fstatSync(fd);
      ownsLeaf = opened.isFile();
      const currentDir = lstatSync(dir.path);
      if (!ownsLeaf || !inodeMatches(currentDir, dir.stat)) reject('snapshot directory changed during publication');
      fchmodSync(fd, 0o600);
      writeFileSync(fd, payload);
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
        fd = undefined;
      }
      if (ownsLeaf && opened) {
        try {
          const current = lstatSync(destination);
          if (inodeMatches(current, opened)) unlinkSync(destination);
        } catch {}
      }
      if (error instanceof SnapshotStoreError) throw error;
      if (error?.code === 'EEXIST') reject('snapshot timestamp already exists', 'SNAPSHOT_COLLISION');
      reject('snapshot could not be published');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const saved = list(snapshot.fileKey).find((item) => item.file === filename);
    if (!saved) reject('published snapshot could not be resolved');
    const pruned = prune(snapshot.fileKey, { keep, budgetBytes });
    return Object.freeze({
      file: filename,
      path: destination,
      bytes: payload.length,
      pruned: Object.freeze(pruned),
    });
  }

  function guarded(operation, reason) {
    try { return operation(); }
    catch (error) {
      if (error instanceof SnapshotStoreError) throw error;
      reject(reason);
    }
  }

  return Object.freeze({
    directory,
    save: (...args) => guarded(() => save(...args), 'snapshot could not be published'),
    list: (...args) => guarded(() => list(...args), 'snapshot directory could not be listed'),
    resolve: (...args) => guarded(() => resolve(...args), 'snapshot ref could not be resolved'),
    read: (...args) => guarded(() => read(...args), 'snapshot could not be read'),
  });
}

export const snapshotStore = createSnapshotStore();
