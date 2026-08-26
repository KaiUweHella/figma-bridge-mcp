import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  normalizeBrowserFidelityLedger,
  verifyBrowserFidelityLedger,
} from '../src/lib/browser-fidelity-ledger.js';
import { CAPTURE_STYLE_PROPERTIES } from '../src/lib/browser-dom-capture.js';

const node = (classes, style = {}, children = [], extra = {}) => ({
  tag: 'div', classes, rect: { x: 0, y: 0, w: 100, h: 40 },
  style, authoredStyle: {}, sourceIdentity: {}, children, ...extra,
});

const capture = {
  version: 2,
  viewport: { width: 1440, height: 1000 },
  root: node('screen', {}, [
    node('orb orb-two', { mixBlendMode: 'screen', opacity: '0.58' }),
    node('pipeline-note', {
      borderTop: '2px solid rgb(32, 33, 39)',
      borderRight: '1px solid rgb(32, 33, 39)',
      borderBottom: '2px solid rgb(32, 33, 39)',
      borderLeft: '3px solid rgb(32, 33, 39)',
    }),
    node('delivery-title', {
      fontFamily: '"DM Sans", sans-serif', fontWeight: '700', fontStyle: 'normal',
    }, [], { fontEvidence: { family: '"DM Sans", sans-serif', weight: '700', style: 'normal', size: '24px', loaded: true } }),
    node('risk-status', { backgroundColor: 'rgb(238, 233, 255)' }),
  ]),
};

const baseLedger = {
  schemaVersion: 1,
  sourceRootNodeId: '155:7710',
  facts: [
    {
      id: 'hero.orb-two.blend', sourceNodeId: '155:7818',
      target: { path: 'screen/orb.orb-two' }, property: 'style.mixBlendMode', expected: 'screen',
    },
    {
      id: 'pipeline.left-stroke', sourceNodeId: '155:8122',
      target: { path: 'screen/pipeline-note' }, property: 'style.borderLeft',
      expected: '3px solid rgb(32, 33, 39)',
    },
    {
      id: 'delivery.heading.family', sourceNodeId: '155:8200',
      target: { path: 'screen/delivery-title' }, property: 'style.fontFamily', expected: 'Manrope',
    },
    {
      id: 'delivery.heading.loaded', sourceNodeId: '155:8200',
      target: { path: 'screen/delivery-title' }, property: 'font.loaded', expected: true,
    },
    {
      id: 'risk.status.presentation', sourceNodeId: '257:3501',
      target: { path: 'screen/risk-status' }, property: 'style.backgroundColor',
      expected: 'rgba(0, 0, 0, 0)',
      approvedDeviation: { reason: 'Reviewer approved the code-only status treatment.' },
    },
  ],
};

