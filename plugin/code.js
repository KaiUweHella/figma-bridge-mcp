/**
 * Figma Bridge (Safe/Hardened) Plugin
 *
 * Safe Mode: connects to the local figma-bridge-mcp daemon over WebSocket.
 * No debug port, no app patching. The connection is authenticated with an
 * access key the user pastes in once; it is persisted in figma.clientStorage
 * (only reachable from this main thread, not the UI iframe) and handed to the
 * UI on request.
 */

const KEY_STORAGE = 'daemonKey';
// Minimal durable identity shared with figma-bridge.json. Repository paths
// deliberately stay outside the Figma document; the plugin stores only the
// stable Design Entity handle needed to resolve them server-side.
const DESIGN_ENTITY_STORAGE = 'figma-bridge-design-entity';

// Monotonic document revision for freshness-safe Design Captures. A plugin
// restart resets this counter, but the daemon assigns every authenticated
// socket a new connectionId, so revision 0 can never revive an older Capture.
// If this editor does not expose documentchange, null disables caching.
let documentRevision = 0;
let documentRevisionAvailable = true;
try {
  figma.on('documentchange', () => {
    if (documentRevision < Number.MAX_SAFE_INTEGER) documentRevision++;
    else documentRevisionAvailable = false;
  });
} catch (e) {
  documentRevisionAvailable = false;
}

function revisionMetadata(before) {
  return {
    documentRevisionBefore: before,
    documentRevisionAfter: documentRevisionAvailable ? documentRevision : null,
  };
}

// Visible UI: connection status, access-key entry, activity log, pause switch,
// selection push, save version. The UI may grow itself via the `resize` message.
figma.showUI(__html__, { width: 360, height: 220 });

// Execute code with auto-return and timeout protection.
//
// REPL pattern: first try the code as a single EXPRESSION — `return (code)`.
// If that throws a SyntaxError, the throw happens at PARSE time, before any
// execution, so falling back to running the code as plain statements never
// double-executes anything. The previous string heuristics (split at the last
// `;`, "no semicolon = expression") corrupted legal code: a trailing
// `for (…) { … }` block, or multi-statement code without semicolons, became a
// SyntaxError. Statement code now returns undefined unless it ends with an
// explicit `return` — which is what every engine call site already does.
// 22s, deliberately BELOW the daemon's 25s eval timeout: with both at 25s the
// daemon always fired first and the plugin's more precise error message
// (naming the actual slow API call) never reached anyone. Note the timeout
// only rejects the promise — the sandboxed eval itself keeps running.
async function executeCode(code, timeoutMs = 22000) {
  const trimmed = code.trim();

  let execPromise;
  try {
    // eval() (not new Function — Figma's QuickJS blocks that) runs in the
    // plugin's main scope where `figma` is already global.
    execPromise = eval(`(async () => { return (${trimmed}\n) })()`);
  } catch (e) {
    if (e instanceof SyntaxError) {
      execPromise = eval(`(async () => { ${trimmed} })()`);
    } else {
      throw e;
    }
  }

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Execution timeout (${timeoutMs / 1000}s)`)), timeoutMs)
  );

  return Promise.race([execPromise, timeoutPromise]);
}

// BEGIN STRUCTURED RENDER RUNTIME
function structuredNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function structuredVariableSpec(value) {
  if (typeof value !== 'string' || !value.startsWith('var:')) return null;
  const source = value.slice(4);
  const separator = source.indexOf('|');
  const requested = (separator < 0 ? source : source.slice(0, separator)).trim();
  const fallback = separator < 0 ? null : source.slice(separator + 1).trim() || null;
  if (!requested) return { error: 'variable name is empty' };
  const colon = requested.indexOf(':');
  return {
    requested,
    name: colon > 0 ? requested.slice(colon + 1) : requested,
    collection: colon > 0 ? requested.slice(0, colon) : null,
    fallback,
  };
}

function structuredColorSupported(value) {
  const variable = structuredVariableSpec(value);
  if (variable) return !variable.error && (variable.fallback == null || (variable.fallback !== 'none' && structuredColorSupported(variable.fallback)));
  return value == null || value === 'none'
    || /^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(String(value));
}

function structuredGradientTransformFromCssAngle(degrees, width = 1, height = 1) {
  const radians = Number(degrees) * Math.PI / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const x = sin * Math.max(structuredNumber(width, 1), 0.0001);
  const y = -cos * Math.max(structuredNumber(height, 1), 0.0001);
  const length = Math.hypot(x, y) || 1;
  const axisX = x / length;
  const axisY = y / length;
  return [
    [axisX, axisY, 0.5 - 0.5 * (axisX + axisY)],
    [-axisY, axisX, 0.5 - 0.5 * (-axisY + axisX)],
  ];
}

function structuredGradientColor(input, previous = null) {
  const source = String(input || '').trim();
  if (source.toLowerCase() === 'transparent') {
    return { ...(previous || { r: 0, g: 0, b: 0 }), a: 0 };
  }
  const hex = source.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let value = hex[1];
    if (value.length === 3) value = value.split('').map((part) => part + part).join('');
    return {
      r: parseInt(value.slice(0, 2), 16) / 255,
      g: parseInt(value.slice(2, 4), 16) / 255,
      b: parseInt(value.slice(4, 6), 16) / 255,
      a: value.length === 8 ? parseInt(value.slice(6), 16) / 255 : 1,
    };
  }
  const rgb = source.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/\s*,\s*/).map(Number);
    if ((parts.length === 3 || parts.length === 4)
      && parts.slice(0, 3).every((part) => Number.isFinite(part) && part >= 0 && part <= 255)
      && (parts.length === 3 || (Number.isFinite(parts[3]) && parts[3] >= 0 && parts[3] <= 1))) {
      return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: parts[3] ?? 1 };
    }
  }
  return null;
}

function structuredGradientPaint(input, dimensions = null) {
  const match = String(input || '').trim().match(/^(linear|radial|angular|diamond)-gradient\s*\(([\s\S]*)\)\s*$/i);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const parts = [];
  let depth = 0, buffer = '';
  for (const character of match[2]) {
    if (character === '(') depth++;
    else if (character === ')') depth--;
    if (depth < 0) throw new Error('gradient has unbalanced parentheses');
    if (character === ',' && depth === 0) { parts.push(buffer.trim()); buffer = ''; }
    else buffer += character;
  }
  if (depth !== 0) throw new Error('gradient has unbalanced parentheses');
  if (buffer.trim()) parts.push(buffer.trim());
  let angle = 180;
  let center = { x: 0.5, y: 0.5 };
  let stopParts = parts;
  const angleMatch = parts[0]?.match(/^(-?\d+(?:\.\d+)?)deg$/i);
  if (angleMatch) {
    angle = Number(angleMatch[1]);
    stopParts = parts.slice(1);
  } else if (kind === 'radial') {
    const position = parts[0]?.match(/^(?:(?:circle|ellipse)(?:\s+.*?)?\s+)?at\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/i);
    if (position) {
      center = { x: Number(position[1]) / 100, y: Number(position[2]) / 100 };
      if (center.x < 0 || center.x > 1 || center.y < 0 || center.y > 1) throw new Error('radial gradient center must be inside 0-100%');
      stopParts = parts.slice(1);
    }
  }
  if (stopParts.length < 2) throw new Error('gradient needs at least two color stops');
  const stops = [];
  for (let index = 0; index < stopParts.length; index++) {
    const source = stopParts[index];
    const positionMatch = source.match(/(-?\d+(?:\.\d+)?)%\s*$/);
    const position = positionMatch ? Number(positionMatch[1]) / 100 : index / (stopParts.length - 1);
    if (position < 0 || position > 1) throw new Error('gradient stop positions must be inside 0-100%');
    const colorSource = positionMatch ? source.slice(0, positionMatch.index).trim() : source.trim();
    const color = structuredGradientColor(colorSource, stops[stops.length - 1]?.color);
    if (!color) throw new Error(`unsupported gradient color: ${colorSource || 'empty'}`);
    stops.push({ position, color });
  }
  return {
    type: { linear: 'GRADIENT_LINEAR', radial: 'GRADIENT_RADIAL', angular: 'GRADIENT_ANGULAR', diamond: 'GRADIENT_DIAMOND' }[kind],
    gradientStops: stops,
    gradientTransform: kind === 'radial'
      ? [[1, 0, center.x - 0.5], [0, 1, center.y - 0.5]]
      : structuredGradientTransformFromCssAngle(angle, dimensions?.width, dimensions?.height),
  };
}

function structuredPaintLayers(input) {
  const source = String(input ?? '').trim();
  if (!source) return [];
  const layers = [];
  let depth = 0, buffer = '';
  for (const character of source) {
    if (character === '(') depth++;
    else if (character === ')') depth--;
    if (depth < 0) throw new Error('paint list has unbalanced parentheses');
    if (character === ',' && depth === 0) { layers.push(buffer.trim()); buffer = ''; }
    else buffer += character;
  }
  if (depth !== 0) throw new Error('paint list has unbalanced parentheses');
  if (buffer.trim()) layers.push(buffer.trim());
  if (!layers.length || layers.some((layer) => !layer)) throw new Error('paint list contains an empty layer');
  return layers;
}

function structuredPaintSupported(value) {
  if (structuredVariableSpec(value)) return structuredColorSupported(value);
  if (structuredColorSupported(value)) return true;
  try { return Boolean(structuredGradientPaint(value)); }
  catch { return false; }
}

function structuredFillPaintSupported(value) {
  if (structuredVariableSpec(value) || structuredColorSupported(value)) return structuredPaintSupported(value);
  try {
    const layers = structuredPaintLayers(value);
    return layers.length > 0 && layers.every((layer) => Boolean(structuredGradientPaint(layer)));
  } catch { return false; }
}

function structuredNumericSupported(value, { variable = false } = {}) {
  const reference = variable ? structuredVariableSpec(value) : null;
  return reference
    ? !reference.error && (reference.fallback == null || Number.isFinite(Number(reference.fallback)))
    : Number.isFinite(Number(value));
}

function structuredStringSupported(value) {
  const reference = structuredVariableSpec(value);
  return reference ? !reference.error : typeof value === 'string';
}

function structuredFontStyle(weight, italic) {
  const names = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };
  const numeric = Number(weight);
  const base = names[numeric]
    || ({ normal: 'Regular', medium: 'Medium', semibold: 'Semi Bold', bold: 'Bold' }[String(weight || '').toLowerCase()])
    || 'Regular';
  return italic === true || italic === 'true' ? `${base} Italic` : base;
}

function structuredFontNameCandidates(fontName) {
  const candidates = [fontName];
  const compact = String(fontName.style || '').replace(/\b(Extra|Semi)\s+(?=(?:Light|Bold)\b)/g, '$1');
  if (compact !== fontName.style) candidates.push({ family: fontName.family, style: compact });
  return candidates;
}

function structuredFontAxes(input) {
  const source = String(input ?? '').trim();
  if (!source) throw new Error('fontAxes needs at least one axis');
  const axes = {};
  for (const raw of source.split(',')) {
    const part = raw.trim();
    const match = part.match(/^(?:"([a-z0-9]{4})"|([a-z0-9]{4}))\s*(?:=|\s)\s*(-?\d+(?:\.\d+)?)$/i);
    if (!match) throw new Error(`fontAxes entry "${part}" must use wght=357 or "wght" 357`);
    const tag = match[1] || match[2];
    if (Object.prototype.hasOwnProperty.call(axes, tag)) throw new Error(`fontAxes contains duplicate axis "${tag}"`);
    axes[tag] = Number(match[3]);
  }
  return axes;
}

function structuredTracks(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('tracks must be a non-empty string');
  return input.split(',').map((raw) => {
    const source = raw.trim();
    if (source === 'hug') return { type: 'HUG' };
    const fixed = source.match(/^fixed:([\d.]+)$/);
    if (fixed && Number.isFinite(Number(fixed[1]))) return { type: 'FIXED', value: Number(fixed[1]) };
    const flex = source.match(/^flex(?::([\d.]+))?$/);
    if (flex && Number(flex[1] || 1) > 0) return { type: 'FLEX', value: Number(flex[1] || 1) };
    throw new Error(`unsupported Grid track: ${source || 'empty'}`);
  });
}

function structuredDashPattern(input) {
  if (input == null || input === '') return [];
  const values = String(input).trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('strokeDashPattern must contain non-negative numbers');
  }
  return values;
}

function structuredCssFunctions(input) {
  const source = String(input || '').trim();
  if (!source || source === 'none') return [];
  const functions = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] || '')) index++;
    const match = source.slice(index).match(/^([a-z-]+)\s*\(/i);
    if (!match) throw new Error(`unsupported filter syntax near "${source.slice(index, index + 24)}"`);
    const name = match[1].toLowerCase();
    index += match[0].length;
    const start = index;
    let depth = 1;
    while (index < source.length && depth > 0) {
      if (source[index] === '(') depth++;
      else if (source[index] === ')') depth--;
      index++;
    }
    if (depth !== 0) throw new Error(`unterminated ${name}() filter`);
    functions.push({ name, value: source.slice(start, index - 1).trim() });
  }
  return functions;
}

function structuredEffectColor(input, fallback = null) {
  const source = String(input || '').trim();
  const hex = source.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let value = hex[1];
    if (value.length === 3) value = value.split('').map((part) => part + part).join('');
    return {
      r: parseInt(value.slice(0, 2), 16) / 255,
      g: parseInt(value.slice(2, 4), 16) / 255,
      b: parseInt(value.slice(4, 6), 16) / 255,
      a: value.length === 8 ? parseInt(value.slice(6), 16) / 255 : 1,
    };
  }
  const rgb = source.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/\s*,\s*/).map(Number);
    if ((parts.length === 3 || parts.length === 4)
      && parts.slice(0, 3).every((part) => Number.isFinite(part) && part >= 0 && part <= 255)
      && (parts.length === 3 || (Number.isFinite(parts[3]) && parts[3] >= 0 && parts[3] <= 1))) {
      return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255, a: parts[3] ?? 1 };
    }
  }
  if (fallback) return fallback;
  throw new Error(`unsupported effect color: ${source || 'empty'}`);
}

function structuredShadow(input) {
  if (typeof input !== 'string') throw new Error('shadow must be a string');
  const presets = {
    sm: '0 1px 2px rgba(0,0,0,0.05)', md: '0 4px 6px rgba(0,0,0,0.1)',
    lg: '0 10px 15px rgba(0,0,0,0.1)', xl: '0 20px 25px rgba(0,0,0,0.1)',
    '2xl': '0 25px 50px rgba(0,0,0,0.25)', soft: '0 4px 12px rgba(0,0,0,0.08)',
    subtle: '0 2px 4px rgba(0,0,0,0.06)', strong: '0 16px 32px rgba(0,0,0,0.2)',
    hard: '0 8px 0 rgba(0,0,0,1)', glow: '0 0 24px rgba(59,130,246,0.5)',
  };
  let source = input.trim();
  if (source.toLowerCase() === 'none') return null;
  source = presets[source.toLowerCase()] || source;
  const colorMatch = source.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i);
  const color = colorMatch
    ? structuredEffectColor(colorMatch[0])
    : { r: 0, g: 0, b: 0, a: 0.1 };
  if (colorMatch) source = `${source.slice(0, colorMatch.index)} ${source.slice(colorMatch.index + colorMatch[0].length)}`;
  const values = source.trim().split(/\s+/).filter(Boolean).map((part) => Number(part.replace(/px$/i, '')));
  if (values.length < 2 || values.length > 4 || values.some((part) => !Number.isFinite(part))) {
    throw new Error(`shadow needs 2-4 numeric lengths: ${input}`);
  }
  const [x, y, blur = 0, spread = 0] = values;
  if (blur < 0) throw new Error('shadow blur must be non-negative');
  return { x, y, blur, spread, color };
}

function structuredFiniteEffectNumber(props, key, fallback, { min = 0, max = Infinity } = {}) {
  const value = props[key] == null ? fallback : Number(props[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max === Infinity ? 'Infinity' : max}`);
  }
  return value;
}

