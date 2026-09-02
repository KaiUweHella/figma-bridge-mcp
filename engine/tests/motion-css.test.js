import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionCssName, motionToCss, projectMotion } from '../src/lib/motion-css.js';

const easeInOut = { type: 'EASE_IN_AND_OUT', easingFunctionCubicBezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } };
const float = (value) => ({ type: 'FLOAT', value });
const key = (t, value, easing = easeInOut) => ({ id: `${t}:k`, timelinePosition: t, value, easing });

test('projectMotion keeps every native track bounded, sorted and free of ids', () => {
  const projected = projectMotion({
    TRANSLATION_X: { id: 'KeyframeTrackId:1', keyframeOperation: 'SET', baseValue: float(0),
      keyframes: [key(5, float(13)), key(0, float(0)), key(10, float(0))] },
    SCALE_XY: { keyframes: [key(0, { type: 'VECTOR', value: { x: 1, y: 1 } }), key(5, { type: 'VECTOR', value: { x: 1.0399999618530273, y: 1.0399999618530273 } })] },
    fills: { 0: { keyframes: [key(0, { type: 'COLOR', value: { r: 1, g: 0, b: 0, a: 1 } }), key(2, { type: 'COLOR', value: { r: 0, g: 0, b: 1, a: 0.5 } })] } },
    effects: { 0: { keyframes: [] } },
  }, [{ id: '1:1', duration: 10 }]);
  assert.deepEqual(projected.tracks.map((track) => track.field), ['TRANSLATION_X', 'SCALE_XY', 'fills[0]']);
  assert.deepEqual(projected.tracks[0].keys.map((k) => k.t), [0, 5, 10]);
  assert.equal(projected.tracks[0].keys[1].id, undefined);
  assert.deepEqual(projected.tracks[0].keys[1].easing, { type: 'EASE_IN_AND_OUT', bezier: [0.42, 0, 0.58, 1] });
  assert.equal(projected.tracks[1].keys[1].value.value.x, 1.04, 'float32 storage noise is rounded away');
  assert.deepEqual(projected.timeline, { id: '1:1', duration: 10 });
  assert.deepEqual(projected.unsupported, ['effects[0]']);
  assert.equal(projectMotion({}), null);
});

test('motionToCss composes transform tracks into one keyframe timeline with shifted easings', () => {
  const fact = projectMotion({
    TRANSLATION_X: { keyframes: [key(0, float(0)), key(5, float(13)), key(10, float(0))] },
    TRANSLATION_Y: { keyframes: [key(0, float(0)), key(5, float(-7)), key(10, float(0))] },
    SCALE_XY: { keyframes: [key(0, { type: 'VECTOR', value: { x: 1, y: 1 } }), key(5, { type: 'VECTOR', value: { x: 1.04, y: 1.04 } }), key(10, { type: 'VECTOR', value: { x: 1, y: 1 } })] },
  }, [{ id: '362:1846', duration: 10 }]);
  const css = motionToCss(fact, { name: motionCssName('362:1948') });
  assert.equal(css.name, 'motion-362-1948');
  assert.equal(css.animation, 'animation: motion-362-1948 10s linear 1 normal both;');
  assert.equal(css.keyframes, [
    '@keyframes motion-362-1948 {',
    '  0% { transform: none; animation-timing-function: ease-in-out; }',
    '  50% { transform: translate(13px, -7px) scale(1.04); animation-timing-function: ease-in-out; }',
    '  100% { transform: none; }',
    '}',
  ].join('\n'));
  assert.ok(css.limitations.some((line) => /prefers-reduced-motion/.test(line)));
});

test('motionToCss interpolates a transform component that has no key at a sibling keyframe', () => {
  const fact = projectMotion({
    TRANSLATION_X: { keyframes: [key(0, float(0), { type: 'LINEAR' }), key(4, float(100), { type: 'LINEAR' })] },
    ROTATION: { keyframes: [key(0, float(0)), key(2, float(90), { type: 'LINEAR' })] },
  }, [{ id: 't', duration: 4 }]);
  const css = motionToCss(fact, { name: 'spin' });
  assert.match(css.keyframes, /50% \{ transform: translate\(50px, 0px\) rotate\(90deg\); \}/);
  assert.match(css.keyframes, /100% \{ transform: translate\(100px, 0px\) rotate\(90deg\); \}/);
});

