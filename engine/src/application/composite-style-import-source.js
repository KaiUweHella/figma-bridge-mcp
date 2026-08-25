// Versioned, bounded projection of design-token composites into native Style intent.

import { styleMutationPropertiesValue } from './style-mutation-values.js';

export const COMPOSITE_STYLE_FACTS_VERSION = 1;
export const MAX_COMPOSITE_STYLE_ITEMS = 2_000;
export const MAX_COMPOSITE_UNSUPPORTED_ITEMS = 2_000;
const MAX_TEXT = 1_024;
const MAX_DESCRIPTION = 65_536;
const CONTROL = /[\u0000\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const BLEND_MODES = new Set([
  'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN',
  'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT',
  'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
]);
const BINDABLE_TEXT_FIELDS = Object.freeze({
  fontFamily: 'STRING', fontStyle: 'STRING', fontSize: 'FLOAT', fontWeight: 'FLOAT',
  letterSpacing: 'FLOAT', lineHeight: 'FLOAT', paragraphSpacing: 'FLOAT',
  paragraphIndent: 'FLOAT',
});

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeName(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT || CONTROL.test(value)) {
    throw new Error(`Composite Style ${label} must be bounded safe text.`);
  }
  return value.trim();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function description(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION || CONTROL.test(value)) {
    throw new Error('Composite Style description must be bounded safe text.');
  }
  return value;
}

function wrapped(value) {
  if (!plain(value) || !Object.hasOwn(value, 'value')) return { value, alias: null };
  const keys = Object.keys(value);
  if (keys.some((key) => !['value', 'alias'].includes(key))) return { value, alias: null };
  return {
    value: value.value,
    alias: value.alias == null ? null : safeName(value.alias, 'Variable alias'),
  };
}

function finite(value) {
  const raw = wrapped(value).value;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(px|rem)?$/iu);
  if (!match) return null;
  const number = Number(match[1]);
  return match[2]?.toLowerCase() === 'rem' ? number * 16 : number;
}

function fontStyle(value, weight) {
  if (typeof value === 'string' && value.trim()) return safeName(value, 'font style');
  const numeric = finite(weight);
  if (numeric == null) return 'Regular';
  if (numeric >= 800) return 'Extra Bold';
  if (numeric >= 700) return 'Bold';
  if (numeric >= 600) return 'Semi Bold';
  if (numeric >= 500) return 'Medium';
  if (numeric <= 300) return 'Light';
  return 'Regular';
}

function sourceIdentity(entry) {
  const candidate = entry.sourceIdentity
    ?? entry.$extensions?.['figma-bridge']?.style
    ?? entry.$extensions?.figma?.style;
  if (candidate == null) return null;
  if (!plain(candidate) || Object.keys(candidate).some((key) => !['id', 'key'].includes(key))) {
    throw new Error('Composite Style sourceIdentity must contain only id and key.');
  }
  const identity = {};
  if (candidate.id != null) identity.id = safeName(candidate.id, 'source id');
  if (candidate.key != null) identity.key = safeName(candidate.key, 'source key');
  if (!identity.id && !identity.key) throw new Error('Composite Style sourceIdentity is empty.');
  return identity;
}

function tokenBody(entry) {
  if (!plain(entry)) return { value: entry, description: '', sourceIdentity: null };
  const isTokenWrapper = Object.hasOwn(entry, '$value')
    || (Object.hasOwn(entry, 'value') && ['typography', 'shadow'].includes(entry.type));
  const directValue = isTokenWrapper ? (entry.$value ?? entry.value)
    : Object.fromEntries(Object.entries(entry)
      .filter(([key]) => !['description', 'sourceIdentity', '$extensions'].includes(key)));
  return {
    value: directValue,
    description: description(entry.description),
    sourceIdentity: sourceIdentity(entry),
  };
}

function bindingOf(value, field, bindings) {
  const item = wrapped(value);
  if (item.alias) bindings[field] = { query: item.alias, expectedType: BINDABLE_TEXT_FIELDS[field] };
  return item.value;
}