function structuredEffects(props) {
  const effects = [];
  for (const fn of structuredCssFunctions(props.filter)) {
    if (fn.name === 'blur') {
      const radius = Number(fn.value.replace(/px$/i, ''));
      if (!Number.isFinite(radius) || radius < 0) throw new Error('filter blur must be non-negative');
      if (radius > 0) effects.push({ type: 'LAYER_BLUR', blurType: 'NORMAL', radius, visible: true });
    } else if (fn.name === 'drop-shadow') {
      const shadow = structuredShadow(fn.value);
      if (shadow) effects.push({ type: 'DROP_SHADOW', color: shadow.color, offset: { x: shadow.x, y: shadow.y }, radius: shadow.blur, spread: shadow.spread, visible: true, blendMode: 'NORMAL' });
    } else throw new Error(`CSS filter ${fn.name}() is not supported by native Figma effects`);
  }
  for (const [key, type] of [['shadow', 'DROP_SHADOW'], ['innerShadow', 'INNER_SHADOW']]) {
    if (props[key] == null) continue;
    for (const raw of Array.isArray(props[key]) ? props[key] : [props[key]]) {
      const shadow = structuredShadow(raw);
      if (shadow) effects.push({ type, color: shadow.color, offset: { x: shadow.x, y: shadow.y }, radius: shadow.blur, spread: shadow.spread, visible: true, blendMode: 'NORMAL' });
    }
  }
  for (const [key, type] of [['blur', 'LAYER_BLUR'], ['bgBlur', 'BACKGROUND_BLUR']]) {
    if (props[key] == null) continue;
    const radius = structuredFiniteEffectNumber(props, key, 0);
    if (radius > 0) effects.push({ type, blurType: 'NORMAL', radius, visible: true });
  }
  if (props.noise !== undefined && props.noise !== null && props.noise !== false && props.noise !== 'false') {
    const value = String(props.noise).toLowerCase();
    const noiseType = value.startsWith('duo') ? 'DUOTONE' : value.startsWith('multi') ? 'MULTITONE' : value.startsWith('mono') || value === 'true' ? 'MONOTONE' : null;
    if (!noiseType) throw new Error('noise must be mono, duo, or multi');
    const effect = {
      type: 'NOISE', noiseType,
      density: structuredFiniteEffectNumber(props, 'noiseDensity', 0.4, { max: 1 }),
      noiseSize: structuredFiniteEffectNumber(props, 'noiseSize', 1.5),
      color: structuredEffectColor(props.noiseColor || '#000000'), visible: true, blendMode: 'NORMAL',
    };
    if (noiseType === 'DUOTONE') effect.secondaryColor = structuredEffectColor(props.noiseColor2 || '#ffffff');
    if (noiseType === 'MULTITONE') effect.opacity = structuredFiniteEffectNumber(props, 'noiseOpacity', 0.5, { max: 1 });
    effects.push(effect);
  }
  if (props.texture !== undefined && props.texture !== null && props.texture !== false && props.texture !== 'false') {
    effects.push({
      type: 'TEXTURE', noiseSize: structuredFiniteEffectNumber(props, 'textureSize', 12),
      radius: structuredFiniteEffectNumber(props, 'textureRadius', 30),
      clipToShape: !(props.textureClip === false || props.textureClip === 'false'), visible: true,
    });
  }
  if (props.progressiveBlur != null) {
    const radius = structuredFiniteEffectNumber(props, 'progressiveBlur', 0);
    const direction = String(props.progressiveBlurDir || 'down').toLowerCase();
    const offsets = {
      down: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }], up: [{ x: 0.5, y: 1 }, { x: 0.5, y: 0 }],
      right: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], left: [{ x: 1, y: 0.5 }, { x: 0, y: 0.5 }],
    }[direction];
    if (!offsets) throw new Error('progressiveBlurDir must be down, up, left, or right');
    if (radius > 0) effects.push({
      type: 'LAYER_BLUR', blurType: 'PROGRESSIVE', radius,
      startRadius: structuredFiniteEffectNumber(props, 'progressiveBlurStart', 0),
      startOffset: offsets[0], endOffset: offsets[1], visible: true,
    });
  }
  if (props.glass !== undefined && props.glass !== null && props.glass !== false && props.glass !== 'false') {
    effects.push({
      type: 'GLASS', visible: true,
      refraction: structuredFiniteEffectNumber(props, 'glassRefraction', 0.95, { max: 1 }),
      depth: structuredFiniteEffectNumber(props, 'glassDepth', 50, { min: 1 }),
      radius: structuredFiniteEffectNumber(props, 'glassRadius', 6),
      dispersion: structuredFiniteEffectNumber(props, 'glassDispersion', 0.4, { max: 1 }),
      lightIntensity: structuredFiniteEffectNumber(props, 'glassLight', 0.7, { max: 1 }),
      lightAngle: structuredFiniteEffectNumber(props, 'glassLightAngle', 130, { min: -360, max: 360 }),
    });
  }
  return effects;
}

function structuredSvgFilterDescriptors(svg) {
  const descriptors = [];
  for (const opening of String(svg || '').match(/<[^>]+>/g) || []) {
    const id = opening.match(/\bid=["'](figma-filter-[^"']+)["']/i)?.[1];
    const filter = opening.match(/\bfilter=["']([^"']+)["']/i)?.[1];
    if (id && filter && filter !== 'none' && !filter.startsWith('url(')) descriptors.push({ id, filter });
  }
  return descriptors;
}

function structuredVariantPairs(input) {
  if (input == null || String(input).trim() === '') return {};
  const pairs = {};
  for (const raw of String(input).split(',')) {
    const separator = raw.indexOf('=');
    const key = separator < 0 ? '' : raw.slice(0, separator).trim();
    const value = separator < 0 ? '' : raw.slice(separator + 1).trim();
    if (!key || !value) throw new Error(`variant segment needs Axis=Value: ${raw.trim() || 'empty'}`);
    if (Object.prototype.hasOwnProperty.call(pairs, key)) throw new Error(`variant axis is duplicated: ${key}`);
    pairs[key] = value;
  }
  return pairs;
}

function structuredDesignEntityId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._/-]{0,127}$/.test(value);
}

function structuredOverrideEntries(props, prefix) {
  return Object.entries(props || {})
    .filter(([key]) => key.startsWith(`${prefix}:`))
    .map(([key, value]) => ({ key, target: key.slice(prefix.length + 1), value }));
}

