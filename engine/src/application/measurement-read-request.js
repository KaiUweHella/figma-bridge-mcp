// Closed request Interface for `measure list`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid measurement read command: ${message}.`);
}

function nodeValue(value) {
  if (value === undefined || value === null || value === '') {
    return { nodeId: null, fileKey: null, warning: '' };
  }
  if (typeof value !== 'string') throw requestError('nodeId must be a string');
  try {
    const reference = parseNodeReference(value);
    return {
      nodeId: reference.nodeId,
      fileKey: reference.fileKey,
      warning: reference.warning,
      planningValue: reference.planningValue,
    };
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'measure' || args[1] !== 'list') {
    throw new Error('Expected a measurement read command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Measurement Read arguments must be strings.');
  }
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return nodeValue(positionals[0]);
}

function projected(input) {
  return Object.freeze({ nodeId: input.nodeId, warning: input.warning });
}

export function parseMeasurementReadRequest(args) {
  return projected(parsedRequest(args));
}

export function acceptsMeasurementReadArgv(args) {
  try {
    parsedRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function measurementReadFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Measurement Read request must be an object.');
  }
  return nodeValue(request.nodeId);
}

export function measurementReadArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['measure', 'list', ...(input.nodeId ? ['--', input.nodeId] : [])];
  parseMeasurementReadRequest(args);
  return args;
}

export function measurementReadPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['measure', 'list', ...(input.nodeId ? ['--', input.planningValue] : [])];
}
