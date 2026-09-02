import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesignCaptureModule } from '../src/application/design-capture.js';

const walkerResult = (name = 'Screen') => ({
  id: '1:2', name, frames: [{ t: 'FRAME', n: name, id: '1:2', kids: [] }], sets: [],
});

function revisionAdapter({ revision = 1, connectionId = 'CONN_A', fileKey = 'FILE_A' } = {}) {
  const state = { revision, connectionId, fileKey, probes: 0, walks: 0, unstable: false };
  return {
    state,
    async evaluateWithMetadata(code) {
      const probe = code.includes('(async () => null)()');
      if (probe) state.probes++;
      else state.walks++;
      const before = state.revision;
      const after = state.unstable ? before + 1 : before;
      return {
        value: probe ? null : JSON.stringify(walkerResult()),
        metadata: {
          connectionId: state.connectionId,
          fileKey: state.fileKey,
          documentRevisionBefore: before,
          documentRevisionAfter: after,
        },
      };
    },
  };
}

const request = { nodeId: '1:2', fileKey: 'FILE_A', depth: 12, includeHidden: false };

test('one revision-stable Capture serves repeated projections without a second walker', async () => {
  const module = createDesignCaptureModule();
  const adapter = revisionAdapter();
  const first = await module.capture(request, adapter);
  const second = await module.capture(request, adapter);
  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'hit');
  assert.equal(adapter.state.walks, 1);
  assert.equal(adapter.state.probes, 1);
  assert.strictEqual(first.result, second.result);
  assert.equal(Object.isFrozen(second.result), true);
});

test('document revision and plugin connection changes invalidate immediately', async () => {
  const module = createDesignCaptureModule();
  const adapter = revisionAdapter();
  await module.capture(request, adapter);
  adapter.state.revision = 2;
  await module.capture(request, adapter);
  adapter.state.connectionId = 'CONN_B';
  await module.capture(request, adapter);
  assert.equal(adapter.state.walks, 3);
  assert.equal(adapter.state.probes, 2);
});

test('page revision reuses a Capture across unrelated-page changes and invalidates its own page', async () => {
  const module = createDesignCaptureModule();
  const state = { targetRevision: 4, unrelatedRevision: 9, walks: 0, probes: 0 };
  const adapter = {
    async evaluateWithMetadata(code) {
      const probe = code.includes('(async () => null)()');
      if (probe) state.probes++;
      else state.walks++;
      return {
        value: probe ? null : JSON.stringify(walkerResult()),
        metadata: {
          connectionId: 'CONN_A', fileKey: 'FILE_A', pluginVersion: '3.3.26',
          documentRevisionBefore: null, documentRevisionAfter: null,
          revisionObservation: {
            scope: 'page', pageId: '0:1',
            revisionBefore: state.targetRevision,
            revisionAfter: state.targetRevision,
          },
        },
      };
    },
  };
  assert.equal((await module.capture(request, adapter)).cache, 'miss');
  state.unrelatedRevision++;
  assert.equal((await module.capture(request, adapter)).cache, 'hit');
  state.targetRevision++;
  assert.equal((await module.capture(request, adapter)).cache, 'miss');
  assert.equal(state.walks, 2);
  assert.equal(state.probes, 2);
});

test('unstable or absent revisions are never cached', async () => {
  const unstableModule = createDesignCaptureModule();
  const unstable = revisionAdapter();
  unstable.state.unstable = true;
  assert.equal((await unstableModule.capture(request, unstable)).cache, 'bypass');
  assert.equal((await unstableModule.capture(request, unstable)).cache, 'bypass');
  assert.equal(unstable.state.walks, 2);
  assert.equal(unstable.state.probes, 0);

  const legacyModule = createDesignCaptureModule();
  let calls = 0;
  const legacy = { async evaluate() { calls++; return walkerResult(); } };
  assert.equal((await legacyModule.capture(request, legacy)).cache, 'bypass');
  assert.equal((await legacyModule.capture(request, legacy)).cache, 'bypass');
  assert.equal(calls, 2);
});

test('Capture key includes capture options but excludes projection concerns', async () => {
  const module = createDesignCaptureModule();
  const adapter = revisionAdapter();
  await module.capture({ ...request, phase: 'structure', format: 'yaml', dedup: true }, adapter);
  const projected = await module.capture({ ...request, phase: 'style', format: 'json', dedup: false }, adapter);
  assert.equal(projected.cache, 'hit');
  await module.capture({ ...request, includeHidden: true }, adapter);
  await module.capture({ ...request, depth: 10 }, adapter);
  assert.equal(adapter.state.walks, 3);
});

test('bounded LRU evicts old Captures', async () => {
  const module = createDesignCaptureModule({ maxEntries: 1, maxBytes: 1024 * 1024 });
  const adapter = revisionAdapter();
  await module.capture(request, adapter);
  await module.capture({ ...request, nodeId: '2:2' }, adapter);
  await module.capture(request, adapter);
  assert.equal(adapter.state.walks, 3);
});

test('parallel requests join one in-flight Capture', async () => {
  const module = createDesignCaptureModule();
  const adapter = revisionAdapter();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = adapter.evaluateWithMetadata.bind(adapter);
  adapter.evaluateWithMetadata = async (code) => { await gate; return original(code); };
  const a = module.capture(request, adapter);
  const b = module.capture(request, adapter);
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.cache, 'miss');
  assert.equal(second.cache, 'joined');
  assert.equal(adapter.state.walks, 1);
});

