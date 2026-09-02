// Closed reference projection for the Figma Slides beta Command surface.

import {
  parseUnionReference,
  unionReferenceArgvValue,
} from './union-reference.js';

const ACTIONS = new Set(['inspect', 'create', 'duplicate', 'move', 'transition', 'skip', 'delete', 'lint', 'manifest', 'focus', 'view']);
const VALUE_OPTIONS = Object.freeze({
  create: new Set(['--row', '--col']),
  duplicate: new Set(['--label', '--row', '--col']),
  transition: new Set(['--duration', '--curve', '--timing', '--delay']),
  lint: new Set(['--kinds', '--limit']),
});
// Options that stand alone. The reference grammar had no boolean flag before
// deck lint, so every `--flag` used to be rejected as unknown.
const FLAG_OPTIONS = Object.freeze({
  lint: new Set(['--fail-on-issues']),
});
const POSITIONAL_BOUNDS = Object.freeze({
  lint: [0, 0],
  manifest: [0, 0],
  focus: [1, 1],
  view: [1, 1],
  inspect: [0, 1],
  create: [0, 1],
  duplicate: [1, 1],
  move: [3, 3],
  transition: [2, 2],
  skip: [1, 2],
  delete: [1, 1],
});
const REFERENCE_ACTIONS = new Set(['inspect', 'duplicate', 'move', 'transition', 'skip', 'delete', 'focus']);

function requestError(message) {
  return new Error(`Invalid Slides command: ${message}.`);
}

function positionalIndexes(args, action) {
  const indexes = [];
  const valueOptions = VALUE_OPTIONS[action] || new Set();
  const flagOptions = FLAG_OPTIONS[action] || new Set();
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
      if (flagOptions.has(name)) {
        if (equals !== -1) throw requestError(`${name} does not take a value`);
        continue;
      }
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

function typedInspectRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slides Inspect request must be an object.');
  }
  if (Object.keys(request).some((key) => key !== 'reference')) {
    throw requestError('inspect request contains an unknown field');
  }
  if (request.reference === undefined || request.reference === null) return null;
  try { return parseUnionReference(request.reference); }
  catch (error) { throw requestError(error.message); }
}

function inspectArgv(request, planning) {
  const reference = typedInspectRequest(request);
  const args = ['slides', 'inspect'];
  if (reference) {
    args.push(reference.kind === 'node' && planning
      ? `node:${reference.planningValue}`
      : unionReferenceArgvValue(reference));
  }
  parseSlidesReferenceRequest(args);
  return args;
}

export function slidesInspectArgvFromRequest(request) {
  return inspectArgv(request, false);
}

export function slidesInspectPlanningArgvFromRequest(request) {
  return inspectArgv(request, true);
}
