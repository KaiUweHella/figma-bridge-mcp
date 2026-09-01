// Closed request Interface for `gradient mesh`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_GRADIENT_MESH_COLORS = 62;
export const MAX_GRADIENT_MESH_NAME_CODE_UNITS = 4_096;
export const MAX_GRADIENT_MESH_DIMENSION = 10_000_000;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const STYLE_ALIASES = Object.freeze({
  aurora: 'drift', blossom: 'spotlight', nebula: 'scatter', ring: 'scatter',
  blob: 'spotlight', radial: 'spotlight', linear: 'diagonal', stripes: 'bands',
  random: 'auto', mesh: 'auto',
});
const STYLES = new Set(['auto', 'scatter', 'diagonal', 'bands', 'drift', 'spotlight', 'corners']);

function requestError(message) { return new Error(`Invalid Gradient Mesh command: ${message}.`); }
function normalizeHex(value, label) {
  if (typeof value !== 'string' || !HEX.test(value.trim())) throw requestError(`${label} must be a 3- or 6-digit hex color`);
  let hex = value.trim().slice(1);
  if (hex.length === 3) hex = [...hex].map((part) => part + part).join('');
  return `#${hex.toUpperCase()}`;
}
function colorsValue(value) {
  if (typeof value !== 'string') throw requestError('colors are required');
  const colors = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (colors.length < 2 || colors.length > MAX_GRADIENT_MESH_COLORS) {
    throw requestError(`colors must contain 2-${MAX_GRADIENT_MESH_COLORS} comma-separated hex colors`);
  }
  return Object.freeze(colors.map((color) => normalizeHex(color, 'each palette color')));
}
function targetValue(value) {
  if (value === null || value === undefined) return { selector: null, reference: null };
  if (typeof value !== 'string' || !value.trim()) throw requestError('--apply-to requires a value');
  if (value.trim().toLowerCase() === 'selected') return { selector: Object.freeze({ kind: 'selection' }), reference: null };
  try {
    const reference = parseNodeReference(value);
    return { selector: Object.freeze({ kind: 'node', nodeId: reference.nodeId }), reference };
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('--apply-to must be selected or a bounded Figma node id or URL containing node-id');
  }
}
function sizeValue(value = '1920x1080') {
  if (typeof value !== 'string') throw requestError('size must use WxH');
  const match = value.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) throw requestError('size must use WxH');
  const width = Number(match[1]); const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_GRADIENT_MESH_DIMENSION || height > MAX_GRADIENT_MESH_DIMENSION) {
    throw requestError(`size dimensions must be 1-${MAX_GRADIENT_MESH_DIMENSION}`);
  }
  return Object.freeze({ width, height });
}
function boundedNumber(value, label, minimum, maximum, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const source = typeof value === 'string' ? value.trim() : value;
  const number = Number(source);
  if (source === '' || !Number.isFinite(number)) throw requestError(`${label} must be a finite number`);
  return Math.max(minimum, Math.min(maximum, number));
}
function seedValue(value) {
  if (value === null || value === undefined) return null;
  const source = typeof value === 'string' ? value.trim() : value;
  const number = Number(source);
  if (source === '' || !Number.isSafeInteger(number)) throw requestError('seed must be a safe integer');
  return number >>> 0;
}
function styleValue(value = 'auto') {
  if (typeof value !== 'string' || !value.trim() || value.length > 64 || UNSAFE.test(value)) {
    throw requestError('style is invalid');
  }
  const raw = value.trim().toLowerCase();
  const style = STYLE_ALIASES[raw] || raw;
  if (!STYLES.has(style)) throw requestError('style is invalid');
  return style;
}
function nameValue(value = 'Mesh Wallpaper') {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_GRADIENT_MESH_NAME_CODE_UNITS || UNSAFE.test(value)) {
    throw requestError(`name must be safe non-empty text of at most ${MAX_GRADIENT_MESH_NAME_CODE_UNITS} code units`);
  }
  return value;
}
function optionValue(args, index, name, inline) {
  if (inline !== null) {
    if (!inline.length) throw requestError(`${name} requires a value`);
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (value === undefined || value === '--' || value.startsWith('-')) {
    throw requestError(`${name} requires a value; option-looking values must use ${name}=<value>`);
  }
  return { value, index: index + 1 };
}
function parsed(args) {
  if (!Array.isArray(args) || args[0] !== 'gradient' || args[1] !== 'mesh') throw new Error('Expected a gradient mesh command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Gradient Mesh arguments must be strings.');
  const positionals = []; const seen = new Set(); let literal = false;
  let target = targetValue(null); let base = null; let size = sizeValue(); let blur = 0.42;
  let grain = null; let texture = false; let style = 'auto'; let seed = null; let name = 'Mesh Wallpaper'; let json = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const option = ['--apply-to','--base','--size','--blur','--grain','--texture','--style','--seed','--name','--json']
        .find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!option) throw requestError(`unknown option ${token}`);
      if (seen.has(option)) throw requestError(`${option} may be provided only once`);
      seen.add(option);
      if (option === '--texture' || option === '--json') {
        if (token !== option) throw requestError(`${option} does not accept a value`);
        if (option === '--texture') texture = true; else json = true;
        continue;
      }
      const inline = token.startsWith(`${option}=`) ? token.slice(option.length + 1) : null;
      if (option === '--grain' && inline === null
        && (args[index + 1] === undefined || args[index + 1] === '--' || args[index + 1].startsWith('-'))) {
        grain = 0.18; continue;
      }
      const entry = optionValue(args, index, option, inline); index = entry.index;
      if (option === '--apply-to') target = targetValue(entry.value);
      else if (option === '--base') base = normalizeHex(entry.value, 'base');
      else if (option === '--size') size = sizeValue(entry.value);
      else if (option === '--blur') blur = boundedNumber(entry.value, 'blur', 0.05, 0.8);
      else if (option === '--grain') grain = boundedNumber(entry.value, 'grain', 0, 1);
      else if (option === '--style') style = styleValue(entry.value);
      else if (option === '--seed') seed = seedValue(entry.value);
      else name = nameValue(entry.value);
      continue;
    }
    positionals.push(token);
  }
  if (!positionals.length) throw requestError('colors are required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { colors: colorsValue(positionals[0]), ...target, base, size, blur, grain, texture, style, seed, name, json };
}
function projected(input) {
  return Object.freeze({
    colors: input.colors, selector: input.selector, base: input.base, size: input.size,
    blur: input.blur, grain: input.grain, texture: input.texture, style: input.style,
    seed: input.seed, name: input.name, json: input.json,
  });
}
export function parseGradientMeshRequest(args) { return projected(parsed(args)); }
export function acceptsGradientMeshArgv(args) { try { parsed(args); return true; } catch { return false; } }
export function gradientMeshFigmaUrlFileKeyFromArgv(args) { return parsed(args).reference?.fileKey || null; }
function typed(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => ![
      'colors','selector','applyTo','base','size','width','height','blur','grain','texture','style','seed','name','json',
    ].includes(key))) throw new TypeError('Gradient Mesh request must be a closed object.');
  let applyTo = request.applyTo;
  if (request.selector !== undefined) {
    if (request.applyTo !== undefined) throw new TypeError('Gradient Mesh request cannot combine selector with applyTo.');
    if (request.selector === null) applyTo = null;
    else if (!request.selector || typeof request.selector !== 'object' || Array.isArray(request.selector)
      || !['selection','node'].includes(request.selector.kind)) throw new TypeError('Gradient Mesh selector must be selection or node.');
    else if (request.selector.kind === 'selection') {
      if (Object.keys(request.selector).some((key) => key !== 'kind')) throw new TypeError('Gradient Mesh selection accepts no extra fields.');
      applyTo = 'selected';
    } else {
      if (Object.keys(request.selector).some((key) => !['kind','nodeId'].includes(key)) || typeof request.selector.nodeId !== 'string') {
        throw new TypeError('Gradient Mesh node selector requires nodeId.');
      }
      applyTo = request.selector.nodeId;
    }
  }
  let size = request.size;
  if (size && typeof size === 'object' && !Array.isArray(size)) {
    if (Object.keys(size).some((key) => !['width','height'].includes(key))) throw new TypeError('Gradient Mesh size must be closed.');
    size = `${size.width}x${size.height}`;
  } else if (request.width !== undefined || request.height !== undefined) {
    if (request.width === undefined || request.height === undefined) throw new TypeError('Gradient Mesh width and height must be provided together.');
    size = `${request.width}x${request.height}`;
  }
  const colors = Array.isArray(request.colors) ? request.colors.join(',') : request.colors;
  return {
    colors: colorsValue(colors), ...targetValue(applyTo), base: request.base == null ? null : normalizeHex(request.base, 'base'),
    size: sizeValue(size), blur: boundedNumber(request.blur, 'blur', 0.05, 0.8, 0.42),
    grain: request.grain === true ? 0.18 : boundedNumber(request.grain, 'grain', 0, 1),
    texture: request.texture === true, style: styleValue(request.style), seed: seedValue(request.seed),
    name: nameValue(request.name), json: request.json === true,
  };
}
function argv(input, planning) {
  const target = input.reference ? (planning ? input.reference.planningValue : input.reference.nodeId)
    : input.selector?.kind === 'selection' ? 'selected' : null;
  return ['gradient', 'mesh', ...(target ? ['--apply-to', target] : []),
    ...(input.base === null ? [] : ['--base', input.base]), '--size', `${input.size.width}x${input.size.height}`,
    '--blur', String(input.blur), ...(input.grain === null ? [] : ['--grain', String(input.grain)]),
    ...(input.texture ? ['--texture'] : []), '--style', input.style,
    ...(input.seed === null ? [] : ['--seed', String(input.seed)]), '--name', input.name,
    ...(input.json ? ['--json'] : []), '--', input.colors.join(',')];
}
export function gradientMeshArgvFromRequest(request) { const args = argv(typed(request), false); parseGradientMeshRequest(args); return args; }
export function gradientMeshPlanningArgvFromRequest(request) { const args = argv(typed(request), true); parseGradientMeshRequest(args); return args; }
