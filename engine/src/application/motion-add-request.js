// Closed request Interface for `motion add`.

import { mapEasing, mapField, normalizeSpec, parseKeys } from '../lib/motion-core.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEFAULT_MOTION_ADD_DURATION = 0.5;
export const DEFAULT_MOTION_ADD_OFFSET = 0;
export const DEFAULT_MOTION_ADD_EASING = 'ease-out';
export const MAX_MOTION_ADD_KEYFRAMES = 256;
export const MAX_MOTION_ADD_KEYS_CODE_UNITS = 65_536;
const MAX_FIELD_CODE_UNITS = 256;
const MAX_EASING_CODE_UNITS = 256;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid Motion Add command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function finite(value, label, { positive = false, nonNegative = true } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw requestError(`${label} must be a finite number`);
  }
  const source = typeof value === 'string' ? value.trim() : value;
  const number = Number(source);
  if (source === '' || !Number.isFinite(number) || (nonNegative && number < 0)
    || (positive && number === 0)
    || Math.abs(number) > Number.MAX_SAFE_INTEGER) {
    const range = positive ? 'positive' : nonNegative ? 'non-negative' : 'bounded';
    throw requestError(`${label} must be a finite ${range} number`);
  }
  return number;
}

function safeString(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || UNSAFE_TEXT.test(value)) {
    throw requestError(`${label} must be a non-empty control-safe string`);
  }
  return value.trim();
}

function canonicalField(value) {
  const raw = safeString(value, 'field', MAX_FIELD_CODE_UNITS);
  let field;
  try { field = mapField(raw); }
  catch (error) { throw requestError(error.message); }
  if (field.valueType === 'COLOR' && field.index >= 256) {
    throw requestError('paint index exceeds the bounded Motion paint inventory');
  }
  return field.valueType === 'COLOR' ? `${field.name}:${field.index}` : field.name;
}

function easingValue(value) {
  const raw = safeString(value, 'easing', MAX_EASING_CODE_UNITS);
  try { mapEasing(raw); }
  catch (error) { throw requestError(error.message); }
  return raw;
}

function validNativeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['FLOAT', 'VECTOR', 'COLOR'].includes(value.type)) return false;
  if (value.type === 'FLOAT') return Number.isFinite(value.value);
  if (!value.value || typeof value.value !== 'object' || Array.isArray(value.value)) return false;
  if (value.type === 'VECTOR') return Number.isFinite(value.value.x) && Number.isFinite(value.value.y);
  return ['r', 'g', 'b', 'a'].every((key) => Number.isFinite(value.value[key])
    && value.value[key] >= 0 && value.value[key] <= 1);
}

function validEasing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.type !== 'string' || value.type.length === 0
    || value.type.length > MAX_EASING_CODE_UNITS || UNSAFE_TEXT.test(value.type)) return false;
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || serialized.length > 4_096) return false;
  let valid = true;
  const visit = (entry) => {
    if (typeof entry === 'number') valid &&= Number.isFinite(entry);
    else if (Array.isArray(entry)) entry.forEach(visit);
    else if (entry && typeof entry === 'object') Object.values(entry).forEach(visit);
    else if (typeof entry !== 'string' && typeof entry !== 'boolean' && entry !== null) valid = false;
  };
  visit(value);
  return valid;
}

function validateTrack(track) {
  if (!track || !Array.isArray(track.keyframes) || track.keyframes.length === 0
    || track.keyframes.length > MAX_MOTION_ADD_KEYFRAMES) {
    throw requestError(`keys must contain between 1 and ${MAX_MOTION_ADD_KEYFRAMES} keyframes`);
  }
  for (const keyframe of track.keyframes) {
    if (!keyframe || typeof keyframe !== 'object' || Array.isArray(keyframe)
      || !Number.isFinite(keyframe.timelinePosition) || keyframe.timelinePosition < 0
      || keyframe.timelinePosition > Number.MAX_SAFE_INTEGER || !validNativeValue(keyframe.value)
      || (keyframe.easing !== undefined && !validEasing(keyframe.easing))) {
      throw requestError('keys contain an invalid timeline position, value, or easing');
    }
  }
  return track;
}

function parsedKeys(value, field) {
  const raw = safeString(value, 'keys', MAX_MOTION_ADD_KEYS_CODE_UNITS);
  let keyframes;
  try { keyframes = parseKeys(raw, mapField(field).valueType); }
  catch (error) { throw requestError(error.message); }
  validateTrack({ keyframes });
  return { raw, duration: Math.max(...keyframes.map((keyframe) => keyframe.timelinePosition)) };
}

function normalizedFromTo(field, from, to, duration, offset, easing) {
  let normalized;
  try {
    normalized = normalizeSpec({ tracks: [{
      node: '0:0', field,
      keys: [{ t: offset, v: from }, { t: offset + duration, v: to, ease: easing }],
    }] });
  } catch (error) { throw requestError(error.message); }
  const fieldName = Object.keys(normalized.byNode['0:0'])[0];
  const entry = normalized.byNode['0:0'][fieldName];
  const track = fieldName === 'fills' || fieldName === 'strokes' ? entry[mapField(field).index] : entry;
  validateTrack(track);
}

