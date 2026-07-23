// Unit tests for the pure Motion logic (no Figma connection needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapField,
  mapEasing,
  parseKeys,
  hexToRgba,
  normalizeSpec,
  presetTracks,
  expandStagger,
  PRESETS,
} from '../src/lib/motion-core.js';

// ---------- mapField ----------

test('mapField maps friendly aliases to API fields', () => {
  assert.equal(mapField('opacity').name, 'OPACITY');
  assert.equal(mapField('opacity').valueType, 'FLOAT');
  assert.equal(mapField('translateX').name, 'TRANSLATION_X');
  assert.equal(mapField('translateY').name, 'TRANSLATION_Y');
  assert.equal(mapField('rotate').name, 'ROTATION');
  assert.equal(mapField('scale').name, 'SCALE_XY');
  assert.equal(mapField('radius').name, 'CORNER_RADIUS');
});

test('scale maps to SCALE_XY as a VECTOR and expands scalar keys to {x,y}', () => {
  assert.equal(mapField('scale').valueType, 'VECTOR');
  const norm = normalizeSpec({
    tracks: [{ node: '1:2', field: 'scale', keys: [{ t: 0, v: 0.8 }, { t: 0.5, v: 1 }] }],
  });
  const kf = norm.byNode['1:2'].SCALE_XY.keyframes;
  assert.deepEqual(kf[0].value, { type: 'VECTOR', value: { x: 0.8, y: 0.8 } });
  assert.deepEqual(kf[1].value, { type: 'VECTOR', value: { x: 1, y: 1 } });
});

test('mapField marks transform fields additive and absolute fields not', () => {
  assert.equal(mapField('translateX').additive, true);
  assert.equal(mapField('scale').additive, true);
  assert.equal(mapField('opacity').additive, false);
  assert.equal(mapField('radius').additive, false);
});

test('mapField handles color fields with paint index', () => {
  const fill = mapField('fill');
  assert.equal(fill.name, 'fills');
  assert.equal(fill.valueType, 'COLOR');
  assert.equal(fill.index, 0);
  assert.equal(mapField('fill:2').index, 2);
  assert.equal(mapField('stroke').name, 'strokes');
});

test('mapField passes through raw API enum names', () => {
  assert.equal(mapField('OPACITY').name, 'OPACITY');
  assert.equal(mapField('TRANSLATION_X').name, 'TRANSLATION_X');
});

test('mapField throws on unknown field', () => {
  assert.throws(() => mapField('wobble'), /unknown|unsupported|field/i);
});

// ---------- mapEasing ----------

test('mapEasing maps named easings', () => {
  assert.deepEqual(mapEasing('ease-out'), { type: 'EASE_OUT' });
  assert.deepEqual(mapEasing('linear'), { type: 'LINEAR' });
  assert.deepEqual(mapEasing('gentle'), { type: 'GENTLE' });
  assert.deepEqual(mapEasing('hold'), { type: 'HOLD' });
});

test('mapEasing never emits the invalid EASE_IN_OUT alias', () => {
  assert.deepEqual(mapEasing('ease-in-out'), { type: 'EASE_IN_AND_OUT' });
});

test('mapEasing parses spring with bounce', () => {
  assert.deepEqual(mapEasing('spring'), { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.3 } });
  assert.deepEqual(mapEasing('spring(0.7)'), { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.7 } });
});

test('mapEasing clamps spring bounce to 0..1', () => {
  assert.equal(mapEasing('spring(5)').easingFunctionSpring.bounce, 1);
  assert.equal(mapEasing('spring(-2)').easingFunctionSpring.bounce, 0);
});

test('mapEasing parses cubic bezier', () => {
  assert.deepEqual(mapEasing('cubic(0.34,1.56,0.64,1)'), {
    type: 'CUSTOM_CUBIC_BEZIER',
    easingFunctionCubicBezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 },
  });
});

test('mapEasing passes through raw enum and defaults to EASE_OUT', () => {
  assert.deepEqual(mapEasing('EASE_IN_AND_OUT_BACK'), { type: 'EASE_IN_AND_OUT_BACK' });
  assert.deepEqual(mapEasing(undefined), { type: 'EASE_OUT' });
});

// ---------- hexToRgba ----------

test('hexToRgba converts 6- and 8-digit hex to 0..1 channels', () => {
  assert.deepEqual(hexToRgba('#ff0000'), { r: 1, g: 0, b: 0, a: 1 });
  const c = hexToRgba('#00ff0080');
  assert.equal(c.g, 1);
  assert.ok(Math.abs(c.a - 0.5019) < 0.01);
});

// ---------- parseKeys ----------

test('parseKeys parses "t:v" pairs into keyframes', () => {
  const kf = parseKeys('0:0, 0.4:1', 'FLOAT');
  assert.equal(kf.length, 2);
  assert.deepEqual(kf[0], { timelinePosition: 0, value: { type: 'FLOAT', value: 0 } });
  assert.equal(kf[1].timelinePosition, 0.4);
  assert.deepEqual(kf[1].value, { type: 'FLOAT', value: 1 });
});