test('motionToCss maps scalar, colour and custom-bezier tracks and reports what CSS cannot express', () => {
  const fact = projectMotion({
    OPACITY: { keyframes: [key(0, float(0), { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0.1, x2: 0.3, y2: 1 } }), key(1, float(1), { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0.1, x2: 0.3, y2: 1 } })] },
    CORNER_RADIUS: { keyframes: [key(0, float(4), { type: 'GENTLE', easingFunctionSpring: { bounce: 0.2 } }), key(1, float(12), { type: 'GENTLE' })] },
    fills: { 0: { keyframes: [key(0, { type: 'COLOR', value: { r: 1, g: 0, b: 0, a: 1 } }, { type: 'HOLD' }), key(1, { type: 'COLOR', value: { r: 0, g: 0, b: 1, a: 0.5 } }, { type: 'HOLD' })] } },
    PATH_TRIM_START: { keyframes: [key(0, float(0)), key(1, float(1))] },
  }, [{ id: 't', duration: 2 }]);
  const css = motionToCss(fact, { name: 'reveal' });
  assert.match(css.keyframes, /0% \{ opacity: 0; border-radius: 4px; background-color: rgb\(255 0 0\); animation-timing-function: cubic-bezier\(0\.2, 0\.1, 0\.3, 1\); \}/);
  assert.match(css.keyframes, /50% \{ opacity: 1; border-radius: 12px; background-color: rgb\(0 0 255 \/ 0\.5\); \}/);
  assert.ok(css.limitations.some((line) => /spring easing GENTLE/.test(line)));
  assert.ok(css.limitations.some((line) => /PATH_TRIM_START/.test(line)));
  assert.ok(css.limitations.some((line) => /mixes 3 easings/.test(line)));
  assert.equal(motionToCss(null), null);
});

import { cssAnimationToMotion, parseCssTransform, repeatMotionToTimeline } from '../src/lib/motion-css.js';

test('cssAnimationToMotion turns an alternate infinite orbit with a negative delay into one phase-shifted period', () => {
  const motion = cssAnimationToMotion(
    [{ name: 'orbit', duration: '5s', delay: '-1.7s', timingFunction: 'ease-in-out', iterationCount: 'infinite', direction: 'alternate' }],
    { orbit: [{ selectorText: 'to', style: { transform: 'translate3d(13px, -7px, 0px) scale(1.04)' } }] },
    { transform: 'none' },
  );
  assert.equal(motion.duration, 10);
  assert.deepEqual(motion.tracks.map((track) => track.field.name), ['TRANSLATION_X', 'TRANSLATION_Y', 'SCALE_XY']);
  const x = motion.tracks[0].binding.keyframes;
  assert.deepEqual(x.map((key) => [key.timelinePosition, key.value.value]), [[0, 3.1349], [3.3, 13], [8.3, 0], [10, 3.1349]]);
  assert.equal(x[1].easing.type, 'EASE_IN_AND_OUT');
  assert.equal(x[2].easing.type, 'EASE_IN_AND_OUT', 'the cycle-end easing survives the rotation');
  assert.deepEqual(motion.tracks[2].binding.keyframes[1].value, { type: 'VECTOR', value: { x: 1.04, y: 1.04 } });
  assert.ok(motion.limitations.some((line) => /one alternate period/.test(line)));
  assert.ok(motion.limitations.some((line) => /phase shift/.test(line)));
});

test('cssAnimationToMotion maps opacity, colour, radius and per-keyframe timing with the arrival convention', () => {
  const motion = cssAnimationToMotion(
    [{ name: 'reveal', duration: '400ms', delay: '0s', timingFunction: 'ease', iterationCount: '1', direction: 'normal' }],
    { reveal: [
      { selectorText: '0%', style: { opacity: '0', backgroundColor: 'rgb(255, 0, 0)', borderTopLeftRadius: '4px', borderTopRightRadius: '4px', borderBottomRightRadius: '4px', borderBottomLeftRadius: '4px', animationTimingFunction: 'cubic-bezier(0.2, 0.1, 0.3, 1)' } },
      { selectorText: '100%', style: { opacity: '1', backgroundColor: 'rgba(0, 0, 255, 0.5)', borderTopLeftRadius: '12px', borderTopRightRadius: '12px', borderBottomRightRadius: '12px', borderBottomLeftRadius: '12px' } },
    ] },
    {},
  );
  assert.equal(motion.duration, 0.4);
  const byField = Object.fromEntries(motion.tracks.map((track) => [track.field.name || `${track.field.collection}[${track.field.index}]`, track.binding.keyframes]));
  assert.deepEqual(byField.OPACITY.map((key) => key.value.value), [0, 1]);
  assert.equal(byField.OPACITY[0].easing, undefined, 'the first keyframe has nothing to arrive from');
  assert.deepEqual(byField.OPACITY[1].easing, { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.2, y1: 0.1, x2: 0.3, y2: 1 } });
  assert.deepEqual(byField['fills[0]'][1].value, { type: 'COLOR', value: { r: 0, g: 0, b: 1, a: 0.5 } });
  assert.deepEqual(byField.CORNER_RADIUS.map((key) => key.value.value), [4, 12]);
  assert.equal(motion.limitations.length, 0);
});

