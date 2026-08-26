// Snapshot normalization, diffing and storage — all reachable without Figma,
// which is the point: the whole feature is built so the comparison logic can be
// proven on plain objects and only the capture step needs a live document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeSnapshot, normalizeRestDocument, buildSnapshotEval, hashOf,
} from '../src/lib/doc-snapshot.js';
import { diffSnapshots, formatDiff, formatChangelog, isEmptyDiff } from '../src/lib/doc-diff.js';
import {
  createSnapshotStore,
  MAX_SNAPSHOT_COMPRESSED_BYTES,
} from '../src/lib/snapshot-store.js';
import { assertPosixMode } from '../../test-support/posix-permissions.js';

// A tiny document: page → Hero → [Title, Button]
function rawDoc(overrides = {}) {
  const nodes = [
    { id: '0:1', name: 'Page 1', type: 'PAGE', path: 'Page 1', parentId: null, index: 0,
      x: 0, y: 0, w: 0, h: 0, props: {} },
    { id: '1:1', name: 'Hero', type: 'FRAME', path: 'Page 1 / Hero', parentId: '0:1', index: 0,
      x: 0, y: 0, w: 400, h: 200, props: { layoutMode: 'VERTICAL', itemSpacing: 8 } },
    { id: '1:2', name: 'Title', type: 'TEXT', path: 'Page 1 / Hero / Title', parentId: '1:1', index: 0,
      x: 16, y: 16, w: 200, h: 24, props: { characters: 'Hello', fontSize: 24 } },
    { id: '1:3', name: 'Button', type: 'INSTANCE', path: 'Page 1 / Hero / Button', parentId: '1:1', index: 1,
      x: 16, y: 56, w: 120, h: 40, props: { mainComponentKey: 'abc' } },
  ];
  return {
    rootId: '0:1', rootName: 'Page 1', rootType: 'PAGE',
    fileKey: 'FILEKEY123', fileName: 'Test File', page: 'Page 1',
    nodes, ...overrides,
  };
}

function snap(mutate = (n) => n, meta = {}) {
  const doc = rawDoc();
  doc.nodes = doc.nodes.map((n) => mutate({ ...n, props: { ...n.props } })).filter(Boolean);
  return normalizeSnapshot(doc, meta);
}

test('normalizeSnapshot hashes each node and folds children into subtree hashes', () => {
  const s = normalizeSnapshot(rawDoc(), { label: 'base' });
  assert.equal(s.nodeCount, 4);
  assert.equal(s.fileKey, 'FILEKEY123');
  assert.equal(s.label, 'base');
  for (const n of s.nodes) {
    assert.match(n.hash, /^[0-9a-f]{12}$/);
    assert.match(n.subtreeHash, /^[0-9a-f]{12}$/);
  }
  // A leaf's subtree hash differs from its own hash (it folds in an empty
  // child list), but both must be stable across runs.
  const again = normalizeSnapshot(rawDoc(), { label: 'base' });
  assert.deepEqual(s.nodes.map((n) => n.subtreeHash), again.nodes.map((n) => n.subtreeHash));
});

test('a child change propagates to ancestor subtree hashes but not to siblings', () => {
  const base = normalizeSnapshot(rawDoc());
  const doc = rawDoc();
  doc.nodes[2].props.characters = 'Goodbye';
  const after = normalizeSnapshot(doc);

  const by = (s, id) => s.nodes.find((n) => n.id === id);
  assert.notEqual(by(base, '1:2').subtreeHash, by(after, '1:2').subtreeHash, 'the text node changed');
  assert.notEqual(by(base, '1:1').subtreeHash, by(after, '1:1').subtreeHash, 'its parent must change too');
  assert.notEqual(by(base, '0:1').subtreeHash, by(after, '0:1').subtreeHash, 'and the page');
  assert.equal(by(base, '1:3').subtreeHash, by(after, '1:3').subtreeHash, 'the sibling must NOT change');
});

test('hashOf is key-order independent', () => {
  assert.equal(hashOf({ a: 1, b: [2, { c: 3 }] }), hashOf({ b: [2, { c: 3 }], a: 1 }));
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
});

test('geometry is rounded, so sub-pixel relayout noise is not a change', () => {
  const doc = rawDoc();
  doc.nodes[1].x = 0.0001;
  const jittered = normalizeSnapshot(doc);
  const base = normalizeSnapshot(rawDoc());
  assert.equal(
    jittered.nodes[1].hash, base.nodes[1].hash,
    'a 0.0001px difference must not register as a change',
  );
});

