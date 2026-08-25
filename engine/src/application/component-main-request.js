// Closed request Interface for `component main`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid component main command: ${message}.`);
}

function nodeValue(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('instanceId must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'main') {
    throw new Error('Expected a component main command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Main arguments must be strings.');
  }

  const positionals = [];
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('instanceId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { node: nodeValue(positionals[0]), json };
}

export function parseComponentMainRequest(args) {
  const input = parsedRequest(args);
  return {
    instanceId: input.node.nodeId,
    json: input.json,
    warning: input.node.warning,
  };
}

export function componentMainFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node.fileKey;
}

export function acceptsComponentMainArgv(args) {
  try {
    parseComponentMainRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Main request must be an object.');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return { node: nodeValue(request.instanceId), json: request.json === true };
}

export function componentMainArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['component', 'main', input.node.nodeId, ...(input.json ? ['--json'] : [])];
}

export function componentMainPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['component', 'main', input.node.planningValue, ...(input.json ? ['--json'] : [])];
}
