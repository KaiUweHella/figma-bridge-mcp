// Closed request Interface for `slides duplicate`.

import {
  parseUnionReference,
  unionReferenceArgvValue,
} from './union-reference.js';

export const MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS = 4_096;
export const MAX_SLIDES_DUPLICATE_INDEX = 4_095;

function requestError(message) {
  return new Error(`Invalid Slides Duplicate command: ${message}.`);
}

function labelValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw requestError('label must be a string');
  if (value.length > MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS) {
    throw requestError(`label must not exceed ${MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS} code units`);
  }
  return value;
}

function indexValue(value, name) {
  if (value === undefined || value === null) return null;
  const source = typeof value === 'number' ? String(value) : value;
  if (typeof source !== 'string' || !/^(0|[1-9][0-9]*)$/.test(source)) {
    throw requestError(`${name} must be a zero-based non-negative integer`);
  }
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SLIDES_DUPLICATE_INDEX) {
    throw requestError(`${name} must not exceed ${MAX_SLIDES_DUPLICATE_INDEX}`);
  }
  return parsed;
}

function referenceValue(value) {
  try {
    if (typeof value === 'string') return parseUnionReference(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return parseUnionReference(`${value.kind || ''}:${value.value ?? value.nodeId ?? ''}`);
    }
  } catch (error) {
    throw requestError(error.message);
  }
  throw requestError('slide reference is required');
}

export function parseSlidesDuplicateRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slides' || args[1] !== 'duplicate') {
    throw new Error('Expected a slides duplicate command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slides Duplicate arguments must be strings.');
  }
  const seen = new Set();
  const positionals = [];
  let label = null;
  let row = null;
  let col = null;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && ['--label', '--row', '--col'].some(
      (name) => token === name || token.startsWith(`${name}=`),
    )) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      if (seen.has(name)) throw requestError(`${name} may be provided only once`);
      seen.add(name);
      const value = equals === -1 ? args[++index] : token.slice(equals + 1);
      if (typeof value !== 'string' || value === '--') {
        throw requestError(`${name} requires a value`);
      }
      if (name === '--label') label = labelValue(value);
      if (name === '--row') row = indexValue(value, 'row');
      if (name === '--col') col = indexValue(value, 'col');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('slide reference is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  if (col !== null && row === null) throw requestError('--col requires --row');
  return Object.freeze({ reference: referenceValue(positionals[0]), label, row, col });
}

export function acceptsSlidesDuplicateArgv(args) {
  try { parseSlidesDuplicateRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slides Duplicate request must be an object.');
  }
  if (Object.keys(request).some((key) => !['reference', 'label', 'row', 'col'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  const reference = referenceValue(request.reference);
  const label = labelValue(request.label);
  const row = indexValue(request.row, 'row');
  const col = indexValue(request.col, 'col');
  if (col !== null && row === null) throw requestError('col requires row');
  return { reference, label, row, col };
}

function argvFromInput(input, planning) {
  const reference = input.reference.kind === 'node' && planning
    ? `node:${input.reference.planningValue}`
    : unionReferenceArgvValue(input.reference);
  const options = [
    ...(input.label === null ? [] : [`--label=${input.label}`]),
    ...(input.row === null ? [] : [`--row=${input.row}`]),
    ...(input.col === null ? [] : [`--col=${input.col}`]),
  ];
  return reference.startsWith('-')
    ? ['slides', 'duplicate', ...options, '--', reference]
    : ['slides', 'duplicate', reference, ...options];
}

export function slidesDuplicateArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseSlidesDuplicateRequest(args);
  return args;
}

export function slidesDuplicatePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseSlidesDuplicateRequest(args);
  return args;
}

export function slidesDuplicateFigmaUrlFileKeyFromArgv(args) {
  return parseSlidesDuplicateRequest(args).reference.fileKey;
}
