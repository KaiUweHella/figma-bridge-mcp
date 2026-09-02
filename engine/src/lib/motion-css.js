// Motion Projection: native Figma Motion keyframe tracks → CSS animation.
//
// One bounded, dependency-free projection shared by Design Capture (walker
// facts), Code Spec (tree/model output) and, inverted, by the Browser DOM
// Capture translator. It never approximates what CSS cannot express: springs
// and unsupported fields become explicit limitations, never invented curves.
//
// Keyframe easing convention: Figma stores the easing on the keyframe it
// arrives at; CSS `animation-timing-function` inside a keyframe describes the
// segment that leaves it. The projection therefore moves each Figma easing one
// keyframe back. The inverse translation (CSS → Motion) applies the same rule,
// so a round trip is stable.

const TRANSFORM_FIELDS = new Set(['TRANSLATION_X', 'TRANSLATION_Y', 'TRANSLATION_XY', 'SCALE_X', 'SCALE_Y', 'SCALE_XY', 'ROTATION']);
const SCALAR_FIELDS = Object.freeze({
  OPACITY: { property: 'opacity', unit: '' },
  WIDTH: { property: 'width', unit: 'px' },
  HEIGHT: { property: 'height', unit: 'px' },
  CORNER_RADIUS: { property: 'border-radius', unit: 'px' },
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: { property: 'border-top-left-radius', unit: 'px' },
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: { property: 'border-top-right-radius', unit: 'px' },
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: { property: 'border-bottom-right-radius', unit: 'px' },
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: { property: 'border-bottom-left-radius', unit: 'px' },
  STROKE_WEIGHT: { property: 'border-width', unit: 'px' },
  STACK_SPACING: { property: 'gap', unit: 'px' },
  GRID_ROW_GAP: { property: 'row-gap', unit: 'px' },
  GRID_COLUMN_GAP: { property: 'column-gap', unit: 'px' },
  STACK_PADDING_TOP: { property: 'padding-top', unit: 'px' },
  STACK_PADDING_RIGHT: { property: 'padding-right', unit: 'px' },
  STACK_PADDING_BOTTOM: { property: 'padding-bottom', unit: 'px' },
  STACK_PADDING_LEFT: { property: 'padding-left', unit: 'px' },
});
const NAMED_EASING_CSS = Object.freeze({
  LINEAR: 'linear', EASE_IN: 'ease-in', EASE_OUT: 'ease-out', EASE_IN_AND_OUT: 'ease-in-out',
  HOLD: 'steps(1, jump-end)',
});
const NAMED_EASING_BEZIER = Object.freeze({
  LINEAR: [0, 0, 1, 1], EASE_IN: [0.42, 0, 1, 1], EASE_OUT: [0, 0, 0.58, 1], EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
});
const SPRING_TYPES = new Set(['GENTLE', 'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING']);
export const MAX_MOTION_PROJECTION_TRACKS = 64;
export const MAX_MOTION_PROJECTION_KEYFRAMES = 256;

