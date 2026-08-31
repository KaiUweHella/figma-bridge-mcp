// Closed request Interface for `dev list`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid Dev Resource Read command: ${message}.`);
}

function nodeValue(value) {
  if (value === undefined || value === null || value === '') {
    return { nodeId: null, fileKey: null, planningValue: null, warning: '' };
  }
  if (typeof value !== 'string') throw requestError('nodeId must be a string');
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'dev' || args[1] !== 'list') {
    throw new Error('Expected a dev list command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Dev Resource Read arguments must be strings.');
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
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return nodeValue(positionals[0]);
}

export function parseDevResourceReadRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    nodeId: input.nodeId,
    warning: input.warning,
  });
}

export function acceptsDevResourceReadArgv(args) {
  try {
    parseDevResourceReadRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function devResourceReadFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Dev Resource Read request must be an object.');
  }
  return nodeValue(request.nodeId);
}

export function devResourceReadArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['dev', 'list', ...(input.nodeId ? ['--', input.nodeId] : [])];
  parseDevResourceReadRequest(args);
  return args;
}

export function devResourceReadPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['dev', 'list', ...(input.nodeId ? ['--', input.planningValue] : [])];
}