function typographyStyle(name, raw, unsupported) {
  const body = tokenBody(raw);
  if (!plain(body.value)) {
    unsupported.push({ kind: 'typography', name, reason: 'token is not an object' });
    return null;
  }
  const value = body.value;
  const bindings = {};
  const familyValue = bindingOf(value.fontFamily, 'fontFamily', bindings);
  const family = Array.isArray(familyValue) ? familyValue[0] : familyValue;
  const sizeValue = bindingOf(value.fontSize, 'fontSize', bindings);
  const size = finite(sizeValue);
  if (typeof family !== 'string' || !family.trim() || size == null || size <= 0) {
    unsupported.push({ kind: 'typography', name, reason: 'fontFamily and positive fontSize are required' });
    return null;
  }
  const explicitStyle = bindingOf(value.fontStyle, 'fontStyle', bindings);
  bindingOf(value.fontWeight, 'fontWeight', bindings);
  const properties = {
    fontName: { family: safeName(family, 'font family'), style: fontStyle(explicitStyle, value.fontWeight) },
    fontSize: size,
  };
  for (const field of ['paragraphSpacing', 'paragraphIndent']) {
    if (value[field] === undefined) continue;
    const resolved = finite(bindingOf(value[field], field, bindings));
    if (resolved == null) unsupported.push({ kind: 'typography-field', name, reason: `${field} is not a finite dimension` });
    else properties[field] = resolved;
  }
  for (const [field, unit] of [['lineHeight', 'PIXELS'], ['letterSpacing', 'PIXELS']]) {
    if (value[field] === undefined) continue;
    const resolved = finite(bindingOf(value[field], field, bindings));
    if (resolved == null) unsupported.push({ kind: 'typography-field', name, reason: `${field} is not a finite dimension` });
    else properties[field] = { unit, value: resolved };
  }
  for (const field of ['textCase', 'textDecoration']) {
    if (value[field] !== undefined) properties[field] = value[field];
  }
  const supported = new Set([
    'fontFamily', 'fontStyle', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'paragraphSpacing', 'paragraphIndent', 'textCase', 'textDecoration',
  ]);
  for (const field of Object.keys(value)) {
    if (!supported.has(field)) unsupported.push({ kind: 'typography-field', name, reason: `${field} has no exact supported Text Style projection` });
  }
  const normalized = styleMutationPropertiesValue(properties, 'TEXT', (message) => new Error(message));
  return {
    kind: 'TEXT', name, description: body.description, sourceIdentity: body.sourceIdentity,
    properties: normalized, bindings,
  };
}

function color(value) {
  if (plain(value) && ['r', 'g', 'b'].every((key) => typeof value[key] === 'number')) {
    const result = { r: value.r, g: value.g, b: value.b, a: value.a ?? 1 };
    return Object.values(result).every((channel) => Number.isFinite(channel)
      && channel >= 0 && channel <= 1) ? result : null;
  }
  if (typeof value !== 'string') return null;
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/iu)?.[1];
  if (hex) {
    const expanded = hex.length === 3 || hex.length === 4
      ? [...hex].map((digit) => digit + digit).join('') : hex;
    if (![6, 8].includes(expanded.length)) return null;
    return {
      r: parseInt(expanded.slice(0, 2), 16) / 255,
      g: parseInt(expanded.slice(2, 4), 16) / 255,
      b: parseInt(expanded.slice(4, 6), 16) / 255,
      a: expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/iu);
  if (!rgb) return null;
  const result = { r: Number(rgb[1]) / 255, g: Number(rgb[2]) / 255,
    b: Number(rgb[3]) / 255, a: rgb[4] == null ? 1 : Number(rgb[4]) };
  return Object.values(result).every((channel) => Number.isFinite(channel)
    && channel >= 0 && channel <= 1) ? result : null;
}