test('parseKeys attaches per-keyframe easing when given', () => {
  const kf = parseKeys('0:0, 0.5:1:ease-out', 'FLOAT');
  assert.deepEqual(kf[1].easing, { type: 'EASE_OUT' });
});

test('parseKeys handles color values via hex', () => {
  const kf = parseKeys('0:#ff0000, 1:#0000ff', 'COLOR');
  assert.deepEqual(kf[0].value, { type: 'COLOR', value: { r: 1, g: 0, b: 0, a: 1 } });
  assert.equal(kf[1].value.value.b, 1);
});

test('parseKeys sorts keyframes by time', () => {
  const kf = parseKeys('0.5:1, 0:0', 'FLOAT');
  assert.equal(kf[0].timelinePosition, 0);
  assert.equal(kf[1].timelinePosition, 0.5);
});

// ---------- normalizeSpec ----------

test('normalizeSpec groups tracks by node and computes duration', () => {
  const spec = {
    tracks: [
      { node: '1:2', field: 'opacity', keys: [{ t: 0, v: 0 }, { t: 0.4, v: 1, ease: 'ease-out' }] },
      { node: '1:2', field: 'translateY', keys: [{ t: 0, v: 40 }, { t: 0.5, v: 0 }] },
      { node: '1:3', field: 'opacity', keys: [{ t: 0.2, v: 0 }, { t: 0.6, v: 1 }] },
    ],
  };
  const norm = normalizeSpec(spec);
  assert.equal(norm.duration, 0.6); // max t across all tracks
  assert.deepEqual(Object.keys(norm.byNode).sort(), ['1:2', '1:3']);
  assert.ok(norm.byNode['1:2'].OPACITY);
  assert.ok(norm.byNode['1:2'].TRANSLATION_Y);
  assert.equal(norm.byNode['1:2'].OPACITY.keyframes[1].easing.type, 'EASE_OUT');
});

test('normalizeSpec honours explicit duration but never below max keyframe', () => {
  const spec = {
    duration: 2,
    tracks: [{ node: '1:2', field: 'opacity', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 1 }] }],
  };
  assert.equal(normalizeSpec(spec).duration, 2);
  const spec2 = {
    duration: 0.2,
    tracks: [{ node: '1:2', field: 'opacity', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 1 }] }],
  };
  assert.equal(normalizeSpec(spec2).duration, 0.5);
});

test('normalizeSpec nests color tracks under fills/strokes by index', () => {
  const spec = {
    tracks: [{ node: '1:2', field: 'fill', keys: [{ t: 0, v: '#ff0000' }, { t: 1, v: '#0000ff' }] }],
  };
  const norm = normalizeSpec(spec);
  assert.ok(norm.byNode['1:2'].fills);
  assert.ok(norm.byNode['1:2'].fills[0]);
  assert.equal(norm.byNode['1:2'].fills[0].keyframes[0].value.type, 'COLOR');
});

test('normalizeSpec rejects a spec with no tracks', () => {
  assert.throws(() => normalizeSpec({ tracks: [] }), /track/i);
});

// ---------- presets ----------

test('PRESETS covers the documented set', () => {
  for (const name of ['fade-in', 'fade-up', 'fade-down', 'slide-left', 'slide-right', 'pop', 'spin']) {
    assert.ok(PRESETS[name], `missing preset ${name}`);
  }
});

test('presetTracks(fade-up) returns opacity + translateY tracks', () => {
  const tracks = presetTracks('fade-up', { dur: 0.5, at: 0 });
  const fields = tracks.map((t) => t.field);
  assert.ok(fields.includes('opacity'));
  assert.ok(fields.includes('translateY'));
  // ends within the duration window
  const maxT = Math.max(...tracks.flatMap((t) => t.keys.map((k) => k.t)));
  assert.equal(maxT, 0.5);
});

test('presetTracks offsets keyframes by --at', () => {
  const tracks = presetTracks('fade-in', { dur: 0.5, at: 1 });
  const minT = Math.min(...tracks.flatMap((t) => t.keys.map((k) => k.t)));
  assert.equal(minT, 1);
});

test('presetTracks throws on unknown preset', () => {
  assert.throws(() => presetTracks('explode', {}), /unknown|preset/i);
});

// ---------- stagger ----------

test('expandStagger offsets each node by index * step', () => {
  const spec = expandStagger(['1:2', '1:3', '1:4'], { preset: 'fade-up', dur: 0.5 }, 0.1);
  // returns a spec with tracks for all three nodes
  const nodes = [...new Set(spec.tracks.map((t) => t.node))];
  assert.deepEqual(nodes, ['1:2', '1:3', '1:4']);
  // node #3 (index 2) should start at 0.2
  const thirdOpacity = spec.tracks.find((t) => t.node === '1:4' && t.field === 'opacity');
  assert.equal(Math.min(...thirdOpacity.keys.map((k) => k.t)), 0.2);
});

test('expandStagger works with a raw field/from/to instead of a preset', () => {
  const spec = expandStagger(['1:2', '1:3'], { field: 'opacity', from: 0, to: 1, dur: 0.4 }, 0.2);
  const second = spec.tracks.find((t) => t.node === '1:3');
  assert.equal(Math.min(...second.keys.map((k) => k.t)), 0.2);
  assert.equal(second.keys.length, 2);
});
