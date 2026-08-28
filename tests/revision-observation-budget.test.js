import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVISION_OBSERVATION_COLD_BUDGET,
  assessRevisionObservationColdBudget,
} from '../scripts/lib/revision-observation-budget.js';

const accepted = {
  page: { scope: 'page', stable: true, pluginVersion: '3.3.30', elapsedMs: 29.882 },
  document: { scope: 'document', stable: true, pluginVersion: '3.3.30', elapsedMs: 328.544 },
  documentFacts: { pageCount: 33, nodeCount: 30_534 },
};

test('qualified cold Page observation stays beneath absolute and relative budgets', () => {
  assert.deepEqual(REVISION_OBSERVATION_COLD_BUDGET, {
    minimumPageCount: 25,
    minimumNodeCount: 25_000,
    maximumPageElapsedMs: 250,
    maximumPageToDocumentRatio: 0.5,
  });
  const result = assessRevisionObservationColdBudget(accepted);
  assert.equal(result.passed, true);
  assert.equal(result.findings.length, 0);
  assert.ok(result.metrics.pageToDocumentRatio < 0.1);
});

test('the budget rejects unqualified, unstable and mismatched samples', () => {
  const result = assessRevisionObservationColdBudget({
    page: { ...accepted.page, stable: false, pluginVersion: '3.3.29' },
    document: accepted.document,
    documentFacts: { pageCount: 2, nodeCount: 100 },
  });
  assert.equal(result.passed, false);
  assert.match(result.findings.join('\n'), /stable bounded cold observation/);
  assert.match(result.findings.join('\n'), /different Plugin builds/);
  assert.match(result.findings.join('\n'), /Page count/);
  assert.match(result.findings.join('\n'), /node count/);
});

test('a Page path that regresses toward full-document cost fails closed', () => {
  const result = assessRevisionObservationColdBudget({
    ...accepted,
    page: { ...accepted.page, elapsedMs: 280 },
  });
  assert.equal(result.passed, false);
  assert.match(result.findings.join('\n'), /absolute latency budget/);
  assert.match(result.findings.join('\n'), /relative Document latency budget/);
});
