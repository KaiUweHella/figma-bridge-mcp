import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetPolicyPluginSource,
  capturedVectorCluster,
  captureVectorFacts,
  isCapturedVectorArt,
  VECTOR_CLUSTER_MIN_CHILDREN,
} from '../src/lib/asset-policy.js';
import { assetCollectorCode } from '../src/design-extract.js';

const vector = (type = 'VECTOR') => ({ t: type, kids: [] });

test('one Asset Policy classifies captured vector art and soft styling', () => {
  assert.deepEqual(captureVectorFacts(vector('VECTOR')), { vec: true, hard: true });
  assert.equal(isCapturedVectorArt(vector('RECTANGLE')), false);
  assert.equal(isCapturedVectorArt({ t: 'FRAME', kids: [vector('VECTOR'), vector('RECTANGLE')] }), true);
  assert.equal(isCapturedVectorArt({ t: 'FRAME', fills: ['IMAGE'], kids: [vector()] }), false);
});

test('cluster threshold is canonical and exported', () => {
  const kids = Array.from({ length: VECTOR_CLUSTER_MIN_CHILDREN }, (_, index) =>
    index === VECTOR_CLUSTER_MIN_CHILDREN - 1 ? { t: 'TEXT' } : vector());
  assert.equal(capturedVectorCluster({ t: 'FRAME', kids }).cluster, true);
  assert.equal(capturedVectorCluster({ t: 'FRAME', kids: kids.slice(0, VECTOR_CLUSTER_MIN_CHILDREN - 1) }).cluster, false);
});

test('plugin collector embeds the same policy Implementation', () => {
  const source = assetPolicyPluginSource();
  const collector = assetCollectorCode('1:2');
  assert.match(collector, new RegExp(`VECTOR_CLUSTER_MIN_CHILDREN = ${VECTOR_CLUSTER_MIN_CHILDREN}`));
  assert.ok(collector.includes(source.trim()));
  assert.doesNotMatch(collector, /const SOFT_VEC =|const HARD_VEC =|const isVec =/);
  assert.doesNotThrow(() => new Function(`return ${collector};`));
});