test('semantic paths navigate snapshots but never alter visual subtree hashes', () => {
  const marked = rawDoc();
  marked.nodes[1].semanticPath = 'screen.hero';
  const captured = normalizeSnapshot(marked);
  assert.equal(captured.nodes[1].semanticPath, 'screen.hero');
  const renamed = rawDoc();
  renamed.nodes[1].semanticPath = 'screen.hero-renamed';
  const recaptured = normalizeSnapshot(renamed);
  assert.equal(captured.nodes[1].hash, recaptured.nodes[1].hash);
  assert.equal(captured.nodes[1].subtreeHash, recaptured.nodes[1].subtreeHash);
});

test('identical snapshots produce an empty diff', () => {
  const d = diffSnapshots(snap(), snap());
  assert.ok(isEmptyDiff(d));
  assert.equal(d.summary.unchanged, 4);
  assert.match(formatDiff(d, {}), /no structural differences/);
});

test('a property change is reported with old and new values', () => {
  const before = snap();
  const after = snap((n) => (n.id === '1:2' ? { ...n, props: { ...n.props, characters: 'Goodbye' } } : n));
  const d = diffSnapshots(before, after);
  assert.equal(d.summary.changed, 1);
  assert.equal(d.summary.added, 0);
  assert.equal(d.summary.removed, 0);
  const change = d.changed[0];
  assert.equal(change.node.id, '1:2');
  const chars = change.changes.find((c) => c.key === 'characters');
  assert.deepEqual([chars.from, chars.to], ['Hello', 'Goodbye']);
});

test('geometry changes are labelled as geometry, not as properties', () => {
  const before = snap();
  const after = snap((n) => (n.id === '1:1' ? { ...n, w: 500 } : n));
  const d = diffSnapshots(before, after);
  const change = d.changed[0].changes[0];
  assert.equal(change.kind, 'geometry');
  assert.deepEqual([change.key, change.from, change.to], ['w', 400, 500]);
});

test('added and removed nodes are separated', () => {
  const before = snap();
  const after = snap((n) => (n.id === '1:3' ? null : n));
  const d = diffSnapshots(before, after);
  assert.equal(d.summary.removed, 1);
  assert.equal(d.removed[0].id, '1:3');
  assert.equal(d.summary.added, 0);

  const reverse = diffSnapshots(after, before);
  assert.equal(reverse.summary.added, 1);
  assert.equal(reverse.added[0].id, '1:3');
});

test('a re-render reads as "replaced", not as a mass delete plus a mass add', () => {
  // This is the case that decides whether the diff is usable at all: an agent
  // deleting a frame and rendering it again keeps the path but changes ids.
  const before = snap();
  const after = snap((n) => (n.id.startsWith('1:') ? { ...n, id: `9:${n.id.split(':')[1]}` } : n));
  // Re-parent the moved children onto the new ids so the tree stays coherent.
  after.nodes = after.nodes.map((n) => ({
    ...n,
    parentId: n.parentId === '1:1' ? '9:1' : n.parentId,
  }));

  const d = diffSnapshots(before, after);
  assert.equal(d.summary.added, 0, 'nothing should look newly added');
  assert.equal(d.summary.removed, 0, 'nothing should look deleted');
  assert.equal(d.summary.replaced, 3, 'the three recreated nodes are replacements');
  for (const r of d.replaced) {
    assert.ok(r.identical, 'recreated unchanged, so no property differences');
  }
});

test('a replaced node that also changed reports its differences', () => {
  const before = snap();
  const after = snap((n) => (n.id === '1:2'
    ? { ...n, id: '9:2', props: { ...n.props, characters: 'New' } }
    : n));
  const d = diffSnapshots(before, after);
  assert.equal(d.summary.replaced, 1);
  assert.equal(d.replaced[0].identical, false);
  assert.equal(d.replaced[0].changes.find((c) => c.key === 'characters').to, 'New');
});

test('reorder and reparent are reported as moves', () => {
  const before = snap();
  const reordered = snap((n) => (n.id === '1:3' ? { ...n, index: 0 } : n));
  const d1 = diffSnapshots(before, reordered);
  assert.equal(d1.summary.moved, 1);
  assert.equal(d1.moved[0].reparented, false);
  assert.deepEqual([d1.moved[0].fromIndex, d1.moved[0].toIndex], [1, 0]);

  const reparented = snap((n) => (n.id === '1:3' ? { ...n, parentId: '0:1' } : n));
  const d2 = diffSnapshots(before, reparented);
  assert.equal(d2.moved[0].reparented, true);
});

test('the text report names each section and truncates long ones', () => {
  const before = snap();
  const after = snap((n) => (n.id === '1:2' ? { ...n, props: { ...n.props, characters: 'X' } } : n));
  const out = formatDiff(before && diffSnapshots(before, after), { before, after, maxPerSection: 1 });
  assert.match(out, /summary: /);
  assert.match(out, /changed:/);
  assert.match(out, /characters: Hello → X/);
});

