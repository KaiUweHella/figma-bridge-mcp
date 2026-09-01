// Closed request Interface for `motion style`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEFAULT_MOTION_STYLE_DURATION = 0.5;
export const DEFAULT_MOTION_STYLE_OFFSET = 0;
export const MAX_MOTION_STYLE_NAME_CODE_UNITS = 4_096;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid Motion Style command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function nameValue(value) {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_MOTION_STYLE_NAME_CODE_UNITS || UNSAFE_TEXT.test(value)) {
    throw requestError('name must be a non-empty control-safe string');
  }
  return value;
}

function numberValue(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw requestError(`${label} must be a finite number`);
  }
  const source = typeof value === 'string' ? value.trim() : value;
  const number = Number(source);
  if (source === '' || !Number.isFinite(number) || number < 0 || (positive && number === 0)
    || number > Number.MAX_SAFE_INTEGER) {
    throw requestError(`${label} must be a finite ${positive ? 'positive' : 'non-negative'} number`);
  }
  return number;
}

function timingValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!['in', 'out'].includes(value)) throw requestError('timing must be in or out');
  return value;
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
  if (!Array.isArray(args) || args[0] !== 'motion' || args[1] !== 'style') {
    throw new Error('Expected a motion style command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Motion Style arguments must be strings.');
  }
  let duration = DEFAULT_MOTION_STYLE_DURATION;
  let offset = DEFAULT_MOTION_STYLE_OFFSET;
  let timing = null;
  let durationSeen = false;
  let offsetSeen = false;
  let timingSeen = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const options = [
        { aliases: ['-d', '--dur'], seen: durationSeen, label: 'duration' },
        { aliases: ['--at'], seen: offsetSeen, label: 'offset' },
        { aliases: ['-t', '--timing'], seen: timingSeen, label: 'timing' },
      ];
      const option = options.find(({ aliases }) => aliases.includes(token)
        || optionValue(token, aliases) !== null);
      if (!option) throw requestError(`unknown option ${token}`);
      if (option.seen) throw requestError(`${option.label} may be provided only once`);
      let value = optionValue(token, option.aliases);
      if (value === null) {
        value = args[index + 1];
        if (value === undefined || value === '--') throw requestError(`${token} requires a value`);
        index += 1;
      }
      if (option.label === 'duration') { duration = numberValue(value, 'duration', { positive: true }); durationSeen = true; }
      else if (option.label === 'offset') { offset = numberValue(value, 'offset'); offsetSeen = true; }
      else { timing = timingValue(value); timingSeen = true; }
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 2) {
    throw requestError(positionals.length > 2 ? `unexpected argument ${positionals[2]}` : 'nodeId and name are required');
  }
  if (!Number.isFinite(duration + offset) || duration + offset > Number.MAX_SAFE_INTEGER) {
    throw requestError('duration plus offset exceeds the supported timeline range');
  }
  return { reference: nodeReference(positionals[0]), name: nameValue(positionals[1]), duration, offset, timing };
}

function projected(input) {
  return Object.freeze({
    nodeId: input.reference.nodeId,
    name: input.name,
    duration: input.duration,
    offset: input.offset,
    timing: input.timing,
  });
}

export function parseMotionStyleRequest(args) {
  return projected(parsedRequest(args));
}

export function acceptsMotionStyleArgv(args) {
  try { parseMotionStyleRequest(args); return true; }
  catch { return false; }
}

export function motionStyleFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Motion Style request must be an object.');
  }
  if (Object.keys(request).some((key) => !['nodeId','name','duration','offset','timing'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  const reference = nodeReference(request.nodeId);
  const name = nameValue(request.name);
  const duration = numberValue(request.duration ?? DEFAULT_MOTION_STYLE_DURATION,
    'duration', { positive: true });
  const offset = numberValue(request.offset ?? DEFAULT_MOTION_STYLE_OFFSET, 'offset');
  const timing = timingValue(request.timing);
  if (!Number.isFinite(duration + offset) || duration + offset > Number.MAX_SAFE_INTEGER) {
    throw requestError('duration plus offset exceeds the supported timeline range');
  }
  return { reference, name, duration, offset, timing };
}

function argvFrom(input, planning) {
  return [
    'motion', 'style',
    ...(input.duration === DEFAULT_MOTION_STYLE_DURATION ? [] : ['--dur', String(input.duration)]),
    ...(input.offset === DEFAULT_MOTION_STYLE_OFFSET ? [] : ['--at', String(input.offset)]),
    ...(input.timing === null ? [] : ['--timing', input.timing]),
    '--', planning ? input.reference.planningValue : input.reference.nodeId, input.name,
  ];
}

export function motionStyleArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false);
  parseMotionStyleRequest(args);
  return args;
}

export function motionStylePlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true);
  parseMotionStyleRequest(args);
  return args;
}