function cssShadow(value) {
  if (typeof value !== 'string') return null;
  let remaining = value.trim();
  const colorMatch = remaining.match(/(#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*$/iu);
  if (!colorMatch) return null;
  const shadowColor = color(colorMatch[1]);
  if (!shadowColor) return null;
  remaining = remaining.slice(0, colorMatch.index).trim();
  const parts = remaining.split(/\s+/u);
  const inset = parts[0]?.toLowerCase() === 'inset';
  if (inset) parts.shift();
  const numbers = parts.map(finite);
  if (numbers.length < 3 || numbers.some((number) => number == null)) return null;
  return {
    type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: shadowColor,
    offset: { x: numbers[0], y: numbers[1] }, radius: numbers[2], spread: numbers[3] ?? 0,
    visible: true, blendMode: 'NORMAL',
    ...(inset ? {} : { showShadowBehindNode: false }),
  };
}

function oneEffect(value) {
  if (typeof value === 'string') return cssShadow(value);
  if (!plain(value)) return null;
  if (typeof value.type === 'string') {
    const blendMode = value.blendMode ?? 'NORMAL';
    if (!['DROP_SHADOW', 'INNER_SHADOW'].includes(value.type)
      || !color(value.color) || !plain(value.offset)
      || ![value.offset.x, value.offset.y, value.radius, value.spread ?? 0]
        .every((number) => typeof number === 'number' && Number.isFinite(number))
      || value.radius < 0 || (value.visible !== undefined && typeof value.visible !== 'boolean')
      || !BLEND_MODES.has(blendMode)
      || (value.showShadowBehindNode !== undefined
        && typeof value.showShadowBehindNode !== 'boolean')) return null;
    return { ...value, color: color(value.color), spread: value.spread ?? 0,
      visible: value.visible ?? true, blendMode,
      ...(value.type === 'DROP_SHADOW'
        ? { showShadowBehindNode: value.showShadowBehindNode ?? false } : {}) };
  }
  const effectColor = color(value.color ?? '#00000040');
  const x = finite(value.x ?? value.offsetX ?? 0);
  const y = finite(value.y ?? value.offsetY ?? 0);
  const radius = finite(value.blur ?? value.radius);
  const spread = finite(value.spread ?? 0);
  const blendMode = value.blendMode ?? 'NORMAL';
  if (!effectColor || [x, y, radius, spread].some((number) => number == null) || radius < 0
    || (value.visible !== undefined && typeof value.visible !== 'boolean')
    || (value.inset !== undefined && typeof value.inset !== 'boolean')
    || !BLEND_MODES.has(blendMode)) return null;
  return {
    type: value.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: effectColor,
    offset: { x, y }, radius, spread, visible: value.visible ?? true,
    blendMode,
    ...(value.inset ? {} : { showShadowBehindNode: false }),
  };
}

function splitCssShadows(value) {
  if (typeof value !== 'string') return null;
  const items = [];
  let depth = 0; let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '(') depth++;
    else if (value[index] === ')') depth--;
    else if (value[index] === ',' && depth === 0) {
      items.push(value.slice(start, index).trim()); start = index + 1;
    }
    if (depth < 0) return null;
  }
  if (depth !== 0) return null;
  items.push(value.slice(start).trim());
  return items.every(Boolean) ? items : null;
}

function containsAlias(value) {
  if (!value || typeof value !== 'object') return false;
  if (plain(value) && typeof value.alias === 'string') return true;
  return Object.values(value).some(containsAlias);
}

function effectStyle(name, raw, unsupported) {
  const body = tokenBody(raw);
  if (containsAlias(body.value)) {
    unsupported.push({ kind: 'shadow-binding', name, reason: 'Effect Style Variable aliases do not have an owned exact mutation path yet' });
    return null;
  }
  const values = Array.isArray(body.value) ? body.value
    : (typeof body.value === 'string' ? splitCssShadows(body.value) : [body.value]);
  if (!values) {
    unsupported.push({ kind: 'shadow', name, reason: 'shadow syntax is malformed' });
    return null;
  }
  const effects = values.map(oneEffect);
  if (!effects.length || effects.some((effect) => effect == null)) {
    unsupported.push({ kind: 'shadow', name, reason: 'shadow cannot be represented as structured Figma effects' });
    return null;
  }
  const properties = styleMutationPropertiesValue({ effects }, 'EFFECT', (message) => new Error(message));
  return {
    kind: 'EFFECT', name, description: body.description,
    sourceIdentity: body.sourceIdentity, properties, bindings: {},
  };
}

export function normalizeCompositeStyleImport({ tokens }) {
  if (!plain(tokens)) throw new Error('Composite Style token root must be an object.');
  const typography = tokens.typography == null ? {} : tokens.typography;
  const shadow = tokens.shadow == null ? {} : tokens.shadow;
  if (!plain(typography) || !plain(shadow)) throw new Error('Composite Style families must be objects.');
  const total = Object.keys(typography).length + Object.keys(shadow).length;
  if (total > MAX_COMPOSITE_STYLE_ITEMS) throw new Error(`Composite Style import exceeds ${MAX_COMPOSITE_STYLE_ITEMS} items.`);
  const unsupported = [];
  const styles = [];
  for (const [rawName, value] of Object.entries(typography)) {
    const name = safeName(rawName, 'name');
    const style = typographyStyle(name, value, unsupported);
    if (style) styles.push(style);
  }
  for (const [rawName, value] of Object.entries(shadow)) {
    const name = safeName(rawName, 'name');
    const style = effectStyle(name, value, unsupported);
    if (style) styles.push(style);
  }
  if (unsupported.length > MAX_COMPOSITE_UNSUPPORTED_ITEMS) throw new Error('Composite Style unsupported evidence exceeds its bound.');
  if (new Set(styles.map((style) => `${style.kind}:${style.name}`)).size !== styles.length) {
    throw new Error('Composite Style names must be unique within each Style family.');
  }
  return deepFreeze({ schemaVersion: COMPOSITE_STYLE_FACTS_VERSION, styles, unsupported });
}