function optionValue(token, aliases) {
  for (const alias of aliases) {
    if (token.startsWith(`${alias}=`)) return token.slice(alias.length + 1);
    if (alias.length === 2 && token.startsWith(alias) && token.length > 2
      && token[2] !== '-') return token.slice(2);
  }
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'motion' || args[1] !== 'add') {
    throw new Error('Expected a motion add command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Motion Add arguments must be strings.');
  }
  const values = { field: null, keys: null, from: null, to: null };
  const seen = new Set();
  let duration = DEFAULT_MOTION_ADD_DURATION;
  let offset = DEFAULT_MOTION_ADD_OFFSET;
  let easing = DEFAULT_MOTION_ADD_EASING;
  let literal = false;
  const positionals = [];
  const definitions = [
    { name: 'field', aliases: ['-f', '--field'] },
    { name: 'keys', aliases: ['-k', '--keys'] },
    { name: 'from', aliases: ['--from'] },
    { name: 'to', aliases: ['--to'] },
    { name: 'duration', aliases: ['-d', '--dur'] },
    { name: 'offset', aliases: ['--at'] },
    { name: 'easing', aliases: ['-e', '--ease'] },
  ];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const definition = definitions.find(({ aliases }) => aliases.includes(token)
        || optionValue(token, aliases) !== null);
      if (!definition) throw requestError(`unknown option ${token}`);
      if (seen.has(definition.name)) throw requestError(`${definition.name} may be provided only once`);
      seen.add(definition.name);
      let value = optionValue(token, definition.aliases);
      if (value === null) {
        value = args[index + 1];
        if (value === undefined || value === '--') throw requestError(`${token} requires a value`);
        index += 1;
      }
      if (definition.name === 'duration') duration = finite(value, 'duration', { positive: true });
      else if (definition.name === 'offset') offset = finite(value, 'offset');
      else if (definition.name === 'easing') easing = easingValue(value);
      else values[definition.name] = value;
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  }
  if (values.field === null) throw requestError('field is required');
  const field = canonicalField(values.field);
  if (values.keys !== null) {
    if (values.from !== null || values.to !== null) throw requestError('keys cannot be combined with from or to');
    if (seen.has('duration') || seen.has('offset') || seen.has('easing')) {
      throw requestError('duration, offset, and easing apply only to from/to mode');
    }
    const keys = parsedKeys(values.keys, field);
    return { reference: nodeReference(positionals[0]), field, mode: 'keys', keys: keys.raw,
      from: null, to: null, duration: keys.duration, offset: 0, easing: null };
  }
  if (values.from === null || values.to === null) throw requestError('keys or both from and to are required');
  if (!Number.isFinite(duration + offset) || duration + offset > Number.MAX_SAFE_INTEGER) {
    throw requestError('duration plus offset exceeds the supported timeline range');
  }
  const type = mapField(field).valueType;
  const from = type === 'COLOR' ? safeString(values.from, 'from', 64)
    : finite(values.from, 'from', { nonNegative: false });
  const to = type === 'COLOR' ? safeString(values.to, 'to', 64)
    : finite(values.to, 'to', { nonNegative: false });
  normalizedFromTo(field, from, to, duration, offset, easing);
  return { reference: nodeReference(positionals[0]), field, mode: 'from-to', keys: null,
    from, to, duration, offset, easing };
}

function projected(input) {
  return Object.freeze({
    nodeId: input.reference.nodeId,
    field: input.field,
    mode: input.mode,
    keys: input.keys,
    from: input.from,
    to: input.to,
    duration: input.duration,
    offset: input.offset,
    easing: input.easing,
  });
}

export function parseMotionAddRequest(args) {
  return projected(parsedRequest(args));
}

export function acceptsMotionAddArgv(args) {
  try { parseMotionAddRequest(args); return true; }
  catch { return false; }
}

export function motionAddFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}

function typedInput(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Motion Add request must be an object.');
  }
  if (Object.keys(request).some((key) => ![
    'nodeId', 'field', 'mode', 'keys', 'from', 'to', 'duration', 'offset', 'easing',
  ].includes(key))) throw requestError('request contains an unknown field');
  const args = ['motion', 'add', '--field', String(request.field ?? '')];
  const keysMode = request.keys !== undefined && request.keys !== null;
  if (request.mode !== undefined && request.mode !== (keysMode ? 'keys' : 'from-to')) {
    throw requestError('mode does not match the supplied keyframe inputs');
  }
  if (keysMode) args.push('--keys', String(request.keys));
  if (request.from !== undefined && request.from !== null) args.push('--from', String(request.from));
  if (request.to !== undefined && request.to !== null) args.push('--to', String(request.to));
  if (!keysMode && request.duration !== undefined && request.duration !== null) args.push('--dur', String(request.duration));
  if (!keysMode && request.offset !== undefined && request.offset !== null) args.push('--at', String(request.offset));
  if (!keysMode && request.easing !== undefined && request.easing !== null) args.push('--ease', String(request.easing));
  args.push('--', String(request.nodeId ?? ''));
  return parsedRequest(args);
}

function argvFrom(input, planning) {
  return [
    'motion', 'add', '--field', input.field,
    ...(input.mode === 'keys' ? ['--keys', input.keys] : [
      '--from', String(input.from), '--to', String(input.to),
      ...(input.duration === DEFAULT_MOTION_ADD_DURATION ? [] : ['--dur', String(input.duration)]),
      ...(input.offset === DEFAULT_MOTION_ADD_OFFSET ? [] : ['--at', String(input.offset)]),
      ...(input.easing === DEFAULT_MOTION_ADD_EASING ? [] : ['--ease', input.easing]),
    ]),
    '--', planning ? input.reference.planningValue : input.reference.nodeId,
  ];
}

export function motionAddArgvFromRequest(request) {
  const args = argvFrom(typedInput(request), false);
  parseMotionAddRequest(args);
  return args;
}

export function motionAddPlanningArgvFromRequest(request) {
  const args = argvFrom(typedInput(request), true);
  parseMotionAddRequest(args);
  return args;
}
