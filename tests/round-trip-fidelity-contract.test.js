import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

import { planFigmaCommand } from '../src/capability-catalog.js';
import { FigmaClient } from '../engine/src/lib/jsx-render.js';
import { inspectStructuredRenderPlan } from '../engine/src/lib/structured-render-executor.js';
import {
  auditRoundTripFidelityContract,
  formatRoundTripFidelityContract,
  roundTripFidelityContract,
  roundTripFidelityEvidenceRegistry,
  roundTripFidelitySummary,
} from '../engine/src/lib/round-trip-fidelity-contract.js';

const typingsPath = new URL('../node_modules/@figma/plugin-typings/plugin-api.d.ts', import.meta.url);
const sourceText = readFileSync(typingsPath, 'utf8');
const sourceFile = ts.createSourceFile('plugin-api.d.ts', sourceText, ts.ScriptTarget.Latest, true);
const declaredTypes = new Set(sourceFile.statements
  .filter((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node))
  .map((node) => node.name.text));

test('the Round-trip Fidelity Contract classifies every core fact in both directions', () => {
  const contract = roundTripFidelityContract();
  const audit = auditRoundTripFidelityContract(contract);
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.ok, true);
  assert.equal(audit.summary.total, contract.facts.length);
  assert.equal(audit.summary.classifiedBothWays, contract.facts.length);
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.facts[0].figmaToCode), true);
});

test('every named Figma fact type still exists in the installed official typings', () => {
  for (const fact of roundTripFidelityContract().facts) {
    for (const name of fact.figmaTypes) {
      assert.ok(declaredTypes.has(name), `${fact.id}: official Figma type ${name} is missing`);
    }
  }
});

test('the Domain definition and executable mapping vocabulary stay synchronized', () => {
  const context = readFileSync(new URL('../CONTEXT.md', import.meta.url), 'utf8');
  const definition = context.split('**Round-trip Fidelity Contract**:')[1].split('\n\n')[0].toLowerCase();
  const domainNames = {
    EXACT: 'exact',
    CONDITIONAL: 'conditional',
    STRUCTURAL: 'structural',
    VISUAL: 'visual',
    FIGMA_ONLY: 'figma-only',
    CODE_ONLY: 'code-only',
    STOP: 'stopped',
  };
  for (const mappingClass of roundTripFidelityContract().mappingClasses) {
    assert.match(definition, new RegExp(`\\b${domainNames[mappingClass]}\\b`), mappingClass);
  }
});

test('the contract audit fails closed on an unclassified direction or an unexplained seam', () => {
  const base = roundTripFidelityContract().facts[0];
  const unclassified = {
    version: 1,
    facts: [{ ...base, id: 'missing-reverse', figmaToCode: null }],
  };
  assert.equal(auditRoundTripFidelityContract(unclassified).ok, false);
  assert.match(auditRoundTripFidelityContract(unclassified).errors.join('\n'), /direction is unclassified/);

  const unexplained = {
    version: 1,
    facts: [{
      ...base,
      id: 'unexplained-seam',
      figmaToCode: { classification: 'STOP', implementation: [], verification: [], note: '' },
    }],
  };
  assert.match(auditRoundTripFidelityContract(unexplained).errors.join('\n'), /explicit seam needs a reason/);
});

test('the contract audit fails closed on an unknown verification Evidence ID', () => {
  const base = roundTripFidelityContract().facts[0];
  const unknownEvidence = {
    version: 1,
    facts: [{
      ...base,
      id: 'unknown-evidence',
      figmaToCode: {
        ...base.figmaToCode,
        verification: ['verification.this-does-not-exist'],
      },
    }],
  };

  const audit = auditRoundTripFidelityContract(unknownEvidence);
  assert.equal(audit.ok, false);
  assert.match(audit.errors.join('\n'), /unknown verification Evidence ID verification\.this-does-not-exist/);

  const proseEvidence = {
    version: 1,
    facts: [{
      ...base,
      id: 'free-verification-prose',
      figmaToCode: {
        ...base.figmaToCode,
        classification: 'CONDITIONAL',
        verification: ['looks correct in the browser'],
      },
    }],
  };
  assert.match(
    auditRoundTripFidelityContract(proseEvidence).errors.join('\n'),
    /verification must use stable Evidence IDs/,
  );
});