test('a complete Capture stitches wall-clock budget cuts under one observed revision', async () => {
  const module = createDesignCaptureModule({ maxEntries: 0, maxBytes: 0 });
  const walks = [];
  const metadata = { connectionId: 'CONN_A', fileKey: 'FILE_A', documentRevisionBefore: 4, documentRevisionAfter: 4 };
  const adapter = {
    async evaluateWithMetadata(code) {
      const match = code.match(/getNodeByIdAsync\("([^"]+)"\)/);
      const nodeId = match ? match[1] : null;
      const budget = Number(code.match(/const BUDGET_MS = (\d+);/)?.[1]);
      const maxDepth = Number(code.match(/const MAX_DEPTH = (\d+);/)?.[1]);
      walks.push({ nodeId, budget, maxDepth });
      const value = nodeId === '1:2'
        ? { id: '1:2', name: 'Screen', visibleNodeCount: 6, sets: [{ id: 'set:a', name: 'Button', props: {} }],
          frames: [{ t: 'FRAME', n: 'Screen', id: '1:2', kids: [
            { t: 'FRAME', n: 'Sidebar', id: '1:3', kids: [] },
            { t: 'FRAME', n: 'Workspace', id: '1:4', more: 2, budgetCut: true,
              frontier: [{ id: '1:5', name: 'Hero' }, { id: '1:6', name: 'Metrics' }] },
          ] }] }
        : nodeId === '1:5'
          ? { id: '1:5', name: 'Hero', sets: [{ id: 'set:a', name: 'Button', props: {} }, { id: 'set:b', name: 'Badge', props: {} }],
            frames: [{ t: 'FRAME', n: 'Hero', id: '1:5', more: 1, budgetCut: true, frontier: [{ id: '1:7', name: 'Orbit' }] }] }
          : nodeId === '1:6'
            ? { id: '1:6', name: 'Metrics', sets: [], frames: [{ t: 'FRAME', n: 'Metrics', id: '1:6', kids: [] }] }
            : { id: '1:7', name: 'Orbit', sets: [], frames: [{ t: 'ELLIPSE', n: 'Orbit', id: '1:7' }] };
      return { value: JSON.stringify(value), metadata };
    },
  };
  const capture = await module.capture({ nodeId: '1:2', fileKey: 'FILE_A', depth: 12, chunkBudgetMs: 500 }, adapter);
  assert.deepEqual(walks, [
    { nodeId: '1:2', budget: 500, maxDepth: 12 },
    { nodeId: '1:5', budget: 500, maxDepth: 10 },
    { nodeId: '1:6', budget: 500, maxDepth: 10 },
    { nodeId: '1:7', budget: 500, maxDepth: 9 },
  ], 'every frontier child is walked at the depth that remains below it');
  const workspace = capture.result.frames[0].kids[1];
  assert.equal(workspace.more, undefined);
  assert.equal(workspace.frontier, undefined);
  assert.equal(workspace.budgetCut, undefined);
  assert.deepEqual(workspace.kids.map((kid) => kid.id), ['1:5', '1:6']);
  assert.deepEqual(workspace.kids[0].kids.map((kid) => kid.id), ['1:7']);
  assert.deepEqual(capture.result.sets.map((set) => set.id), ['set:a', 'set:b'], 'sets merge by identity');
  assert.equal(capture.completeness.depthLimited, false);
  assert.equal(capture.completeness.budgetLimited, false);
  assert.equal(capture.completeness.stitchedCaptures, 3);
  assert.equal(capture.completeness.budgetCuts, 2);
  assert.equal(capture.options.complete, true);
});

test('a complete Capture fails explicitly when the document changes between stitched evals', async () => {
  const module = createDesignCaptureModule({ maxEntries: 0, maxBytes: 0 });
  let revision = 4;
  const adapter = {
    async evaluateWithMetadata(code) {
      const nodeId = code.match(/getNodeByIdAsync\("([^"]+)"\)/)?.[1];
      const metadata = { connectionId: 'CONN_A', fileKey: 'FILE_A', documentRevisionBefore: revision, documentRevisionAfter: revision };
      revision += 1;
      const value = nodeId === '1:2'
        ? { id: '1:2', name: 'Screen', sets: [], frames: [{ t: 'FRAME', n: 'Screen', id: '1:2', more: 1, budgetCut: true, frontier: [{ id: '1:3', name: 'Child' }] }] }
        : { id: '1:3', name: 'Child', sets: [], frames: [{ t: 'FRAME', n: 'Child', id: '1:3', kids: [] }] };
      return { value: JSON.stringify(value), metadata };
    },
  };
  await assert.rejects(
    module.capture({ nodeId: '1:2', fileKey: 'FILE_A', depth: 12 }, adapter),
    /observed a document change while completing node 1:2/,
  );
});

test('complete:false returns the first bounded eval with its budget cut visible', async () => {
  const module = createDesignCaptureModule({ maxEntries: 0, maxBytes: 0 });
  let walks = 0;
  const adapter = {
    async evaluate(code) {
      walks++;
      assert.match(code, /const BUDGET_MS = 0;/, 'opting out of completion also disables the walker budget');
      return JSON.stringify({ id: '1:2', name: 'Screen', sets: [], frames: [{ t: 'FRAME', n: 'Screen', id: '1:2', more: 1, budgetCut: true, frontier: [{ id: '1:3', name: 'Child' }] }] });
    },
  };
  const capture = await module.capture({ nodeId: '1:2', depth: 12, complete: false }, adapter);
  assert.equal(walks, 1);
  assert.equal(capture.completeness.budgetLimited, true);
  assert.equal(capture.completeness.stitchedCaptures, 0);
});
