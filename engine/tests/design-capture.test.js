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
