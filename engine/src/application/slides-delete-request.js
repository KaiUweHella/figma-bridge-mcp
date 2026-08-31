// Closed request Interface for irreversible `slides delete`.

import { parseUnionReference, unionReferenceArgvValue } from './union-reference.js';

function requestError(message) {
  return new Error(`Invalid Slides Delete command: ${message}.`);
}

function referenceValue(value) {
  try {
    if (typeof value === 'string') return parseUnionReference(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return parseUnionReference(`${value.kind || ''}:${value.value ?? value.nodeId ?? ''}`);
    }
  } catch (error) { throw requestError(error.message); }
  throw requestError('slide reference is required');
}

export function parseSlidesDeleteRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slides' || args[1] !== 'delete') {
    throw new Error('Expected a slides delete command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slides Delete arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (const token of args.slice(2)) {
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('slide reference is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return Object.freeze({ reference: referenceValue(positionals[0]) });
}

export function acceptsSlidesDeleteArgv(args) {
  try { parseSlidesDeleteRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slides Delete request must be an object.');
  }
  if (Object.keys(request).some((key) => key !== 'reference')) {
    throw requestError('request contains an unknown field');
  }
  return { reference: referenceValue(request.reference) };
}

function argvFromInput(input, planning) {
  const reference = input.reference.kind === 'node' && planning
    ? `node:${input.reference.planningValue}` : unionReferenceArgvValue(input.reference);
  return ['slides', 'delete', reference];
}

export function slidesDeleteArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseSlidesDeleteRequest(args);
  return args;
}

export function slidesDeletePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseSlidesDeleteRequest(args);
  return args;
}

export function slidesDeleteFigmaUrlFileKeyFromArgv(args) {
  return parseSlidesDeleteRequest(args).reference.fileKey;
}
