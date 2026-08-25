import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { STYLE_FACTS_DISCRIMINANTS } from '../engine/src/application/style-facts-contract.js';
import { FIGMA_TYPINGS_AUDITED_VERSION } from '../engine/src/lib/api-operation-coverage.js';
import {
  auditFigmaStyleUnionDrift,
  officialUnionDiscriminants,
} from '../scripts/lib/figma-typing-union-audit.js';

const typingsPath = fileURLToPath(
  new URL('../node_modules/@figma/plugin-typings/plugin-api.d.ts', import.meta.url),
);
const packagePath = new URL('../node_modules/@figma/plugin-typings/package.json', import.meta.url);

test('Style Facts discriminants exactly match the pinned official Figma unions', () => {
  const installed = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  assert.equal(installed, FIGMA_TYPINGS_AUDITED_VERSION,
    'Review Style Facts union drift before updating the audited typings version');
  const audit = auditFigmaStyleUnionDrift({
    typingsPath,
    contract: STYLE_FACTS_DISCRIMINANTS,
  });
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.ok, true);
  assert.deepEqual(Object.keys(audit.official).sort(), Object.keys(STYLE_FACTS_DISCRIMINANTS).sort());
});

test('Style union drift reports new official and stale Bridge discriminants separately', () => {
  const official = officialUnionDiscriminants({
    typingsPath,
    contract: STYLE_FACTS_DISCRIMINANTS,
  });
  const drifted = {
    ...STYLE_FACTS_DISCRIMINANTS,
    Paint: {
      ...STYLE_FACTS_DISCRIMINANTS.Paint,
      values: [...official.Paint.filter((value) => value !== 'PATTERN'), 'RETIRED_BRIDGE_VALUE'],
    },
  };
  const audit = auditFigmaStyleUnionDrift({ typingsPath, contract: drifted });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.errors, [{
    unionName: 'Paint',
    missing: ['PATTERN'],
    stale: ['RETIRED_BRIDGE_VALUE'],
  }]);
});
