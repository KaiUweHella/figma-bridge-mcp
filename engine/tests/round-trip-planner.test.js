import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedRoundTripBaseline,
  fingerprintCodeSource,
  fingerprintFigmaSnapshot,
  formatProjectDesignContext,
  formatRoundTripPlan,
  planRoundTrip,
  projectDesignContext,
} from '../src/lib/round-trip-planner.js';

const code = (content) => fingerprintCodeSource({ path: 'src/Button.tsx', exportName: 'Button', content });
const figma = (hash = 'aaaaaaaaaaaa') => fingerprintFigmaSnapshot({
  rootId: '1:2', nodeCount: 1, nodes: [{ id: '1:2', subtreeHash: hash }],
});

test('Round-trip Planner classifies every three-way state without guessing direction', () => {
  const baseCode = code('export const Button = 1;');
  const baseFigma = figma();
  const baseline = acceptedRoundTripBaseline(baseCode, baseFigma, '2026-08-11T10:00:00.000Z');
  assert.equal(planRoundTrip({ code: baseCode, figma: baseFigma, baseline }).status, 'unchanged');
  assert.equal(planRoundTrip({ code: code('export const Button = 2;'), figma: baseFigma, baseline }).status, 'code-only');
  assert.equal(planRoundTrip({ code: baseCode, figma: figma('bbbbbbbbbbbb'), baseline }).status, 'figma-only');
  assert.equal(planRoundTrip({ code: code('changed'), figma: figma('bbbbbbbbbbbb'), baseline }).status, 'conflict');
  assert.equal(planRoundTrip({ code: baseCode, figma: baseFigma, baseline: null }).status, 'untracked');
});

test('fingerprints are deterministic and never put source bytes into the baseline', () => {
  assert.deepEqual(code('same'), code('same'));
  assert.notEqual(code('same').hash, code('different').hash);
  const baseline = acceptedRoundTripBaseline(code('secret source'), figma());
  assert.equal(JSON.stringify(baseline).includes('secret source'), false);
});

test('formatted plan gives the agent exact next reads', () => {
  const entity = {
    id: 'ui.button', kind: 'component',
    code: { path: 'src/Button.tsx', export: 'Button' }, figma: { nodeId: '1:2' },
  };
  const plan = planRoundTrip({ code: code('new'), figma: figma(), baseline: acceptedRoundTripBaseline(code('old'), figma()) });
  assert.match(formatRoundTripPlan(entity, plan), /round-trip: code-only/);
  assert.match(formatRoundTripPlan(entity, plan), /figma_screenshot 1:2/);
  const context = projectDesignContext({
    entity, plan, projectFiles: { designDoc: 'DESIGN.md', tokens: 'design/tokens.json' },
  });
  const text = formatProjectDesignContext(context);
  assert.match(text, /Project Design Context — ui\.button/);
  assert.match(text, /designDoc: DESIGN\.md/);
  assert.match(text, /Exact next reads/);
});

test('semantic subtree hashes turn a Figma change into exact follow-up reads', () => {
  const baseFigma = fingerprintFigmaSnapshot({
    rootId: '1:1', nodeCount: 3, nodes: [
      { id: '1:1', subtreeHash: 'aaaaaaaaaaaa' },
      { id: '1:2', semanticPath: 'screen.header', subtreeHash: 'bbbbbbbbbbbb' },
      { id: '1:3', semanticPath: 'screen.body', subtreeHash: 'cccccccccccc' },
    ],
  });
  const currentFigma = fingerprintFigmaSnapshot({
    rootId: '1:1', nodeCount: 4, nodes: [
      { id: '1:1', subtreeHash: 'dddddddddddd' },
      { id: '1:2', semanticPath: 'screen.header', subtreeHash: 'eeeeeeeeeeee' },
      { id: '1:3', semanticPath: 'screen.body', subtreeHash: 'cccccccccccc' },
      { id: '1:4', semanticPath: 'screen.footer', subtreeHash: 'ffffffffffff' },
    ],
  });
  const baseline = acceptedRoundTripBaseline(code('same'), baseFigma);
  const plan = planRoundTrip({ code: code('same'), figma: currentFigma, baseline });
  assert.equal(plan.status, 'figma-only');
  assert.deepEqual(plan.figmaDelta.paths.map(({ path, change }) => ({ path, change })), [
    { path: 'screen.footer', change: 'added' },
    { path: 'screen.header', change: 'changed' },
  ]);
  const entity = {
    id: 'screen.home', kind: 'screen', code: { path: 'src/Home.tsx' }, figma: { nodeId: '1:1' },
  };
  const output = formatRoundTripPlan(entity, plan, { baseline });
  assert.match(output, /changed: screen\.header \[1:2\]/);
  assert.match(output, /figma_spec 1:4 \(screen\.footer; structure, then style\)/);
  assert.doesNotMatch(output, /figma_spec 1:3/);
});

test('duplicate semantic paths are reported as ambiguous instead of guessed', () => {
  const captured = fingerprintFigmaSnapshot({
    rootId: '1:1', nodeCount: 3, nodes: [
      { id: '1:1', subtreeHash: 'aaaaaaaaaaaa' },
      { id: '1:2', semanticPath: 'screen.card', subtreeHash: 'bbbbbbbbbbbb' },
      { id: '1:3', semanticPath: 'screen.card', subtreeHash: 'cccccccccccc' },
    ],
  });
  assert.equal(captured.semanticPaths, undefined);
  assert.deepEqual(captured.semanticPathConflicts, [{ path: 'screen.card', nodeIds: ['1:2', '1:3'] }]);
  const baselineFigma = fingerprintFigmaSnapshot({
    rootId: '1:1', nodeCount: 2, nodes: [
      { id: '1:1', subtreeHash: 'dddddddddddd' },
      { id: '1:2', semanticPath: 'screen.card', subtreeHash: 'bbbbbbbbbbbb' },
    ],
  });
  const baseline = acceptedRoundTripBaseline(code('same'), baselineFigma);
  const plan = planRoundTrip({ code: code('same'), figma: captured, baseline });
  assert.deepEqual(plan.figmaDelta.paths, [], 'ambiguous current identity must not be mislabeled as removed');
  assert.equal(plan.figmaDelta.conflicts[0].path, 'screen.card');
});
