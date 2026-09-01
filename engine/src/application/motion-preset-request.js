// Closed request Interface for `motion preset`.

import { mapEasing, PRESETS, presetTracks } from '../lib/motion-core.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEFAULT_MOTION_PRESET_DURATION = 0.5;
export const DEFAULT_MOTION_PRESET_OFFSET = 0;
export const DEFAULT_MOTION_PRESET_EASING = 'ease-out';
const MAX_EASING_CODE_UNITS = 256;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid Motion Preset command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function numberValue(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') throw requestError(`${label} must be a finite number`);
  const source = typeof value === 'string' ? value.trim() : value;
  const number = Number(source);
  if (source === '' || !Number.isFinite(number) || number < 0 || (positive && number === 0)
    || number > Number.MAX_SAFE_INTEGER) {
    throw requestError(`${label} must be a finite ${positive ? 'positive' : 'non-negative'} number`);
  }
  return number;
}

function presetValue(value) {
  if (typeof value !== 'string' || !Object.hasOwn(PRESETS, value)) {
    throw requestError(`preset must be one of ${Object.keys(PRESETS).join(', ')}`);
  }
  return value;
}

function easingValue(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EASING_CODE_UNITS
    || UNSAFE_TEXT.test(value)) throw requestError('easing must be a non-empty control-safe string');
  const result = value.trim();
  try { mapEasing(result); }
  catch (error) { throw requestError(error.message); }
  return result;
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
  if (!Array.isArray(args) || args[0] !== 'motion' || args[1] !== 'preset') {
    throw new Error('Expected a motion preset command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Motion Preset arguments must be strings.');
  let duration = DEFAULT_MOTION_PRESET_DURATION;
  let offset = DEFAULT_MOTION_PRESET_OFFSET;
  let easing = DEFAULT_MOTION_PRESET_EASING;
  const seen = new Set();
  let literal = false;
  const positionals = [];
  const definitions = [
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
      if (definition.name === 'duration') duration = numberValue(value, 'duration', { positive: true });
      else if (definition.name === 'offset') offset = numberValue(value, 'offset');
      else easing = easingValue(value);
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 2) {
    throw requestError(positionals.length > 2 ? `unexpected argument ${positionals[2]}` : 'nodeId and preset are required');
  }
  if (!Number.isFinite(duration + offset) || duration + offset > Number.MAX_SAFE_INTEGER) {
    throw requestError('duration plus offset exceeds the supported timeline range');
  }
  const preset = presetValue(positionals[1]);
  try { presetTracks(preset, { dur: duration, at: offset, ease: easing }); }
  catch (error) { throw requestError(error.message); }
  return { reference: nodeReference(positionals[0]), preset, duration, offset, easing };
}

function projected(input) {
  return Object.freeze({
    nodeId: input.reference.nodeId,
    preset: input.preset,
    duration: input.duration,
    offset: input.offset,
    easing: input.easing,
  });
}

export function parseMotionPresetRequest(args) { return projected(parsedRequest(args)); }
export function acceptsMotionPresetArgv(args) {
  try { parseMotionPresetRequest(args); return true; } catch { return false; }
}
export function motionPresetFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).reference.fileKey; }

function typedInput(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Motion Preset request must be an object.');
  if (Object.keys(request).some((key) => !['nodeId','preset','duration','offset','easing'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  const args = ['motion', 'preset'];
  if (request.duration !== undefined && request.duration !== null) args.push('--dur', String(request.duration));
  if (request.offset !== undefined && request.offset !== null) args.push('--at', String(request.offset));
  if (request.easing !== undefined && request.easing !== null) args.push('--ease', String(request.easing));
  args.push('--', String(request.nodeId ?? ''), String(request.preset ?? ''));
  return parsedRequest(args);
}

function argvFrom(input, planning) {
  return [
    'motion', 'preset',
    ...(input.duration === DEFAULT_MOTION_PRESET_DURATION ? [] : ['--dur', String(input.duration)]),
    ...(input.offset === DEFAULT_MOTION_PRESET_OFFSET ? [] : ['--at', String(input.offset)]),
    ...(input.easing === DEFAULT_MOTION_PRESET_EASING ? [] : ['--ease', input.easing]),
    '--', planning ? input.reference.planningValue : input.reference.nodeId, input.preset,
  ];
}

export function motionPresetArgvFromRequest(request) {
  const args = argvFrom(typedInput(request), false); parseMotionPresetRequest(args); return args;
}
export function motionPresetPlanningArgvFromRequest(request) {
  const args = argvFrom(typedInput(request), true); parseMotionPresetRequest(args); return args;
}
