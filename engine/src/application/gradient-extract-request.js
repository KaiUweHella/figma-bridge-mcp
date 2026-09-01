// Closed request Interface for `gradient extract`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_GRADIENT_IMAGE_PATH_CODE_UNITS = 32_768;
const UNSAFE_PATH = /[\u0000\r\n\u2028\u2029]/u;
const MODES = new Set(['linear', 'mesh']);
const DIRECTIONS = new Set(['auto', 'vertical', 'horizontal', '180', '90']);

function requestError(message) { return new Error(`Invalid Gradient Extract command: ${message}.`); }
function imageValue(value) {
  if (typeof value !== 'string' || !value.length) throw requestError('image is required');
  if (value.length > MAX_GRADIENT_IMAGE_PATH_CODE_UNITS || UNSAFE_PATH.test(value)) {
    throw requestError('image path must be bounded control-safe text');
  }
  return value;
}
function enumValue(value, values, label, fallback) {
  const normalized = value === undefined ? fallback
    : typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!values.has(normalized)) throw requestError(`${label} is invalid`);
  return normalized;
}
function stopsValue(value) {
  const source = value === undefined ? 3 : typeof value === 'string' ? value.trim() : value;
  const number = Number(source);
  if (source === '' || !Number.isInteger(number) || number < 2 || number > 5) {
    throw requestError('stops must be an integer from 2 through 5');
  }
  return number;
}
function blurValue(value) {
  if (value === null || value === undefined) return null;
  const source = typeof value === 'string' ? value.trim() : value;
  const number = Number(source);
  if (source === '' || !Number.isFinite(number)) throw requestError('blur must be a finite number');
  return Math.max(0.05, Math.min(0.8, number));
}
function targetValue(value) {
  if (value === null || value === undefined) return { selector: null, reference: null };
  if (typeof value !== 'string' || !value.trim()) throw requestError('--apply-to requires a value');
  if (value.trim().toLowerCase() === 'selected') {
    return { selector: Object.freeze({ kind: 'selection' }), reference: null };
  }
  try {
    const reference = parseNodeReference(value);
    return { selector: Object.freeze({ kind: 'node', nodeId: reference.nodeId }), reference };
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('--apply-to must be selected or a bounded Figma node id or URL containing node-id');
  }
}
function optionValue(args, index, name, inline) {
  if (inline !== null) {
    if (!inline.length) throw requestError(`${name} requires a value`);
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (value === undefined || value === '--') throw requestError(`${name} requires a value`);
  return { value, index: index + 1 };
}
function parsed(args) {
  if (!Array.isArray(args) || args[0] !== 'gradient' || args[1] !== 'extract') {
    throw new Error('Expected a gradient extract command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Gradient Extract arguments must be strings.');
  const positionals = []; const seen = new Set(); let literal = false;
  let mode = 'linear'; let direction = 'auto'; let stops = 3; let blur = null;
  let trim = true; let json = false; let target = targetValue(null);
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = ['--mode','--apply-to','--direction','--stops','--blur','--no-trim','--json']
        .find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (seen.has(name)) throw requestError(`${name} may be provided only once`);
      seen.add(name);
      if (name === '--no-trim' || name === '--json') {
        if (token !== name) throw requestError(`${name} does not accept a value`);
        if (name === '--no-trim') trim = false; else json = true;
        continue;
      }
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const entry = optionValue(args, index, name, inline); index = entry.index;
      if (name === '--mode') mode = enumValue(entry.value, MODES, 'mode', 'linear');
      else if (name === '--direction') direction = enumValue(entry.value, DIRECTIONS, 'direction', 'auto');
      else if (name === '--stops') stops = stopsValue(entry.value);
      else if (name === '--blur') blur = blurValue(entry.value);
      else target = targetValue(entry.value);
      continue;
    }
    positionals.push(token);
  }
  if (!positionals.length) throw requestError('image is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { image: imageValue(positionals[0]), mode, direction, stops, blur, trim, json, ...target };
}
function projected(input) {
  return Object.freeze({
    image: input.image, mode: input.mode, direction: input.direction, stops: input.stops,
    blur: input.blur, trim: input.trim, json: input.json, selector: input.selector,
  });
}
export function parseGradientExtractRequest(args) { return projected(parsed(args)); }
export function acceptsGradientExtractArgv(args) { try { parsed(args); return true; } catch { return false; } }
export function gradientExtractFigmaUrlFileKeyFromArgv(args) { return parsed(args).reference?.fileKey || null; }
function typed(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => ![
      'image', 'mode', 'direction', 'stops', 'blur', 'trim', 'json', 'applyTo', 'selector',
    ].includes(key))) throw new TypeError('Gradient Extract request must be a closed object.');
  let applyTo = request.applyTo;
  if (request.selector !== undefined) {
    if (request.applyTo !== undefined) {
      throw new TypeError('Gradient Extract request cannot combine selector with applyTo.');
    }
    if (request.selector === null) applyTo = null;
    else if (!request.selector || typeof request.selector !== 'object'
      || Array.isArray(request.selector) || !['selection', 'node'].includes(request.selector.kind)) {
      throw new TypeError('Gradient Extract selector must be selection or node.');
    } else if (request.selector.kind === 'selection') {
      if (Object.keys(request.selector).some((key) => key !== 'kind')) throw new TypeError('Gradient Extract selection accepts no extra fields.');
      applyTo = 'selected';
    } else {
      if (Object.keys(request.selector).some((key) => !['kind','nodeId'].includes(key))
        || typeof request.selector.nodeId !== 'string') throw new TypeError('Gradient Extract node selector requires nodeId.');
      applyTo = request.selector.nodeId;
    }
  }
  const target = targetValue(applyTo);
  return {
    image: imageValue(request.image), mode: enumValue(request.mode, MODES, 'mode', 'linear'),
    direction: enumValue(request.direction, DIRECTIONS, 'direction', 'auto'),
    stops: stopsValue(request.stops), blur: blurValue(request.blur), trim: request.trim !== false,
    json: request.json === true, ...target,
  };
}
function argv(input, planning) {
  const target = input.reference ? (planning ? input.reference.planningValue : input.reference.nodeId)
    : input.selector?.kind === 'selection' ? 'selected' : null;
  return ['gradient', 'extract', '--mode', input.mode, '--direction', input.direction,
    '--stops', String(input.stops), ...(input.blur === null ? [] : ['--blur', String(input.blur)]),
    ...(target ? ['--apply-to', target] : []), ...(input.trim ? [] : ['--no-trim']),
    ...(input.json ? ['--json'] : []), '--', input.image];
}
export function gradientExtractArgvFromRequest(request) { const args = argv(typed(request), false); parseGradientExtractRequest(args); return args; }
export function gradientExtractPlanningArgvFromRequest(request) { const args = argv(typed(request), true); parseGradientExtractRequest(args); return args; }