function structuredLayerName(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function structuredFindOverrideLayer(root, requested, predicate, label) {
  const descendants = typeof root.findAll === 'function'
    ? root.findAll((node) => predicate(node))
    : [];
  const exact = descendants.filter((node) => node.name === requested);
  const matches = exact.length
    ? exact
    : descendants.filter((node) => structuredLayerName(node.name) === structuredLayerName(requested));
  if (matches.length !== 1) {
    throw new Error(`${label}: ${matches.length ? 'is ambiguous' : 'does not exist'} on component ${root.name || root.id}`);
  }
  return matches[0];
}

async function prepareStructuredComponents(figmaApi, plan) {
  const intents = [];
  const bindings = new WeakMap();
  const overrides = new WeakMap();
  const collect = (node) => {
    if (node.source.type === 'instance') intents.push(node);
    for (const child of node.children || []) collect(child);
  };
  collect(plan.root);
  if (!intents.length) return { bindings, overrides };

  const resolveVariant = (target, requested, label) => {
    const wanted = structuredVariantPairs(requested);
    if (!Object.keys(wanted).length) {
      if (target.type === 'COMPONENT_SET') return target.defaultVariant || target.children?.[0] || null;
      return target.type === 'COMPONENT' ? target : null;
    }
    const set = target.type === 'COMPONENT_SET'
      ? target
      : target.type === 'COMPONENT' && target.parent?.type === 'COMPONENT_SET' ? target.parent : null;
    const candidates = set?.children || (target.type === 'COMPONENT' ? [target] : []);
    const matches = candidates.filter((candidate) => {
      const actual = candidate.variantProperties || structuredVariantPairs(candidate.name);
      return Object.entries(wanted).every(([axis, value]) => actual?.[axis] === value);
    });
    if (matches.length !== 1) {
      const available = candidates.map((candidate) => candidate.name).filter(Boolean).join(' | ');
      throw new Error(`${label}: variant "${requested}" ${matches.length ? 'is ambiguous' : 'does not exist'}${available ? ` (available: ${available})` : ''}`);
    }
    return matches[0];
  };

  const resolveHandle = async (handle, label, variant = null) => {
    let target = null;
    if (handle.key) {
      try { target = await figmaApi.importComponentByKeyAsync(String(handle.key)); }
      catch {
        try { target = await figmaApi.importComponentSetByKeyAsync(String(handle.key)); }
        catch {
          // A Registry Design Entity may intentionally carry both anchors:
          // the publish key is strongest, while the node id is the explicit
          // current-file locator. Falling back to that id is still identity-
          // based and never a display-name guess.
          if (handle.id) target = await figmaApi.getNodeByIdAsync(String(handle.id));
          if (!target) throw new Error(`${label}: published component key ${handle.key} could not be imported and local component node ${handle.id || '(none)'} does not exist in this file`);
        }
      }
    } else {
      target = await figmaApi.getNodeByIdAsync(String(handle.id));
      if (!target) throw new Error(`${label}: local component node ${handle.id} does not exist in this file`);
    }
    if (!['COMPONENT', 'COMPONENT_SET'].includes(target.type)) {
      throw new Error(`${label}: linked Figma node is ${target.type}, not a component or component set`);
    }
    const component = resolveVariant(target, variant, label);
    if (!component || component.type !== 'COMPONENT') throw new Error(`${label}: no instantiable component resolved`);
    return component;
  };

  const outcomes = await Promise.all(intents.map(async (node) => {
    const props = node.source.props;
    const label = `Design Entity ${props.entity}`;
    try {
      return { node, component: await resolveHandle(props, label, props.variant) };
    } catch (error) {
      return { node, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const failures = outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error);
  if (failures.length) throw new Error(`Structured component preflight failed: ${failures.slice(0, 5).join('; ')}`);

  const swapEntities = new Set();
  for (const outcome of outcomes) {
    const { node, component } = outcome;
    const props = node.source.props;
    const label = `Design Entity ${props.entity}`;
    bindings.set(node, component);
    const prepared = { properties: {}, texts: [], fills: [], swaps: [] };
    const definitions = component.componentPropertyDefinitions
      || (component.parent?.type === 'COMPONENT_SET' ? component.parent.componentPropertyDefinitions : null)
      || {};
    const definitionKeys = Object.keys(definitions);

    for (const entry of structuredOverrideEntries(props, 'prop')) {
      const matches = definitionKeys.filter((key) => key === entry.target || key.split('#')[0] === entry.target);
      if (matches.length !== 1) {
        failures.push(`${label}: component property "${entry.target}" ${matches.length ? 'is ambiguous' : 'does not exist'}`);
        continue;
      }
      const key = matches[0];
      const definition = definitions[key];
      if (definition.type === 'VARIANT') {
        failures.push(`${label}: prop:${entry.target} is a variant property; use variant="Axis=Value"`);
        continue;
      }
      let next = entry.value;
      if (definition.type === 'BOOLEAN') {
        if (![true, false, 'true', 'false'].includes(next)) {
          failures.push(`${label}: prop:${entry.target} must be true or false`);
          continue;
        }
        next = next === true || next === 'true';
      } else if (definition.type === 'INSTANCE_SWAP') {
        if (!structuredDesignEntityId(String(next))) {
          failures.push(`${label}: prop:${entry.target} instance swap needs a Registry Design Entity id`);
          continue;
        }
        swapEntities.add(String(next));
        next = { entity: String(next) };
      } else next = String(next);
      prepared.properties[key] = next;
    }

    for (const entry of structuredOverrideEntries(props, 'text')) {
      try {
        const target = structuredFindOverrideLayer(component, entry.target, (candidate) => candidate.type === 'TEXT', `${label} text:${entry.target}`);
        prepared.texts.push({ ...entry, targetNode: target });
      } catch (error) { failures.push(error.message); }
    }
    for (const entry of structuredOverrideEntries(props, 'fill')) {
      try {
        structuredFindOverrideLayer(component, entry.target, (candidate) => 'fills' in candidate, `${label} fill:${entry.target}`);
        prepared.fills.push(entry);
      } catch (error) { failures.push(error.message); }
    }
    for (const entry of structuredOverrideEntries(props, 'swap')) {
      if (!structuredDesignEntityId(String(entry.value))) {
        failures.push(`${label}: swap:${entry.target} needs a Registry Design Entity id`);
        continue;
      }
      try {
        structuredFindOverrideLayer(component, entry.target, (candidate) => candidate.type === 'INSTANCE', `${label} swap:${entry.target}`);
        prepared.swaps.push({ ...entry, entity: String(entry.value) });
        swapEntities.add(String(entry.value));
      } catch (error) { failures.push(error.message); }
    }
    overrides.set(node, prepared);
  }

  if (failures.length) throw new Error(`Structured component preflight failed: ${failures.slice(0, 5).join('; ')}`);
  const swapComponents = new Map();
  const swapOutcomes = await Promise.all([...swapEntities].map(async (entity) => {
    const link = plan.componentLinks?.[entity];
    if (!link) return { entity, error: `swap Design Entity ${entity} is not linked in the Render Plan Registry projection` };
    try {
      return { entity, component: await resolveHandle(link, `Swap Design Entity ${entity}`, link.variant) };
    } catch (error) {
      return { entity, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const swapFailures = swapOutcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error);
  if (swapFailures.length) throw new Error(`Structured component preflight failed: ${swapFailures.slice(0, 5).join('; ')}`);
  for (const outcome of swapOutcomes) swapComponents.set(outcome.entity, outcome.component);

  const fonts = new Map();
  for (const prepared of intents.map((node) => overrides.get(node))) {
    for (const { targetNode } of prepared.texts) {
      if (targetNode.fontName && targetNode.fontName !== figmaApi.mixed) {
        fonts.set(`${targetNode.fontName.family}/${targetNode.fontName.style}`, targetNode.fontName);
      } else if (typeof targetNode.getRangeAllFontNames === 'function') {
        for (const font of targetNode.getRangeAllFontNames(0, targetNode.characters?.length || 0)) {
          fonts.set(`${font.family}/${font.style}`, font);
        }
      }
    }
  }
  try {
    await Promise.all([...fonts.values()].map((font) => figmaApi.loadFontAsync(font)));
  } catch (error) {
    throw new Error(`Structured component preflight failed: instance text override font is unavailable (${error.message || error})`);
  }
  return { bindings, overrides, swapComponents };
}

async function prepareStructuredImages(figmaApi, plan) {
  const intents = [];
  const bindings = new WeakMap();
  const collect = (node) => {
    if (node.source.type === 'image') intents.push(node);
    for (const child of node.children || []) collect(child);
  };
  collect(plan.root);
  const outcomes = await Promise.all(intents.map(async (node) => {
    try {
      const image = node.asset.kind === 'embedded-raster'
        ? figmaApi.createImage(figmaApi.base64Decode(node.asset.base64))
        : await figmaApi.createImageAsync(node.asset.src);
      if (!image?.hash) throw new Error('Figma returned no image hash');
      return { node, hash: image.hash };
    } catch (error) {
      return { node, error: `${node.path || node.name}: image preflight failed (${error.message || error})` };
    }
  }));
  const failures = outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error);
  if (failures.length) throw new Error(`Structured image preflight failed: ${failures.slice(0, 5).join('; ')}`);
  for (const outcome of outcomes) bindings.set(outcome.node, outcome.hash);
  return { bindings };
}

function structuredVariableScopes(name, type) {
  if (type !== 'FLOAT') return null;
  const head = String(name || '').trim().toLowerCase().split('/')[0];
  if (head === 'space' || head === 'spacing') return ['GAP'];
  if (head === 'radius' || head === 'radii') return ['CORNER_RADIUS'];
  return null;
}

function structuredScopeQuestion(name, type, collection) {
  const allowed = type === 'COLOR'
    ? ['ALL_SCOPES', 'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR', 'EFFECT_COLOR']
    : type === 'STRING'
      ? ['ALL_SCOPES', 'TEXT_CONTENT', 'FONT_FAMILY', 'FONT_STYLE']
      : ['ALL_SCOPES', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP', 'STROKE_FLOAT', 'EFFECT_FLOAT', 'OPACITY', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT'];
  return {
    name, collection, resolvedType: type, status: 'USER_DECISION_REQUIRED',
    currentScopes: ['ALL_SCOPES'], allowedScopes: allowed,
    question: `Should "${name}" remain unrestricted (ALL_SCOPES), or be limited to one or more compatible ${type} scopes?`,
  };
}

function inspectStructuredRenderPlan(plan) {
  const problems = [];
  const annotationProperties = new Set([
    'width', 'height', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight', 'fills',
    'strokes', 'effects', 'strokeWeight', 'cornerRadius', 'textStyleId',
    'textAlignHorizontal', 'fontFamily', 'fontStyle', 'fontSize', 'fontWeight',
    'lineHeight', 'letterSpacing', 'itemSpacing', 'padding', 'layoutMode',
    'alignItems', 'opacity', 'mainComponent', 'gridRowGap', 'gridColumnGap',
    'gridRowCount', 'gridColumnCount', 'gridRowAnchorIndex',
    'gridColumnAnchorIndex', 'gridRowSpan', 'gridColumnSpan',
  ]);
  let fallbackAnnotationCount = 0;
  const frameProps = new Set([
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH', 'flex', 'gap', 'p', 'padding', 'px', 'py',
    'pt', 'pr', 'pb', 'pl', 'items', 'align', 'justify', 'bg', 'fill', 'rounded',
    'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'cornerSmoothing',
    'clip', 'overflow', 'position', 'x', 'y', 'grow', 'stretch', 'hug', 'opacity', 'visible', 'locked', 'rotate',
    'blendMode', 'mask', 'maskType', 'stroke', 'strokeWidth', 'strokeAlign',
    'strokeDashPattern', 'strokeCap', 'strokeTopWidth', 'strokeRightWidth',
    'strokeBottomWidth', 'strokeLeftWidth', 'shadow', 'innerShadow', 'blur',
    'bgBlur', 'filter', 'noise', 'noiseDensity', 'noiseSize', 'noiseColor',
    'noiseColor2', 'noiseOpacity', 'texture', 'textureSize', 'textureRadius',
    'textureClip', 'progressiveBlur', 'progressiveBlurDir', 'progressiveBlurStart',
    'glass', 'glassRefraction', 'glassDepth', 'glassRadius', 'glassDispersion',
    'glassLight', 'glassLightAngle', 'wrap', 'wrapGap', 'counterAxisSpacing', 'gridColumns',
    'gridRows', 'columnGap', 'rowGap', 'gridAutoFlow', 'gridRow', 'gridColumn',
    'gridRowSpan', 'gridColumnSpan', 'gridHAlign', 'gridVAlign',
  ]);
  const textProps = new Set([
    'name', 'content', 'w', 'h', 'width', 'height', 'size', 'weight', 'italic',
    'color', 'font', 'fontStyle', 'style', 'align', 'lineHeight', 'letterSpacing',
    'paragraphSpacing', 'paragraphIndent', 'position', 'x', 'y', 'grow',
    'opacity', 'minW', 'maxW', 'minH', 'maxH', 'gridRow', 'gridColumn',
    'gridRowSpan', 'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'truncate',
    'maxLines', 'fontAxes', 'mask', 'maskType', 'runs',
  ]);
  const rectProps = new Set([
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH',
    'bg', 'fill', 'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL',
    'roundedBR', 'cornerSmoothing', 'blendMode', 'opacity', 'visible', 'rotate',
    'position', 'x', 'y', 'gridRow', 'gridColumn', 'gridRowSpan',
    'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'mask', 'maskType', 'filter',
  ]);
  const ellipseProps = new Set([
    'name', 'w', 'h', 'width', 'height', 'minW', 'maxW', 'minH', 'maxH',
    'bg', 'fill', 'stroke', 'strokeWidth', 'strokeAlign', 'strokeDashPattern',
    'strokeCap', 'arc', 'arcStart', 'innerRadius', 'opacity', 'visible', 'rotate',
    'position', 'x', 'y', 'gridRow', 'gridColumn', 'gridRowSpan',
    'gridColumnSpan', 'gridHAlign', 'gridVAlign', 'mask', 'maskType', 'filter',
  ]);
  const iconProps = new Set([
    'name', 'size', 's', 'w', 'h', 'width', 'height', 'color', 'c',
    'preserveColors', 'opacity', 'visible', 'rotate', 'position', 'x', 'y',
    'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan', 'gridHAlign',
    'gridVAlign', 'mask', 'maskType',
  ]);
  const imageProps = new Set([
    'name', 'src', 'imageScale', 'w', 'h', 'width', 'height', 'minW', 'maxW',
    'minH', 'maxH', 'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL',
    'roundedBR', 'cornerSmoothing', 'opacity', 'visible', 'rotate', 'position',
    'x', 'y', 'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan',
    'gridHAlign', 'gridVAlign', 'filter', 'blendMode', 'mask', 'maskType',
  ]);
  const instanceProps = new Set([
    'entity', 'name', 'component', 'id', 'key', 'variant', 'w', 'h', 'width',
    'height', 'minW', 'maxW', 'minH', 'maxH', 'grow', 'opacity', 'visible',
    'rotate', 'position', 'x', 'y', 'gridRow', 'gridColumn', 'gridRowSpan',
    'gridColumnSpan', 'gridHAlign', 'gridVAlign',
  ]);
  const instanceOverridePrefixes = ['prop:', 'text:', 'fill:', 'swap:'];
  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  if (!isRecord(plan) || plan.kind !== 'figma-bridge/semantic-render-plan' || plan.version !== 1) {
    return { supported: false, problems: ['unsupported Semantic Render Plan contract'] };
  }
  const visit = (node, path = 'root') => {
    if (!isRecord(node) || !isRecord(node.source) || !isRecord(node.source.props)) {
      problems.push(`${path}: missing executable source properties`);
      return;
    }
    if (node.fallbackAnnotations !== undefined) {
      if (!Array.isArray(node.fallbackAnnotations)) problems.push(`${path}: fallbackAnnotations must be an array`);
      else {
        const policies = new Set();
        for (let index = 0; index < node.fallbackAnnotations.length; index++) {
          fallbackAnnotationCount++;
          const annotation = node.fallbackAnnotations[index];
          const label = `${path}.fallbackAnnotations[${index}]`;
          if (!isRecord(annotation)) { problems.push(`${label}: must be an object`); continue; }
          if (typeof annotation.policy !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(annotation.policy)) problems.push(`${label}: policy is invalid`);
          else if (policies.has(annotation.policy)) problems.push(`${label}: policy ${annotation.policy} is duplicated`);
          else policies.add(annotation.policy);
          if (typeof annotation.labelMarkdown !== 'string' || !annotation.labelMarkdown.trim() || annotation.labelMarkdown.length > 1000) problems.push(`${label}: labelMarkdown must contain at most 1000 characters`);
          if (!Array.isArray(annotation.properties) || annotation.properties.some((property) => !annotationProperties.has(property))) problems.push(`${label}: properties contains an unsupported Figma annotation property`);
        }
      }
    }
    const type = node.source.type;
    const allowed = type === 'frame' ? frameProps
      : type === 'text' ? textProps
        : type === 'rect' ? rectProps
          : type === 'ellipse' ? ellipseProps
            : type === 'icon' ? iconProps
              : type === 'image' ? imageProps
              : type === 'instance' ? instanceProps
                : null;
    if (!allowed) problems.push(`${path}: node type ${type || 'missing'} is not supported by the native executor`);
    else {
      for (const key of Object.keys(node.source.props)) {
        const dynamicInstanceOverride = type === 'instance'
          && instanceOverridePrefixes.some((prefix) => key.startsWith(prefix));
        if (!allowed.has(key) && !dynamicInstanceOverride) problems.push(`${path}: ${type}.${key} is not supported by the native executor`);
        if (dynamicInstanceOverride && !key.slice(key.indexOf(':') + 1).trim()) {
          problems.push(`${path}: ${key} needs a property or layer name after the colon`);
        }
      }
      const props = node.source.props;
      if (type === 'frame' && (!structuredFillPaintSupported(props.bg ?? props.fill) || !structuredPaintSupported(props.stroke))) problems.push(`${path}: frame paint needs the compatibility executor`);
      if (type === 'text' && !structuredPaintSupported(props.color)) problems.push(`${path}: text paint needs the compatibility executor`);
      if (type === 'rect' && !structuredFillPaintSupported(props.bg ?? props.fill)) problems.push(`${path}: rectangle paint needs the compatibility executor`);
      if (type === 'ellipse' && (!structuredFillPaintSupported(props.bg ?? props.fill) || !structuredPaintSupported(props.stroke))) problems.push(`${path}: ellipse paint needs the compatibility executor`);
      if (type === 'icon' && !structuredColorSupported(props.color ?? props.c)) problems.push(`${path}: icon paint needs the compatibility executor`);
      if (type === 'image') {
        if (!node.asset || !['embedded-raster', 'remote-raster'].includes(node.asset.kind)) problems.push(`${path}: image needs embedded bytes or an HTTP(S) source`);
        if (props.imageScale != null && !['fill', 'fit', 'crop', 'tile'].includes(String(props.imageScale).toLowerCase())) problems.push(`${path}: imageScale is unsupported`);
      }
      if (type === 'instance') {
        if (typeof props.entity !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(props.entity)) problems.push(`${path}: native instances require an explicit Registry Design Entity id`);
        if (!props.key && !props.id) problems.push(`${path}: Registry instance needs a published key or explicit local node id`);
        if (props.key != null && (typeof props.key !== 'string' || !props.key.trim())) problems.push(`${path}: component key must be a non-empty string`);
        if (props.id != null && (typeof props.id !== 'string' || !/^\d+:\d+$/.test(props.id))) problems.push(`${path}: component id must use Figma node-id syntax`);
        if (props.component != null) problems.push(`${path}: name-based component lookup is not supported; use the Registry key/id`);
        try { structuredVariantPairs(props.variant); }
        catch (error) { problems.push(`${path}: ${error.message}`); }
        for (const entry of structuredOverrideEntries(props, 'fill')) {
          if (!structuredColorSupported(entry.value)) problems.push(`${path}: ${entry.key} needs a solid color or COLOR variable`);
        }
        for (const entry of structuredOverrideEntries(props, 'swap')) {
          const entity = String(entry.value);
          if (!structuredDesignEntityId(entity)) problems.push(`${path}: ${entry.key} needs a Registry Design Entity id`);
          else {
            const link = plan.componentLinks?.[entity];
            if (!link?.key && !link?.id) problems.push(`${path}: swap Design Entity ${entity} has no Registry key or local id in the Render Plan`);
          }
        }
        if ((node.children || []).length) problems.push(`${path}: an Instance cannot contain authored child nodes`);
      }
      if (type === 'frame' && props.flex === 'grid' && (!props.gridColumns || !props.gridRows)) {
        problems.push(`${path}: Grid requires explicit rows and columns`);
      }
      if (type === 'frame' && props.flex === 'grid') {
        try { structuredTracks(props.gridRows); structuredTracks(props.gridColumns); }
        catch (error) { problems.push(`${path}: ${error.message}`); }
      }
      if (props.position != null && props.position !== 'absolute') problems.push(`${path}: position must be absolute`);
      if (props.opacity != null && (Number(props.opacity) < 0 || Number(props.opacity) > 1)) problems.push(`${path}: opacity must be between 0 and 1`);
      if (props.gridHAlign != null && !['min', 'center', 'max', 'auto'].includes(String(props.gridHAlign).toLowerCase())) problems.push(`${path}: gridHAlign is unsupported`);
      if (props.gridVAlign != null && !['min', 'center', 'max', 'auto'].includes(String(props.gridVAlign).toLowerCase())) problems.push(`${path}: gridVAlign is unsupported`);
      if (props.maskType != null && !['alpha', 'vector', 'luminance'].includes(String(props.maskType).toLowerCase())) problems.push(`${path}: maskType is unsupported`);
      if (props.blendMode != null && !['normal', 'darken', 'multiply', 'linear-burn', 'color-burn', 'lighten', 'screen', 'linear-dodge', 'color-dodge', 'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'pass-through'].includes(String(props.blendMode).toLowerCase())) problems.push(`${path}: blendMode is unsupported`);
      for (const key of ['w', 'h', 'width', 'height']) {
        const raw = props[key];
        if (raw != null && !['fill', 'hug'].includes(raw) && !structuredNumericSupported(raw, { variable: true })) {
          problems.push(`${path}: ${key} must be numeric, fill, hug, or a FLOAT variable`);
        }
      }
      for (const key of ['x', 'y', 'opacity', 'rotate', 'minW', 'maxW', 'minH', 'maxH', 'gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan']) {
        const dimensionConstraint = ['minW', 'maxW', 'minH', 'maxH'].includes(key);
        if (props[key] != null && !(dimensionConstraint
          ? structuredNumericSupported(props[key], { variable: true })
          : Number.isFinite(Number(props[key])))) problems.push(`${path}: ${key} must be numeric${dimensionConstraint ? ' or a FLOAT variable' : ''}`);
      }
      if (type === 'frame') {
        for (const key of ['gap', 'wrapGap', 'counterAxisSpacing', 'p', 'padding', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'grow', 'columnGap', 'rowGap']) {
          if (props[key] != null && !structuredNumericSupported(props[key], { variable: key !== 'grow' })) problems.push(`${path}: ${key} must be numeric or a FLOAT variable`);
        }
        if (props.wrap != null && ![true, false, 'true', 'false'].includes(props.wrap)) problems.push(`${path}: wrap must be true or false`);
        for (const key of ['strokeWidth', 'strokeTopWidth', 'strokeRightWidth', 'strokeBottomWidth', 'strokeLeftWidth', 'cornerSmoothing']) {
          if (props[key] != null && (!Number.isFinite(Number(props[key])) || Number(props[key]) < 0)) problems.push(`${path}: ${key} must be a non-negative number`);
        }
        if (props.cornerSmoothing != null && Number(props.cornerSmoothing) > 1) problems.push(`${path}: cornerSmoothing must be between 0 and 1`);
        try { structuredDashPattern(props.strokeDashPattern); }
        catch (error) { problems.push(`${path}: ${error.message}`); }
        if (props.strokeAlign != null && !['inside', 'outside', 'center'].includes(String(props.strokeAlign).toLowerCase())) problems.push(`${path}: strokeAlign is unsupported`);
        if (props.strokeCap != null && !['none', 'round', 'square'].includes(String(props.strokeCap).toLowerCase())) problems.push(`${path}: strokeCap is unsupported`);
        if (props.flex != null && !['row', 'col', 'column', 'grid', 'none', 'stack', 'free'].includes(props.flex)) problems.push(`${path}: flex is unsupported`);
        if (props.justify != null && !['start', 'center', 'end', 'between'].includes(props.justify)) problems.push(`${path}: justify is unsupported`);
        if ((props.items ?? props.align) != null && !['start', 'center', 'end', 'stretch'].includes(props.items ?? props.align)) problems.push(`${path}: items/align is unsupported`);
        if (props.stretch != null && ![true, false, 'true', 'false'].includes(props.stretch)) problems.push(`${path}: stretch must be true or false`);
        if (props.hug != null && !['both', 'w', 'width', 'h', 'height'].includes(String(props.hug))) problems.push(`${path}: hug must be both, width/w, or height/h`);
        if (props.overflow != null && !['visible', 'hidden', 'clip'].includes(String(props.overflow))) problems.push(`${path}: overflow must be visible, hidden, or clip`);
      }
      if (type === 'text') {
        for (const key of ['size', 'weight', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent', 'grow']) {
          const variable = key !== 'grow';
          if (props[key] != null && !structuredNumericSupported(props[key], { variable })) problems.push(`${path}: ${key} must be numeric${variable ? ' or a FLOAT variable' : ''}`);
        }
        for (const key of ['font', 'fontStyle']) {
          if (props[key] != null && !structuredStringSupported(props[key])) problems.push(`${path}: ${key} must be a string or STRING variable`);
        }
        if (props.align != null && !['left', 'center', 'right', 'justified'].includes(props.align)) problems.push(`${path}: text align is unsupported`);
        if (props.truncate != null && ![true, false, 'true', 'false'].includes(props.truncate)) problems.push(`${path}: truncate must be true or false`);
        if (props.maxLines != null && (!Number.isInteger(Number(props.maxLines)) || Number(props.maxLines) < 1)) problems.push(`${path}: maxLines must be a positive integer`);
        if (props.fontAxes != null) {
          try { structuredFontAxes(props.fontAxes); }
          catch (error) { problems.push(`${path}: ${error.message}`); }
        }
        if (props.runs != null) {
          if (!Array.isArray(props.runs)) problems.push(`${path}: rich-text runs must be an array`);
          else {
            const contentLength = String(props.content || '').length;
            let previousEnd = 0;
            for (let index = 0; index < props.runs.length; index++) {
              const run = props.runs[index];
              const label = `${path}.runs[${index}]`;
              if (!isRecord(run) || !Number.isInteger(run.start) || !Number.isInteger(run.end)
                || run.start < previousEnd || run.start < 0 || run.end <= run.start || run.end > contentLength) {
                problems.push(`${label}: range is invalid or overlapping`);
                continue;
              }
              previousEnd = run.end;
              if (!isRecord(run.style)) { problems.push(`${label}: style must be an object`); continue; }
              const allowedRunStyles = new Set(['font', 'fontStyle', 'weight', 'italic', 'color', 'size', 'letterSpacing', 'underline', 'decoration', 'href']);
              for (const key of Object.keys(run.style)) if (!allowedRunStyles.has(key)) problems.push(`${label}: style.${key} is unsupported`);
              for (const key of ['font', 'fontStyle']) if (run.style[key] != null && typeof run.style[key] !== 'string') problems.push(`${label}: ${key} must be a string`);
              for (const key of ['size', 'letterSpacing']) if (run.style[key] != null && !Number.isFinite(Number(run.style[key]))) problems.push(`${label}: ${key} must be numeric`);
              if (run.style.weight != null && typeof run.style.weight !== 'string' && !Number.isFinite(Number(run.style.weight))) problems.push(`${label}: weight must be a name or number`);
              if (run.style.color != null && (!structuredColorSupported(run.style.color) || structuredVariableSpec(run.style.color))) problems.push(`${label}: color must be a literal solid color`);
              if (run.style.italic != null && ![true, false, 'true', 'false'].includes(run.style.italic)) problems.push(`${label}: italic must be true or false`);
              if (run.style.underline != null && ![true, false, 'true', 'false'].includes(run.style.underline)) problems.push(`${label}: underline must be true or false`);
              if (run.style.decoration != null && !['none', 'underline', 'strikethrough'].includes(String(run.style.decoration).toLowerCase())) problems.push(`${label}: decoration is unsupported`);
              if (run.style.href != null && (typeof run.style.href !== 'string' || run.style.href.length > 2048 || !/^(https?:|mailto:|tel:)/i.test(run.style.href))) problems.push(`${label}: href must be an HTTP(S), mailto or tel URL`);
            }
          }
        }
      }
      for (const key of ['gridRow', 'gridColumn', 'gridRowSpan', 'gridColumnSpan']) {
        if (props[key] != null && (!Number.isInteger(Number(props[key])) || Number(props[key]) < 1)) problems.push(`${path}: ${key} must be a positive integer`);
      }
      if (type === 'ellipse') {
        for (const key of ['strokeWidth', 'arc', 'arcStart', 'innerRadius']) {
          if (props[key] != null && !Number.isFinite(Number(props[key]))) problems.push(`${path}: ${key} must be numeric`);
        }
        try { structuredDashPattern(props.strokeDashPattern); }
        catch (error) { problems.push(`${path}: ${error.message}`); }
        if (props.strokeAlign != null && !['inside', 'outside', 'center'].includes(String(props.strokeAlign).toLowerCase())) problems.push(`${path}: strokeAlign is unsupported`);
        if (props.strokeCap != null && !['none', 'round', 'square'].includes(String(props.strokeCap).toLowerCase())) problems.push(`${path}: strokeCap is unsupported`);
        if (props.strokeWidth != null && Number(props.strokeWidth) < 0) problems.push(`${path}: strokeWidth must be non-negative`);
      }
      if (type === 'rect' || type === 'image') {
        for (const key of ['rounded', 'radius', 'roundedTL', 'roundedTR', 'roundedBL', 'roundedBR', 'cornerSmoothing']) {
          if (props[key] != null && !structuredNumericSupported(props[key], { variable: key !== 'cornerSmoothing' })) problems.push(`${path}: ${key} must be numeric${key !== 'cornerSmoothing' ? ' or a FLOAT variable' : ''}`);
        }
        if (props.cornerSmoothing != null && (Number(props.cornerSmoothing) < 0 || Number(props.cornerSmoothing) > 1)) problems.push(`${path}: cornerSmoothing must be between 0 and 1`);
      }
      if (type === 'icon') {
        const asset = node.asset;
        if (!isRecord(asset) || typeof asset.svg !== 'string' || !/^\s*<svg\b/i.test(asset.svg)) {
          problems.push(`${path}: icon needs executable SVG asset intent`);
        } else if (asset.svg.length > 100 * 1024) {
          problems.push(`${path}: icon SVG exceeds 100 KB`);
        } else {
          for (const descriptor of structuredSvgFilterDescriptors(asset.svg)) {
            try { structuredEffects({ filter: descriptor.filter }); }
            catch (error) { problems.push(`${path}: SVG layer ${descriptor.id}: ${error.message}`); }
          }
        }
      }
      if (['frame', 'rect', 'ellipse', 'image'].includes(type)) {
        try {
          const effects = structuredEffects(props);
          const frameCannotUseSpread = type === 'frame'
            && effects.some((effect) => ['DROP_SHADOW', 'INNER_SHADOW'].includes(effect.type) && 'spread' in effect && effect.spread !== 0)
            && ((props.bg ?? props.fill) == null || (props.bg ?? props.fill) === 'none' || !(props.clip === true || props.clip === 'true'));
          if (frameCannotUseSpread) throw new Error('shadow spread on a Frame requires a visible fill and clip=true in the Figma API');
        }
        catch (error) { problems.push(`${path}: ${error.message}`); }
      }
    }
    for (let index = 0; index < (node.children || []).length; index++) visit(node.children[index], `${path}.children[${index}]`);
    if (type === 'frame' && node.source.props.flex === 'grid') {
      if (node.source.props.gridAutoFlow === 'column') {
        const flowChildren = (node.children || []).filter((child) => child.source?.props?.position !== 'absolute');
        const allExplicit = flowChildren.every((child) => child.source?.props?.gridRow != null && child.source?.props?.gridColumn != null);
        if (!allExplicit) problems.push(`${path}: column Grid auto-flow needs explicit gridRow/gridColumn placement for every flow child`);
      } else if (node.source.props.gridAutoFlow != null && node.source.props.gridAutoFlow !== 'row') {
        problems.push(`${path}: gridAutoFlow is unsupported`);
      }
      try {
        const rows = structuredTracks(node.source.props.gridRows).length;
        const columns = structuredTracks(node.source.props.gridColumns).length;
        const occupied = new Set();
        for (let index = 0; index < (node.children || []).length; index++) {
          const childProps = node.children[index]?.source?.props || {};
          if (childProps.gridRow == null && childProps.gridColumn == null) continue;
          if (childProps.gridRow == null || childProps.gridColumn == null) {
            problems.push(`${path}.children[${index}]: explicit Grid placement needs both gridRow and gridColumn`);
            continue;
          }
          const row = Number(childProps.gridRow), column = Number(childProps.gridColumn);
          const rowSpan = Number(childProps.gridRowSpan || 1), columnSpan = Number(childProps.gridColumnSpan || 1);
          if (![row, column, rowSpan, columnSpan].every(Number.isInteger)) continue;
          if (row + rowSpan - 1 > rows || column + columnSpan - 1 > columns) {
            problems.push(`${path}.children[${index}]: Grid placement exceeds declared tracks`);
            continue;
          }
          for (let r = row; r < row + rowSpan; r++) {
            for (let c = column; c < column + columnSpan; c++) {
              const cell = `${r}:${c}`;
              if (occupied.has(cell)) problems.push(`${path}.children[${index}]: Grid placement overlaps cell ${cell}`);
              occupied.add(cell);
            }
          }
        }
      } catch {}
    }
  };
  visit(plan.root);
  if (fallbackAnnotationCount > 500) problems.push('Render Plan exceeds 500 fallback annotations');
  return { supported: problems.length === 0, problems };
}

async function prepareStructuredVariables(figmaApi, plan) {
  const intents = [];
  const bindings = new WeakMap();
  const addColor = (node, key, raw) => {
    const spec = structuredVariableSpec(raw);
    if (spec) intents.push({ node, key, type: 'COLOR', spec, kind: null });
  };
  const addFloat = (node, key, raw, kind, { generated = true } = {}) => {
    const spec = structuredVariableSpec(raw);
    if (spec) intents.push({ node, key, type: 'FLOAT', spec, kind });
    else if (generated && Number(raw) > 0) {
      const number = Number(raw);
      // Figma rejects decimal points in variable names. Keep the exact numeric
      // value while using the established token-safe spelling (0.5 -> 0-5).
      const tokenNumber = String(number).replace(/\./g, '-');
      intents.push({
        node, key, type: 'FLOAT', kind,
        spec: { requested: `${kind === 'radius' ? 'radius' : 'space'}/${tokenNumber}px`, name: `${kind === 'radius' ? 'radius' : 'space'}/${tokenNumber}px`, collection: null, fallback: String(number) },
        generated: true,
      });
    }
  };
  const addString = (node, key, raw, kind) => {
    const spec = structuredVariableSpec(raw);
    if (spec) intents.push({ node, key, type: 'STRING', spec, kind });
  };
  const addDimensions = (node, props) => {
    addFloat(node, 'width', props.w ?? props.width, 'dimension', { generated: false });
    addFloat(node, 'height', props.h ?? props.height, 'dimension', { generated: false });
    addFloat(node, 'minWidth', props.minW, 'dimension', { generated: false });
    addFloat(node, 'maxWidth', props.maxW, 'dimension', { generated: false });
    addFloat(node, 'minHeight', props.minH, 'dimension', { generated: false });
    addFloat(node, 'maxHeight', props.maxH, 'dimension', { generated: false });
  };
  const collect = (node) => {
    const props = node.source.props;
    const type = node.source.type;
    addDimensions(node, props);
    if (type === 'frame') {
      addColor(node, 'fill', props.bg ?? props.fill);
      addColor(node, 'stroke', props.stroke);
      const padding = props.p ?? props.padding;
      const px = props.px ?? padding, py = props.py ?? padding;
      addFloat(node, 'paddingTop', props.pt ?? py, 'space');
      addFloat(node, 'paddingRight', props.pr ?? px, 'space');
      addFloat(node, 'paddingBottom', props.pb ?? py, 'space');
      addFloat(node, 'paddingLeft', props.pl ?? px, 'space');
      if (props.flex === 'grid') {
        addFloat(node, 'gridRowGap', props.rowGap, 'space');
        addFloat(node, 'gridColumnGap', props.columnGap ?? props.gap, 'space');
      } else {
        const horizontal = props.flex === 'row';
        if (props.justify !== 'between') addFloat(node, 'itemSpacing', horizontal ? (props.columnGap ?? props.gap) : (props.rowGap ?? props.gap), 'space');
        if (props.wrap === true || props.wrap === 'true') addFloat(node, 'counterAxisSpacing', horizontal
          ? (props.rowGap ?? props.wrapGap ?? props.counterAxisSpacing)
          : (props.columnGap ?? props.wrapGap ?? props.counterAxisSpacing), 'space');
      }
      const radius = props.rounded ?? props.radius;
      addFloat(node, 'topLeftRadius', props.roundedTL ?? radius, 'radius');
      addFloat(node, 'topRightRadius', props.roundedTR ?? radius, 'radius');
      addFloat(node, 'bottomLeftRadius', props.roundedBL ?? radius, 'radius');
      addFloat(node, 'bottomRightRadius', props.roundedBR ?? radius, 'radius');
    } else if (type === 'text') {
      addColor(node, 'fill', props.color);
      addFloat(node, 'fontSize', props.size, 'typography', { generated: false });
      addFloat(node, 'fontWeight', props.weight, 'typography', { generated: false });
      addFloat(node, 'lineHeight', props.lineHeight, 'typography', { generated: false });
      addFloat(node, 'letterSpacing', props.letterSpacing, 'typography', { generated: false });
      addFloat(node, 'paragraphSpacing', props.paragraphSpacing, 'typography', { generated: false });
      addFloat(node, 'paragraphIndent', props.paragraphIndent, 'typography', { generated: false });
      addString(node, 'fontFamily', props.font, 'typography');
      addString(node, 'fontStyle', props.fontStyle, 'typography');
    } else if (type === 'rect' || type === 'image') {
      if (type === 'rect') addColor(node, 'fill', props.bg ?? props.fill);
      const radius = props.rounded ?? props.radius;
      addFloat(node, 'topLeftRadius', props.roundedTL ?? radius, 'radius');
      addFloat(node, 'topRightRadius', props.roundedTR ?? radius, 'radius');
      addFloat(node, 'bottomLeftRadius', props.roundedBL ?? radius, 'radius');
      addFloat(node, 'bottomRightRadius', props.roundedBR ?? radius, 'radius');
    } else if (type === 'ellipse') {
      addColor(node, 'fill', props.bg ?? props.fill);
      addColor(node, 'stroke', props.stroke);
    } else if (type === 'icon') addColor(node, 'color', props.color ?? props.c);
    else if (type === 'instance') {
      for (const entry of structuredOverrideEntries(props, 'fill')) addColor(node, entry.key, entry.value);
    }
    for (const child of node.children || []) collect(child);
  };
  collect(plan.root);

  const reusedVariableIds = new Set();
  const report = { references: intents.length, reused: 0, created: 0, bound: 0, ambiguous: 0, unsupported: 0 };
  const fail = (prefix, entries, { unsupported = null } = {}) => {
    const ambiguous = entries.filter((entry) => /ambiguous/i.test(entry)).length;
    const next = {
      ...report,
      reused: reusedVariableIds.size,
      ambiguous,
      unsupported: unsupported ?? Math.max(0, entries.length - ambiguous),
    };
    throw new Error(`${prefix}: ${entries.slice(0, 5).join('; ')} [variable report: reused=${next.reused}, created=0, bound=0, ambiguous=${next.ambiguous}, unsupported=${next.unsupported}]`);
  };

  if (intents.length && !figmaApi.variables) fail('Structured variable preflight failed', ['Figma variables are unavailable']);
  const [collections, variables] = intents.length
    ? await Promise.all([
      figmaApi.variables.getLocalVariableCollectionsAsync(),
      figmaApi.variables.getLocalVariablesAsync(),
    ])
    : [[], []];
  const failures = [];
  const pending = new Map();
  const plannedNames = new Map();
  const resolutions = new Map();

  const variableValue = (variable, seen = new Set()) => {
    if (!variable || seen.has(variable.id)) return null;
    seen.add(variable.id);
    let value = Object.values(variable.valuesByMode || {})[0];
    if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
      value = variableValue(variables.find((candidate) => candidate.id === value.id), seen);
    }
    return value;
  };
  const chooseCollection = (requested, allowMissing, label) => {
    if (!requested) return null;
    const lower = requested.toLowerCase();
    let matches = collections.filter((collection) => collection.name.toLowerCase() === lower);
    if (!matches.length) matches = collections.filter((collection) => collection.name.toLowerCase().includes(lower));
    if (matches.length > 1) {
      failures.push(`${label}: collection "${requested}" is ambiguous (${matches.map((item) => item.name).join(', ')})`);
      return null;
    }
    if (!matches.length && !allowMissing) failures.push(`${label}: collection "${requested}" does not exist`);
    return matches[0] || null;
  };
  const namespaceMatches = (name, kind) => {
    const head = String(name || '').toLowerCase().split('/')[0];
    return kind === 'radius' ? ['radius', 'radii'].includes(head) : ['space', 'spacing'].includes(head);
  };
  const resolveIntent = (intent, index) => {
    const label = `variable ${intent.spec.requested} at intent ${index + 1}`;
    const requestedCollection = intent.spec.collection || plan.variableCollection || null;
    const fallback = intent.type === 'FLOAT'
      ? (intent.spec.fallback == null ? null : Number(intent.spec.fallback))
      : intent.spec.fallback;
    const mayCreate = fallback != null && (intent.type !== 'FLOAT' || Number.isFinite(fallback));
    const collection = chooseCollection(requestedCollection, mayCreate, label);
    if (requestedCollection && !collection && failures.some((failure) => failure.startsWith(`${label}: collection`) && failure.includes('ambiguous'))) return null;
    const scoped = collection ? variables.filter((variable) => variable.variableCollectionId === collection.id) : requestedCollection ? [] : variables;
    let candidates;
    if (intent.generated) {
      // Literal spacing/radius values own a deterministic generated identity.
      // Value matching against authored aliases (for example space/5 and
      // space/xl both equal to 20) guesses design-system semantics and makes a
      // harmless literal ambiguous. Reuse only the exact generated name;
      // otherwise create that name in the chosen/default collection.
      candidates = scoped.filter((variable) => variable.resolvedType === 'FLOAT'
        && namespaceMatches(variable.name, intent.kind)
        && variable.name === intent.spec.name);
    } else {
      candidates = scoped.filter((variable) => variable.name === intent.spec.name);
      if (!candidates.length) candidates = scoped.filter((variable) => variable.name.split('/').slice(-1)[0] === intent.spec.name);
    }
    if (candidates.length > 1) {
      failures.push(`${label}: variable is ambiguous (${candidates.map((item) => item.name).join(', ')})`);
      return null;
    }
    if (candidates.length === 1) {
      const variable = candidates[0];
      if (variable.resolvedType !== intent.type) {
        failures.push(`${label}: expected ${intent.type}, found ${variable.resolvedType}`);
        return null;
      }
      reusedVariableIds.add(variable.id);
      return { variable, value: variableValue(variable) };
    }
    if (!mayCreate) {
      failures.push(`${label}: missing ${intent.type} variable and no usable fallback was supplied`);
      return null;
    }
    const targetName = requestedCollection || 'Tokens';
    const identity = `${targetName.toLowerCase()}:${intent.spec.name}`;
    const priorType = plannedNames.get(identity);
    if (priorType && priorType !== intent.type) {
      failures.push(`${label}: the same variable is required as both ${priorType} and ${intent.type}`);
      return null;
    }
    plannedNames.set(identity, intent.type);
    const key = `${identity}:${intent.type}`;
    const prior = pending.get(key);
    if (prior && JSON.stringify(prior.value) !== JSON.stringify(fallback)) {
      failures.push(`${label}: conflicting fallback values for the same variable`);
      return null;
    }
    if (!prior) pending.set(key, {
      key, name: intent.spec.name, type: intent.type, value: fallback,
      collection, collectionName: targetName,
    });
    return { pendingKey: key, value: fallback };
  };

  for (let index = 0; index < intents.length; index++) resolutions.set(intents[index], resolveIntent(intents[index], index));
  if (failures.length) fail('Structured variable preflight failed', failures);

  const intentByNode = new WeakMap();
  for (const intent of intents) {
    if (!intentByNode.has(intent.node)) intentByNode.set(intent.node, new Map());
    intentByNode.get(intent.node).set(intent.key, intent);
  }
  const resolvedIntentValue = (node, key, raw, fallback) => {
    const intent = intentByNode.get(node)?.get(key);
    if (!intent) return raw ?? fallback;
    const resolution = resolutions.get(intent);
    const final = resolution?.pendingKey ? pending.get(resolution.pendingKey) : resolution;
    return final?.value ?? intent.spec.fallback ?? raw ?? fallback;
  };
  const fontNames = new WeakMap();
  const runFontNames = new WeakMap();
  const fontRequests = [];
  const collectTextFonts = (node) => {
    if (node.source.type === 'text') {
      const props = node.source.props;
      const family = String(resolvedIntentValue(node, 'fontFamily', props.font, 'Inter'));
      const weight = resolvedIntentValue(node, 'fontWeight', props.weight, 400);
      const explicitStyle = resolvedIntentValue(node, 'fontStyle', props.fontStyle, null);
      const fontName = { family, style: explicitStyle ? String(explicitStyle) : structuredFontStyle(weight, props.italic) };
      fontRequests.push({ node, fontName, exact: Boolean(structuredVariableSpec(props.font) || structuredVariableSpec(props.fontStyle)) });
      for (let index = 0; index < (props.runs || []).length; index++) {
        const style = props.runs[index].style || {};
        if (style.font == null && style.fontStyle == null && style.weight == null && style.italic == null) continue;
        const runFamily = String(style.font ?? family);
        const runStyle = style.fontStyle != null
          ? String(style.fontStyle)
          : structuredFontStyle(style.weight ?? weight, style.italic ?? props.italic);
        fontRequests.push({ node, runIndex: index, fontName: { family: runFamily, style: runStyle }, exact: false });
      }
    }
    for (const child of node.children || []) collectTextFonts(child);
  };
  collectTextFonts(plan.root);
  const loadedFontCache = new Map();
  for (const request of fontRequests) {
    const key = `${request.fontName.family}/${request.fontName.style}`;
    let loaded = loadedFontCache.get(key);
    if (!loaded) {
      let originalError = null;
      for (const candidate of structuredFontNameCandidates(request.fontName)) {
        try {
          await figmaApi.loadFontAsync(candidate);
          loaded = candidate;
          break;
        } catch (error) { originalError ||= error; }
      }
      if (!loaded) {
        if (request.exact) {
          fail('Structured variable preflight failed', [`bound font ${key} is unavailable; install it or provide an available family/style (${originalError?.message || originalError})`]);
        }
        const fallbacks = [
          ...structuredFontNameCandidates({ family: 'Inter', style: request.fontName.style }),
          { family: 'Inter', style: 'Regular' },
        ];
        for (const candidate of fallbacks) {
          try {
            await figmaApi.loadFontAsync(candidate);
            loaded = candidate;
            break;
          } catch {}
        }
        if (!loaded) throw originalError || new Error(`font ${key} is unavailable`);
      }
      loadedFontCache.set(key, loaded);
    }
    if (request.runIndex === undefined) fontNames.set(request.node, loaded);
    else {
      if (!runFontNames.has(request.node)) runFontNames.set(request.node, new Map());
      runFontNames.get(request.node).set(request.runIndex, loaded);
    }
  }

  const createdVariables = [];
  const createdVariableObjects = [];
  const scopeQuestions = [];
  const createdCollections = new Map();
  const newCollectionObjects = [];
  try {
    for (const descriptor of pending.values()) {
      let collection = descriptor.collection;
      if (!collection) {
        const key = descriptor.collectionName.toLowerCase();
        collection = createdCollections.get(key)
          || collections.find((candidate) => candidate.name.toLowerCase() === key);
        if (!collection) {
          collection = figmaApi.variables.createVariableCollection(descriptor.collectionName);
          newCollectionObjects.push(collection);
        }
        createdCollections.set(key, collection);
        if (!collections.includes(collection)) collections.push(collection);
      }
      let name = descriptor.name;
      if (variables.some((variable) => variable.variableCollectionId === collection.id && variable.name === name)) {
        let suffix = 2;
        while (variables.some((variable) => variable.variableCollectionId === collection.id && variable.name === `${descriptor.name}-${suffix}`)) suffix++;
        name = `${descriptor.name}-${suffix}`;
      }
      const variable = figmaApi.variables.createVariable(name, collection, descriptor.type);
      createdVariableObjects.push(variable);
      const value = descriptor.type === 'COLOR'
        ? (() => {
          const source = String(descriptor.value).replace(/^#/, '');
          const full = source.length === 3 ? source.split('').map((part) => part + part).join('') : source;
          return { r: parseInt(full.slice(0, 2), 16) / 255, g: parseInt(full.slice(2, 4), 16) / 255, b: parseInt(full.slice(4, 6), 16) / 255, a: full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1 };
        })()
        : descriptor.value;
      for (const mode of collection.modes || []) variable.setValueForMode(mode.modeId, value);
      const scopes = structuredVariableScopes(name, descriptor.type);
      if (scopes) variable.scopes = scopes;
      else scopeQuestions.push(structuredScopeQuestion(name, descriptor.type, collection.name));
      variables.push(variable);
      createdVariables.push(`${collection.name}/${name}`);
      descriptor.variable = variable;
      descriptor.value = value;
    }
  } catch (error) {
    // Resource preparation is part of preflight. Roll back any primitives
    // created earlier in this loop so a rejected name/value cannot leave a
    // partially populated token collection behind.
    for (const variable of createdVariableObjects.reverse()) {
      try { variable.remove(); } catch {}
    }
    for (const collection of newCollectionObjects.reverse()) {
      try { collection.remove(); } catch {}
    }
    throw error;
  }

  for (const intent of intents) {
    const resolution = resolutions.get(intent);
    if (!resolution) continue;
    const final = resolution.pendingKey ? pending.get(resolution.pendingKey) : resolution;
    if (!bindings.has(intent.node)) bindings.set(intent.node, new Map());
    bindings.get(intent.node).set(intent.key, { variable: final.variable, value: final.value });
  }
  Object.assign(report, {
    reused: reusedVariableIds.size,
    created: createdVariables.length,
    bound: intents.length,
  });
  return { bindings, createdVariables: createdVariables.sort(), scopeQuestions, fontNames, runFontNames, variableReport: report };
}

function structuredTextStyleValue(value, fallback) {
  if (!value || typeof value !== 'object') return fallback;
  const unit = String(value.unit || fallback.unit).toUpperCase();
  if (unit === 'AUTO') return { unit: 'AUTO' };
  return { unit, value: structuredNumber(value.value, fallback.value) };
}

function structuredTextStyleSignature(descriptor) {
  // Figma stores many style scalars as float32 (for example 1.54 becomes
  // 1.5399999618530273). Canonicalize before reconciliation so a style just
  // created from the same CSS value can be reused by the next text run.
  const canonicalNumber = (value) => Math.round(structuredNumber(value) * 10000) / 10000;
  const lineHeight = structuredTextStyleValue(descriptor.lineHeight, { unit: 'AUTO' });
  let letterSpacing = structuredTextStyleValue(descriptor.letterSpacing, { unit: 'PIXELS', value: 0 });
  if (canonicalNumber(letterSpacing.value) === 0) letterSpacing = { unit: 'PIXELS', value: 0 };
  return JSON.stringify({
    family: descriptor.fontName?.family || '',
    style: descriptor.fontName?.style || '',
    size: canonicalNumber(descriptor.fontSize),
    lineHeight: lineHeight.unit === 'AUTO' ? lineHeight : { ...lineHeight, value: canonicalNumber(lineHeight.value) },
    letterSpacing: { ...letterSpacing, value: canonicalNumber(letterSpacing.value) },
    paragraphSpacing: canonicalNumber(descriptor.paragraphSpacing),
    paragraphIndent: canonicalNumber(descriptor.paragraphIndent),
  });
}

async function prepareStructuredTextStyles(figmaApi, plan, variableContext) {
  const requests = [];
  const bindings = new WeakMap();
  const bindingValue = (node, key, raw, fallback) => variableContext.bindings.get(node)?.get(key)?.value ?? raw ?? fallback;
  const collect = (node) => {
    if (node.source.type === 'text') {
      const props = node.source.props;
      const fontName = variableContext.fontNames.get(node) || {
        family: String(bindingValue(node, 'fontFamily', props.font, 'Inter')),
        style: String(bindingValue(node, 'fontStyle', props.fontStyle, structuredFontStyle(bindingValue(node, 'fontWeight', props.weight, 400), props.italic))),
      };
      requests.push({
        node,
        explicitName: String(props.style || '').trim() || null,
        descriptor: {
          fontName,
          fontSize: structuredNumber(bindingValue(node, 'fontSize', props.size, 14), 14),
          lineHeight: props.lineHeight == null ? { unit: 'AUTO' } : { unit: 'PIXELS', value: structuredNumber(bindingValue(node, 'lineHeight', props.lineHeight)) },
          letterSpacing: props.letterSpacing == null ? { unit: 'PIXELS', value: 0 } : { unit: 'PIXELS', value: structuredNumber(bindingValue(node, 'letterSpacing', props.letterSpacing)) },
          paragraphSpacing: structuredNumber(bindingValue(node, 'paragraphSpacing', props.paragraphSpacing, 0)),
          paragraphIndent: structuredNumber(bindingValue(node, 'paragraphIndent', props.paragraphIndent, 0)),
        },
      });
    }
    for (const child of node.children || []) collect(child);
  };
  collect(plan.root);
  if (!requests.length) return { bindings, createdStyles: [], textStyleReport: { references: 0, reused: 0, created: 0, bound: 0 } };
  if (typeof figmaApi.getLocalTextStylesAsync !== 'function' || typeof figmaApi.createTextStyle !== 'function') {
    throw new Error('Structured text-style preflight failed: local Text Style APIs are unavailable');
  }

  const styles = await figmaApi.getLocalTextStylesAsync();
  const createdObjects = [];
  const reusedIds = new Set();
  const createdStyles = [];
  const styleBySignature = new Map();
  for (const style of styles) {
    const signature = structuredTextStyleSignature(style);
    if (!styleBySignature.has(signature)) styleBySignature.set(signature, style);
  }
  const generatedName = (descriptor) => {
    const family = String(descriptor.fontName.family).replace(/\//g, '-');
    const lineHeight = descriptor.lineHeight.unit === 'AUTO' ? 'Auto' : `${descriptor.lineHeight.value}px`;
    const letterSpacing = descriptor.letterSpacing.value ? ` · LS ${descriptor.letterSpacing.value}px` : '';
    return `Typography/Generated/${family}/${descriptor.fontSize} ${descriptor.fontName.style} · LH ${lineHeight}${letterSpacing}`;
  };

  try {
    for (const request of requests) {
      const signature = structuredTextStyleSignature(request.descriptor);
      let style;
      if (request.explicitName) {
        style = styles.find((candidate) => candidate.name === request.explicitName);
        if (style && structuredTextStyleSignature(style) !== signature) {
          throw new Error(`named Text Style "${request.explicitName}" exists with different typography; reconcile or rename it before render`);
        }
      } else {
        style = styleBySignature.get(signature);
      }
      if (style) reusedIds.add(style.id);
      else {
        const name = request.explicitName || generatedName(request.descriptor);
        const sameName = styles.find((candidate) => candidate.name === name);
        if (sameName) throw new Error(`generated Text Style "${name}" collides with different typography`);
        style = figmaApi.createTextStyle();
        style.name = name;
        style.fontName = request.descriptor.fontName;
        style.fontSize = request.descriptor.fontSize;
        style.lineHeight = request.descriptor.lineHeight;
        style.letterSpacing = request.descriptor.letterSpacing;
        style.paragraphSpacing = request.descriptor.paragraphSpacing;
        style.paragraphIndent = request.descriptor.paragraphIndent;
        styles.push(style);
        createdObjects.push(style);
        createdStyles.push(name);
        styleBySignature.set(signature, style);
      }
      bindings.set(request.node, style);
    }
  } catch (error) {
    for (const style of createdObjects.reverse()) {
      try { style.remove(); } catch {}
    }
    throw new Error(`Structured text-style preflight failed: ${error.message || error}`);
  }
  return {
    bindings,
    createdStyles,
    textStyleReport: {
      references: requests.length,
      reused: reusedIds.size,
      created: createdStyles.length,
      bound: requests.length,
    },
  };
}

function auditStructuredCreatedNodes(records) {
  const mismatches = [];
  const summary = {
    nodes: records.length, grids: 0, autoLayouts: 0, freeLayouts: 0,
    instances: 0, absoluteNodes: 0,
  };
  const expectedTypes = {
    frame: 'FRAME', text: 'TEXT', rect: 'RECTANGLE', image: 'RECTANGLE',
    ellipse: 'ELLIPSE', icon: 'FRAME', instance: 'INSTANCE',
  };
  const mismatch = (semanticNode, fact, expected, actual) => mismatches.push({
    path: semanticNode.path, fact, expected, actual,
  });
  for (let index = 0; index < records.length; index++) {
    const { semanticNode, created, parent } = records[index];
    const sourceType = semanticNode.source.type;
    const props = semanticNode.source.props;
    const expectedType = expectedTypes[sourceType];
    if (created.type !== expectedType) mismatch(semanticNode, 'node type', expectedType, created.type);
    if (sourceType === 'instance') summary.instances++;
    if (sourceType === 'frame') {
      const expectedLayout = props.flex === 'grid'
        ? 'GRID'
        : ['none', 'stack', 'free'].includes(props.flex)
          ? 'NONE'
          : props.flex === 'row' ? 'HORIZONTAL' : 'VERTICAL';
      if (created.layoutMode !== expectedLayout) mismatch(semanticNode, 'layout mode', expectedLayout, created.layoutMode);
      if (expectedLayout === 'GRID') summary.grids++;
      else if (expectedLayout === 'NONE') summary.freeLayouts++;
      else summary.autoLayouts++;
    }
    if (parent && created.parent !== parent) {
      mismatch(semanticNode, 'parent', parent.id, created.parent?.id || null);
    }
    if (props.position === 'absolute') {
      summary.absoluteNodes++;
      if (parent?.layoutMode !== 'NONE' && created.layoutPositioning !== 'ABSOLUTE') {
        mismatch(semanticNode, 'layout positioning', 'ABSOLUTE', created.layoutPositioning || null);
      }
    }
    if (created.getPluginData('figmaBridge.semanticPath') !== String(semanticNode.path || '')) {
      mismatch(semanticNode, 'semantic path metadata', String(semanticNode.path || ''), created.getPluginData('figmaBridge.semanticPath'));
    }
    if (created.getPluginData('figmaBridge.semanticIndex') !== String(index)) {
      mismatch(semanticNode, 'semantic index metadata', String(index), created.getPluginData('figmaBridge.semanticIndex'));
    }
  }
  return {
    version: 1,
    passed: mismatches.length === 0,
    summary,
    mismatchCount: mismatches.length,
    ...(mismatches.length ? { mismatches: mismatches.slice(0, 20) } : {}),
  };
}

async function executeStructuredRenderPlan(figmaApi, plan) {
  const support = inspectStructuredRenderPlan(plan);
  if (!support.supported) {
    const error = new Error(`Structured render unsupported: ${support.problems.slice(0, 5).join('; ')}`);
    throw error;
  }
  const componentContext = await prepareStructuredComponents(figmaApi, plan);
  const imageContext = await prepareStructuredImages(figmaApi, plan);
  const createdRecords = [];
  const fallbackAnnotationReport = { requested: 0, applied: 0, deduplicated: 0, unsupported: 0 };

  const value = (props, short, long, fallback = undefined) => props[short] ?? props[long] ?? fallback;
  const hex = (input) => {
    let source = String(input || '#000000').replace(/^#/, '');
    if (source.length === 3) source = source.split('').map((part) => part + part).join('');
    const alpha = source.length === 8 ? parseInt(source.slice(6), 16) / 255 : 1;
    source = source.slice(0, 6);
    return {
      type: 'SOLID',
      color: { r: parseInt(source.slice(0, 2), 16) / 255, g: parseInt(source.slice(2, 4), 16) / 255, b: parseInt(source.slice(4, 6), 16) / 255 },
      ...(alpha < 1 ? { opacity: alpha } : {}),
    };
  };
  const align = { start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'STRETCH' };
  const justify = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };

  const variableContext = await prepareStructuredVariables(figmaApi, plan);
  const bindingFor = (node, key) => variableContext.bindings.get(node)?.get(key) || null;
  const resolvedNumber = (node, key, raw, fallback = 0) => {
    const binding = bindingFor(node, key);
    if (binding && typeof binding.value === 'number') return binding.value;
    const spec = structuredVariableSpec(raw);
    return structuredNumber(spec?.fallback ?? raw, fallback);
  };
  const resolvedString = (node, key, raw, fallback = '') => {
    const binding = bindingFor(node, key);
    if (binding && typeof binding.value === 'string') return binding.value;
    const spec = structuredVariableSpec(raw);
    return String(spec?.fallback ?? raw ?? fallback);
  };
  const bindScalar = (node, key, created, field) => {
    const binding = bindingFor(node, key);
    if (binding) created.setBoundVariable(field, binding.variable);
  };
  const boundPaint = (node, key, raw, fallback = '#808080', target = null) => {
    const binding = bindingFor(node, key);
    const spec = structuredVariableSpec(raw);
    const resolved = spec?.fallback || (binding ? fallback : raw || fallback);
    const paint = binding ? hex(resolved) : structuredGradientPaint(resolved, target) || hex(resolved);
    return binding ? figmaApi.variables.setBoundVariableForPaint(paint, 'color', binding.variable) : paint;
  };
  const boundPaints = (node, key, raw, fallback = '#808080', target = null) => {
    const binding = bindingFor(node, key);
    if (binding || structuredVariableSpec(raw)) return [boundPaint(node, key, raw, fallback, target)];
    const layers = structuredPaintLayers(raw || fallback);
    return layers.map((layer) => structuredGradientPaint(layer, target) || hex(layer));
  };
  const textStyleContext = await prepareStructuredTextStyles(figmaApi, plan, variableContext);
  const applyRichTextRuns = (created, semanticNode, props) => {
    for (let index = 0; index < (props.runs || []).length; index++) {
      const run = props.runs[index];
      const style = run.style || {};
      const fontName = variableContext.runFontNames.get(semanticNode)?.get(index);
      if (fontName) created.setRangeFontName(run.start, run.end, fontName);
      if (style.size != null) created.setRangeFontSize(run.start, run.end, structuredNumber(style.size));
      if (style.color != null) created.setRangeFills(run.start, run.end, [hex(style.color)]);
      if (style.letterSpacing != null) {
        created.setRangeLetterSpacing(run.start, run.end, { unit: 'PIXELS', value: structuredNumber(style.letterSpacing) });
      }
      const decoration = style.decoration != null
        ? String(style.decoration).toUpperCase()
        : (style.underline === true || style.underline === 'true') ? 'UNDERLINE' : null;
      if (decoration) created.setRangeTextDecoration(run.start, run.end, decoration);
      if (style.href) created.setRangeHyperlink(run.start, run.end, { type: 'URL', value: String(style.href) });
    }
  };

  const applyInstanceOverrides = (created, semanticNode) => {
    const prepared = componentContext.overrides.get(semanticNode);
    if (!prepared) return;
    const properties = {};
    for (const [key, raw] of Object.entries(prepared.properties)) {
      if (raw && typeof raw === 'object' && raw.entity) {
        const target = componentContext.swapComponents.get(raw.entity);
        if (!target) throw new Error(`Structured component preflight lost swap Design Entity ${raw.entity}`);
        properties[key] = target.id;
      } else properties[key] = raw;
    }
    if (Object.keys(properties).length) created.setProperties(properties);
    for (const entry of prepared.texts) {
      const target = structuredFindOverrideLayer(created, entry.target, (candidate) => candidate.type === 'TEXT', `Instance ${created.name} text:${entry.target}`);
      target.characters = String(entry.value);
    }
    for (const entry of prepared.fills) {
      const target = structuredFindOverrideLayer(created, entry.target, (candidate) => 'fills' in candidate, `Instance ${created.name} fill:${entry.target}`);
      target.fills = [boundPaint(semanticNode, entry.key, entry.value, '#808080', target)];
    }
    for (const entry of prepared.swaps) {
      const target = structuredFindOverrideLayer(created, entry.target, (candidate) => candidate.type === 'INSTANCE', `Instance ${created.name} swap:${entry.target}`);
      const component = componentContext.swapComponents.get(entry.entity);
      if (!component) throw new Error(`Structured component preflight lost swap Design Entity ${entry.entity}`);
      target.swapComponent(component);
    }
  };

  const existing = [...figmaApi.currentPage.children];
  const initialX = existing.reduce((right, node) => Math.max(right, structuredNumber(node.x) + structuredNumber(node.width)), 0) + (existing.length ? 100 : 0);

  const applyPlacement = (created, semanticNode, props, parent) => {
    if (props.opacity != null) created.opacity = structuredNumber(props.opacity, 1);
    if (props.visible === false || props.visible === 'false') created.visible = false;
    if (props.locked === true || props.locked === 'true') created.locked = true;
    if (props.rotate != null) created.rotation = structuredNumber(props.rotate);
    if (props.blendMode != null) created.blendMode = String(props.blendMode).toUpperCase().replace(/-/g, '_');
    if (props.mask != null || props.maskType != null) {
      created.isMask = !(props.mask === false || props.mask === 'false');
      if (created.isMask) created.maskType = String(props.maskType || (typeof props.mask === 'string' ? props.mask : 'ALPHA')).toUpperCase();
    }
    for (const [prop, apiName] of [['minW', 'minWidth'], ['maxW', 'maxWidth'], ['minH', 'minHeight'], ['maxH', 'maxHeight']]) {
      if (props[prop] != null) {
        created[apiName] = resolvedNumber(semanticNode, apiName, props[prop]);
        bindScalar(semanticNode, apiName, created, apiName);
      }
    }
    if (!parent) return;
    if (props.position === 'absolute' && parent.layoutMode !== 'NONE') created.layoutPositioning = 'ABSOLUTE';
    if (props.x != null) created.x = structuredNumber(props.x);
    if (props.y != null) created.y = structuredNumber(props.y);
    if (props.grow != null && parent.layoutMode !== 'NONE') created.layoutGrow = structuredNumber(props.grow);
    const width = value(props, 'w', 'width');
    const height = value(props, 'h', 'height');
    if (width === 'fill' && parent.layoutMode !== 'NONE') created.layoutSizingHorizontal = 'FILL';
    if (height === 'fill' && parent.layoutMode !== 'NONE') created.layoutSizingVertical = 'FILL';
    if (props.stretch === true || props.stretch === 'true') {
      if (parent.layoutMode === 'HORIZONTAL') created.layoutSizingVertical = 'FILL';
      if (parent.layoutMode === 'VERTICAL') created.layoutSizingHorizontal = 'FILL';
    }
    if (parent.layoutMode === 'GRID') {
      const row = structuredNumber(props.gridRow, 0), column = structuredNumber(props.gridColumn, 0);
      if (row > 0 && column > 0) created.setGridChildPosition(row - 1, column - 1);
      if (props.gridRowSpan != null) created.gridRowSpan = structuredNumber(props.gridRowSpan, 1);
      if (props.gridColumnSpan != null) created.gridColumnSpan = structuredNumber(props.gridColumnSpan, 1);
      const horizontal = String(props.gridHAlign || '').toUpperCase();
      const vertical = String(props.gridVAlign || '').toUpperCase();
      if (horizontal) created.gridChildHorizontalAlign = horizontal;
      if (vertical) created.gridChildVerticalAlign = vertical;
    }
  };

  const applyFallbackAnnotations = (created, semanticNode) => {
    const intents = semanticNode.fallbackAnnotations || [];
    if (!intents.length) return;
    const storedPolicies = new Set();
    try {
      const stored = JSON.parse(created.getPluginData('figmaBridge.fallbackAnnotations') || '{}');
      for (const entry of stored.annotations || []) if (entry?.policy) storedPolicies.add(entry.policy);
    } catch {}
    const metadata = [];
    for (const intent of intents) {
      fallbackAnnotationReport.requested++;
      metadata.push({ policy: intent.policy, fact: intent.fact || intent.policy });
      if (storedPolicies.has(intent.policy)) {
        fallbackAnnotationReport.deduplicated++;
        continue;
      }
      if (!('annotations' in created)) {
        fallbackAnnotationReport.unsupported++;
        continue;
      }
      const existing = Array.from(created.annotations || [], (annotation) => ({
        ...(annotation.labelMarkdown ? { labelMarkdown: annotation.labelMarkdown } : annotation.label ? { label: annotation.label } : {}),
        ...(annotation.categoryId ? { categoryId: annotation.categoryId } : {}),
        ...(annotation.properties ? { properties: Array.from(annotation.properties, (property) => ({ type: property.type })) } : {}),
      }));
      if (existing.some((annotation) => 'labelMarkdown' in annotation && annotation.labelMarkdown === intent.labelMarkdown)) {
        fallbackAnnotationReport.deduplicated++;
        storedPolicies.add(intent.policy);
        continue;
      }
      created.annotations = [...existing, {
        labelMarkdown: intent.labelMarkdown,
        properties: intent.properties.map((type) => ({ type })),
      }];
      storedPolicies.add(intent.policy);
      fallbackAnnotationReport.applied++;
    }
    created.setPluginData('figmaBridge.fallbackAnnotations', JSON.stringify({
      schemaVersion: 1,
      annotations: metadata,
    }));
  };

  const create = async (semanticNode, parent = null, root = false) => {
    const props = semanticNode.source.props;
    let created;
    if (semanticNode.source.type === 'text') {
      created = figmaApi.createText();
      created.name = props.name || String(props.content || '').slice(0, 40) || 'Text';
      created.fontName = variableContext.fontNames.get(semanticNode)
        || { family: resolvedString(semanticNode, 'fontFamily', props.font, 'Inter'), style: resolvedString(semanticNode, 'fontStyle', props.fontStyle, structuredFontStyle(resolvedNumber(semanticNode, 'fontWeight', props.weight, 400), props.italic)) };
      created.characters = String(props.content || '');
      const textStyle = textStyleContext.bindings.get(semanticNode);
      created.fontSize = resolvedNumber(semanticNode, 'fontSize', props.size, 14);
      bindScalar(semanticNode, 'fontSize', created, 'fontSize');
      bindScalar(semanticNode, 'fontFamily', created, 'fontFamily');
      bindScalar(semanticNode, 'fontStyle', created, 'fontStyle');
      bindScalar(semanticNode, 'fontWeight', created, 'fontWeight');
      const width = value(props, 'w', 'width', 'hug');
      if (width === 'hug') created.textAutoResize = 'WIDTH_AND_HEIGHT';
      // FILL sizing is applied by applyPlacement only after appendChild. Figma
      // rejects layoutSizingHorizontal while the text has no Auto Layout parent.
      else if (width === 'fill') created.textAutoResize = 'HEIGHT';
      else { created.textAutoResize = 'HEIGHT'; created.resize(resolvedNumber(semanticNode, 'width', width, Math.max(1, created.width)), resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), Math.max(1, created.height))); }
      if (props.color) created.fills = [boundPaint(semanticNode, 'fill', props.color, '#808080', created)];
      if (props.align) created.textAlignHorizontal = ({ left: 'LEFT', center: 'CENTER', right: 'RIGHT', justified: 'JUSTIFIED' })[props.align] || String(props.align).toUpperCase();
      if (props.lineHeight != null) {
        created.lineHeight = { unit: 'PIXELS', value: resolvedNumber(semanticNode, 'lineHeight', props.lineHeight) };
        bindScalar(semanticNode, 'lineHeight', created, 'lineHeight');
      }
      if (props.letterSpacing != null) {
        created.letterSpacing = { unit: 'PIXELS', value: resolvedNumber(semanticNode, 'letterSpacing', props.letterSpacing) };
        bindScalar(semanticNode, 'letterSpacing', created, 'letterSpacing');
      }
      if (props.paragraphSpacing != null) {
        created.paragraphSpacing = resolvedNumber(semanticNode, 'paragraphSpacing', props.paragraphSpacing);
        bindScalar(semanticNode, 'paragraphSpacing', created, 'paragraphSpacing');
      }
      if (props.paragraphIndent != null) {
        created.paragraphIndent = resolvedNumber(semanticNode, 'paragraphIndent', props.paragraphIndent);
        bindScalar(semanticNode, 'paragraphIndent', created, 'paragraphIndent');
      }
      if (props.truncate === true || props.truncate === 'true' || props.maxLines != null) created.textTruncation = 'ENDING';
      if (props.maxLines != null) created.maxLines = Number(props.maxLines);
      if (props.fontAxes != null) {
        created.setPluginData('figmaBridge.variableFontAxes', JSON.stringify({
          schemaVersion: 1,
          ranges: [{ start: 0, end: created.characters.length, axes: structuredFontAxes(props.fontAxes) }],
        }));
      }
      // Apply the named style only after every raw typography setter. Figma
      // detaches a Text Style when fontSize/fontName/lineHeight is assigned
      // after setTextStyleIdAsync, even when the value is identical.
      if (textStyle) {
        try { await created.setTextStyleIdAsync(textStyle.id); }
        catch { created.textStyleId = textStyle.id; }
        // Node-level token/color intent remains an explicit style override.
        for (const field of ['fontSize', 'fontFamily', 'fontStyle', 'fontWeight', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent']) {
          bindScalar(semanticNode, field, created, field);
        }
        if (props.color) created.fills = [boundPaint(semanticNode, 'fill', props.color, '#808080', created)];
      }
      applyRichTextRuns(created, semanticNode, props);
    } else if (semanticNode.source.type === 'rect') {
      created = figmaApi.createRectangle();
      created.name = props.name || 'Rectangle';
      created.resize(resolvedNumber(semanticNode, 'width', value(props, 'w', 'width'), 100), resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), 100));
      const background = props.bg ?? props.fill ?? '#e4e4e7';
      created.fills = background === 'none' ? [] : boundPaints(semanticNode, 'fill', background, '#808080', created);
      const radius = resolvedNumber(semanticNode, 'topLeftRadius', props.rounded ?? props.radius);
      created.cornerRadius = radius;
      created.topLeftRadius = resolvedNumber(semanticNode, 'topLeftRadius', props.roundedTL ?? props.rounded ?? props.radius);
      created.topRightRadius = resolvedNumber(semanticNode, 'topRightRadius', props.roundedTR ?? props.rounded ?? props.radius);
      created.bottomLeftRadius = resolvedNumber(semanticNode, 'bottomLeftRadius', props.roundedBL ?? props.rounded ?? props.radius);
      created.bottomRightRadius = resolvedNumber(semanticNode, 'bottomRightRadius', props.roundedBR ?? props.rounded ?? props.radius);
      for (const field of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) bindScalar(semanticNode, field, created, field);
      if (props.cornerSmoothing != null) created.cornerSmoothing = structuredNumber(props.cornerSmoothing);
      created.effects = structuredEffects(props);
    } else if (semanticNode.source.type === 'image') {
      created = figmaApi.createRectangle();
      created.name = props.name || semanticNode.asset.name || 'Image';
      created.resize(resolvedNumber(semanticNode, 'width', value(props, 'w', 'width'), 200), resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), 150));
      const imageHash = imageContext.bindings.get(semanticNode);
      if (!imageHash) throw new Error(`Structured image preflight lost ${created.name}`);
      created.fills = [{ type: 'IMAGE', imageHash, scaleMode: String(props.imageScale || 'FILL').toUpperCase() }];
      const radius = resolvedNumber(semanticNode, 'topLeftRadius', props.rounded ?? props.radius);
      created.cornerRadius = radius;
      created.topLeftRadius = resolvedNumber(semanticNode, 'topLeftRadius', props.roundedTL ?? props.rounded ?? props.radius);
      created.topRightRadius = resolvedNumber(semanticNode, 'topRightRadius', props.roundedTR ?? props.rounded ?? props.radius);
      created.bottomLeftRadius = resolvedNumber(semanticNode, 'bottomLeftRadius', props.roundedBL ?? props.rounded ?? props.radius);
      created.bottomRightRadius = resolvedNumber(semanticNode, 'bottomRightRadius', props.roundedBR ?? props.rounded ?? props.radius);
      for (const field of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) bindScalar(semanticNode, field, created, field);
      if (props.cornerSmoothing != null) created.cornerSmoothing = structuredNumber(props.cornerSmoothing);
      created.effects = structuredEffects(props);
    } else if (semanticNode.source.type === 'ellipse') {
      created = figmaApi.createEllipse();
      created.name = props.name || 'Ellipse';
      const width = resolvedNumber(semanticNode, 'width', value(props, 'w', 'width'), 100);
      created.resize(width, resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), width));
      const background = props.bg ?? props.fill;
      created.fills = background && background !== 'none' ? boundPaints(semanticNode, 'fill', background, '#808080', created) : [];
      if (props.stroke && props.stroke !== 'none') {
        created.strokes = [boundPaint(semanticNode, 'stroke', props.stroke, '#808080', created)];
        created.strokeWeight = structuredNumber(props.strokeWidth, 1);
        if (props.strokeAlign) created.strokeAlign = String(props.strokeAlign).toUpperCase();
        created.dashPattern = structuredDashPattern(props.strokeDashPattern);
        if (props.strokeCap) created.strokeCap = String(props.strokeCap).toUpperCase();
      }
      if (props.arc != null || props.arcStart != null || props.innerRadius != null) {
        const start = structuredNumber(props.arcStart) * Math.PI / 180;
        created.arcData = {
          startingAngle: start,
          endingAngle: start + structuredNumber(props.arc, 360) * Math.PI / 180,
          innerRadius: Math.max(0, Math.min(1, structuredNumber(props.innerRadius))),
        };
      }
      created.effects = structuredEffects(props);
    } else if (semanticNode.source.type === 'icon') {
      created = figmaApi.createNodeFromSvg(semanticNode.asset.svg);
      created.name = props.name || semanticNode.asset.name || 'Icon';
      created.fills = [];
      const size = structuredNumber(props.size ?? props.s, 24);
      created.resize(resolvedNumber(semanticNode, 'width', value(props, 'w', 'width'), size), resolvedNumber(semanticNode, 'height', value(props, 'h', 'height'), size));
      const preserveColors = props.preserveColors === true || props.preserveColors === 'true';
      const color = props.color ?? props.c;
      if (!preserveColors && color) {
        const paint = boundPaint(semanticNode, 'color', color);
        const recolor = (node) => {
          if (Array.isArray(node.fills) && node.fills.length) node.fills = [paint];
          if (Array.isArray(node.strokes) && node.strokes.length) node.strokes = [paint];
          for (const child of node.children || []) recolor(child);
        };
        for (const child of created.children || []) recolor(child);
      }
      for (const descriptor of structuredSvgFilterDescriptors(semanticNode.asset.svg)) {
        for (const filtered of created.findAll((node) => node.name === descriptor.id)) {
          filtered.effects = structuredEffects({ filter: descriptor.filter });
        }
      }
    } else if (semanticNode.source.type === 'instance') {
      const component = componentContext.bindings.get(semanticNode);
      if (!component) throw new Error(`Structured component preflight lost ${props.entity}`);
      created = component.createInstance();
      created.name = props.name || component.name || props.entity;
      applyInstanceOverrides(created, semanticNode);
      const requestedWidth = value(props, 'w', 'width');
      const requestedHeight = value(props, 'h', 'height');
      const numericWidth = requestedWidth != null && !['fill', 'hug'].includes(requestedWidth)
        ? resolvedNumber(semanticNode, 'width', requestedWidth, created.width) : created.width;
      const numericHeight = requestedHeight != null && !['fill', 'hug'].includes(requestedHeight)
        ? resolvedNumber(semanticNode, 'height', requestedHeight, created.height) : created.height;
      if (numericWidth !== created.width || numericHeight !== created.height) created.resize(numericWidth, numericHeight);
    } else {
      created = figmaApi.createFrame();
      created.name = props.name || 'Frame';
      const width = value(props, 'w', 'width');
      const height = value(props, 'h', 'height');
      const hug = String(props.hug || '');
      const hugWidth = ['both', 'w', 'width'].includes(hug);
      const hugHeight = ['both', 'h', 'height'].includes(hug);
      created.resize(typeof width === 'string' && ['fill', 'hug'].includes(width) ? 320 : resolvedNumber(semanticNode, 'width', width, 320), typeof height === 'string' && ['fill', 'hug'].includes(height) ? 200 : resolvedNumber(semanticNode, 'height', height, 200));
      const mode = props.flex === 'grid' ? 'GRID' : ['none', 'stack', 'free'].includes(props.flex) ? 'NONE' : props.flex === 'row' ? 'HORIZONTAL' : 'VERTICAL';
      created.layoutMode = mode;
      if (mode !== 'NONE' && mode !== 'GRID') {
        const horizontal = mode === 'HORIZONTAL';
        const primaryGap = horizontal ? (props.columnGap ?? props.gap) : (props.rowGap ?? props.gap);
        created.itemSpacing = props.justify === 'between' ? 0 : resolvedNumber(semanticNode, 'itemSpacing', primaryGap);
        if (props.justify !== 'between') bindScalar(semanticNode, 'itemSpacing', created, 'itemSpacing');
        created.primaryAxisAlignItems = justify[props.justify] || align[props.justify] || 'MIN';
        created.counterAxisAlignItems = align[props.items || props.align] || 'MIN';
        if (props.wrap === true || props.wrap === 'true') {
          created.layoutWrap = 'WRAP';
          const counterGap = horizontal
            ? (props.rowGap ?? props.wrapGap ?? props.counterAxisSpacing)
            : (props.columnGap ?? props.wrapGap ?? props.counterAxisSpacing);
          created.counterAxisSpacing = resolvedNumber(semanticNode, 'counterAxisSpacing', counterGap);
          bindScalar(semanticNode, 'counterAxisSpacing', created, 'counterAxisSpacing');
        }
      }
      const paddingRaw = props.p ?? props.padding;
      const pxRaw = props.px ?? paddingRaw, pyRaw = props.py ?? paddingRaw;
      const paddingValues = {
        paddingTop: props.pt ?? pyRaw, paddingRight: props.pr ?? pxRaw,
        paddingBottom: props.pb ?? pyRaw, paddingLeft: props.pl ?? pxRaw,
      };
      for (const [field, raw] of Object.entries(paddingValues)) {
        created[field] = resolvedNumber(semanticNode, field, raw);
        bindScalar(semanticNode, field, created, field);
      }
      if (mode === 'GRID') {
        const rows = structuredTracks(props.gridRows), columns = structuredTracks(props.gridColumns);
        created.gridRowCount = rows.length; created.gridColumnCount = columns.length;
        created.gridRowGap = resolvedNumber(semanticNode, 'gridRowGap', props.rowGap);
        created.gridColumnGap = resolvedNumber(semanticNode, 'gridColumnGap', props.columnGap ?? props.gap);
        bindScalar(semanticNode, 'gridRowGap', created, 'gridRowGap');
        bindScalar(semanticNode, 'gridColumnGap', created, 'gridColumnGap');
        rows.forEach((item, index) => Object.assign(created.gridRowSizes[index], item));
        columns.forEach((item, index) => Object.assign(created.gridColumnSizes[index], item));
      }
      if (mode === 'VERTICAL') {
        created.primaryAxisSizingMode = hugHeight || height == null || height === 'hug' ? 'AUTO' : 'FIXED';
        created.counterAxisSizingMode = hugWidth || width == null || width === 'hug' ? 'AUTO' : 'FIXED';
      } else if (mode === 'HORIZONTAL') {
        created.primaryAxisSizingMode = hugWidth || width == null || width === 'hug' ? 'AUTO' : 'FIXED';
        created.counterAxisSizingMode = hugHeight || height == null || height === 'hug' ? 'AUTO' : 'FIXED';
      }
      const background = props.bg ?? props.fill;
      created.fills = background && background !== 'none' ? boundPaints(semanticNode, 'fill', background, '#808080', created) : [];
      const radiusRaw = props.rounded ?? props.radius;
      created.cornerRadius = resolvedNumber(semanticNode, 'topLeftRadius', radiusRaw);
      const cornerValues = {
        topLeftRadius: props.roundedTL ?? radiusRaw, topRightRadius: props.roundedTR ?? radiusRaw,
        bottomLeftRadius: props.roundedBL ?? radiusRaw, bottomRightRadius: props.roundedBR ?? radiusRaw,
      };
      for (const [field, raw] of Object.entries(cornerValues)) {
        created[field] = resolvedNumber(semanticNode, field, raw);
        bindScalar(semanticNode, field, created, field);
      }
      if (props.cornerSmoothing != null) created.cornerSmoothing = structuredNumber(props.cornerSmoothing);
      if (props.stroke && props.stroke !== 'none') {
        created.strokes = [boundPaint(semanticNode, 'stroke', props.stroke, '#808080', created)];
        created.strokeWeight = structuredNumber(props.strokeWidth, 1);
        if (props.strokeAlign) created.strokeAlign = String(props.strokeAlign).toUpperCase();
        created.dashPattern = structuredDashPattern(props.strokeDashPattern);
        if (props.strokeCap) created.strokeCap = String(props.strokeCap).toUpperCase();
        for (const [prop, field] of [['strokeTopWidth', 'strokeTopWeight'], ['strokeRightWidth', 'strokeRightWeight'], ['strokeBottomWidth', 'strokeBottomWeight'], ['strokeLeftWidth', 'strokeLeftWeight']]) {
          if (props[prop] != null) created[field] = structuredNumber(props[prop]);
        }
      }
      created.effects = structuredEffects(props);
      created.clipsContent = props.clip === true || props.clip === 'true'
        || props.overflow === 'hidden' || props.overflow === 'clip';
    }
    bindScalar(semanticNode, 'width', created, 'width');
    bindScalar(semanticNode, 'height', created, 'height');
    if (parent) parent.appendChild(created);
    applyPlacement(created, semanticNode, props, parent);
    if (root) { created.x = props.x == null ? initialX : structuredNumber(props.x); created.y = structuredNumber(props.y); }
    const semanticIndex = createdRecords.length;
    created.setPluginData('figmaBridge.semanticPath', String(semanticNode.path || ''));
    created.setPluginData('figmaBridge.semanticIndex', String(semanticIndex));
    if (root) created.setPluginData('figmaBridge.renderPlanVersion', String(plan.version));
    applyFallbackAnnotations(created, semanticNode);
    createdRecords.push({ semanticNode, created, parent });
    for (const child of semanticNode.children || []) await create(child, created, false);
    return created;
  };

  const root = await create(plan.root, null, true);
  const structuralReport = auditStructuredCreatedNodes(createdRecords);
  return {
    id: root.id, name: root.name, width: root.width, height: root.height,
    executor: 'structured-v1',
    structuralReport,
    ...(variableContext.variableReport.references ? { variableReport: variableContext.variableReport } : {}),
    ...(variableContext.createdVariables.length ? { createdVariables: variableContext.createdVariables } : {}),
    ...(variableContext.scopeQuestions.length ? { scopeQuestions: variableContext.scopeQuestions } : {}),
    textStyleReport: textStyleContext.textStyleReport,
    ...(textStyleContext.createdStyles.length ? { createdTextStyles: textStyleContext.createdStyles } : {}),
    ...(fallbackAnnotationReport.requested ? { fallbackAnnotationReport } : {}),
  };
}

async function executeStructuredRenderPlanBatch(figmaApi, plans, options = {}) {
  if (!Array.isArray(plans) || !plans.length) throw new Error('Structured batch needs at least one Render Plan');
  const gap = structuredNumber(options.gap, 40);
  if (gap < 0 || gap > 10000) throw new Error('Structured batch gap must be between 0 and 10000');
  const vertical = options.vertical === true;
  const unsupported = [];
  for (let index = 0; index < plans.length; index++) {
    const support = inspectStructuredRenderPlan(plans[index]);
    if (!support.supported) unsupported.push(`plan ${index + 1}: ${support.problems.slice(0, 3).join('; ')}`);
  }
  if (unsupported.length) throw new Error(`Structured batch unsupported: ${unsupported.slice(0, 5).join(' | ')}`);

  const existing = [...figmaApi.currentPage.children];
  let x = existing.reduce((right, node) => Math.max(right, structuredNumber(node.x) + structuredNumber(node.width)), 0) + (existing.length ? 100 : 0);
  let y = 100;
  const frames = [];
  const createdRootIds = [];
  const createdVariables = new Set();
  const scopeQuestions = [];
  const variableReport = { references: 0, reused: 0, created: 0, bound: 0, ambiguous: 0, unsupported: 0 };
  const textStyleReport = { references: 0, reused: 0, created: 0, bound: 0 };
  const createdTextStyles = new Set();
  const fallbackAnnotationReport = { requested: 0, applied: 0, deduplicated: 0, unsupported: 0 };
  try {
    for (let index = 0; index < plans.length; index++) {
      const positioned = JSON.parse(JSON.stringify(plans[index]));
      positioned.root.source.props = { ...positioned.root.source.props, x, y };
      const result = await executeStructuredRenderPlan(figmaApi, positioned);
      frames.push(result);
      createdRootIds.push(result.id);
      for (const name of result.createdVariables || []) createdVariables.add(name);
      for (const question of result.scopeQuestions || []) scopeQuestions.push(question);
      for (const key of Object.keys(variableReport)) variableReport[key] += structuredNumber(result.variableReport?.[key]);
      for (const key of Object.keys(textStyleReport)) textStyleReport[key] += structuredNumber(result.textStyleReport?.[key]);
      for (const name of result.createdTextStyles || []) createdTextStyles.add(name);
      for (const key of Object.keys(fallbackAnnotationReport)) fallbackAnnotationReport[key] += structuredNumber(result.fallbackAnnotationReport?.[key]);
      if (vertical) y += result.height + gap;
      else x += result.width + gap;
    }
  } catch (error) {
    for (const id of createdRootIds.reverse()) {
      try {
        const node = await figmaApi.getNodeByIdAsync(id);
        if (node && typeof node.remove === 'function') node.remove();
      } catch {}
    }
    throw new Error(`Structured batch failed after ${frames.length} of ${plans.length} plans; created root frames were rolled back (${error.message || error})`);
  }
  return {
    frames,
    executor: 'structured-batch-v1',
    ...(variableReport.references ? { variableReport } : {}),
    ...(createdVariables.size ? { createdVariables: [...createdVariables].sort() } : {}),
    ...(scopeQuestions.length ? { scopeQuestions } : {}),
    textStyleReport,
    ...(createdTextStyles.size ? { createdTextStyles: [...createdTextStyles].sort() } : {}),
    ...(fallbackAnnotationReport.requested ? { fallbackAnnotationReport } : {}),
  };
}
// END STRUCTURED RENDER RUNTIME

// Normalize anything thrown into a non-empty string. `throw 'msg'` or a
// rejected plain object used to produce `error: undefined`, which the daemon
// treats as SUCCESS (falsy error check) — a failing script read as "worked,
// returned nothing".
function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  try {
    return typeof error === 'string' ? error : JSON.stringify(error) || String(error);
  } catch (e) {
    return String(error);
  }
}

// --- Selection push (UI feature C) ---
// Fully automatic: every selection change is pushed (debounced) — the UI
// displays it and forwards it to the daemon, where the MCP tool
// figma_selection picks it up. There is no button; selecting IS the gesture.
//
// Component identity: for the first few nodes the STABLE publish key is
// resolved (main component for instances, own key for components/sets) so a
// Storybook/code mapping can identify the component — node ids are file-local.
const KEY_RESOLVE_CAP = 10; // bound the async main-component lookups per push

async function selectionSnapshot() {
  const selection = figma.currentPage.selection;
  const nodes = [];
  for (let i = 0; i < Math.min(selection.length, 50); i++) {
    const n = selection[i];
    const entry = { id: n.id, name: n.name, type: n.type };
    try {
      entry.width = Math.round(n.width);
      entry.height = Math.round(n.height);
    } catch (e) {}
    try {
      const raw = n.getPluginData(DESIGN_ENTITY_STORAGE);
      if (raw) {
        const link = JSON.parse(raw);
        if (link && link.version === 1 && typeof link.id === 'string' && link.id) {
          entry.entityId = link.id;
          if (typeof link.kind === 'string' && link.kind) entry.entityKind = link.kind;
        }
      }
    } catch (e) {}
    if (i < KEY_RESOLVE_CAP) {
      try {
        if (n.type === 'INSTANCE') {
          const main = await n.getMainComponentAsync();
          if (main) {
            entry.mainName = main.name;
            if (main.key) entry.componentKey = main.key;
            if (main.parent && main.parent.type === 'COMPONENT_SET') {
              entry.setName = main.parent.name;
              if (main.parent.key) entry.setKey = main.parent.key;
            }
          }
        } else if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
          if (n.key) entry.componentKey = n.key;
        }
      } catch (e) {}
    }
    nodes.push(entry);
  }
  return {
    page: figma.currentPage.name,
    total: selection.length,
    nodes,
    // File identity for the optional REST layer (default scope = this file).
    // figma.fileKey needs enablePrivatePluginApi in the manifest and is
    // undefined for never-saved drafts — both degrade to null gracefully.
    fileKey: (typeof figma.fileKey === 'string' && figma.fileKey) || null,
    fileName: figma.root.name,
    // Which editor the bridge is attached to. The plugin runs in FigJam and
    // Slides too, and a command/editor mismatch must be visible to the agent.
    editorType: figma.editorType || null,
  };
}

async function pushSelection() {
  figma.ui.postMessage({ type: 'selection-snapshot', selection: await selectionSnapshot() });
}

// Auto-push on selection change (debounced) so the agent's figma_selection is
// always current without the user pressing the button.
let selectionDebounce = null;
figma.on('selectionchange', () => {
  if (selectionDebounce) clearTimeout(selectionDebounce);
  selectionDebounce = setTimeout(pushSelection, 300);
});

// Eval serialization chain — every handler in it catches its own errors, so
// the chain itself never rejects (a rejected chain would wedge all later evals).
let evalChain = Promise.resolve();

// Handle messages from UI (WebSocket bridge)
figma.ui.onmessage = async (msg) => {
  // --- Access-key bridge (clientStorage is only reachable here) ---
  if (msg.type === 'get-key') {
    let value = '';
    try {
      value = (await figma.clientStorage.getAsync(KEY_STORAGE)) || '';
    } catch (e) {
      value = '';
    }
    figma.ui.postMessage({ type: 'key', value });
    return;
  }

  if (msg.type === 'save-key') {
    try {
      await figma.clientStorage.setAsync(KEY_STORAGE, msg.value || '');
      figma.ui.postMessage({ type: 'key-saved', value: msg.value || '' });
      figma.notify('Access key saved', { timeout: 1500 });
    } catch (e) {
      figma.ui.postMessage({ type: 'key-saved', value: msg.value || '', error: errorMessage(e) });
    }
    return;
  }

  // --- Eval bridge ---
  // Serialized through a promise chain: figma.ui.onmessage is async, so two
  // evals arriving back-to-back would otherwise interleave at their await
  // points and mutate shared document state mid-flight. The daemon currently
  // sends strictly serially, but the plugin must not depend on that.
  if (msg.type === 'eval') {
    const { id, code } = msg;
    evalChain = evalChain.then(async () => {
      const revisionBefore = documentRevisionAvailable ? documentRevision : null;
      try {
        const result = await executeCode(code);
        figma.ui.postMessage({ type: 'result', id, result, metadata: revisionMetadata(revisionBefore) });
      } catch (error) {
        figma.ui.postMessage({ type: 'result', id, error: errorMessage(error), metadata: revisionMetadata(revisionBefore) });
      }
    });
    return;
  }

  if (msg.type === 'render-plan') {
    const { id, plan } = msg;
    if (figma.editorType === 'dev') {
      figma.ui.postMessage({
        type: 'result', id,
        error: 'Figma Dev Mode is read-only. Switch this file to Design mode and open Figma Bridge there to render or edit nodes.',
      });
      return;
    }
    evalChain = evalChain.then(async () => {
      const revisionBefore = documentRevisionAvailable ? documentRevision : null;
      try {
        const result = await executeStructuredRenderPlan(figma, plan);
        figma.ui.postMessage({ type: 'result', id, result, metadata: revisionMetadata(revisionBefore) });
      } catch (error) {
        figma.ui.postMessage({ type: 'result', id, error: errorMessage(error), metadata: revisionMetadata(revisionBefore) });
      }
    });
    return;
  }

  if (msg.type === 'render-plan-batch') {
    const { id, plans, options } = msg;
    if (figma.editorType === 'dev') {
      figma.ui.postMessage({
        type: 'result', id,
        error: 'Figma Dev Mode is read-only. Switch this file to Design mode and open Figma Bridge there to render or edit nodes.',
      });
      return;
    }
    evalChain = evalChain.then(async () => {
      const revisionBefore = documentRevisionAvailable ? documentRevision : null;
      try {
        const result = await executeStructuredRenderPlanBatch(figma, plans, options || {});
        figma.ui.postMessage({ type: 'result', id, result, metadata: revisionMetadata(revisionBefore) });
      } catch (error) {
        figma.ui.postMessage({ type: 'result', id, error: errorMessage(error), metadata: revisionMetadata(revisionBefore) });
      }
    });
    return;
  }

  // Batch eval (execute multiple codes in sequence, return all results)
  if (msg.type === 'eval-batch') {
    const { id, codes } = msg;
    evalChain = evalChain.then(async () => {
      const results = [];
      for (const code of codes) {
        const revisionBefore = documentRevisionAvailable ? documentRevision : null;
        try {
          const result = await executeCode(code);
          results.push({ success: true, result, metadata: revisionMetadata(revisionBefore) });
        } catch (error) {
          results.push({ success: false, error: errorMessage(error), metadata: revisionMetadata(revisionBefore) });
        }
      }
      figma.ui.postMessage({ type: 'batch-result', id, results });
    });
    return;
  }

  // --- UI feature bridge ---
  // The iframe cannot resize itself; it asks the main thread.
  if (msg.type === 'resize') {
    const w = Math.max(280, Math.min(500, Number(msg.width) || 360));
    const h = Math.max(200, Math.min(700, Number(msg.height) || 272));
    if (figma.editorType !== 'dev') figma.ui.resize(w, h);
    return;
  }

  // Save version (UI feature D): a labeled entry in Figma's native version
  // history. No restore API exists — this is a safety net the user restores
  // from via Figma's own version history panel.
  if (msg.type === 'save-version') {
    if (figma.editorType === 'dev') {
      const error = 'Figma Dev Mode is read-only. Switch to Design mode to save a named version.';
      figma.ui.postMessage({ type: 'version-saved', error });
      figma.notify(error, { error: true, timeout: 4000 });
      return;
    }
    try {
      await figma.saveVersionHistoryAsync('Figma Bridge — ' + new Date().toISOString());
      figma.ui.postMessage({ type: 'version-saved' });
      figma.notify('✓ Version saved to Figma’s version history', { timeout: 2000 });
    } catch (e) {
      figma.ui.postMessage({ type: 'version-saved', error: errorMessage(e) });
      figma.notify('Figma Bridge: saving the version failed — ' + errorMessage(e), { error: true });
    }
    return;
  }

  if (msg.type === 'connected') {
    figma.notify(
      figma.editorType === 'dev'
        ? '✓ Figma Bridge connected in Dev Mode (read-only)'
        : '✓ Figma Bridge connected',
      { timeout: 2500 },
    );
    // Seed the daemon with the current selection right away.
    pushSelection();
  }

  if (msg.type === 'disconnected') {
    figma.notify('Figma Bridge disconnected', { timeout: 2000 });
  }

  // Another Figma window's plugin authenticated after us — the daemon routes
  // all evals there now. The UI shows the state; this is just the toast.
  if (msg.type === 'superseded') {
    figma.notify('Figma Bridge: another Figma window took over the connection', { timeout: 4000 });
  }

  // Fired once per outage, after the UI has scanned all ports for a few
  // seconds without finding the daemon.
  if (msg.type === 'daemon-unreachable') {
    figma.notify('Figma Bridge: daemon not reachable — run figma_connect to restart it', {
      error: true,
      timeout: 5000,
    });
  }

  if (msg.type === 'auth-error') {
    // The daemon distinguishes why auth failed; mirror that in the toast.
    // Re-entering the key only helps for invalid-key.
    const reason = msg.reason || 'invalid-key';
    if (reason === 'no-key-configured') {
      figma.notify('Figma Bridge: daemon has no access key configured — run figma_connect', { error: true });
    } else if (reason === 'timeout') {
      figma.notify('Figma Bridge: auth handshake timed out — reconnecting', { error: true, timeout: 3000 });
    } else {
      figma.notify('Figma Bridge: access key rejected — re-enter it', { error: true });
    }
  }

  if (msg.type === 'error') {
    figma.notify('Figma Bridge: ' + msg.message, { error: true });
  }
};

console.log('Figma Bridge (Safe/Hardened) plugin started');