const record = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 3) => {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const num = (value) => String(round(value));

function projectEasing(easing) {
  if (!record(easing)) return null;
  if (easing.type === 'VARIABLE_ALIAS') return { type: 'VARIABLE_ALIAS', id: String(easing.id || '') };
  if (typeof easing.type !== 'string') return null;
  const out = { type: easing.type };
  const bezier = easing.easingFunctionCubicBezier;
  if (record(bezier) && ['x1', 'y1', 'x2', 'y2'].every((key) => finite(bezier[key]))) {
    out.bezier = [bezier.x1, bezier.y1, bezier.x2, bezier.y2].map((value) => round(value, 4));
  }
  const spring = easing.easingFunctionSpring;
  if (record(spring)) {
    out.spring = Object.fromEntries(Object.entries(spring).filter(([, value]) => finite(value)).map(([key, value]) => [key, round(value, 4)]));
  }
  return out;
}

function projectValue(value) {
  if (!record(value) || typeof value.type !== 'string') return null;
  if (value.type === 'FLOAT' && finite(value.value)) return { type: 'FLOAT', value: round(value.value, 4) };
  if (value.type === 'BOOL' && typeof value.value === 'boolean') return { type: 'BOOL', value: value.value };
  if (value.type === 'VECTOR' && record(value.value) && finite(value.value.x) && finite(value.value.y)) {
    return { type: 'VECTOR', value: { x: round(value.value.x, 4), y: round(value.value.y, 4) } };
  }
  if (value.type === 'COLOR' && record(value.value) && ['r', 'g', 'b'].every((key) => finite(value.value[key]))) {
    const { r, g, b } = value.value;
    const a = finite(value.value.a) ? value.value.a : 1;
    return { type: 'COLOR', value: { r: round(r, 4), g: round(g, 4), b: round(b, 4), a: round(a, 4) } };
  }
  if (value.type === 'TEXT_DATA' && typeof value.value === 'string') return { type: 'TEXT_DATA', value: value.value.slice(0, 256) };
  return null;
}

function projectTrack(track) {
  if (!record(track) || !Array.isArray(track.keyframes)) return null;
  const keys = [];
  for (const keyframe of track.keyframes.slice(0, MAX_MOTION_PROJECTION_KEYFRAMES)) {
    if (!record(keyframe) || !finite(keyframe.timelinePosition) || keyframe.timelinePosition < 0) return null;
    const value = projectValue(keyframe.value);
    if (!value) return null;
    const key = { t: round(keyframe.timelinePosition, 4), value };
    const easing = projectEasing(keyframe.easing);
    if (easing) key.easing = easing;
    keys.push(key);
  }
  if (!keys.length) return null;
  keys.sort((a, b) => a.t - b.t);
  const out = { keys };
  const base = projectValue(track.baseValue);
  if (base) out.base = base;
  return out;
}

/**
 * Project native `manualKeyframeTracks` (+ optional timelines) into the
 * bounded Motion Capture fact carried by Design Capture. Unsupported track
 * shapes are dropped with their field name recorded, never silently.
 */
export function projectMotion(nativeTracks, timelines = []) {
  if (!record(nativeTracks)) return null;
  const tracks = [];
  const unsupported = [];
  const push = (field, track, extra = {}) => {
    if (tracks.length >= MAX_MOTION_PROJECTION_TRACKS) { unsupported.push(field); return; }
    const projected = projectTrack(track);
    if (projected) tracks.push({ field, ...extra, ...projected });
    else unsupported.push(field);
  };
  for (const [field, value] of Object.entries(nativeTracks)) {
    if (field === 'fills' || field === 'strokes' || field === 'effects') {
      if (!record(value)) { unsupported.push(field); continue; }
      for (const [index, track] of Object.entries(value)) {
        if (field === 'effects') { unsupported.push(`effects[${index}]`); continue; }
        push(`${field}[${index}]`, track, { collection: field, index: Number(index) });
      }
      continue;
    }
    push(field, value);
  }
  if (!tracks.length && !unsupported.length) return null;
  const out = { tracks };
  const timeline = Array.isArray(timelines) ? timelines.find((entry) => record(entry) && finite(entry.duration)) : null;
  if (timeline) out.timeline = { id: String(timeline.id || ''), duration: round(timeline.duration, 4) };
  if (unsupported.length) out.unsupported = unsupported;
  return out;
}

function bezierAt(x, [x1, y1, x2, y2]) {
  const sample = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  let lo = 0; let hi = 1;
  for (let step = 0; step < 40; step++) {
    const mid = (lo + hi) / 2;
    if (sample(mid, x1, x2) < x) lo = mid; else hi = mid;
  }
  return sample((lo + hi) / 2, y1, y2);
}

function easingCurve(easing) {
  if (!easing) return { bezier: [0.5, 0, 0.5, 1], css: null, limitation: null };
  if (easing.type === 'VARIABLE_ALIAS') return { bezier: [0.5, 0, 0.5, 1], css: null, limitation: 'easing bound to a Figma Variable; resolve the EASING Variable value' };
  if (SPRING_TYPES.has(easing.type)) {
    return { bezier: [0.5, 0, 0.5, 1], css: 'linear', limitation: `Figma spring easing ${easing.type} has no CSS equivalent; linear emitted` };
  }
  if (easing.type === 'HOLD') return { bezier: null, css: NAMED_EASING_CSS.HOLD, limitation: null };
  if (easing.bezier) {
    const css = NAMED_EASING_CSS[easing.type] || `cubic-bezier(${easing.bezier.map(num).join(', ')})`;
    return { bezier: easing.bezier, css, limitation: null };
  }
  if (NAMED_EASING_BEZIER[easing.type]) return { bezier: NAMED_EASING_BEZIER[easing.type], css: NAMED_EASING_CSS[easing.type], limitation: null };
  return { bezier: [0.5, 0, 0.5, 1], css: null, limitation: `Figma easing ${easing.type} has no CSS equivalent; default curve emitted` };
}

function scalarOf(value, field) {
  if (!value) return null;
  if (value.type === 'FLOAT' || value.type === 'BOOL') return Number(value.value);
  if (value.type === 'VECTOR') return field?.endsWith('_Y') ? value.value.y : value.value.x;
  return null;
}

function valueAt(track, time) {
  const keys = track.keys;
  if (time <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.t) return last.value;
  let index = 1;
  while (keys[index].t < time) index++;
  const from = keys[index - 1]; const to = keys[index];
  const span = to.t - from.t;
  const progress = span > 0 ? (time - from.t) / span : 1;
  const curve = easingCurve(to.easing);
  const eased = curve.bezier ? bezierAt(progress, curve.bezier) : (progress >= 1 ? 1 : 0);
  const mix = (a, b) => a + (b - a) * eased;
  if (from.value.type === 'VECTOR' && to.value.type === 'VECTOR') {
    return { type: 'VECTOR', value: { x: mix(from.value.value.x, to.value.value.x), y: mix(from.value.value.y, to.value.value.y) } };
  }
  if (from.value.type === 'COLOR' && to.value.type === 'COLOR') {
    return { type: 'COLOR', value: Object.fromEntries(['r', 'g', 'b', 'a'].map((key) => [key, mix(from.value.value[key], to.value.value[key])])) };
  }
  if (from.value.type === 'FLOAT' && to.value.type === 'FLOAT') return { type: 'FLOAT', value: mix(from.value.value, to.value.value) };
  return progress >= 1 ? to.value : from.value;
}

function rgba(color) {
  const channel = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255);
  const alpha = round(Math.max(0, Math.min(1, color.a ?? 1)), 3);
  return alpha < 1
    ? `rgb(${channel(color.r)} ${channel(color.g)} ${channel(color.b)} / ${num(alpha)})`
    : `rgb(${channel(color.r)} ${channel(color.g)} ${channel(color.b)})`;
}

