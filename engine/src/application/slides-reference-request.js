// Closed reference projection for the Figma Slides beta Command surface.

import {
  parseUnionReference,
  unionReferenceArgvValue,
} from './union-reference.js';

const ACTIONS = new Set(['inspect', 'create', 'duplicate', 'move', 'transition', 'skip', 'delete']);
const VALUE_OPTIONS = Object.freeze({
  create: new Set(['--row', '--col']),
  duplicate: new Set(['--label', '--row', '--col']),
  transition: new Set(['--duration', '--curve', '--timing', '--delay']),
});
const POSITIONAL_BOUNDS = Object.freeze({
  inspect: [0, 1],
  create: [0, 1],
  duplicate: [1, 1],
  move: [3, 3],
  transition: [2, 2],
  skip: [1, 2],
  delete: [1, 1],
});
const REFERENCE_ACTIONS = new Set(['inspect', 'duplicate', 'move', 'transition', 'skip', 'delete']);

function requestError(message) {
  return new Error(`Invalid Slides command: ${message}.`);
}

function positionalIndexes(args, action) {
  const indexes = [];
  const valueOptions = VALUE_OPTIONS[action] || new Set();
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      if (!valueOptions.has(name)) throw requestError(`unknown option ${name}`);
      if (equals === -1) {
        if (typeof args[index + 1] !== 'string') throw requestError(`${name} requires a value`);
        index++;
      }
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    indexes.push(index);
  }
  return indexes;
}

export function parseSlidesReferenceRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slides' || !ACTIONS.has(args[1])) {
    throw new Error('Expected a supported Slides command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slides arguments must be strings.');
  }
  const action = args[1];
  const indexes = positionalIndexes(args, action);
  const [minimum, maximum] = POSITIONAL_BOUNDS[action];
  if (indexes.length < minimum) throw requestError(`${action} is missing a required argument`);
  if (indexes.length > maximum) throw requestError(`${action} received an unexpected argument`);

  let reference = null;
  let referenceIndex = null;
  if (REFERENCE_ACTIONS.has(action) && indexes.length > 0) {
    referenceIndex = indexes[0];
    try {
      reference = parseUnionReference(args[referenceIndex]);
    } catch (error) {
      throw requestError(error.message);
    }
  }

  return Object.freeze({
    action,
    argv: Object.freeze([...args]),
    reference,
    referenceIndex,
  });
}

export function acceptsSlidesReferenceArgv(args) {
  try {
    parseSlidesReferenceRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function slidesReferenceArgvFromRequest(request) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.argv)) {
    throw new TypeError('Slides reference request must be parsed before canonicalization.');
  }
  const input = parseSlidesReferenceRequest(request.argv);
  const result = [...input.argv];
  if (input.reference) result[input.referenceIndex] = unionReferenceArgvValue(input.reference);
  return result;
}

export function slidesReferencePlanningArgvFromRequest(request) {
  const input = parseSlidesReferenceRequest(request.argv);
  const result = slidesReferenceArgvFromRequest(input);
  if (input.reference?.kind === 'node') {
    result[input.referenceIndex] = `node:${input.reference.planningValue}`;
  }
  return result;
}

export function slidesReferenceFigmaUrlFileKeyFromArgv(args) {
  return parseSlidesReferenceRequest(args).reference?.fileKey || null;
}
