// Closed request Interface for one exact `node bind` mutation.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_NODE_BIND_QUERY_CODE_UNITS = 512;
export const NODE_BIND_PROPERTIES = Object.freeze({
  fill: Object.freeze({ kind: 'paint', field: 'fills', type: 'COLOR' }),
  stroke: Object.freeze({ kind: 'paint', field: 'strokes', type: 'COLOR' }),
  radius: Object.freeze({ kind: 'scalar', field: 'cornerRadius', type: 'FLOAT' }),
  gap: Object.freeze({ kind: 'scalar', field: 'itemSpacing', type: 'FLOAT' }),
  opacity: Object.freeze({ kind: 'scalar', field: 'opacity', type: 'FLOAT' }),
  'stroke-width': Object.freeze({ kind: 'scalar', field: 'strokeWeight', type: 'FLOAT' }),
  width: Object.freeze({ kind: 'scalar', field: 'width', type: 'FLOAT' }),
  height: Object.freeze({ kind: 'scalar', field: 'height', type: 'FLOAT' }),
  padding: Object.freeze({ kind: 'scalar', field: Object.freeze([
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  ]), type: 'FLOAT' }),
  'padding-top': Object.freeze({ kind: 'scalar', field: 'paddingTop', type: 'FLOAT' }),
  'padding-right': Object.freeze({ kind: 'scalar', field: 'paddingRight', type: 'FLOAT' }),
  'padding-bottom': Object.freeze({ kind: 'scalar', field: 'paddingBottom', type: 'FLOAT' }),
  'padding-left': Object.freeze({ kind: 'scalar', field: 'paddingLeft', type: 'FLOAT' }),
});

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
function requestError(message) { return new Error(`Invalid node bind command: ${message}.`); }
function bounded(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw requestError(`${field} is required`);
  if (value.length > MAX_NODE_BIND_QUERY_CODE_UNITS) throw requestError(`${field} is too long`);
  if (UNSAFE.test(value)) throw requestError(`${field} contains unsafe control characters`);
  return value;
}
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}
function propertyValue(value) {
  const property = bounded(value, 'property');
  if (!Object.hasOwn(NODE_BIND_PROPERTIES, property)) {
    throw requestError(`property must be one of ${Object.keys(NODE_BIND_PROPERTIES).join(', ')}`);
  }
  return property;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'bind') {
    throw new Error('Expected a node bind command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Node Bind arguments must be strings.');
  const positionals = [];
  let collection = null;
  let literal = false;
  let collectionSeen = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '--batch' || token.startsWith('--batch='))) {
      throw requestError('--batch is disabled; bind one explicit node per command');
    }
    if (!literal && (token === '-c' || token === '--collection' || token.startsWith('--collection='))) {
      if (collectionSeen) throw requestError('--collection may be provided only once');
      collectionSeen = true;
      const inline = token.startsWith('--collection=') ? token.slice(13) : null;
      const value = inline === null ? args[++index] : inline;
      if (value === undefined || value === '' || (inline === null && value.startsWith('-'))) {
        throw requestError('--collection requires a value');
      }
      collection = bounded(value, 'collection');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 3) throw requestError('nodeId, property, and variable are required');
  if (positionals.length > 3) throw requestError(`unexpected argument ${positionals[3]}`);
  return {
    node: nodeValue(positionals[0]), property: propertyValue(positionals[1]),
    variable: bounded(positionals[2], 'variable'), collection,
  };
}

export function parseNodeBindRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({ nodeId: input.node.nodeId, property: input.property,
    variable: input.variable, collection: input.collection });
}
export function acceptsNodeBindArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }
export function nodeBindFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).node.fileKey; }

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node Bind request must be an object.');
  }
  return { node: nodeValue(request.nodeId), property: propertyValue(request.property),
    variable: bounded(request.variable, 'variable'),
    collection: request.collection == null ? null : bounded(request.collection, 'collection') };
}
function argvFrom(input, node) {
  return ['node', 'bind', ...(input.collection === null ? [] : ['--collection', input.collection]),
    '--', node, input.property, input.variable];
}
export function nodeBindArgvFromRequest(request) {
  const input = typedRequest(request); const args = argvFrom(input, input.node.nodeId);
  parseNodeBindRequest(args); return args;
}
export function nodeBindPlanningArgvFromRequest(request) {
  const input = typedRequest(request); const args = argvFrom(input, input.node.planningValue);
  parseNodeBindRequest(args); return args;
}
