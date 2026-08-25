// Closed request Interface for `grid list`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid grid list command: ${message}.`);
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
  if (!Array.isArray(args) || args[0] !== 'grid' || args[1] !== 'list') {
    throw new Error('Expected a grid list command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Layout Grid Facts arguments must be strings.');
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
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { node: positionals.length ? nodeValue(positionals[0]) : null, json };
}

export function parseLayoutGridFactsRequest(args) {
  const input = parsedRequest(args);
  return {
    nodeId: input.node?.nodeId || null,
    json: input.json,
    warning: input.node?.warning || '',
  };
}

export function layoutGridFactsFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node?.fileKey || null;
}

export function acceptsLayoutGridFactsArgv(args) {
  try {
    parseLayoutGridFactsRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Layout Grid Facts request must be an object.');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return {
    node: request.nodeId == null ? null : nodeValue(request.nodeId),
    json: request.json === true,
  };
}

export function layoutGridFactsArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'grid', 'list',
    ...(input.node ? [input.node.nodeId] : []),
    ...(input.json ? ['--json'] : []),
  ];
}
export function layoutGridFactsPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'grid', 'list',
    ...(input.node ? [input.node.planningValue] : []),
    ...(input.json ? ['--json'] : []),
  ];
}
