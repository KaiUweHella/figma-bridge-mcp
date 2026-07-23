// Pure logic for the `motion` command: alias maps, keyframe parsing, spec
// normalization, presets, stagger expansion. No Figma dependency — unit-tested
// in tests/motion-core.test.js. The command file (commands/motion.js) turns the
// normalized output into Plugin API calls via fastEval.

// ---------------------------------------------------------------------------
// Field aliases → Figma Motion animatable fields
// ---------------------------------------------------------------------------
// additive transform fields compose with the node's resting transform (neutral
// 0, or 1 for scale); absolute fields replace the node's value in the window.

const FIELD_DEFS = [
  // transform (additive)
  { aliases: ['translateX', 'x'], name: 'TRANSLATION_X', valueType: 'FLOAT', additive: true },
  { aliases: ['translateY', 'y'], name: 'TRANSLATION_Y', valueType: 'FLOAT', additive: true },
  { aliases: ['translate', 'move'], name: 'TRANSLATION_XY', valueType: 'VECTOR', additive: true },
  { aliases: ['rotate', 'rotation'], name: 'ROTATION', valueType: 'FLOAT', additive: true },
  { aliases: ['scale'], name: 'SCALE_XY', valueType: 'VECTOR', additive: true },
  { aliases: ['scaleX'], name: 'SCALE_X', valueType: 'FLOAT', additive: true },
  { aliases: ['scaleY'], name: 'SCALE_Y', valueType: 'FLOAT', additive: true },
  // absolute
  { aliases: ['opacity', 'fade'], name: 'OPACITY', valueType: 'FLOAT', additive: false },
  { aliases: ['radius', 'cornerRadius'], name: 'CORNER_RADIUS', valueType: 'FLOAT', additive: false },
  { aliases: ['width', 'w'], name: 'WIDTH', valueType: 'FLOAT', additive: false },
  { aliases: ['height', 'h'], name: 'HEIGHT', valueType: 'FLOAT', additive: false },
  { aliases: ['strokeWeight'], name: 'STROKE_WEIGHT', valueType: 'FLOAT', additive: false },
  { aliases: ['gap', 'spacing'], name: 'STACK_SPACING', valueType: 'FLOAT', additive: false },
  { aliases: ['padTop'], name: 'STACK_PADDING_TOP', valueType: 'FLOAT', additive: false },
  { aliases: ['padRight'], name: 'STACK_PADDING_RIGHT', valueType: 'FLOAT', additive: false },
  { aliases: ['padBottom'], name: 'STACK_PADDING_BOTTOM', valueType: 'FLOAT', additive: false },
  { aliases: ['padLeft'], name: 'STACK_PADDING_LEFT', valueType: 'FLOAT', additive: false },
  { aliases: ['trimStart'], name: 'PATH_TRIM_START', valueType: 'FLOAT', additive: false },
  { aliases: ['trimEnd'], name: 'PATH_TRIM_END', valueType: 'FLOAT', additive: false },
];

const FIELD_LOOKUP = {};
for (const def of FIELD_DEFS) {
  const entry = { name: def.name, valueType: def.valueType, additive: def.additive };
  FIELD_LOOKUP[def.name] = entry; // raw API enum
  for (const a of def.aliases) FIELD_LOOKUP[a.toLowerCase()] = entry;
}

/**
 * Resolve a field alias (or raw API enum, or color field) to
 * { name, valueType, additive, index? }.
 */
export function mapField(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Missing motion field');

  // color: fill, fill:2, stroke, strokes:1
  const color = raw.match(/^(fill|fills|stroke|strokes)(?::(\d+))?$/i);
  if (color) {
    const isFill = /^fill/i.test(color[1]);
    return {
      name: isFill ? 'fills' : 'strokes',
      valueType: 'COLOR',
      additive: false,
      index: color[2] != null ? parseInt(color[2], 10) : 0,
    };
  }

  const def = FIELD_LOOKUP[raw] || FIELD_LOOKUP[raw.toLowerCase()];
  if (def) return { ...def };

  // raw API enum passthrough (e.g. RECTANGLE_TOP_LEFT_CORNER_RADIUS)
  if (/^[A-Z][A-Z0-9_]*$/.test(raw)) {
    return { name: raw, valueType: 'FLOAT', additive: /^(TRANSLATION|ROTATION|SCALE)/.test(raw) };
  }

  throw new Error(`Unknown motion field "${input}". Try opacity, translateX/Y, scale, rotate, radius, fill.`);
}

