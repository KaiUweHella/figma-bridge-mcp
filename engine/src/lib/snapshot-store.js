// On-disk storage for structural snapshots.
//
// ~/.figma-bridge-mcp/snapshots/<fileKey>/<timestamp>.json.gz
//
// Per file key, so two projects never diff against each other by accident, and
// gzipped because a snapshot of a real screen is mostly repeated property names
// — it compresses about 10:1, which is the difference between keeping twenty
// restore points and keeping two.
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './state-dir.js';

// Keep enough history to answer "what changed this session" without letting an
// unattended agent fill a disk. Both are overridable per call.
export const DEFAULT_KEEP = 20;
export const DEFAULT_BUDGET_BYTES = 50 * 1024 * 1024;

// A file key comes from Figma, but it lands in a path — so it is constrained
// here rather than trusted. "local" covers never-saved drafts, which have none.
function safeKey(fileKey) {
  const key = String(fileKey || 'local').replace(/[^A-Za-z0-9_-]/g, '');
  return key.slice(0, 64) || 'local';
}

export function snapshotDir(fileKey, root = STATE_DIR) {
  return join(root, 'snapshots', safeKey(fileKey));
}

/** Timestamps go in the filename so listing is sorted without opening anything. */
function fileNameFor(takenAt) {
  return `${String(takenAt).replace(/[:.]/g, '-')}.json.gz`;
}

/**
 * Write a snapshot and prune older ones.
 * @returns {{path: string, bytes: number, pruned: string[]}}
 */
export function saveSnapshot(snapshot, { root = STATE_DIR, keep = DEFAULT_KEEP, budgetBytes = DEFAULT_BUDGET_BYTES } = {}) {
  const dir = snapshotDir(snapshot.fileKey, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, fileNameFor(snapshot.takenAt));
  const payload = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
  writeFileSync(path, payload);
  const pruned = prune(dir, { keep, budgetBytes });
  return { path, bytes: payload.length, pruned };
}

/** Newest first. Cheap: filenames carry the timestamp. */
export function listSnapshots(fileKey, { root = STATE_DIR } = {}) {
  const dir = snapshotDir(fileKey, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json.gz'))
    .sort()
    .reverse()
    .map((f) => {
      const full = join(dir, f);
      let bytes = 0;
      try { bytes = statSync(full).size; } catch {}
      return { file: f, path: full, bytes };
    });
}

export function readSnapshot(path) {
  const raw = gunzipSync(readFileSync(path));
  return JSON.parse(raw.toString('utf8'));
}

/**
 * Resolve a user-supplied reference to a snapshot path.
 * Accepts: "latest", "previous", an index ("2" = third newest), a filename, or
 * an absolute path. Returns null when nothing matches — callers report that
 * with the available options rather than guessing.
 */
export function resolveRef(ref, fileKey, { root = STATE_DIR } = {}) {
  const snaps = listSnapshots(fileKey, { root });
  const text = String(ref ?? '').trim();
  if (!text || text === 'latest') return snaps[0]?.path ?? null;
  if (text === 'previous') return snaps[1]?.path ?? null;
  if (/^\d+$/.test(text)) return snaps[Number(text)]?.path ?? null;
  if (existsSync(text)) return text;
  const named = snaps.find((s) => s.file === text || s.file.startsWith(text));
  return named?.path ?? null;
}

/** Enforce the count limit first, then the size budget. Returns deleted names. */
function prune(dir, { keep, budgetBytes }) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json.gz'))
    .sort()
    .reverse();
  const deleted = [];

  const survivors = [];
  files.forEach((f, i) => {
    if (i >= keep) {
      try { unlinkSync(join(dir, f)); deleted.push(f); } catch {}
    } else {
      survivors.push(f);
    }
  });

  let total = 0;
  for (const f of survivors) {
    let size = 0;
    try { size = statSync(join(dir, f)).size; } catch {}
    total += size;
    // The newest snapshot is never pruned, however large: losing the one that
    // was just written would make the command silently useless.
    if (total > budgetBytes && f !== survivors[0]) {
      try { unlinkSync(join(dir, f)); deleted.push(f); } catch {}
    }
  }
  return deleted;
}
