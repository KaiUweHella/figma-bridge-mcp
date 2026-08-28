// Canonical Figma MotionEasing projection shared by Variable Snapshot,
// CSS/DTCG Token Export and Token Import.

export const MOTION_EASING_TYPES = Object.freeze([
  'EASE_IN',
  'EASE_OUT',
  'EASE_IN_AND_OUT',
  'LINEAR',
  'EASE_IN_BACK',
  'EASE_OUT_BACK',
  'EASE_IN_AND_OUT_BACK',
  'CUSTOM_CUBIC_BEZIER',
  'GENTLE',
  'QUICK',
  'BOUNCY',
  'SLOW',
  'CUSTOM_SPRING',
  'HOLD',
]);

export const NATIVE_CUBIC_EASINGS = Object.freeze({
  EASE_IN: Object.freeze({ x1: 0.42, y1: 0, x2: 1, y2: 1 }),
  EASE_OUT: Object.freeze({ x1: 0, y1: 0, x2: 0.58, y2: 1 }),
  EASE_IN_AND_OUT: Object.freeze({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 }),
  LINEAR: Object.freeze({ x1: 0, y1: 0, x2: 1, y2: 1 }),
  EASE_IN_BACK: Object.freeze({ x1: 0.3, y1: -0.05, x2: 0.7, y2: -0.5 }),
  EASE_OUT_BACK: Object.freeze({ x1: 0.45, y1: 1.45, x2: 0.8, y2: 1 }),
  EASE_IN_AND_OUT_BACK: Object.freeze({ x1: 0.7, y1: -0.4, x2: 0.4, y2: 1.4 }),
});

export const NATIVE_SPRING_EASINGS = Object.freeze({
  GENTLE: 0.25,
  QUICK: 0.42264973081037427,
  BOUNCY: 0.6938137821521027,
  SLOW: 0,
});

export const MOTION_EASING_NUMBER_SCALE = 1_000_000;

const cleanNumber = (value) => Math.round(Number(value) * MOTION_EASING_NUMBER_SCALE)
  / MOTION_EASING_NUMBER_SCALE;
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const equivalent = (actual, expected) => typeof actual === 'number'
  && Number.isFinite(actual)
  && (Object.is(actual, expected)
    || Math.fround(actual) === Math.fround(expected)
    || cleanNumber(actual) === cleanNumber(expected));

function cubic(value) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'x1,x2,y1,y2'
    || ![value.x1, value.y1, value.x2, value.y2].every(Number.isFinite)
    || value.x1 < 0 || value.x1 > 1 || value.x2 < 0 || value.x2 > 1) {
    throw new Error('Motion Easing cubic Bézier must contain finite x1, y1, x2, y2 values.');
  }
  return {
    x1: cleanNumber(value.x1),
    y1: cleanNumber(value.y1),
    x2: cleanNumber(value.x2),
    y2: cleanNumber(value.y2),
  };
}

function spring(value) {
  if (!plain(value) || Object.keys(value).join(',') !== 'bounce'
    || typeof value.bounce !== 'number' || !Number.isFinite(value.bounce)
    || value.bounce < 0 || value.bounce > 1) {
    throw new Error('Motion Easing spring bounce must be between zero and one.');
  }
  return { bounce: cleanNumber(value.bounce) };
}

export function canonicalMotionEasing(value) {
  if (!plain(value) || !MOTION_EASING_TYPES.includes(value.type)
    || Object.keys(value).some((key) => ![
      'type', 'easingFunctionCubicBezier', 'easingFunctionSpring',
    ].includes(key))) {
    throw new Error('Motion Easing must use the closed native Figma shape.');
  }
  const nativeCubic = NATIVE_CUBIC_EASINGS[value.type];
  if (nativeCubic) {
    if (value.easingFunctionSpring !== undefined) {
      throw new Error(`Motion Easing ${value.type} cannot contain a spring.`);
    }
    if (value.easingFunctionCubicBezier !== undefined) {
      const actual = cubic(value.easingFunctionCubicBezier);
      if (!Object.keys(nativeCubic).every((key) => equivalent(actual[key], nativeCubic[key]))) {
        throw new Error(`Motion Easing ${value.type} does not match its native curve.`);
      }
    }
    return { type: value.type, easingFunctionCubicBezier: { ...nativeCubic } };
  }
  if (Object.hasOwn(NATIVE_SPRING_EASINGS, value.type)) {
    if (value.easingFunctionCubicBezier !== undefined) {
      throw new Error(`Motion Easing ${value.type} cannot contain a cubic Bézier.`);
    }
    if (value.easingFunctionSpring !== undefined
      && !equivalent(value.easingFunctionSpring.bounce, NATIVE_SPRING_EASINGS[value.type])) {
      throw new Error(`Motion Easing ${value.type} does not match its native spring.`);
    }
    return {
      type: value.type,
      easingFunctionSpring: { bounce: cleanNumber(NATIVE_SPRING_EASINGS[value.type]) },
    };
  }
  if (value.type === 'CUSTOM_CUBIC_BEZIER') {
    if (value.easingFunctionSpring !== undefined) {
      throw new Error('Custom cubic Bézier easing cannot contain a spring.');
    }
    return { type: value.type, easingFunctionCubicBezier: cubic(value.easingFunctionCubicBezier) };
  }
  if (value.type === 'CUSTOM_SPRING') {
    if (value.easingFunctionCubicBezier !== undefined) {
      throw new Error('Custom spring easing cannot contain a cubic Bézier.');
    }
    return { type: value.type, easingFunctionSpring: spring(value.easingFunctionSpring) };
  }
  if (value.easingFunctionCubicBezier !== undefined || value.easingFunctionSpring !== undefined) {
    throw new Error('HOLD easing cannot contain a curve or spring.');
  }
  return { type: 'HOLD' };
}

export function motionEasingIsNativeReadback(value) {
  try {
    const canonical = canonicalMotionEasing(value);
    if (canonical.easingFunctionCubicBezier
      && !value.easingFunctionCubicBezier) return false;
    if (canonical.easingFunctionSpring && !value.easingFunctionSpring) return false;
    return true;
  } catch {
    return false;
  }
}

export function motionEasingProjection(value) {
  const native = canonicalMotionEasing(value);
  const bezier = native.easingFunctionCubicBezier;
  if (bezier) {
    const css = native.type === 'LINEAR' ? 'linear'
      : native.type === 'EASE_IN' ? 'ease-in'
        : native.type === 'EASE_OUT' ? 'ease-out'
          : native.type === 'EASE_IN_AND_OUT' ? 'ease-in-out'
            : `cubic-bezier(${bezier.x1}, ${bezier.y1}, ${bezier.x2}, ${bezier.y2})`;
    return {
      native,
      kind: 'cubicBezier',
      css,
      dtcgType: 'cubicBezier',
      dtcgValue: [bezier.x1, bezier.y1, bezier.x2, bezier.y2],
    };
  }
  if (native.type === 'HOLD') {
    return {
      native,
      kind: 'hold',
      css: 'steps(1, jump-end)',
      dtcgType: 'string',
      dtcgValue: 'HOLD',
    };
  }
  return {
    native,
    kind: 'spring',
    css: null,
    dtcgType: 'string',
    dtcgValue: native.type,
  };
}
