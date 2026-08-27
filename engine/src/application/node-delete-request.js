// Closed request Interface for `node delete`.
//
// CLI and MCP share every accepted Node Reference, duplicate check and Figma
// URL target decision before Plugin readiness or destructive dispatch.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_NODE_DELETE_TARGETS = 1000;

function requestError(message) {
  return new Error(`Invalid node delete command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('every target must be a bounded Figma node id or URL containing node-id');
  }
}

function validatedReferences(values) {
  if (!Array.isArray(values)) throw requestError('nodeIds must be an array');
  if (values.length === 0) throw requestError('at least one node id is required');
  if (values.length > MAX_NODE_DELETE_TARGETS) {
    throw requestError(`at most ${MAX_NODE_DELETE_TARGETS} nodes may be deleted at once`);
  }
  const nodes = values.map(nodeReference);
  const ids = nodes.map((node) => node.nodeId);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw requestError(`duplicate node id ${duplicate}`);
  return nodes;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'delete') {
    throw new Error('Expected a node delete command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Delete arguments must be strings.');
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
  return validatedReferences(positionals);
}

export function parseNodeDeleteRequest(args) {
  return { nodeIds: parsedRequest(args).map((node) => node.nodeId) };
}

export function nodeDeleteFigmaUrlFileKeyFromArgv(args) {
  const keys = new Set(parsedRequest(args).map((node) => node.fileKey).filter(Boolean));
  if (keys.size > 1) throw requestError('node references target multiple Figma files');
  return keys.values().next().value || null;
}

export function acceptsNodeDeleteArgv(args) {
  try {
    parseNodeDeleteRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node Delete request must be an object.');
  }
  return validatedReferences(request.nodeIds);
}

export function nodeDeleteArgvFromRequest(request) {
  return ['node', 'delete', ...typedRequest(request).map((node) => node.nodeId)];
}

export function nodeDeletePlanningArgvFromRequest(request) {
  return ['node', 'delete', ...typedRequest(request).map((node) => node.planningValue)];
}
