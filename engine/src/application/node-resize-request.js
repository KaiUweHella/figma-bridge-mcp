// Closed request Interface for `node resize`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';
import { finiteNodeCoordinate } from './node-coordinate.js';

export const MAX_NODE_RESIZE_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const NODE_RESIZE_KEYWORDS = Object.freeze(['keep', 'fill', 'hug']);

function requestError(message) {
  return new Error(`Invalid node resize command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError('nodeId must not be empty');
    if (error.code === 'too-long') {
      throw requestError(`nodeId must be at most ${MAX_NODE_RESIZE_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError('nodeId must be a Figma node id or URL containing node-id');
  }
}

function dimension(value, field) {
  if (typeof value === 'string') {
    const keyword = value.toLowerCase();
    if (NODE_RESIZE_KEYWORDS.includes(keyword)) return keyword;
  }
  try { return finiteNodeCoordinate(value, field); }
  catch (error) { throw requestError(`${field} must be a finite number or keep, fill, hug`); }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'resize') {
    throw new Error('Expected a node resize command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Resize arguments must be strings.');
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-') && !Number.isFinite(Number(token))) {
      throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length < 3) throw requestError('nodeId, width and height are required');
  if (positionals.length > 3) throw requestError(`unexpected argument ${positionals[3]}`);
  return {
    reference: nodeReference(positionals[0]),
    width: dimension(positionals[1], 'width'),
    height: dimension(positionals[2], 'height'),
  };
}

export function parseNodeResizeRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    nodeId: input.reference.nodeId, width: input.width, height: input.height,
  });
}

export function acceptsNodeResizeArgv(args) {
  try { parseNodeResizeRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Node Resize request must be an object.');
  }
  return {
    reference: nodeReference(request.nodeId),
    width: dimension(request.width, 'width'),
    height: dimension(request.height, 'height'),
  };
}

function argvFromInput(input, { planning = false } = {}) {
  return [
    'node', 'resize', planning ? input.reference.planningValue : input.reference.nodeId,
    '--', String(input.width), String(input.height),
  ];
}

export function nodeResizeArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseNodeResizeRequest(args);
  return args;
}

export function nodeResizePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseNodeResizeRequest(args);
  return args;
}

export function nodeResizeFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}