// ---------------------------------------------------------------------------
// Easing aliases → Figma easing objects
// ---------------------------------------------------------------------------

const EASING_ALIASES = {
  linear: 'LINEAR',
  'ease-in': 'EASE_IN',
  'ease-out': 'EASE_OUT',
  'ease-in-out': 'EASE_IN_AND_OUT', // never the invalid EASE_IN_OUT
  'ease-in-back': 'EASE_IN_BACK',
  'ease-out-back': 'EASE_OUT_BACK',
  'ease-in-out-back': 'EASE_IN_AND_OUT_BACK',
  gentle: 'GENTLE',
  quick: 'QUICK',
  bouncy: 'BOUNCY',
  slow: 'SLOW',
  hold: 'HOLD',
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * Resolve an easing alias to a Figma easing object. Defaults to EASE_OUT.
 * Supports spring(bounce), cubic(x1,y1,x2,y2), named springs, and raw enums.
 */
export function mapEasing(input) {
  if (input == null || input === '') return { type: 'EASE_OUT' };
  const raw = String(input).trim();

  const spring = raw.match(/^spring(?:\(\s*([-\d.]+)\s*\))?$/i);
  if (spring) {
    const bounce = spring[1] != null ? clamp01(parseFloat(spring[1])) : 0.3;
    return { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce } };
  }

  const cubic = raw.match(/^cubic\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/i);
  if (cubic) {
    return {
      type: 'CUSTOM_CUBIC_BEZIER',
      easingFunctionCubicBezier: { x1: +cubic[1], y1: +cubic[2], x2: +cubic[3], y2: +cubic[4] },
    };
  }

  const named = EASING_ALIASES[raw.toLowerCase()];
  if (named) return { type: named };

  if (/^[A-Z][A-Z0-9_]*$/.test(raw)) return { type: raw }; // raw enum passthrough

  throw new Error(`Unknown easing "${input}". Try ease-out, gentle, quick, spring, linear, hold.`);
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** Convert #rgb / #rrggbb / #rrggbbaa to { r, g, b, a } in 0..1. */
export function hexToRgba(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function toColor(v) {
  if (typeof v === 'string') return hexToRgba(v);
  // assume already {r,g,b,a} in 0..1
  return { r: v.r ?? 0, g: v.g ?? 0, b: v.b ?? 0, a: v.a ?? 1 };
}

function toValue(valueType, v) {
  if (valueType === 'COLOR') return { type: 'COLOR', value: toColor(v) };
  if (valueType === 'VECTOR') {
    // accept a scalar (CLI: applies to both axes) or an {x,y} object (spec)
    if (typeof v === 'number') return { type: 'VECTOR', value: { x: v, y: v } };
    if (typeof v === 'string') { const n = parseFloat(v); return { type: 'VECTOR', value: { x: n, y: n } }; }
    return { type: 'VECTOR', value: { x: v.x ?? 0, y: v.y ?? 0 } };
  }
  return { type: 'FLOAT', value: typeof v === 'string' ? parseFloat(v) : v };
}

// ---------------------------------------------------------------------------
// --keys "t:v[:ease], ..." parser
// ---------------------------------------------------------------------------

/**
 * Parse a "t:v[:ease], t:v[:ease]" string into sorted keyframe objects.
 * valueType is FLOAT (default) or COLOR (v is a hex string).
 */
export function parseKeys(str, valueType = 'FLOAT') {
  const kf = String(str)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const toks = part.split(':').map((t) => t.trim());
      const t = parseFloat(toks[0]);
      const value = toValue(valueType, toks[1]);
      const k = { timelinePosition: t, value };
      if (toks[2]) k.easing = mapEasing(toks[2]);
      return k;
    });
  kf.sort((a, b) => a.timelinePosition - b.timelinePosition);
  return kf;
}

// ---------------------------------------------------------------------------
// Spec normalizer — groups tracks by node into API-ready keyframe tracks
// ---------------------------------------------------------------------------