test('the changelog is markdown and leads with the counts', () => {
  const before = snap();
  const after = snap((n) => (n.id === '1:3' ? null : n));
  const md = formatChangelog(diffSnapshots(before, after), { before, after, title: 'Sprint 4' });
  assert.match(md, /^# Sprint 4/);
  assert.match(md, /## Removed/);
  assert.match(md, /`Page 1 \/ Hero \/ Button`/);
  assert.doesNotMatch(md, /## Added/, 'empty sections are omitted');
});

test('REST documents normalize into the same shape, so one differ serves both', () => {
  const restDoc = {
    id: '0:1', name: 'Document', type: 'DOCUMENT',
    children: [{
      id: '1:1', name: 'Hero', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 200 },
      layoutMode: 'VERTICAL', itemSpacing: 8,
      children: [{
        id: '1:2', name: 'Title', type: 'TEXT',
        absoluteBoundingBox: { x: 16, y: 16, width: 200, height: 24 },
        characters: 'Hello',
      }],
    }],
  };
  const s = normalizeRestDocument(restDoc, { fileKey: 'K', version: '123' });
  assert.equal(s.source, 'rest');
  assert.equal(s.version, '123');
  assert.equal(s.nodeCount, 3);
  assert.equal(s.nodes[2].path, 'Document / Hero / Title');
  for (const n of s.nodes) assert.match(n.subtreeHash, /^[0-9a-f]{12}$/);

  // And two REST versions diff with the very same function.
  const changed = JSON.parse(JSON.stringify(restDoc));
  changed.children[0].children[0].characters = 'Bye';
  const d = diffSnapshots(s, normalizeRestDocument(changed, { fileKey: 'K', version: '124' }));
  assert.equal(d.summary.changed, 1);
});

test('normalizeSnapshot refuses a payload with no nodes instead of storing junk', () => {
  assert.throws(() => normalizeSnapshot(null), /no nodes/);
  assert.throws(() => normalizeSnapshot({}), /no nodes/);
});

test('buildSnapshotEval targets the page by default and a node when asked', () => {
  assert.match(buildSnapshotEval(), /figma\.currentPage;/);
  assert.match(buildSnapshotEval({ nodeId: '12:34' }), /getNodeByIdAsync\("12:34"\)/);
  assert.match(buildSnapshotEval({ depth: 2 }), /MAX_DEPTH = 2/);
  assert.match(buildSnapshotEval(), /MAX_DEPTH = -1/);
  // figma.mixed is a symbol and would break JSON round-tripping.
  assert.match(buildSnapshotEval(), /__mixed__/);
  assert.match(buildSnapshotEval(), /figmaBridge\.semanticPath/);
});

test('the store saves, lists, reads back and resolves refs', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-'));
  try {
    const store = createSnapshotStore({ root });
    const a = snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z', label: 'morning' });
    const b = snap(undefined, { takenAt: '2026-08-04T18:00:00.000Z', label: 'evening' });
    store.save(a);
    const saved = store.save(b);
    assert.ok(existsSync(saved.path));
    assertPosixMode(saved.path, 0o600);
    assertPosixMode(store.directory('FILEKEY123'), 0o700);

    const list = store.list('FILEKEY123');
    assert.equal(list.length, 2);
    assert.equal(store.read(list[0]).label, 'evening', 'newest first');

    assert.equal(store.read(store.resolve('latest', 'FILEKEY123')).label, 'evening');
    assert.equal(store.read(store.resolve('previous', 'FILEKEY123')).label, 'morning');
    assert.equal(store.read(store.resolve('1', 'FILEKEY123')).label, 'morning');
    assert.equal(store.read(store.resolve('2026-08-04T18', 'FILEKEY123')).label, 'evening');
    assert.equal(store.resolve('nope', 'FILEKEY123'), null);
    assert.equal(store.resolve('latest', 'OTHERFILE'), null, 'file keys are isolated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the store prunes to the keep limit but never the newest', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-'));
  try {
    const store = createSnapshotStore({ root });
    for (let i = 0; i < 5; i++) {
      store.save(snap(undefined, { takenAt: `2026-08-0${i + 1}T10:00:00.000Z` }), { keep: 3 });
    }
    const list = store.list('FILEKEY123');
    assert.equal(list.length, 3);
    assert.equal(store.read(list[0]).takenAt, '2026-08-05T10:00:00.000Z');

    // A budget smaller than one snapshot must still leave the newest in place.
    store.save(snap(undefined, { takenAt: '2026-08-06T10:00:00.000Z' }), { keep: 3, budgetBytes: 1 });
    const after = store.list('FILEKEY123');
    assert.equal(after.length, 1);
    assert.equal(store.read(after[0]).takenAt, '2026-08-06T10:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file key from Figma cannot escape the snapshot directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-'));
  try {
    const store = createSnapshotStore({ root });
    const evil = snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z' });
    evil.fileKey = '../../../etc/passwd';
    const { path } = store.save(evil);
    assert.ok(path.startsWith(root), `snapshot escaped its root: ${path}`);
    assert.doesNotMatch(path, /\.\./);

    const other = snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z' });
    other.fileKey = '..//../etc/passwd';
    store.save(other);
    assert.notEqual(store.directory(evil.fileKey), store.directory(other.fileKey),
      'distinct hostile keys must not collapse into one namespace');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the store rejects host paths, traversal, ambiguous refs and symlink leaves', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-policy-'));
  const outside = mkdtempSync(join(tmpdir(), 'figma-snap-outside-'));
  try {
    const store = createSnapshotStore({ root });
    store.save(snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z' }));
    store.save(snap(undefined, { takenAt: '2026-08-04T18:00:00.000Z' }));
    for (const ref of ['/etc/passwd', '../outside.json.gz', 'nested/file.json.gz']) {
      assert.throws(() => store.resolve(ref, 'FILEKEY123'), /snapshot ref rejected/);
    }
    assert.throws(() => store.resolve('2026-08-04', 'FILEKEY123'), /ambiguous/);

    const external = join(outside, '2026-08-05T10-00-00-000Z.json.gz');
    writeFileSync(external, gzipSync('{}'));
    symlinkSync(external, join(store.directory('FILEKEY123'), '2026-08-05T10-00-00-000Z.json.gz'));
    assert.equal(store.list('FILEKEY123').length, 2, 'symlink leaves never become snapshot refs');
    assert.equal(store.resolve('2026-08-05', 'FILEKEY123'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the store rejects a symlinked snapshot namespace before publication', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-parent-'));
  const outside = mkdtempSync(join(tmpdir(), 'figma-snap-parent-outside-'));
  try {
    symlinkSync(outside, join(root, 'snapshots'), 'dir');
    const store = createSnapshotStore({ root });
    assert.throws(
      () => store.save(snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z' })),
      /escaped its private namespace/,
    );
    assert.equal(existsSync(join(outside, 'FILEKEY123')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the store bounds compressed and expanded bytes before JSON parsing', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-limits-'));
  try {
    const store = createSnapshotStore({ root, limits: { expandedBytes: 4096 } });
    store.save(snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z' }));
    const dir = store.directory('FILEKEY123');
    const expanded = join(dir, '2026-08-05T10-00-00-000Z.json.gz');
    writeFileSync(expanded, gzipSync(JSON.stringify({ value: 'x'.repeat(8192) })), { mode: 0o600 });
    assert.throws(() => store.read(store.resolve('2026-08-05', 'FILEKEY123')), /expanded byte limit/);

    const compressed = join(dir, '2026-08-06T10-00-00-000Z.json.gz');
    writeFileSync(compressed, Buffer.alloc(MAX_SNAPSHOT_COMPRESSED_BYTES + 1), { mode: 0o600 });
    assert.throws(() => store.read(store.resolve('2026-08-06', 'FILEKEY123')), /compressed byte limit/);

    const nested = join(dir, '2026-08-07T10-00-00-000Z.json.gz');
    writeFileSync(nested, gzipSync('{"a":{"b":{"c":{"d":{"e":1}}}}}'), { mode: 0o600 });
    const shallowStore = createSnapshotStore({ root, limits: { depth: 3 } });
    assert.throws(
      () => shallowStore.read(shallowStore.resolve('2026-08-07', 'FILEKEY123')),
      /structural limits/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot publication never overwrites an existing timestamp collision', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-collision-'));
  try {
    const store = createSnapshotStore({ root });
    const first = snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z', label: 'first' });
    const saved = store.save(first);
    const before = readFileSync(saved.path);
    assert.throws(
      () => store.save(snap(undefined, { takenAt: first.takenAt, label: 'second' })),
      /already exists/,
    );
    assert.deepEqual(readFileSync(saved.path), before);
    const invalid = snap(undefined, { takenAt: '2026-08-05T10:00:00.000Z' });
    invalid.takenAt = '../../outside';
    assert.throws(() => store.save(invalid), /canonical UTC timestamp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot reads require an owned unchanged descriptor and redact host failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-descriptor-'));
  try {
    const store = createSnapshotStore({ root });
    store.save(snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z' }));
    const ref = store.resolve('latest', 'FILEKEY123');
    assert.throws(() => store.read({ ...ref }), /requires a ref resolved by this Snapshot Store/);

    // Rewrite the already-resolved file in place. This preserves its inode and
    // proves the descriptor protects the snapshot bytes, not only the path.
    writeFileSync(ref.path, gzipSync(JSON.stringify({ replaced: true })), { mode: 0o600 });
    let failure;
    try { store.read(ref); } catch (error) { failure = error; }
    assert.match(failure?.message || '', /changed while it was opened/);
    assert.doesNotMatch(failure?.message || '', new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'store errors must not expose their host root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
