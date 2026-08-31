// Closed request Interface for `annotate clear`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid Annotation Clear command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'annotate' || args[1] !== 'clear') {
    throw new Error('Expected an annotate clear command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Annotation Clear arguments must be strings.');
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
  if (positionals.length === 0) throw requestError('missing required argument nodeId');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return nodeReference(positionals[0]);
}

export function parseAnnotationClearRequest(args) {
  return Object.freeze({ nodeId: parsedRequest(args).nodeId });
}

export function acceptsAnnotationClearArgv(args) {
  try {
    parseAnnotationClearRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function annotationClearFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Annotation Clear request must be an object.');
  }
  return nodeReference(request.nodeId);
}

export function annotationClearArgvFromRequest(request) {
  const reference = typedRequest(request);
  const args = ['annotate', 'clear', reference.nodeId];
  parseAnnotationClearRequest(args);
  return args;
}

export function annotationClearPlanningArgvFromRequest(request) {
  const reference = typedRequest(request);
  const args = ['annotate', 'clear', reference.planningValue];
  parseAnnotationClearRequest(args);
  return args;
}
