// Gradient-angle conversion (Run-7 report, Rectangle 28): ONE shared
// implementation in lib/paint-css.js for reading (gradientTransform → CSS
// angle, Y-flip + aspect-ratio correct) and writing (CSS angle →
// gradientTransform). The old per-command copies were mirrored (spec read
// 180° as 0°, 135° as 45°) or dropped the angle entirely (inspect).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makePaintSerializer,
  paintsSnippetJs,
  cssAngleFromGradientTransform,
  serializePaints,
  gradientTransformFromCssAngle,
} from '../src/lib/paint-css.js';
import { nodeWalkerCode } from '../src/design-extract.js';

// ── reading: known Figma matrices (square node) ──
// Ground truth from the Plugin API: identity = left→right (CSS 90deg);
// [[0,1,0],[-1,0,1]] maps gradient-x onto normalized y = top→bottom (180deg).
const KNOWN = [
  { t: [[1, 0, 0], [0, 1, 0]], deg: 90, what: 'identity = left→right' },
  { t: [[0, 1, 0], [-1, 0, 1]], deg: 180, what: 'top→bottom' },
  { t: [[0, -1, 1], [1, 0, 0]], deg: 0, what: 'bottom→top' },
  { t: [[-1, 0, 1], [0, -1, 1]], deg: 270, what: 'right→left' },
  { t: [[0.7071, -0.7071, 0.5], [0.7071, 0.7071, 0]], deg: 45, what: 'toward top-right' },
  { t: [[0.7071, 0.7071, 0], [-0.7071, 0.7071, 0.5]], deg: 135, what: 'toward bottom-right' },
];

test('cssAngle: known Figma matrices on a square node', () => {
  for (const { t, deg, what } of KNOWN) {
    assert.equal(cssAngleFromGradientTransform(t, 100, 100), deg, what);
  }
});

test('cssAngle: the Rectangle-28 regression — 135° must not read as 45°', () => {
  // Glow top-left fading to bottom-right = CSS 135deg. The old reader
  // (atan2(t[1][0], t[0][0]) + 90) returned the vertical mirror: 45.
  const t = [[0.7071, 0.7071, 0], [-0.7071, 0.7071, 0.5]];
  assert.equal(cssAngleFromGradientTransform(t, 600, 600), 135);
  assert.notEqual(cssAngleFromGradientTransform(t, 600, 600), 45);
});

test('cssAngle: aspect ratio — normalized diagonal on a 2:1 node is NOT 135°', () => {
  // Handles run along the normalized diagonal; on a 200×100 node the visual
  // iso-lines tilt: pixel-space direction ∝ (t00/w, t01/h) = (1, 2) y-down
  // → atan2(1, -2) ≈ 153°. A square node still reads 135°.
  const t = [[0.7071, 0.7071, 0], [-0.7071, 0.7071, 0.5]];
  assert.equal(cssAngleFromGradientTransform(t, 200, 100), 153);
  assert.equal(cssAngleFromGradientTransform(t, 100, 100), 135);
});

test('cssAngle: degenerate/missing transforms return null', () => {
  assert.equal(cssAngleFromGradientTransform(undefined, 100, 100), null);
  assert.equal(cssAngleFromGradientTransform([], 100, 100), null);
  assert.equal(cssAngleFromGradientTransform([[0, 0, 0], [0, 0, 0]], 100, 100), null);
});

// ── writing: CSS angle → Figma matrix ──

test('writer: 180° yields the canonical top→bottom matrix', () => {
  const m = gradientTransformFromCssAngle(180);
  const flat = [...m[0], ...m[1]];
  const want = [0, 1, 0, -1, 0, 1];
  flat.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `component ${i}: ${v} ≈ ${want[i]}`));
});

test('writer: 90° yields the identity (left→right)', () => {
  const m = gradientTransformFromCssAngle(90);
  const flat = [...m[0], ...m[1]];
  const want = [1, 0, 0, 0, 1, 0];
  flat.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `component ${i}: ${v} ≈ ${want[i]}`));
});

test('round-trip: write(deg) then read = deg for all compass + diagonal angles', () => {
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const m = gradientTransformFromCssAngle(deg);
    assert.equal(cssAngleFromGradientTransform(m, 100, 100), deg, `${deg}°`);
  }
});

// ── serializer: paints() output format ──

const stop = (hex, position, a = 1) => ({
  position,
  color: {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
    a,
  },
});

test('serializePaints: linear gradient carries an explicit, correct angle', () => {
  const paint = {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [[0.7071, 0.7071, 0], [-0.7071, 0.7071, 0.5]],
    gradientStops: [stop('#02153b', 0), stop('#0e1425', 0.5)],
  };
  assert.deepEqual(
    serializePaints([paint], 600, 600),
    ['linear-gradient(135deg, #02153b 0%, #0e1425 50%)'],
  );
});

test('serializePaints: missing transform falls back to an EXPLICIT 180deg (never omitted)', () => {
  const paint = { type: 'GRADIENT_LINEAR', gradientStops: [stop('#000000', 0), stop('#ffffff', 1)] };
  assert.deepEqual(serializePaints([paint], 100, 100), ['linear-gradient(180deg, #000000 0%, #ffffff 100%)']);
});

test('serializePaints: solid opacity, stop alpha, conic naming, invisible skipped', () => {
  const out = serializePaints([
    { type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 0.5 },
    { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, visible: false },
    { type: 'GRADIENT_ANGULAR', gradientStops: [stop('#ff0000', 0, 0.4), stop('#00ff00', 1)] },
  ], 100, 100);
  assert.deepEqual(out, ['#ff0000@50', 'conic-gradient(#ff0000@40 0%, #00ff00 100%)']);
});

// ── snippet embedding: the sandbox fragment IS the same implementation ──

test('paintsSnippetJs evaluates standalone and matches the Node-side serializer', () => {
  const api = new Function(`${paintsSnippetJs}; return { hex, cssAngle, paints };`)();
  for (const { t, deg } of KNOWN) assert.equal(api.cssAngle(t, 100, 100), deg);
  const direct = makePaintSerializer();
  const paint = {
    type: 'GRADIENT_LINEAR',
    gradientTransform: [[0, 1, 0], [-1, 0, 1]],
    gradientStops: [stop('#112233', 0), stop('#445566', 1)],
  };
  assert.deepEqual(api.paints([paint], 50, 200), direct.paints([paint], 50, 200));
});

// ── end-to-end: the walker (figma_spec data source) uses the shared math ──

const MIXED = Symbol('mixed');
const stubFigma = (root) => ({
  mixed: MIXED,
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (root) =>
  new Function('figma', `return ${nodeWalkerCode(root.id)}`)(stubFigma(root));

test('walker: Rectangle-28 shaped node comes out as 135deg, not 45deg', async () => {
  const root = {
    id: 'r:28', name: 'Rectangle 28', type: 'RECTANGLE', visible: true,
    width: 600, height: 600,
    fills: [{
      type: 'GRADIENT_LINEAR',
      gradientTransform: [[0.7071, 0.7071, 0], [-0.7071, 0.7071, 0.5]],
      gradientStops: [stop('#02153b', 0), stop('#0e1425', 0.5)],
    }],
    children: [],
  };
  const out = JSON.parse(await runWalker(root)).frames[0];
  assert.deepEqual(out.fills, ['linear-gradient(135deg, #02153b 0%, #0e1425 50%)']);
});
