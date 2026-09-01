// Closed host-side parser for one CSS-like native Figma GradientPaint.

import { gradientTransformFromCssAngle } from './paint-css.js';

export const MAX_GRADIENT_VALUE_CODE_UNITS = 65_536;
export const MAX_GRADIENT_STOPS = 256;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function invalid(message) { throw new Error(`Invalid gradient: ${message}.`); }
function rounded(value) {
  const result = Number(value.toFixed(4));
  return Object.is(result, -0) ? 0 : result;
}
function freezeGraph(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeGraph(child);
  return Object.freeze(value);
}
function colorValue(source, previous) {
  if (source.toLowerCase() === 'transparent') {
    return { ...(previous || { r: 0, g: 0, b: 0 }), a: 0 };
  }
  const hex = source.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let value = hex[1];
    if (value.length === 3) value = value.split('').map((part) => part + part).join('');
    return {
      r: rounded(parseInt(value.slice(0, 2), 16) / 255),
      g: rounded(parseInt(value.slice(2, 4), 16) / 255),
      b: rounded(parseInt(value.slice(4, 6), 16) / 255),
      a: value.length === 8 ? parseInt(value.slice(6), 16) / 255 : 1,
    };
  }
  const rgb = source.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgb) return null;
  const values = rgb[1].split(',').map((part) => Number(part.trim()));
  if (![3, 4].includes(values.length)
    || !values.slice(0, 3).every((value) => Number.isFinite(value) && value >= 0 && value <= 255)
    || (values.length === 4 && (!Number.isFinite(values[3]) || values[3] < 0 || values[3] > 1))) return null;
  return {
    r: rounded(values[0] / 255), g: rounded(values[1] / 255), b: rounded(values[2] / 255),
    a: values[3] ?? 1,
  };
}

export function parseGradientPaint(input) {
  if (typeof input !== 'string' || !input.trim()) invalid('value is required');
  const source = input.trim();
  if (source.length > MAX_GRADIENT_VALUE_CODE_UNITS || UNSAFE.test(source)) {
    invalid('value is unsafe or exceeds its bounded length');
  }
  const match = source.match(/^(linear|radial|angular|diamond)-gradient\s*\(([\s\S]*)\)\s*$/i);
  if (!match) invalid('expected linear, radial, angular, or diamond syntax');
  const kind = match[1].toLowerCase();
  const parts = [];
  let depth = 0; let buffer = '';
  for (const character of match[2]) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (depth < 0) invalid('parentheses are unbalanced');
    if (character === ',' && depth === 0) { parts.push(buffer.trim()); buffer = ''; }
    else buffer += character;
  }
  if (depth !== 0) invalid('parentheses are unbalanced');
  if (buffer.trim()) parts.push(buffer.trim());
  let angle = 180;
  let center = { x: 0.5, y: 0.5 };
  let stopParts = parts;
  const angleMatch = parts[0]?.match(/^(-?\d+(?:\.\d+)?)deg$/i);
  if (angleMatch) {
    angle = Number(angleMatch[1]);
    if (!Number.isFinite(angle) || Math.abs(angle) > Number.MAX_SAFE_INTEGER) invalid('angle is not finite and bounded');
    stopParts = parts.slice(1);
  } else if (kind === 'radial') {
    const position = parts[0]?.match(/^(?:(?:circle|ellipse)(?:\s+.*?)?\s+)?at\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/i);
    if (position) {
      center = { x: Number(position[1]) / 100, y: Number(position[2]) / 100 };
      if (center.x < 0 || center.x > 1 || center.y < 0 || center.y > 1) {
        invalid('radial center must be inside 0-100%');
      }
      stopParts = parts.slice(1);
    }
  }
  if (stopParts.length < 2 || stopParts.length > MAX_GRADIENT_STOPS) {
    invalid(`expected 2-${MAX_GRADIENT_STOPS} color stops`);
  }
  const stops = [];
  for (let index = 0; index < stopParts.length; index++) {
    const stop = stopParts[index];
    const positionMatch = stop.match(/(-?\d+(?:\.\d+)?)%\s*$/);
    const position = positionMatch ? Number(positionMatch[1]) / 100 : index / (stopParts.length - 1);
    if (!Number.isFinite(position) || position < 0 || position > 1) {
      invalid('stop positions must be inside 0-100%');
    }
    const colorSource = positionMatch ? stop.slice(0, positionMatch.index).trim() : stop.trim();
    const color = colorValue(colorSource, stops.at(-1)?.color);
    if (!color) invalid('a color stop is unsupported');
    stops.push({ position, color });
  }
  const transform = kind === 'radial'
    ? [[1, 0, rounded(center.x - 0.5)], [0, 1, rounded(center.y - 0.5)]]
    : gradientTransformFromCssAngle(angle).map((row) => row.map(rounded));
  return freezeGraph({
    type: {
      linear: 'GRADIENT_LINEAR', radial: 'GRADIENT_RADIAL',
      angular: 'GRADIENT_ANGULAR', diamond: 'GRADIENT_DIAMOND',
    }[kind],
    gradientStops: stops,
    gradientTransform: transform,
  });
}