/**
 * Project one Motion Capture fact into CSS: a `@keyframes` block, the
 * `animation` declaration and every limitation that kept a fact out of CSS.
 * `name` must already be a valid CSS identifier.
 */
export function motionToCss(motion, { name = 'figma-motion' } = {}) {
  if (!record(motion) || !Array.isArray(motion.tracks) || !motion.tracks.length) return null;
  const tracks = motion.tracks.filter((track) => Array.isArray(track.keys) && track.keys.length);
  const lastKey = Math.max(...tracks.map((track) => track.keys[track.keys.length - 1].t));
  const duration = motion.timeline?.duration > 0 ? motion.timeline.duration : lastKey;
  const limitations = [];
  const seenLimitations = new Set();
  const limit = (text) => { if (text && !seenLimitations.has(text)) { seenLimitations.add(text); limitations.push(text); } };
  if (!(duration > 0)) return null;
  if (!motion.timeline) limit('no Figma timeline duration was captured; the last keyframe time is used');

  const transformTracks = tracks.filter((track) => TRANSFORM_FIELDS.has(track.field));
  const propertyTracks = [];
  for (const track of tracks) {
    if (TRANSFORM_FIELDS.has(track.field)) continue;
    if (SCALAR_FIELDS[track.field]) propertyTracks.push({ ...track, property: SCALAR_FIELDS[track.field].property, unit: SCALAR_FIELDS[track.field].unit });
    else if (track.collection === 'fills' && track.index === 0) propertyTracks.push({ ...track, property: 'background-color', color: true });
    else if (track.collection === 'strokes' && track.index === 0) propertyTracks.push({ ...track, property: 'border-color', color: true });
    else limit(`Figma track ${track.field} has no CSS equivalent; keep it in Figma`);
  }
  for (const field of motion.unsupported || []) limit(`Figma track ${field} could not be projected`);

  const times = [...new Set([...transformTracks, ...propertyTracks].flatMap((track) => track.keys.map((key) => key.t)))].sort((a, b) => a - b);
  const percent = (time) => `${num(round((time / duration) * 100, 2))}%`;
  const keyframeLines = [];
  for (let index = 0; index < times.length; index++) {
    const time = times[index];
    const declarations = [];
    if (transformTracks.length && transformTracks.some((track) => track.keys.some((key) => key.t === time))) {
      // Every transform component must be present in a transform keyframe,
      // otherwise the browser would snap the missing component to identity.
      const at = (field) => transformTracks.filter((track) => track.field === field).map((track) => valueAt(track, time))[0] || null;
      const tx = scalarOf(at('TRANSLATION_X'), 'TRANSLATION_X') ?? (at('TRANSLATION_XY') ? at('TRANSLATION_XY').value.x : 0);
      const ty = scalarOf(at('TRANSLATION_Y'), 'TRANSLATION_Y') ?? (at('TRANSLATION_XY') ? at('TRANSLATION_XY').value.y : 0);
      const sxy = at('SCALE_XY');
      const sx = scalarOf(at('SCALE_X'), 'SCALE_X') ?? (sxy ? sxy.value.x : 1);
      const sy = scalarOf(at('SCALE_Y'), 'SCALE_Y') ?? (sxy ? sxy.value.y : 1);
      const rotation = scalarOf(at('ROTATION'), 'ROTATION') ?? 0;
      const parts = [];
      if (tx !== 0 || ty !== 0) parts.push(`translate(${num(tx)}px, ${num(ty)}px)`);
      if (rotation !== 0) parts.push(`rotate(${num(rotation)}deg)`);
      if (sx !== 1 || sy !== 1) parts.push(sx === sy ? `scale(${num(sx)})` : `scale(${num(sx)}, ${num(sy)})`);
      declarations.push(`transform: ${parts.length ? parts.join(' ') : 'none'};`);
    }
    for (const track of propertyTracks) {
      const key = track.keys.find((entry) => entry.t === time);
      if (!key) continue;
      if (track.color) {
        if (key.value.type !== 'COLOR') continue;
        declarations.push(`${track.property}: ${rgba(key.value.value)};`);
      } else {
        const scalar = scalarOf(key.value, track.field);
        if (scalar === null) continue;
        declarations.push(`${track.property}: ${num(scalar)}${track.unit};`);
      }
    }
    // The timing function that leaves this keyframe is the easing Figma stores
    // on the next keyframe (of any track that has one there).
    const nextTime = times[index + 1];
    if (nextTime !== undefined) {
      const arriving = [...transformTracks, ...propertyTracks]
        .map((track) => track.keys.find((entry) => entry.t === nextTime)?.easing)
        .filter(Boolean);
      const curves = arriving.map(easingCurve);
      for (const curve of curves) limit(curve.limitation);
      const curve = curves[0] || null;
      if (curve?.css && curve.css !== 'linear') declarations.push(`animation-timing-function: ${curve.css};`);
      const distinct = new Set(arriving.map((easing) => JSON.stringify(easing)));
      if (distinct.size > 1) limit(`keyframe at ${num(nextTime)}s mixes ${distinct.size} easings across tracks; CSS applies one timing function per keyframe`);
    }
    if (declarations.length) keyframeLines.push(`  ${percent(time)} { ${declarations.join(' ')} }`);
  }
  if (!keyframeLines.length) return null;
  const keyframes = `@keyframes ${name} {\n${keyframeLines.join('\n')}\n}`;
  const animation = `animation: ${name} ${num(duration)}s linear 1 normal both;`;
  limit('Figma timelines play once; add iteration-count/direction in CSS only where the product owns a loop');
  limit('honour prefers-reduced-motion: reduce (animation: none)');
  return { name, duration: round(duration, 4), keyframes, animation, limitations };
}

