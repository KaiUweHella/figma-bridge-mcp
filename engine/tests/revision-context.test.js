import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRevisionContext,
  sameObservedRevision,
  stableObservedRevision,
  stablePageRevision,
} from '../src/lib/revision-context.js';

function pageMetadata({ revision = 4, after = revision, pageId = '0:1', pluginVersion = '3.3.26' } = {}) {
  return {
    connectionId: 'CONN_A', fileKey: 'FILE_A', pluginVersion,
    documentRevisionBefore: null, documentRevisionAfter: null,
    revisionObservation: {
      scope: 'page', pageId, revisionBefore: revision, revisionAfter: after,
    },
  };
}

test('page Revision Context pins page identity and rejects target-page drift', () => {
  const context = createRevisionContext({
    expectedFileKey: 'FILE_A',
    revisionObservation: { scope: 'page', nodeId: '1:2' },
  });
  const first = pageMetadata();
  assert.equal(stablePageRevision(first), true);
  assert.equal(stableObservedRevision(first), true);
  assert.equal(context.accept(first).proof, 'page-revision');
  assert.deepEqual(context.observation(), { scope: 'page', nodeId: '1:2' });
  assert.equal(context.accept(pageMetadata()).proof, 'page-revision');
  assert.throws(() => context.accept(pageMetadata({ revision: 5 })), /observed revision changed/);
});

test('page Revision Context rejects within-call drift and a different page', () => {
  const changed = createRevisionContext({
    revisionObservation: { scope: 'page', nodeId: '1:2' },
  });
  assert.throws(() => changed.accept(pageMetadata({ revision: 4, after: 5 })), /observed Figma page changed/);

  const moved = createRevisionContext({
    revisionObservation: { scope: 'page', nodeId: '1:2' },
  });
  moved.accept(pageMetadata());
  assert.throws(() => moved.accept(pageMetadata({ pageId: '0:2' })), /observed revision changed/);
  assert.equal(sameObservedRevision(pageMetadata(), pageMetadata({ pageId: '0:2' })), false);
});

test('known old plugins retain document proof but new plugins must supply page proof', () => {
  const legacy = createRevisionContext({
    revisionObservation: { scope: 'page', nodeId: '1:2' },
  });
  const documentMetadata = {
    connectionId: 'CONN_A', fileKey: 'FILE_A', pluginVersion: '3.3.25',
    documentRevisionBefore: 7, documentRevisionAfter: 7,
  };
  assert.equal(legacy.accept(documentMetadata).proof, 'document-revision');

  const current = createRevisionContext({
    revisionObservation: { scope: 'page', nodeId: '1:2' },
  });
  assert.throws(() => current.accept({ ...documentMetadata, pluginVersion: '3.3.26' }),
    /required page revision/);
});