describe('browser fidelity ledger', () => {
  it('classifies every bounded source fact without silent loss', () => {
    const result = verifyBrowserFidelityLedger(baseLedger, capture, { captureHash: 'a'.repeat(64) });

    assert.equal(result.passed, false);
    assert.deepEqual(result.summary, { total: 5, matched: 3, approvedDeviations: 1, missing: 1 });
    assert.equal(result.facts.find((fact) => fact.id === 'delivery.heading.family').status, 'missing');
    assert.equal(result.facts.find((fact) => fact.id === 'risk.status.presentation').status, 'approved-deviation');
    assert.equal(result.capture.hash, 'a'.repeat(64));
  });

  it('accepts equivalent first-family CSS and requires loaded-face evidence', () => {
    const corrected = structuredClone(capture);
    const heading = corrected.root.children[2];
    heading.style.fontFamily = '"Manrope", Arial, sans-serif';
    heading.fontEvidence.family = '"Manrope", Arial, sans-serif';
    const result = verifyBrowserFidelityLedger(baseLedger, corrected);

    assert.equal(result.passed, true);
    assert.deepEqual(result.summary, { total: 5, matched: 4, approvedDeviations: 1, missing: 0 });

    heading.fontEvidence.loaded = null;
    const unavailable = verifyBrowserFidelityLedger(baseLedger, corrected);
    assert.equal(unavailable.facts.find((fact) => fact.property === 'font.loaded').status, 'missing');
  });

  it('fails ambiguous targets and malformed or unapproved ledgers closed', () => {
    const ambiguousCapture = structuredClone(capture);
    ambiguousCapture.root.children.push(node('orb orb-two', { mixBlendMode: 'screen' }));
    const result = verifyBrowserFidelityLedger({
      schemaVersion: 1,
      facts: [baseLedger.facts[0]],
    }, ambiguousCapture);
    assert.equal(result.facts[0].status, 'missing');
    assert.equal(result.facts[0].reason, 'target-ambiguous:2');

    assert.throws(() => normalizeBrowserFidelityLedger({
      schemaVersion: 1,
      facts: [{ ...baseLedger.facts[0], approvedDeviation: { reason: '' } }],
    }), /approvedDeviation requires a bounded reason/);
    assert.throws(() => normalizeBrowserFidelityLedger({
      schemaVersion: 1,
      facts: [{ ...baseLedger.facts[0], property: 'style.futureSecret' }],
    }), /unsupported fact property/);
    assert.throws(() => normalizeBrowserFidelityLedger({
      schemaVersion: 1, sourceRootNodeId: 'not-a-node', facts: [baseLedger.facts[0]],
    }), /sourceRootNodeId is invalid/);
    assert.throws(() => normalizeBrowserFidelityLedger({
      schemaVersion: 1,
      facts: [{ ...baseLedger.facts[0], target: { entity: '../unsafe entity' } }],
    }), /target entity is invalid/);
    assert.throws(() => normalizeBrowserFidelityLedger({
      schemaVersion: 1,
      facts: [{ ...baseLedger.facts[0], id: 123 }],
    }), /id is invalid/);
    assert.throws(() => normalizeBrowserFidelityLedger({
      schemaVersion: 1,
      facts: [{ ...baseLedger.facts[0], expected: 'x'.repeat(4_097) }],
    }), /expected value is invalid/);

    const malformedCapture = structuredClone(capture);
    malformedCapture.root.children = 'not-an-array';
    assert.throws(() => verifyBrowserFidelityLedger({
      schemaVersion: 1, facts: [baseLedger.facts[0]],
    }, malformedCapture), /children must be an array/);

    const oversizedActual = structuredClone(capture);
    oversizedActual.root.children[0].style.mixBlendMode = 'x'.repeat(4_097);
    const bounded = verifyBrowserFidelityLedger({
      schemaVersion: 1, facts: [baseLedger.facts[0]],
    }, oversizedActual);
    assert.equal(Object.hasOwn(bounded.facts[0], 'actual'), false);
    assert.equal(bounded.facts[0].reason, 'actual-value-invalid');
  });

  it('catches every Northern rare-fact regression from the publication review', () => {
    const northernCapture = {
      version: 2,
      root: node('screen', {}, [
        node('orb orb-two', { mixBlendMode: 'normal' }),
        node('rights-card lime', { backgroundColor: 'rgb(255, 255, 255)' }, [
          node('rights-cover', { backgroundImage: 'none' }),
          node('progress-track', { backgroundColor: 'rgba(0, 0, 0, 0)' }),
        ]),
        node('pipeline-note', {
          borderTop: '2px solid rgb(32, 33, 39)', borderRight: '2px solid rgb(32, 33, 39)',
          borderBottom: '2px solid rgb(32, 33, 39)', borderLeft: '2px solid rgb(32, 33, 39)',
        }),
        node('network-glow glow-lime', { opacity: '0.65', filter: 'blur(10px)', boxShadow: 'none' }),
        node('forecast-bars', { flexGrow: '0', height: '215px' }),
      ]),
    };
    const facts = [
      ['hero.blend', '155:7818', 'screen/orb.orb-two', 'style.mixBlendMode', 'screen'],
      ['rights.surface', '155:7972', 'screen/rights-card.lime', 'style.backgroundColor', 'rgb(250, 250, 247)'],
      ['rights.gradient', '155:7973', 'screen/rights-card.lime/rights-cover', 'style.backgroundImage', 'linear-gradient(rgb(117, 203, 244), rgb(134, 104, 232))'],
      ['rights.orbit', '155:7976', 'screen/rights-card.lime/rights-orbit', 'present', true],
      ['rights.track', '155:7972', 'screen/rights-card.lime/progress-track', 'style.backgroundColor', 'rgb(231, 231, 225)'],
      ['pipeline.stroke-left', '155:8122', 'screen/pipeline-note', 'style.borderLeft', '3px solid rgb(32, 33, 39)'],
      ['network.opacity', '155:8252', 'screen/network-glow.glow-lime', 'style.opacity', '0.58'],
      ['network.blur', '155:8252', 'screen/network-glow.glow-lime', 'style.filter', 'blur(3px)'],
      ['network.shadow', '155:8252', 'screen/network-glow.glow-lime', 'style.boxShadow', 'rgb(201, 255, 88) 0px 0px 22px 0px'],
      ['forecast.fill', '257:3480', 'screen/forecast-bars', 'style.flexGrow', '1'],
    ].map(([id, sourceNodeId, path, property, expected]) => ({
      id, sourceNodeId, target: { path }, property, expected,
    }));
    const result = verifyBrowserFidelityLedger({ schemaVersion: 1, facts }, northernCapture);

    assert.equal(result.passed, false);
    assert.equal(result.summary.missing, facts.length);
    assert.deepEqual(result.facts.map((fact) => fact.id), facts.map((fact) => fact.id));
  });
});

it('verify-build gates a release on the bounded source-fact result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-fidelity-ledger-'));
  mkdirSync(join(root, 'src', 'assets'), { recursive: true });
  writeFileSync(join(root, 'src', 'assets', 'assets.json'), JSON.stringify({
    schemaVersion: 2, roots: [], assets: [],
  }));
  writeFileSync(join(root, 'src', 'app.js'), 'export const app = true;');
  const ledgerPath = join(root, 'facts.json');
  const capturePath = join(root, 'capture.json');
  writeFileSync(ledgerPath, JSON.stringify(baseLedger));
  const realisticLargeCapture = structuredClone(capture);
  const completeStyle = Object.fromEntries(CAPTURE_STYLE_PROPERTIES.map((property) => [property, 'initial']));
  for (let index = 0; index < 1_000; index++) {
    realisticLargeCapture.root.children.push(node(`capture-node-${index}`, completeStyle));
  }
  writeFileSync(capturePath, JSON.stringify(realisticLargeCapture));
  const entry = new URL('../src/index.js', import.meta.url);
  const result = await promisify(execFile)(process.execPath, [
    entry.pathname, 'verify-build', root,
    '--fidelity-ledger', ledgerPath, '--browser-capture', capturePath, '--json',
  ], { env: { ...process.env, FIGMA_BRIDGE_WORKSPACE_ROOTS: root } })
    .then((value) => ({ code: 0, ...value }), (error) => ({
      code: error.code, stdout: error.stdout, stderr: error.stderr,
    }));

  assert.equal(result.code, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.fidelity.summary.missing, 1);
  assert.equal(output.fidelity.facts.find((fact) => fact.id === 'delivery.heading.family').status, 'missing');
});
