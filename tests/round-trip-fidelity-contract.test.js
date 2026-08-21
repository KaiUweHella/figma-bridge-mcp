import { readFileSync } from 'node:fs';
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

test('the summary exposes exact pairs and explicit seams without prose parsing', () => {
  const summary = roundTripFidelitySummary();
  assert.equal(summary.version, 1);
  assert.ok(summary.total >= 10);
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
