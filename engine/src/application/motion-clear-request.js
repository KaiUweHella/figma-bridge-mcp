// Closed request Interface for `motion clear`.

import { mapField } from '../lib/motion-core.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MOTION_CLEAR_MODES = Object.freeze(['tracks', 'field', 'styles']);
export const MAX_MOTION_CLEAR_FIELD_CODE_UNITS = 256;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid Motion Clear command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function canonicalField(value) {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_MOTION_CLEAR_FIELD_CODE_UNITS || UNSAFE_TEXT.test(value)) {
    throw requestError('field must be a non-empty control-safe Motion field');
  }
  let field;
  try { field = mapField(value); }
  catch (error) { throw requestError(error.message); }
  return field.valueType === 'COLOR' ? `${field.name}:${field.index}` : field.name;
}

function inlineValue(token, option) {
  return token.startsWith(`${option}=`) ? token.slice(option.length + 1) : null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'motion' || args[1] !== 'clear') {
    throw new Error('Expected a motion clear command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Motion Clear arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  let styles = false;
  let field = null;
  let fieldSeen = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--styles') {
      if (styles) throw requestError('--styles may be provided only once');
      styles = true; continue;
    }
    if (!literal && (token === '-f' || token === '--field'
      || inlineValue(token, '-f') !== null || inlineValue(token, '--field') !== null
      || /^-f[^-]/u.test(token))) {
      if (fieldSeen) throw requestError('--field may be provided only once');
      fieldSeen = true;
      let value = inlineValue(token, '--field') ?? inlineValue(token, '-f');
      if (value === null && /^-f[^-]/u.test(token)) value = token.slice(2);
      if (value === null) {
        value = args[index + 1];
        if (value === undefined || value === '--') throw requestError(`${token} requires a value`);
        index += 1;
      }
      field = canonicalField(value);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  }
  return {
    reference: nodeReference(positionals[0]),
    mode: styles ? 'styles' : field === null ? 'tracks' : 'field',
    field: styles ? null : field,
  };
}

function projected(input) {
  return Object.freeze({
    nodeId: input.reference.nodeId,
    mode: input.mode,
    field: input.field,
  });
}

export function parseMotionClearRequest(args) {
  return projected(parsedRequest(args));
}

export function acceptsMotionClearArgv(args) {
  try { parseMotionClearRequest(args); return true; }
  catch { return false; }
}

export function motionClearFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Motion Clear request must be an object.');
  }
  if (Object.keys(request).some((key) => !['nodeId', 'mode', 'field'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  const reference = nodeReference(request.nodeId);
  if (!MOTION_CLEAR_MODES.includes(request.mode)) {
    throw requestError('mode must be tracks, field, or styles');
  }
  const field = request.mode === 'field' ? canonicalField(request.field) : null;
  if (request.mode !== 'field' && request.field !== null && request.field !== undefined) {
    throw requestError('field is accepted only in field mode');
  }
  return { reference, mode: request.mode, field };
}

function argvFrom(input, planning) {
  return [
    'motion', 'clear',
    ...(input.mode === 'styles' ? ['--styles'] : []),
    ...(input.mode === 'field' ? ['--field', input.field] : []),
    '--', planning ? input.reference.planningValue : input.reference.nodeId,
  ];
}

export function motionClearArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false);
  parseMotionClearRequest(args);
  return args;
}

export function motionClearPlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true);
  parseMotionClearRequest(args);
  return args;
}
