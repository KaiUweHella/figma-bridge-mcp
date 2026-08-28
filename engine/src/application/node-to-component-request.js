// Closed request Interface for `node to-component`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_NODE_TO_COMPONENT_TARGETS = 1_000;
export const MAX_NODE_TO_COMPONENT_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;

function requestError(message) {
  return new Error(`Invalid node to-component command: ${message}.`);
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
  if (values.length > MAX_NODE_TO_COMPONENT_TARGETS) {
    throw requestError(`at most ${MAX_NODE_TO_COMPONENT_TARGETS} nodes may be converted at once`);
  }
  const references = values.map(nodeReference);
  const ids = references.map((reference) => reference.nodeId);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw requestError(`duplicate node id ${duplicate}`);
  const keys = new Set(references.map((reference) => reference.fileKey).filter(Boolean));
  if (keys.size > 1) throw requestError('node references target multiple Figma files');
  return references;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'to-component') {
    throw new Error('Expected a node to-component command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node to-component arguments must be strings.');
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

export function parseNodeToComponentRequest(args) {
  return Object.freeze({ nodeIds: Object.freeze(parsedRequest(args).map((reference) => reference.nodeId)) });
}

export function acceptsNodeToComponentArgv(args) {
  try { parseNodeToComponentRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node to-component request must be an object.');
  }
  return validatedReferences(request.nodeIds);
}

function argvFromReferences(references, { planning = false } = {}) {
  return [
    'node', 'to-component',
    ...references.map((reference) => planning ? reference.planningValue : reference.nodeId),
  ];
}

export function nodeToComponentArgvFromRequest(request) {
  const args = argvFromReferences(typedRequest(request));
  parseNodeToComponentRequest(args);
  return args;
}

export function nodeToComponentPlanningArgvFromRequest(request) {
  const args = argvFromReferences(typedRequest(request), { planning: true });
  parseNodeToComponentRequest(args);
  return args;
}

export function nodeToComponentFigmaUrlFileKeyFromArgv(args) {
  const keys = new Set(parsedRequest(args).map((reference) => reference.fileKey).filter(Boolean));
  return keys.values().next().value || null;
}