/**
 * Normalize an animation spec { duration?, tracks:[{node,field,keys:[{t,v,ease}]}] }
 * into { duration, maxT, byNode: { id: { FIELD:{keyframes}, fills:{i:{keyframes}} } } }.
 */
export function normalizeSpec(spec) {
  const tracks = spec?.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('Motion spec has no tracks');
  }

  const byNode = {};
  let maxT = 0;

  for (const tr of tracks) {
    if (!tr.node) throw new Error('Motion spec track is missing "node"');
    const f = mapField(tr.field);
    const keyframes = (tr.keys || [])
      .map((k) => {
        const kf = { timelinePosition: k.t, value: toValue(f.valueType, k.v) };
        if (k.ease) kf.easing = mapEasing(k.ease);
        return kf;
      })
      .sort((a, b) => a.timelinePosition - b.timelinePosition);

    if (keyframes.length === 0) throw new Error(`Track for ${tr.node}/${tr.field} has no keys`);
    maxT = Math.max(maxT, ...keyframes.map((k) => k.timelinePosition));

    byNode[tr.node] = byNode[tr.node] || {};
    if (f.valueType === 'COLOR') {
      const coll = (byNode[tr.node][f.name] = byNode[tr.node][f.name] || {});
      coll[f.index] = { keyframes };
    } else {
      byNode[tr.node][f.name] = { keyframes };
    }
  }

  let duration = spec.duration != null ? spec.duration : maxT;
  if (duration < maxT) duration = maxT; // never below the last keyframe
  return { duration, maxT, byNode };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function twoKey(field, from, to, dur, at, ease) {
  return {
    field,
    keys: [
      { t: at, v: from },
      { t: at + dur, v: to, ease },
    ],
  };
}

// Each preset returns tracks in {field, keys:[{t,v,ease}]} form (pre-normalize).
export const PRESETS = {
  'fade-in': (d, a, e) => [twoKey('opacity', 0, 1, d, a, e)],
  'fade-up': (d, a, e) => [twoKey('opacity', 0, 1, d, a, e), twoKey('translateY', 24, 0, d, a, e)],
  'fade-down': (d, a, e) => [twoKey('opacity', 0, 1, d, a, e), twoKey('translateY', -24, 0, d, a, e)],
  'slide-left': (d, a, e) => [twoKey('opacity', 0, 1, d, a, e), twoKey('translateX', 24, 0, d, a, e)],
  'slide-right': (d, a, e) => [twoKey('opacity', 0, 1, d, a, e), twoKey('translateX', -24, 0, d, a, e)],
  pop: (d, a, e) => [twoKey('opacity', 0, 1, d, a, e), twoKey('scale', 0.8, 1, d, a, e)],
  spin: (d, a, e) => [twoKey('rotate', -360, 0, d, a, e)],
};

/** Build preset tracks for one node. opts: { dur=0.5, at=0, ease='ease-out' }. */
export function presetTracks(name, opts = {}) {
  const builder = PRESETS[name];
  if (!builder) {
    throw new Error(`Unknown preset "${name}". Available: ${Object.keys(PRESETS).join(', ')}`);
  }
  const { dur = 0.5, at = 0, ease = 'ease-out' } = opts;
  return builder(dur, at, ease);
}

// ---------------------------------------------------------------------------
// Stagger — same animation applied across nodes, offset by index * step
// ---------------------------------------------------------------------------

/**
 * Expand a stagger into a full spec. opts is either
 * { preset, dur?, at?, ease? } or { field, from, to, dur?, at?, ease? }.
 */
export function expandStagger(ids, opts, step = 0.1) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('stagger needs at least one node id');
  const base = opts.preset
    ? presetTracks(opts.preset, { dur: opts.dur, at: opts.at || 0, ease: opts.ease })
    : [twoKey(opts.field, opts.from, opts.to, opts.dur ?? 0.5, opts.at || 0, opts.ease || 'ease-out')];

  const tracks = [];
  ids.forEach((node, i) => {
    const offset = i * step;
    for (const tr of base) {
      tracks.push({
        node,
        field: tr.field,
        keys: tr.keys.map((k) => ({ ...k, t: +(k.t + offset).toFixed(4) })),
      });
    }
  });
  return { tracks };
}