test('cssAnimationToMotion synthesizes resting keyframes, honours reverse and positive delays, and drops idle transforms', () => {
  const fade = cssAnimationToMotion(
    [{ name: 'fade', duration: '1s', delay: '0.5s', timingFunction: 'linear', iterationCount: '1', direction: 'reverse' }],
    { fade: [{ selectorText: 'from', style: { opacity: '0' } }] },
    { opacity: '0.8' },
  );
  const keys = fade.tracks[0].binding.keyframes;
  assert.deepEqual(keys.map((key) => [key.timelinePosition, key.value.value]), [[0.5, 0.8], [1.5, 0]], 'reverse plays the resting value first, shifted by the delay');
  assert.ok(fade.limitations.some((line) => /0\.5s delay/.test(line)));

  const idle = cssAnimationToMotion(
    [{ name: 'still', duration: '1s', delay: '0s', timingFunction: 'linear', iterationCount: '1', direction: 'normal' }],
    { still: [{ selectorText: 'to', style: { transform: 'translate(0px, 0px)' } }] },
    { transform: 'none' },
  );
  assert.equal(idle, null);
  assert.equal(cssAnimationToMotion([{ name: 'missing', duration: '1s' }], {}), null);
  assert.ok(cssAnimationToMotion([{ name: 'weird', duration: '1s', timingFunction: 'linear' }],
    { weird: [{ selectorText: 'to', style: { transform: 'skew(10deg)', opacity: '0' } }] }).limitations.some((line) => /skew\(10deg\)/.test(line)));
});

test('parseCssTransform composes translate, scale and rotate functions', () => {
  assert.deepEqual(parseCssTransform('translateX(10px) translateY(-4px) scale(2, 0.5) rotate(0.5turn)'), { x: 10, y: -4, sx: 2, sy: 0.5, rotation: 180, limitations: [] });
  assert.deepEqual(parseCssTransform('none').limitations, []);
  assert.match(parseCssTransform('translate(50%, 0)').limitations[0], /px only/);
});

const floatLoop = () => cssAnimationToMotion(
  [{ name: 'float', duration: '3.8s', delay: '0s', timingFunction: 'ease-in-out', iterationCount: 'infinite', direction: 'normal' }],
  { float: [{ selectorText: '50%', style: { transform: 'translateY(-7px)' } }] },
  { transform: 'none' },
);

test('cssAnimationToMotion reports a repeatable cycle only for an endless, undelayed loop', () => {
  assert.deepEqual(floatLoop().loop, { cycle: 3.8 });

  const alternate = cssAnimationToMotion(
    [{ name: 'orbit', duration: '5s', delay: '0s', timingFunction: 'ease-in-out', iterationCount: 'infinite', direction: 'alternate' }],
    { orbit: [{ selectorText: 'to', style: { transform: 'translateY(-7px)' } }] },
    { transform: 'none' },
  );
  assert.deepEqual(alternate.loop, { cycle: 10 }, 'an alternate loop repeats on its doubled period');

  const once = cssAnimationToMotion(
    [{ name: 'float', duration: '3.8s', delay: '0s', timingFunction: 'ease-in-out', iterationCount: '1', direction: 'normal' }],
    { float: [{ selectorText: '50%', style: { transform: 'translateY(-7px)' } }] },
    { transform: 'none' },
  );
  assert.equal(once.loop, undefined, 'a single run must never be repeated');

  const delayed = cssAnimationToMotion(
    [{ name: 'float', duration: '3.8s', delay: '0.5s', timingFunction: 'ease-in-out', iterationCount: 'infinite', direction: 'normal' }],
    { float: [{ selectorText: '50%', style: { transform: 'translateY(-7px)' } }] },
    { transform: 'none' },
  );
  assert.equal(delayed.loop, undefined, 'a positive delay happens once, so the period is not repeatable');
});

test('repeatMotionToTimeline fills a longer shared timeline and interpolates the mid-cycle cut', () => {
  const filled = repeatMotionToTimeline(floatLoop(), 10);
  assert.equal(filled.duration, 10);
  const keys = filled.tracks[0].binding.keyframes.map((key) => [key.timelinePosition, key.value.value]);
  assert.deepEqual(keys.map(([time]) => time), [0, 1.9, 3.8, 5.7, 7.6, 9.5, 10]);
  assert.deepEqual(keys.slice(0, 6).map(([, value]) => value), [0, -7, 0, -7, 0, -7]);
  // The timeline cuts 0.5s into a 1.9s ease-in-out segment from -7 to 0.
  const boundary = keys[6][1];
  assert.ok(boundary > -7 && boundary < -5, `expected an eased mid-segment value, got ${boundary}`);
});

test('repeatMotionToTimeline leaves motion alone without a repeatable cycle or a longer timeline', () => {
  const loop = floatLoop();
  assert.equal(repeatMotionToTimeline(loop, 3.8), loop, 'a timeline of one cycle needs no repeat');
  assert.equal(repeatMotionToTimeline(loop, 2), loop, 'a shorter timeline never truncates the period');
  const once = { duration: 1, tracks: loop.tracks, limitations: [] };
  assert.equal(repeatMotionToTimeline(once, 10), once, 'no loop metadata means no repeat');
  assert.equal(repeatMotionToTimeline(null, 10), null);
});