/** A CSS identifier derived from a Figma node id (`362:1948` → `motion-362-1948`). */
export function motionCssName(nodeId, prefix = 'motion') {
  const safe = String(nodeId || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${safe || 'node'}`;
}

// ---------------------------------------------------------------------------
// Inverse projection: browser CSS animation facts → Figma Motion tracks.
// ---------------------------------------------------------------------------

const CSS_NAMED_EASING = Object.freeze({
  linear: { type: 'LINEAR' },
  ease: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } },
  'ease-in': { type: 'EASE_IN' },
  'ease-out': { type: 'EASE_OUT' },
  'ease-in-out': { type: 'EASE_IN_AND_OUT' },
  'step-start': { type: 'HOLD' },
  'step-end': { type: 'HOLD' },
});
export const MAX_MOTION_TRACK_FIELDS = 64;
const EPSILON = 1e-6;

function cssSeconds(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(-?[\d.]+)(ms|s)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] === 'ms' ? amount / 1000 : amount;
}

function cssTimingToEasing(value) {
  const text = String(value ?? '').trim();
  if (!text) return { easing: null, limitation: null };
  if (CSS_NAMED_EASING[text]) return { easing: CSS_NAMED_EASING[text], limitation: null };
  const cubic = text.match(/^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/);
  if (cubic) {
    return { easing: { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: +cubic[1], y1: +cubic[2], x2: +cubic[3], y2: +cubic[4] } }, limitation: null };
  }
  if (/^steps\(/.test(text)) return { easing: { type: 'HOLD' }, limitation: null };
  return { easing: { type: 'LINEAR' }, limitation: `CSS timing function ${text} has no Figma easing; linear used` };
}

function splitTopLevel(value) {
  const out = [];
  let depth = 0; let buffer = '';
  for (const character of String(value ?? '')) {
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === ',' && depth === 0) { out.push(buffer.trim()); buffer = ''; continue; }
    buffer += character;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

function cssLength(value) {
  const text = String(value ?? '').trim();
  if (text === '0') return 0;
  const match = text.match(/^(-?[\d.]+)px$/);
  return match ? Number(match[1]) : null;
}

function cssAngle(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(-?[\d.]+)(deg|rad|turn|grad)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] || 'deg';
  if (unit === 'rad') return amount * 180 / Math.PI;
  if (unit === 'turn') return amount * 360;
  if (unit === 'grad') return amount * 0.9;
  return amount;
}

function cssColorValue(value) {
  const text = String(value ?? '').trim().toLowerCase();
  let match = text.match(/^#([0-9a-f]{3,8})$/);
  if (match) {
    let hex = match[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const channel = (index) => parseInt(hex.slice(index, index + 2), 16) / 255;
    return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) : 1 };
  }
  match = text.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
  if (!match) return null;
  const alpha = match[4] == null ? 1 : match[4].endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
  return { r: Number(match[1]) / 255, g: Number(match[2]) / 255, b: Number(match[3]) / 255, a: alpha };
}

/** Parse a CSS transform list into Figma-relative components (px, factor, deg). */
export function parseCssTransform(value) {
  const text = String(value ?? '').trim();
  const out = { x: 0, y: 0, sx: 1, sy: 1, rotation: 0, limitations: [] };
  if (!text || text === 'none') return out;
  const functions = text.match(/[a-zA-Z0-9]+\([^)]*\)/g) || [];
  for (const fn of functions) {
    const name = fn.slice(0, fn.indexOf('(')).toLowerCase();
    const args = fn.slice(fn.indexOf('(') + 1, -1).split(',').map((part) => part.trim());
    const px = args.map(cssLength);
    if (name === 'translate' || name === 'translate3d') {
      if (px[0] === null || (args[1] && px[1] === null)) { out.limitations.push(`${fn} uses a unit Figma Motion cannot express (px only)`); continue; }
      out.x += px[0]; out.y += px[1] ?? 0;
    } else if (name === 'translatex' || name === 'translatey') {
      if (px[0] === null) { out.limitations.push(`${fn} uses a unit Figma Motion cannot express (px only)`); continue; }
      if (name === 'translatex') out.x += px[0]; else out.y += px[0];
    } else if (name === 'scale' || name === 'scale3d') {
      const sx = Number(args[0]); const sy = args[1] === undefined ? sx : Number(args[1]);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) { out.limitations.push(`${fn} is not numeric`); continue; }
      out.sx *= sx; out.sy *= sy;
    } else if (name === 'scalex' || name === 'scaley') {
      const factor = Number(args[0]);
      if (!Number.isFinite(factor)) { out.limitations.push(`${fn} is not numeric`); continue; }
      if (name === 'scalex') out.sx *= factor; else out.sy *= factor;
    } else if (name === 'rotate' || name === 'rotatez') {
      const degrees = cssAngle(args[0]);
      if (degrees === null) { out.limitations.push(`${fn} is not an angle`); continue; }
      out.rotation += degrees;
    } else {
      out.limitations.push(`transform ${fn} has no Figma Motion equivalent`);
    }
  }
  return out;
}

function keyframeOffsets(selectorText) {
  return splitTopLevel(selectorText).map((selector) => {
    const text = selector.trim().toLowerCase();
    if (text === 'from') return 0;
    if (text === 'to') return 1;
    const match = text.match(/^([\d.]+)%$/);
    return match ? Number(match[1]) / 100 : null;
  }).filter((offset) => offset !== null && offset >= 0 && offset <= 1);
}

/** Rotate one cycle of keys so that `phase` seconds become t=0 (negative CSS delay). */
function rotateCycle(keys, phase, cycle) {
  if (!(phase > 0) || !keys.length) return keys;
  const projected = projectTrack({ keyframes: keys })?.keys || [];
  const boundary = valueAt({ keys: projected }, phase);
  const arriving = keys.find((key) => key.timelinePosition > phase) || keys[keys.length - 1];
  // The cycle-end key is the same state as the cycle start in a loop; keep the
  // easing that arrives at the end on the start key before rotating.
  const endKey = keys.find((key) => key.timelinePosition === cycle);
  const rotated = keys
    .filter((key) => key.timelinePosition !== cycle)
    .map((key) => (key.timelinePosition === 0 && endKey?.easing && !key.easing ? { ...key, easing: endKey.easing } : key))
    .map((key) => ({ ...key, timelinePosition: round(((key.timelinePosition - phase) % cycle + cycle) % cycle, 4) }))
    .filter((key) => key.timelinePosition > 0 && key.timelinePosition < cycle);
  const restore = (value) => (value.type === 'VECTOR'
    ? { type: 'VECTOR', value: { x: round(value.value.x, 4), y: round(value.value.y, 4) } }
    : value.type === 'COLOR' ? { type: 'COLOR', value: Object.fromEntries(Object.entries(value.value).map(([k, v]) => [k, round(v, 4)])) }
      : { type: value.type, value: typeof value.value === 'number' ? round(value.value, 4) : value.value });
  const first = { timelinePosition: 0, value: restore(boundary) };
  const last = { timelinePosition: cycle, value: restore(boundary) };
  if (arriving?.easing) last.easing = arriving.easing;
  const merged = [first, ...rotated, last].sort((a, b) => a.timelinePosition - b.timelinePosition);
  return merged.filter((key, index) => index === 0 || key.timelinePosition !== merged[index - 1].timelinePosition);
}

/** Value of a CSS-derived keyframe list at `time`, on the arrival easing. */
function cycleValueAt(keys, time) {
  if (time <= keys[0].timelinePosition) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.timelinePosition) return last.value;
  let index = 1;
  while (keys[index].timelinePosition < time) index++;
  const from = keys[index - 1];
  const to = keys[index];
  const span = to.timelinePosition - from.timelinePosition;
  const progress = span > 0 ? (time - from.timelinePosition) / span : 1;
  const curve = easingCurve(projectEasing(to.easing));
  const eased = curve.bezier ? bezierAt(progress, curve.bezier) : (progress >= 1 ? 1 : 0);
  const mix = (a, b) => round(a + (b - a) * eased, 4);
  if (from.value.type === 'VECTOR' && to.value.type === 'VECTOR') {
    return { type: 'VECTOR', value: { x: mix(from.value.value.x, to.value.value.x), y: mix(from.value.value.y, to.value.value.y) } };
  }
  if (from.value.type === 'COLOR' && to.value.type === 'COLOR') {
    return { type: 'COLOR', value: Object.fromEntries(['r', 'g', 'b', 'a'].map((key) => [key, mix(from.value.value[key] ?? 1, to.value.value[key] ?? 1)])) };
  }
  if (from.value.type === 'FLOAT' && to.value.type === 'FLOAT') return { type: 'FLOAT', value: mix(from.value.value, to.value.value) };
  return progress >= 1 ? to.value : from.value;
}

function repeatCycleKeyframes(keyframes, cycle, target) {
  const base = keyframes.slice().sort((a, b) => a.timelinePosition - b.timelinePosition);
  const out = [];
  const push = (keyframe) => {
    const t = round(keyframe.timelinePosition, 4);
    if (out.some((existing) => existing.timelinePosition === t)) return;
    if (out.length >= MAX_MOTION_PROJECTION_KEYFRAMES) return;
    out.push({ ...keyframe, timelinePosition: t });
  };
  for (let repeat = 0; repeat * cycle < target - EPSILON; repeat++) {
    const shift = repeat * cycle;
    for (const keyframe of base) {
      const time = keyframe.timelinePosition + shift;
      if (time > target + EPSILON) break;
      push({ ...keyframe, timelinePosition: time });
    }
  }
  const last = out[out.length - 1];
  if (last && last.timelinePosition < target - EPSILON) {
    // The timeline cuts mid-cycle: land on the value the browser would show,
    // interpolated on the same curve rather than snapping to a keyframe.
    const phase = ((target % cycle) + cycle) % cycle;
    push({ timelinePosition: target, value: cycleValueAt(base, phase), ...(base[0].easing ? { easing: base[0].easing } : {}) });
  }
  return out.sort((a, b) => a.timelinePosition - b.timelinePosition);
}

/**
 * Repeat one endless CSS period until it fills the frame's shared Figma
 * timeline. A Figma timeline plays once, so a 3.8s loop written into a 10s
 * timeline would hold still for the remaining 6.2s while a 10s sibling keeps
 * moving — the browser shows both looping. Motion without a repeatable
 * `loop` cycle, and a timeline no longer than one cycle, are returned as is.
 */
export function repeatMotionToTimeline(motion, timelineDuration) {
  if (!record(motion) || !Array.isArray(motion.tracks) || !motion.tracks.length) return motion;
  const cycle = motion.loop?.cycle;
  const target = Number(timelineDuration);
  if (!finite(cycle) || cycle <= 0) return motion;
  if (!finite(target) || target <= cycle + EPSILON) return motion;
  const tracks = motion.tracks.map((track) => ({
    ...track,
    binding: { ...track.binding, keyframes: repeatCycleKeyframes(track.binding.keyframes, cycle, target) },
  }));
  return { ...motion, duration: round(target, 4), tracks };
}

/**
 * Translate the CSS animations of one captured element into Figma Motion
 * tracks. `animations` are the element's computed animation facts, `keyframes`
 * maps every `@keyframes` name to its rules `{ selectorText, style }`, and
 * `base` carries the element's resting computed values (the browser
 * synthesizes missing 0%/100% keyframes from them).
 *
 * Loops: Figma timelines play once, so an infinite or repeated animation is
 * written as one period (two for `alternate`). Negative delays rotate that
 * period so t=0 shows what the browser shows at load; positive delays shift
 * the keys later.
 */
export function cssAnimationToMotion(animations, keyframes = {}, base = {}) {
  const list = Array.isArray(animations) ? animations : [];
  const limitations = [];
  const seenLimitations = new Set();
  const limit = (text) => { if (text && !seenLimitations.has(text)) { seenLimitations.add(text); limitations.push(text); } };
  const fields = new Map();
  const loops = [];
  let duration = 0;
  const ANIMATABLE = ['transform', 'opacity', 'backgroundColor', 'borderRadius', 'width', 'height'];
  const REST = { transform: 'none', opacity: '1' };

  for (const animation of list) {
    if (!record(animation) || typeof animation.name !== 'string' || !animation.name || animation.name === 'none') continue;
    const rules = keyframes?.[animation.name];
    if (!Array.isArray(rules) || !rules.length) { limit(`@keyframes ${animation.name} was not captured`); continue; }
    const period = cssSeconds(animation.duration) ?? 0;
    if (!(period > 0)) { limit(`animation ${animation.name} has no positive duration`); continue; }
    const delay = cssSeconds(animation.delay) ?? 0;
    const direction = String(animation.direction || 'normal');
    const iterations = String(animation.iterationCount || '1');
    const alternate = direction.startsWith('alternate');
    const reversed = direction === 'reverse' || direction === 'alternate-reverse';
    if (iterations !== '1') limit(`animation ${animation.name} repeats (${iterations}); Figma receives one ${alternate ? 'alternate ' : ''}period`);
    const timingDefault = cssTimingToEasing(animation.timingFunction || 'ease');
    limit(timingDefault.limitation);

    // Samples: every keyframe rule expanded per selector, then the implicit
    // 0% / 100% keyframes the browser synthesizes from the resting values.
    const samples = [];
    const animated = new Set();
    for (const rule of rules) {
      const style = record(rule.style) ? rule.style : {};
      const corners = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'];
      if (style.borderRadius === undefined && corners.every((corner) => style[corner] !== undefined)) {
        const values = corners.map((corner) => style[corner]);
        if (values.every((value) => value === values[0])) style.borderRadius = values[0];
        else limit(`@keyframes ${animation.name} animates per-corner radii, which Figma Motion cannot express`);
      }
      for (const property of Object.keys(style)) {
        if (property === 'animationTimingFunction' || corners.includes(property)) continue;
        if (ANIMATABLE.includes(property)) animated.add(property);
        else limit(`@keyframes ${animation.name} animates ${property}, which Figma Motion cannot express`);
      }
      for (const offset of keyframeOffsets(rule.selectorText ?? rule.keyText ?? '')) {
        const timing = style.animationTimingFunction ? cssTimingToEasing(style.animationTimingFunction) : timingDefault;
        limit(timing.limitation);
        samples.push({ offset, style, easing: timing.easing });
      }
    }
    if (!samples.length || !animated.size) { limit(`@keyframes ${animation.name} defines no usable keyframes`); continue; }
    const restStyle = Object.fromEntries([...animated].map((property) => [property, base?.[property] ?? REST[property] ?? '']));
    for (const offset of [0, 1]) {
      if (!samples.some((sample) => sample.offset === offset)) samples.push({ offset, style: restStyle, easing: timingDefault.easing, synthetic: true });
    }
    samples.sort((a, b) => a.offset - b.offset);
    for (const sample of samples) for (const text of parseCssTransform(sample.style.transform).limitations) limit(text);

    let ordered = reversed
      ? samples.map((sample) => ({ ...sample, offset: 1 - sample.offset })).sort((a, b) => a.offset - b.offset)
      : samples;
    let cycle = period;
    if (alternate) {
      const mirrored = ordered.filter((sample) => sample.offset < 1).map((sample) => ({ ...sample, offset: 2 - sample.offset }));
      ordered = [...ordered, ...mirrored].sort((a, b) => a.offset - b.offset);
      cycle = period * 2;
    }

    // Per-field keys over one cycle. Easing convention (see motionToCss): the
    // CSS timing that leaves a keyframe is the Figma easing of the keyframe it
    // arrives at.
    const perField = new Map();
    const put = (identity, field, time, value, easing) => {
      if (!perField.has(identity)) perField.set(identity, { field, keys: [] });
      const keys = perField.get(identity).keys;
      const t = round(time, 4);
      if (keys.some((key) => key.timelinePosition === t)) return;
      const keyframe = { timelinePosition: t, value };
      if (easing) keyframe.easing = easing;
      keys.push(keyframe);
    };
    for (let index = 0; index < ordered.length; index++) {
      const sample = ordered[index];
      const time = sample.offset * period;
      const easing = index > 0 ? ordered[index - 1].easing : null;
      const style = sample.style;
      if (typeof style.transform === 'string' && style.transform.trim() !== '') {
        const transform = parseCssTransform(style.transform);
        put('TRANSLATION_X', { type: 'PROPERTY', name: 'TRANSLATION_X' }, time, { type: 'FLOAT', value: round(transform.x, 4) }, easing);
        put('TRANSLATION_Y', { type: 'PROPERTY', name: 'TRANSLATION_Y' }, time, { type: 'FLOAT', value: round(transform.y, 4) }, easing);
        put('SCALE_XY', { type: 'PROPERTY', name: 'SCALE_XY' }, time, { type: 'VECTOR', value: { x: round(transform.sx, 4), y: round(transform.sy, 4) } }, easing);
        put('ROTATION', { type: 'PROPERTY', name: 'ROTATION' }, time, { type: 'FLOAT', value: round(transform.rotation, 4) }, easing);
      }
      if (style.opacity !== undefined && style.opacity !== '') {
        const opacity = Number(style.opacity);
        if (Number.isFinite(opacity)) put('OPACITY', { type: 'PROPERTY', name: 'OPACITY' }, time, { type: 'FLOAT', value: round(Math.max(0, Math.min(1, opacity)), 4) }, easing);
      }
      if (style.backgroundColor) {
        const color = cssColorValue(style.backgroundColor);
        if (color) put('fills:0', { type: 'INDEXED_ITEM', collection: 'fills', index: 0 }, time, { type: 'COLOR', value: Object.fromEntries(Object.entries(color).map(([k, v]) => [k, round(v, 4)])) }, easing);
        else limit(`background-color ${style.backgroundColor} in @keyframes ${animation.name} is not a plain colour`);
      }
      for (const [property, fieldName] of [['borderRadius', 'CORNER_RADIUS'], ['width', 'WIDTH'], ['height', 'HEIGHT']]) {
        if (style[property] === undefined || style[property] === '') continue;
        const length = cssLength(style[property]);
        if (length === null) limit(`${property} ${style[property]} in @keyframes ${animation.name} is not a px length`);
        else put(fieldName, { type: 'PROPERTY', name: fieldName }, time, { type: 'FLOAT', value: round(length, 4) }, easing);
      }
    }

    const phase = delay < 0 && iterations !== '1' ? ((-delay % cycle) + cycle) % cycle : 0;
    if (phase > 0) limit(`animation ${animation.name}: negative delay ${delay}s is written as a ${round(phase, 3)}s phase shift; the split segment keeps its easing on both halves`);
    if (delay > 0) limit(`animation ${animation.name}: ${delay}s delay holds the layer's resting values before the first keyframe`);
    let contributed = false;
    for (const [identity, track] of perField) {
      let keys = track.keys.sort((a, b) => a.timelinePosition - b.timelinePosition);
      if (phase > 0) keys = rotateCycle(keys, phase, cycle);
      if (delay > 0) keys = keys.map((key) => ({ ...key, timelinePosition: round(key.timelinePosition + delay, 4) }));
      if (fields.has(identity)) { limit(`field ${identity} is animated by more than one CSS animation; only ${fields.get(identity).source} was kept`); continue; }
      if (fields.size >= MAX_MOTION_TRACK_FIELDS) { limit(`more than ${MAX_MOTION_TRACK_FIELDS} animated fields; ${identity} dropped`); continue; }
      fields.set(identity, { field: track.field, keys, source: animation.name });
      duration = Math.max(duration, keys[keys.length - 1].timelinePosition);
      contributed = true;
    }
    // A positive delay happens once, so such a period must not be repeated to
    // fill a longer shared timeline; only an endless, undelayed loop may be.
    if (contributed) loops.push({ cycle: round(cycle, 4), repeatable: iterations === 'infinite' && delay <= 0 });
  }

  // Drop transform components that never leave their resting value: an
  // all-zero translation or all-one scale track would only clutter Figma.
  const tracks = [];
  for (const track of fields.values()) {
    const keys = track.keys;
    if (keys.length < 2) continue;
    const name = track.field.type === 'PROPERTY' ? track.field.name : null;
    const idle = name === 'TRANSLATION_X' || name === 'TRANSLATION_Y' || name === 'ROTATION'
      ? keys.every((key) => key.value.value === 0)
      : name === 'SCALE_XY' ? keys.every((key) => key.value.value.x === 1 && key.value.value.y === 1) : false;
    if (idle) continue;
    tracks.push({ field: track.field, binding: { keyframes: keys } });
  }
  if (!tracks.length) return null;
  // One shared cycle across every contributing animation is what makes the
  // period safely repeatable; mixed cycles would drift against each other.
  const repeatable = loops.length > 0 && loops.every((entry) => entry.repeatable && entry.cycle === loops[0].cycle);
  return {
    duration: round(duration, 4),
    tracks,
    limitations,
    ...(repeatable ? { loop: { cycle: loops[0].cycle } } : {}),
  };
}
