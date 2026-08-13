// Snapshot normalization, diffing and storage — all reachable without Figma,
// which is the point: the whole feature is built so the comparison logic can be
// proven on plain objects and only the capture step needs a live document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeSnapshot, normalizeRestDocument, buildSnapshotEval, hashOf,
} from '../src/lib/doc-snapshot.js';
import { diffSnapshots, formatDiff, formatChangelog, isEmptyDiff } from '../src/lib/doc-diff.js';
import { saveSnapshot, listSnapshots, readSnapshot, resolveRef } from '../src/lib/snapshot-store.js';

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
    const a = snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z', label: 'morning' });
    const b = snap(undefined, { takenAt: '2026-08-04T18:00:00.000Z', label: 'evening' });
    saveSnapshot(a, { root });
    const saved = saveSnapshot(b, { root });
    assert.ok(existsSync(saved.path));

    const list = listSnapshots('FILEKEY123', { root });
    assert.equal(list.length, 2);
    assert.equal(readSnapshot(list[0].path).label, 'evening', 'newest first');

    assert.equal(readSnapshot(resolveRef('latest', 'FILEKEY123', { root })).label, 'evening');
    assert.equal(readSnapshot(resolveRef('previous', 'FILEKEY123', { root })).label, 'morning');
    assert.equal(readSnapshot(resolveRef('1', 'FILEKEY123', { root })).label, 'morning');
    assert.equal(resolveRef('nope', 'FILEKEY123', { root }), null);
    assert.equal(resolveRef('latest', 'OTHERFILE', { root }), null, 'file keys are isolated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the store prunes to the keep limit but never the newest', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-'));
  try {
    for (let i = 0; i < 5; i++) {
      saveSnapshot(snap(undefined, { takenAt: `2026-08-0${i + 1}T10:00:00.000Z` }), { root, keep: 3 });
    }
    const list = listSnapshots('FILEKEY123', { root });
    assert.equal(list.length, 3);
    assert.equal(readSnapshot(list[0].path).takenAt, '2026-08-05T10:00:00.000Z');

    // A budget smaller than one snapshot must still leave the newest in place.
    saveSnapshot(snap(undefined, { takenAt: '2026-08-06T10:00:00.000Z' }), { root, keep: 3, budgetBytes: 1 });
    const after = listSnapshots('FILEKEY123', { root });
    assert.equal(after.length, 1);
    assert.equal(readSnapshot(after[0].path).takenAt, '2026-08-06T10:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file key from Figma cannot escape the snapshot directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'figma-snap-'));
  try {
    const evil = snap(undefined, { takenAt: '2026-08-04T10:00:00.000Z' });
    evil.fileKey = '../../../etc/passwd';
    const { path } = saveSnapshot(evil, { root });
    assert.ok(path.startsWith(root), `snapshot escaped its root: ${path}`);
    assert.doesNotMatch(path, /\.\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