test('an EXACT direction requires registered verification Evidence IDs', () => {
  const base = roundTripFidelityContract().facts[0];
  const proseOnlyEvidence = {
    version: 1,
    facts: [{
      ...base,
      id: 'prose-only-exactness',
      figmaToCode: {
        ...base.figmaToCode,
        classification: 'EXACT',
        verification: ['layer coverage', 'pixel comparison'],
      },
    }],
  };

  const audit = auditRoundTripFidelityContract(proseOnlyEvidence);
  assert.equal(audit.ok, false);
  assert.match(audit.errors.join('\n'), /EXACT mapping needs registered verification Evidence IDs/);
});

test('every verification resolves through the Evidence Registry to a real check, gate, probe, or test', () => {
  const registry = roundTripFidelityEvidenceRegistry();
  for (const fact of roundTripFidelityContract().facts) {
    for (const side of ['codeToFigma', 'figmaToCode']) {
      for (const evidenceId of fact[side].verification) {
        assert.match(evidenceId, /^verification\.[a-z][a-z0-9-]*$/, `${fact.id}.${side}: ${evidenceId}`);
        assert.ok(registry[evidenceId], `${fact.id}.${side}: unregistered ${evidenceId}`);
      }
    }
  }
  for (const [evidenceId, evidence] of Object.entries(registry)) {
    assert.ok(['check', 'gate', 'probe', 'test'].includes(evidence.kind), `${evidenceId}: invalid kind`);
    assert.ok(evidence.label, `${evidenceId}: label is required`);
    assert.ok(existsSync(new URL(`../${evidence.source}`, import.meta.url)), `${evidenceId}: missing ${evidence.source}`);
  }
});

test('the classified write surfaces are reachable and structurally preflighted', () => {
  const plan = new FigmaClient().planJSX(
    '<Frame name="Fidelity" w="120" h="80" blendMode="multiply" mask="luminance" '
      + 'cornerSmoothing="0.6" noise="duo" noiseDensity="0.25" texture="true" '
      + 'progressiveBlur="20" glass="true" />',
  );
  assert.deepEqual(inspectStructuredRenderPlan(plan), { supported: true, problems: [] });
  assert.equal(planFigmaCommand(['prototype', 'inspect', '1:2']).effects.figma, 'read');
  assert.equal(planFigmaCommand(['prototype', 'set', '1:2', '--json', '[]']).effects.figma, 'write');
});

test('open DBI fidelity seams are explicit fact families rather than optimistic parent claims', () => {
  const contract = roundTripFidelityContract();
  const byId = new Map(contract.facts.map((fact) => [fact.id, fact]));

  assert.equal(contract.version, 2);
  assert.equal(byId.get('variables-styles').figmaToCode.classification, 'CONDITIONAL');
  assert.equal(byId.get('asset-identity').figmaToCode.classification, 'CONDITIONAL');
  assert.deepEqual(byId.get('asset-identity').figmaToCode.verification, [
    'verification.asset-manifest-v2',
    'verification.asset-digest-integrity',
  ]);
  assert.equal(byId.get('variable-modes').figmaToCode.classification, 'CONDITIONAL');
  assert.deepEqual(byId.get('variable-modes').figmaToCode.verification, [
    'verification.multi-mode-token-projection',
  ]);
  assert.equal(byId.get('hidden-content-and-alternate-states').figmaToCode.classification, 'CONDITIONAL');
  assert.deepEqual(byId.get('hidden-content-and-alternate-states').figmaToCode.verification, [
    'verification.hidden-content-census',
  ]);
  assert.equal(byId.get('component-state-coverage').figmaToCode.classification, 'CONDITIONAL');
  assert.deepEqual(byId.get('component-state-coverage').figmaToCode.verification, [
    'verification.component-state-lattice',
  ]);
});

test('the summary exposes exact pairs and explicit seams without prose parsing', () => {
  const summary = roundTripFidelitySummary();
  assert.equal(summary.version, 2);
  assert.ok(summary.total >= 14);
  assert.ok(summary.exactBothWays >= 1);
  assert.ok(summary.explicitSeams >= 1);
});

test('the agent-facing projection exposes both directions and their verification seams', () => {
  const report = formatRoundTripFidelityContract();
  assert.match(report, /prototype-reactions \[interaction\]/);
  assert.match(report, /code -> Figma: CONDITIONAL/);
  assert.match(report, /Figma -> code: CONDITIONAL/);
  assert.match(report, /verify: prototype inspect/);
});
