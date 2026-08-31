// Closed request Interface for `annotate remove`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid Annotation Remove command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function annotationIndex(value) {
  if (typeof value === 'string' && value.trim() === '') {
    throw requestError('index must be a non-negative safe integer');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw requestError('index must be a non-negative safe integer');
  }
  return number;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'annotate' || args[1] !== 'remove') {
    throw new Error('Expected an annotate remove command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Annotation Remove arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('missing required arguments nodeId, index');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return { reference: nodeReference(positionals[0]), index: annotationIndex(positionals[1]) };
}

export function parseAnnotationRemoveRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({ nodeId: input.reference.nodeId, index: input.index });
}

export function acceptsAnnotationRemoveArgv(args) {
  try {
    parseAnnotationRemoveRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function annotationRemoveFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Annotation Remove request must be an object.');
  }
  return { reference: nodeReference(request.nodeId), index: annotationIndex(request.index) };
}

function argvFromInput(input, planning) {
  return [
    'annotate', 'remove',
    planning ? input.reference.planningValue : input.reference.nodeId,
    String(input.index),
  ];
}

export function annotationRemoveArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseAnnotationRemoveRequest(args);
  return args;
}

export function annotationRemovePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseAnnotationRemoveRequest(args);
  return args;
}
