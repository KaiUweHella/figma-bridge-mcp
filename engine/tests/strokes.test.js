// Stroke fidelity (stroke-fidelity regression): per-side widths survive
// figma.mixed, strokeAlign reaches the spec, and gradient-border screens get
// the border-image warning. Modeled on card-image 12:34 / content-container
// 12:35 — gradient strokes whose width vanished entirely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWalkerCode } from '../src/design-extract.js';
import { paintSeg, strokeFacts, formatCodeSpec, styleFields } from '../src/lib/code-spec.js';

const MIXED = Symbol('mixed');
const stubFigma = (root) => ({
  mixed: MIXED,
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (root) =>
  new Function('figma', `return ${nodeWalkerCode(root.id)}`)(stubFigma(root));

const solidStroke = { type: 'SOLID', color: { r: 0x21 / 255, g: 0x30 / 255, b: 0x59 / 255 } };

test('walker: uniform stroke weight and default INSIDE align stay compact', async () => {
  const root = {
    id: 's:1', name: 'Card', type: 'FRAME', visible: true, width: 100, height: 100,
    strokes: [solidStroke], strokeWeight: 1, strokeAlign: 'INSIDE', children: [],
  };
  const out = JSON.parse(await runWalker(root)).frames[0];
  assert.equal(out.sw, 1);
  assert.equal(out.sa, undefined, 'INSIDE is the default — not emitted');
});

test('walker: per-side weights survive figma.mixed as [t,r,b,l]', async () => {
  const root = {
    id: 's:2', name: 'Card', type: 'FRAME', visible: true, width: 100, height: 100,
    strokes: [solidStroke], strokeWeight: MIXED,
    strokeTopWeight: 2, strokeRightWeight: 0, strokeBottomWeight: 0, strokeLeftWeight: 2,
    children: [],
  };
  const out = JSON.parse(await runWalker(root)).frames[0];
  assert.deepEqual(out.sw, [2, 0, 0, 2], 'mixed weight no longer swallows the widths');
});

test('walker: OUTSIDE/CENTER alignment is captured', async () => {
  const root = {
    id: 's:3', name: 'Ring', type: 'FRAME', visible: true, width: 40, height: 40,
    strokes: [solidStroke], strokeWeight: 1, strokeAlign: 'OUTSIDE', children: [],
  };
  const out = JSON.parse(await runWalker(root)).frames[0];
  assert.equal(out.sa, 'outside');
});

test('paintSeg renders per-side widths and alignment', () => {
  assert.equal(paintSeg({ strokes: ['#213059'], sw: 1 }), 'stroke #213059 w1');
  assert.equal(paintSeg({ strokes: ['#213059'], sw: [2, 0, 0, 2] }), 'stroke #213059 w2/0/0/2');
  assert.equal(paintSeg({ strokes: ['#213059'], sw: 1, sa: 'outside' }), 'stroke #213059 w1 outside');
  assert.match(paintSeg({ strokes: ['#213059'], sw: 1, dash: [6, 6] }), /w1 dash\[6,6\]/);
});

test('stroke align + per-side widths are style-bundle relevant', () => {
  assert.equal(styleFields({ strokes: ['#000'], sw: 1, sa: 'outside' }).sa, 'outside');
});

test('footer hints appear only when the screen uses the feature', () => {
  const gradientFrame = {
    t: 'FRAME', n: 'card', id: 'g:1', w: 100, h: 100,
    strokes: ['linear-gradient(74deg, #aa6422 0%, #0e1425 100%)'], r: 16,
    kids: [{ t: 'TEXT', n: 'T', id: 'g:2', txt: { chars: 'x' } }],
  };
  const facts = strokeFacts([gradientFrame]);
  assert.equal(facts.gradient, true);
  const withGradient = formatCodeSpec({ id: 'r', name: 'X', frames: [gradientFrame] }, { phase: 'style' });
  assert.match(withGradient, /border-image.*IGNORES.*border-radius/);
  const plain = formatCodeSpec({ id: 'r', name: 'X', frames: [{ t: 'FRAME', n: 'p', id: 'p:1', strokes: ['#000'], sw: 1 }] }, { phase: 'style' });
  assert.doesNotMatch(plain, /border-image/);
  assert.doesNotMatch(plain, /per-side widths/);
  const perSide = formatCodeSpec({ id: 'r', name: 'X', frames: [{ t: 'FRAME', n: 'p', id: 'p:1', strokes: ['#000'], sw: [1, 0, 0, 0] }] }, { phase: 'style' });
  assert.match(perSide, /per-side widths \(top\/right\/bottom\/left\)/);
});
