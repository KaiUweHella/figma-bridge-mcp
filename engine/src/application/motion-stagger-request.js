// Closed request Interface for `motion stagger`.

import {
  motionAddArgvFromRequest,
  parseMotionAddRequest,
} from './motion-add-request.js';
import {
  motionPresetArgvFromRequest,
  parseMotionPresetRequest,
} from './motion-preset-request.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEFAULT_MOTION_STAGGER_STEP = 0.1;
export const DEFAULT_MOTION_STAGGER_DURATION = 0.5;
export const DEFAULT_MOTION_STAGGER_EASING = 'ease-out';
export const MAX_MOTION_STAGGER_NODES = 128;

function requestError(message) { return new Error(`Invalid Motion Stagger command: ${message}.`); }

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('every node must be a bounded Figma node id or URL containing node-id');
  }
}

function references(value) {
  if (typeof value !== 'string') throw requestError('nodes must be a comma-separated string');
  const result = value.split(',').map((entry) => entry.trim()).filter(Boolean).map(nodeReference);
  if (result.length === 0 || result.length > MAX_MOTION_STAGGER_NODES) {
    throw requestError(`nodes must contain between 1 and ${MAX_MOTION_STAGGER_NODES} identities`);
  }
  if (new Set(result.map((entry) => entry.nodeId)).size !== result.length) {
    throw requestError('node identities must be unique');
  }
  const fileKeys = [...new Set(result.map((entry) => entry.fileKey).filter(Boolean))];
  if (fileKeys.length > 1) throw requestError('node URLs must belong to one Figma file');
  return result;
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

function optionValue(token, aliases) {
  for (const alias of aliases) {
    if (token.startsWith(`${alias}=`)) return token.slice(alias.length + 1);
    if (alias.length === 2 && token.startsWith(alias) && token.length > 2
      && token[2] !== '-') return token.slice(2);
  }
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'motion' || args[1] !== 'stagger') {
    throw new Error('Expected a motion stagger command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Motion Stagger arguments must be strings.');
  const values = { preset: null, field: null, from: null, to: null };
  let step = DEFAULT_MOTION_STAGGER_STEP;
  let duration = DEFAULT_MOTION_STAGGER_DURATION;
  let easing = DEFAULT_MOTION_STAGGER_EASING;
  const seen = new Set();
  let literal = false;
  const positionals = [];
  const definitions = [
    { name: 'preset', aliases: ['-p', '--preset'] },
    { name: 'field', aliases: ['-f', '--field'] },
    { name: 'from', aliases: ['--from'] },
    { name: 'to', aliases: ['--to'] },
    { name: 'step', aliases: ['-s', '--step'] },
    { name: 'duration', aliases: ['-d', '--dur'] },
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
      if (definition.name === 'step') step = numberValue(value, 'step');
      else if (definition.name === 'duration') duration = numberValue(value, 'duration', { positive: true });
      else if (definition.name === 'easing') easing = value;
      else values[definition.name] = value;
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodes are required');
  }
  if ((values.preset === null) === (values.field === null)) {
    throw requestError('exactly one of preset or field is required');
  }
  const refs = references(positionals[0]);
  let mode; let preset = null; let field = null; let from = null; let to = null;
  if (values.preset !== null) {
    if (values.from !== null || values.to !== null) throw requestError('from and to require field mode');
    let parsed;
    try {
      parsed = parseMotionPresetRequest(motionPresetArgvFromRequest({
        nodeId: refs[0].nodeId, preset: values.preset, duration, easing,
      }));
    } catch (error) { throw requestError(error.message); }
    mode = 'preset'; preset = parsed.preset; duration = parsed.duration; easing = parsed.easing;
  } else {
    if (values.from === null || values.to === null) throw requestError('field mode requires both from and to');
    let parsed;
    try {
      parsed = parseMotionAddRequest(motionAddArgvFromRequest({
        nodeId: refs[0].nodeId, field: values.field, from: values.from, to: values.to,
        duration, easing,
      }));
    } catch (error) { throw requestError(error.message); }
    mode = 'field'; field = parsed.field; from = parsed.from; to = parsed.to;
    duration = parsed.duration; easing = parsed.easing;
  }
  const end = (refs.length - 1) * step + duration;
  if (!Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER) {
    throw requestError('stagger span exceeds the supported timeline range');
  }
  return { references: refs, mode, preset, field, from, to, step, duration, easing };
}

function projected(input) {
  return Object.freeze({
    nodeIds: Object.freeze(input.references.map((entry) => entry.nodeId)),
    mode: input.mode,
    preset: input.preset,
    field: input.field,
    from: input.from,
    to: input.to,
    step: input.step,
    duration: input.duration,
    easing: input.easing,
  });
}

export function parseMotionStaggerRequest(args) { return projected(parsedRequest(args)); }
export function acceptsMotionStaggerArgv(args) {
  try { parseMotionStaggerRequest(args); return true; } catch { return false; }
}
export function motionStaggerFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).references.find((entry) => entry.fileKey)?.fileKey ?? null;
}

function typedInput(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Motion Stagger request must be an object.');
  if (Object.keys(request).some((key) => ![
    'nodeIds','mode','preset','field','from','to','step','duration','easing',
  ].includes(key))) throw requestError('request contains an unknown field');
  if (!Array.isArray(request.nodeIds)) throw requestError('nodeIds must be an array');
  const mode = request.mode ?? (request.preset != null ? 'preset' : 'field');
  if (!['preset', 'field'].includes(mode)) throw requestError('mode must be preset or field');
  const args = ['motion', 'stagger'];
  if (mode === 'preset') args.push('--preset', String(request.preset ?? ''));
  else {
    args.push('--field', String(request.field ?? ''));
    if (request.from !== undefined && request.from !== null) args.push('--from', String(request.from));
    if (request.to !== undefined && request.to !== null) args.push('--to', String(request.to));
  }
  if (request.step !== undefined && request.step !== null) args.push('--step', String(request.step));
  if (request.duration !== undefined && request.duration !== null) args.push('--dur', String(request.duration));
  if (request.easing !== undefined && request.easing !== null) args.push('--ease', String(request.easing));
  args.push('--', request.nodeIds.map(String).join(','));
  return parsedRequest(args);
}

function argvFrom(input, planning) {
  return [
    'motion', 'stagger',
    ...(input.mode === 'preset' ? ['--preset', input.preset] : [
      '--field', input.field, '--from', String(input.from), '--to', String(input.to),
    ]),
    ...(input.step === DEFAULT_MOTION_STAGGER_STEP ? [] : ['--step', String(input.step)]),
    ...(input.duration === DEFAULT_MOTION_STAGGER_DURATION ? [] : ['--dur', String(input.duration)]),
    ...(input.easing === DEFAULT_MOTION_STAGGER_EASING ? [] : ['--ease', input.easing]),
    '--', input.references.map((entry) => planning ? entry.planningValue : entry.nodeId).join(','),
  ];
}

export function motionStaggerArgvFromRequest(request) {
  const args = argvFrom(typedInput(request), false); parseMotionStaggerRequest(args); return args;
}
export function motionStaggerPlanningArgvFromRequest(request) {
  const args = argvFrom(typedInput(request), true); parseMotionStaggerRequest(args); return args;
}
