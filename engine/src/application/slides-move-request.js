// Closed request Interface for `slides move`.

import {
  parseUnionReference,
  unionReferenceArgvValue,
} from './union-reference.js';

export const MAX_SLIDES_MOVE_INDEX = 4_095;

function requestError(message) {
  return new Error(`Invalid Slides Move command: ${message}.`);
}

function indexValue(value, name) {
  const source = typeof value === 'number' ? String(value) : value;
  if (typeof source !== 'string' || !/^(0|[1-9][0-9]*)$/.test(source)) {
    throw requestError(`${name} must be a zero-based non-negative integer`);
  }
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SLIDES_MOVE_INDEX) {
    throw requestError(`${name} must not exceed ${MAX_SLIDES_MOVE_INDEX}`);
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

export function parseSlidesMoveRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slides' || args[1] !== 'move') {
    throw new Error('Expected a slides move command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slides Move arguments must be strings.');
  }
  let literal = false;
  const positionals = [];
  for (const token of args.slice(2)) {
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 3) throw requestError('slide reference, row and col are required');
  if (positionals.length > 3) throw requestError(`unexpected argument ${positionals[3]}`);
  return Object.freeze({
    reference: referenceValue(positionals[0]),
    row: indexValue(positionals[1], 'row'),
    col: indexValue(positionals[2], 'col'),
  });
}

export function acceptsSlidesMoveArgv(args) {
  try { parseSlidesMoveRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slides Move request must be an object.');
  }
  if (Object.keys(request).some((key) => !['reference', 'row', 'col'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  return {
    reference: referenceValue(request.reference),
    row: indexValue(request.row, 'row'),
    col: indexValue(request.col, 'col'),
  };
}

function argvFromInput(input, planning) {
  const reference = input.reference.kind === 'node' && planning
    ? `node:${input.reference.planningValue}`
    : unionReferenceArgvValue(input.reference);
  return ['slides', 'move', reference, String(input.row), String(input.col)];
}

export function slidesMoveArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseSlidesMoveRequest(args);
  return args;
}

export function slidesMovePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseSlidesMoveRequest(args);
  return args;
}

export function slidesMoveFigmaUrlFileKeyFromArgv(args) {
  return parseSlidesMoveRequest(args).reference.fileKey;
}
