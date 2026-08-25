import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIDELITY_CORPUS_SCHEMA,
  FIDELITY_DIMENSIONS,
  FIDELITY_RUN_SCHEMA,
  auditFidelityCorpus,
  formatFidelityScore,
  scoreFidelityRun,
} from '../engine/src/lib/fidelity-corpus.js';
import { FigmaClient } from '../engine/src/lib/jsx-render.js';
import { inspectStructuredRenderPlan } from '../engine/src/lib/structured-render-executor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(join(ROOT, 'evals/fidelity/v1/corpus.json'), 'utf8'));
const DIGEST = `sha256:${'a'.repeat(64)}`;

function expectedCells(value = corpus) {
  const facts = new Map(value.facts.map((fact) => [fact.id, fact]));
  const result = [];
  for (const workflow of value.workflows) {
    for (const factId of workflow.factIds) {
      const fact = facts.get(factId);
      for (const direction of workflow.directions) {
        for (const [dimension, target] of Object.entries(fact.targets[direction])) {
          result.push({ workflow, fact, factId, direction, dimension, target });
        }
      }
    }
  }
  return result;
}

function passingRun(value = corpus) {
  return {
    schema: FIDELITY_RUN_SCHEMA,
    corpusId: value.id,
    corpusVersion: value.version,
    implementation: {
      name: 'figma-bridge-mcp',
      version: '0.5.2',
      configuration: { safeMode: true, editor: 'fixture-defined' },
    },
    observations: expectedCells(value).map(({ workflow, factId, direction, dimension, target }) => ({
      workflowId: workflow.id,
      factId,
      direction,
      dimension,
      outcome: target.outcome,
      evidence: target.evidence.map((id) => ({
        id,
        status: 'pass',
        artifact: `evidence/${workflow.id}/${factId}-${direction}-${dimension}-${id.slice('verification.'.length)}.json`,
        digest: DIGEST,
        ...(id === 'verification.pixel-comparison' ? { metrics: { diffPct: 0.25 } } : {}),
      })),
    })),
  };
}

test('the v1 corpus is complete, redistributable and covers every North Star fidelity family', () => {
  assert.equal(corpus.schema, FIDELITY_CORPUS_SCHEMA);
  const audit = auditFidelityCorpus(corpus);
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.summary, {
    fixtures: 2,
    workflows: 4,
    facts: 13,
    families: 10,
    editorTypes: 4,
  });
  for (const fixture of corpus.fixtures) {
    assert.equal(fixture.license, 'MIT');
    assert.equal(fixture.provenance, 'authored-for-figma-bridge');
    for (const path of fixture.paths) assert.ok(existsSync(join(ROOT, path)), path);
  }
  const bytes = corpus.fixtures.flatMap((fixture) => fixture.paths)
    .map((path) => readFileSync(join(ROOT, path), 'utf8')).join('\n');
  assert.doesNotMatch(bytes, /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board|slides)\//i);
  assert.doesNotMatch(bytes, /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/);
});

test('the Design fixture adapts into one supported typed Semantic Render Plan', () => {
  const client = new FigmaClient();
  client.setIcons({
    'bridge-glyph': readFileSync(join(ROOT, 'evals/fidelity/v1/assets/bridge-glyph.svg'), 'utf8'),
  });
  client.setComponentLinks({
    'corpus.control': { entityId: 'corpus.control', key: 'PLACEHOLDERCORPUSSETKEY' },
  });
  const plan = client.planJSX(readFileSync(join(ROOT, 'evals/fidelity/v1/design-roundtrip.jsx'), 'utf8'));
  assert.equal(plan.kind, 'figma-bridge/semantic-render-plan');
  assert.equal(plan.version, 1);
  assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
});

test('release-v1 requires complete evidence and scores every dimension independently', () => {
  const report = scoreFidelityRun(corpus, passingRun());
  assert.equal(report.ok, true);
  assert.equal(report.release, true);
  for (const dimension of FIDELITY_DIMENSIONS) {
    assert.equal(report.dimensions[dimension].score, 1, dimension);
    assert.ok(report.dimensions[dimension].total > 0, dimension);
  }
  assert.equal(report.silentLoss, 0);
  assert.equal(report.missingObservations, 0);
  assert.equal(report.evidence.passRate, 1);
  assert.ok(report.platformLimited.some((item) => item.factId === 'dev-mode-static-design-write'));
  assert.match(formatFidelityScore(report), /^RELEASE PASS/);
  assert.match(formatFidelityScore(report), /Platform-limited facts:/);
});

test('a silently lost fact is a release failure even when every other observation passes', () => {
  const run = passingRun();
  const observation = run.observations.find((item) => item.factId === 'native-mask' && item.dimension === 'semantic');
  observation.outcome = 'silently-lost';
  const report = scoreFidelityRun(corpus, run);
  assert.equal(report.release, false);
  assert.equal(report.silentLoss, 1);
  assert.ok(report.findings.some((finding) => finding.code === 'silent-loss'));
  assert.ok(report.thresholdFailures.some((failure) => /silent loss count/.test(failure)));
});

test('known normalization and explicit platform limits pass, but unexpected unsupported output fails', () => {
  const run = passingRun();
  const normalized = run.observations.find((item) => item.factId === 'responsive-constraints' && item.dimension === 'semantic');
  assert.equal(normalized.outcome, 'normalized');
  const devBoundary = run.observations.find((item) => item.factId === 'dev-mode-static-design-write');
  assert.equal(devBoundary.outcome, 'unsupported');
  assert.equal(scoreFidelityRun(corpus, run).release, true);

  const exactTarget = run.observations.find((item) => item.factId === 'variable-alias-topology' && item.dimension === 'semantic');
  exactTarget.outcome = 'unsupported';
  const report = scoreFidelityRun(corpus, run);
  assert.equal(report.release, false);
  assert.ok(report.findings.some((finding) => finding.key.includes('variable-alias-topology')));
});

test('missing evidence, an excessive visual diff, and a missing observation each fail closed', () => {
  const missingEvidence = passingRun();
  missingEvidence.observations[0].evidence = [];
  assert.equal(scoreFidelityRun(corpus, missingEvidence).release, false);
  assert.ok(scoreFidelityRun(corpus, missingEvidence).findings[0].message.includes('no evidence'));

  const visualDrift = passingRun();
  const pixel = visualDrift.observations.flatMap((item) => item.evidence)
    .find((evidence) => evidence.id === 'verification.pixel-comparison');
  pixel.metrics.diffPct = 1.01;
  const driftReport = scoreFidelityRun(corpus, visualDrift);
  assert.equal(driftReport.release, false);
  assert.ok(driftReport.findings.some((finding) => /exceeds 1%/.test(finding.message)));

  const missingObservation = passingRun();
  missingObservation.observations.pop();
  const missingReport = scoreFidelityRun(corpus, missingObservation);
  assert.equal(missingReport.release, false);
  assert.equal(missingReport.missingObservations, 1);
});

test('corpus audit rejects unknown evidence and unsupported facts without a named platform boundary', () => {
  const invalid = structuredClone(corpus);
  const fact = invalid.facts.find((item) => item.id === 'native-mask');
  fact.targets['code-to-figma'].structural.evidence = ['verification.not-real'];
  fact.targets['code-to-figma'].semantic.outcome = 'unsupported';
  const audit = auditFidelityCorpus(invalid);
  assert.equal(audit.ok, false);
  assert.match(audit.errors.join('\n'), /unknown Evidence ID verification\.not-real/);
  assert.match(audit.errors.join('\n'), /unsupported targets must name a platform limit/);
});
