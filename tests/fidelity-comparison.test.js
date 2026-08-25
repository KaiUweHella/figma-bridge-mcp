import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIDELITY_COMPARISON_SCHEMA,
  auditFidelityComparisons,
} from '../engine/src/lib/fidelity-comparison.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(join(ROOT, 'evals/fidelity/v1/corpus.json'), 'utf8'));
const comparisons = JSON.parse(
  readFileSync(join(ROOT, 'evals/fidelity/v1/comparison-baselines.json'), 'utf8'),
);

function implementation(role) {
  return comparisons.implementations.find((item) => item.role === role);
}

test('the comparison baseline covers every corpus direction for all four implementation roles', () => {
  assert.equal(comparisons.schema, FIDELITY_COMPARISON_SCHEMA);
  const audit = auditFidelityComparisons(comparisons, corpus);
  assert.deepEqual(audit.errors, []);
  assert.deepEqual(audit.summary, {
    implementations: 4,
    expectedCellsPerImplementation: 23,
    assessedCells: 92,
    requirements: 3,
  });
});

test('comparison identities pin the exact audited source or official documentation snapshot', () => {
  const cli = implementation('historical-cli');
  assert.equal(cli.identity.version, '2.1.0');
  assert.equal(cli.identity.revision, 'e69cba0dae4478e844516e84ba13e838f6616b6b');
  assert.equal(
    cli.identity.sources[0].digest,
    'sha256:6f1267bb73533f1ff9fd5ad50f0c95079e261324971e762a9efcc0749d5a94ba',
  );

  const consoleMcp = implementation('community-mcp');
  assert.equal(consoleMcp.identity.version, '1.40.0');
  assert.equal(consoleMcp.identity.revision, 'e4d5605e6108cd0b21a950f6f57fc189749bd2eb');
  assert.equal(
    consoleMcp.identity.sources[0].digest,
    'sha256:743f32d58a2a7b5afc5eb651c64ab16aab4211eb26355a1831381a1e6495e1b5',
  );

  const official = implementation('official-mcp');
  assert.equal(official.identity.version, 'managed-service-docs-2026-08-25');
  assert.equal(official.access.status, 'unavailable-client');
  assert.deepEqual(official.identity.sources.map((source) => source.digest), [
    'sha256:7af26c75548f2ebd68ca2c22fd5b46ac2e57563122c997e6477facd37f3edf7a',
    'sha256:23e48ed7f76f14013c3137155c71cabf8a2b3a58c1e76e70257ebab6a18e5d32',
  ]);
});

test('Bridge comparison cells remain executable local regressions bound to Evidence IDs', () => {
  const bridge = implementation('primary');
  assert.equal(bridge.access.level, 'executable');
  for (const assessment of bridge.assessments) {
    assert.equal(assessment.capability, 'supported');
    for (const evidence of assessment.evidence) {
      assert.ok(existsSync(join(ROOT, evidence.ref)), evidence.ref);
      assert.match(evidence.locator, /^verification\.[a-z][a-z0-9-]*$/);
    }
  }
});

test('the audit keeps unavailable access separate from product unsupported behavior', () => {
  const accessAsUnsupported = structuredClone(comparisons);
  const official = accessAsUnsupported.implementations.find((item) => item.role === 'official-mcp');
  const dev = official.assessments.find((item) => item.factId === 'dev-mode-static-design-write');
  dev.capability = 'unsupported';
  assert.match(
    auditFidelityComparisons(accessAsUnsupported, corpus).errors.join('\n'),
    /unsupported means a product limitation, not missing access or evidence/,
  );

  const productAsAccess = structuredClone(comparisons);
  const cli = productAsAccess.implementations.find((item) => item.role === 'historical-cli');
  const slides = cli.assessments.find((item) => item.factId === 'slides-native-structure');
  slides.limitationClass = 'access';
  assert.match(
    auditFidelityComparisons(productAsAccess, corpus).errors.join('\n'),
    /unsupported means a product limitation, not missing access or evidence/,
  );
});

test('the audit rejects a selected comparison configuration that enables an unsafe transport', () => {
  const invalid = structuredClone(comparisons);
  invalid.implementations.find((item) => item.role === 'historical-cli')
    .configuration.transport = 'browser CDP transport';
  assert.match(
    auditFidelityComparisons(invalid, corpus).errors.join('\n'),
    /selected comparison configuration enables a forbidden mechanism/,
  );
});

test('useful observed behavior is translated into a tracked Bridge requirement', () => {
  const provenance = comparisons.requirements.find((item) => item.id === 'bounded-response-provenance');
  assert.deepEqual(
    { status: provenance.status, tracker: provenance.tracker, ticket: provenance.ticket },
    { status: 'recorded', tracker: 'private-local', ticket: 'MAINT-19' },
  );
});

