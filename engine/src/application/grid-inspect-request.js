// Closed request Interface for `layout grid inspect`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid Grid Inspect command: ${message}.`);
}

function nodeValue(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Grid Inspect arguments must be strings.');
  }
  if (args[0] !== 'layout' || args[1] !== 'grid' || args[2] !== 'inspect') {
    throw new Error('Expected a Grid Inspect command.');
  }
  let literal = false;
  const positionals = [];
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  }
  return nodeValue(positionals[0]);
}

function projected(input) {
  return Object.freeze({ nodeId: input.nodeId, warning: input.warning });
}

export function parseGridInspectRequest(args) {
  return projected(parsedRequest(args));
}

export function acceptsGridInspectArgv(args) {
  try {
    parsedRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function gridInspectFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey || null;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Grid Inspect request must be an object.');
  }
  return nodeValue(request.nodeId);
}

function argvFrom(input, planning) {
  return ['layout', 'grid', 'inspect', '--', planning ? input.planningValue : input.nodeId];
}

export function gridInspectArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false);
  parseGridInspectRequest(args);
  return args;
}

export function gridInspectPlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true);
  parseGridInspectRequest(args);
  return args;
}
