import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_NODE_SET_IMAGE_PATH_CODE_UNITS = 4_096;
export const MAX_NODE_SET_IMAGE_SCALE_CODE_UNITS = 64;
const SCALE_MODES = new Set(['FILL', 'FIT', 'CROP', 'TILE']);
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid node set-image command: ${message}.`);
}

function nodeValue(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function fileValue(value) {
  if (typeof value !== 'string' || !value.length) throw requestError('file is required');
  if (value.length > MAX_NODE_SET_IMAGE_PATH_CODE_UNITS || UNSAFE.test(value)) {
    throw requestError('file is invalid or too long');
  }
  return value;
}

function scaleValue(value) {
  if (typeof value !== 'string' || value.length > MAX_NODE_SET_IMAGE_SCALE_CODE_UNITS
    || UNSAFE.test(value)) {
    throw requestError('scale is invalid or too long');
  }
  const normalized = value.trim().toUpperCase();
  return SCALE_MODES.has(normalized) ? normalized : 'FILL';
}

function parsed(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'set-image') {
    throw new Error('Expected a node set-image command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Node Set Image arguments must be strings.');
  }
  let scale = 'FILL';
  let scaleSeen = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '--scale' || token.startsWith('--scale='))) {
      if (scaleSeen) throw requestError('--scale may be provided only once');
      scaleSeen = true;
      const inline = token.startsWith('--scale=');
      const value = inline ? token.slice('--scale='.length) : args[++index];
      if (typeof value !== 'string' || (!inline && value.startsWith('-'))) {
        throw requestError('--scale requires a value; option-looking values must use --scale=<mode>');
      }
      scale = scaleValue(value);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('nodeId and file are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return Object.freeze({ node: nodeValue(positionals[0]), file: fileValue(positionals[1]), scale });
}

export function parseNodeSetImageRequest(args) {
  const input = parsed(args);
  return Object.freeze({ nodeId: input.node.nodeId, file: input.file, scale: input.scale });
}

export function acceptsNodeSetImageArgv(args) {
  try { parsed(args); return true; } catch { return false; }
}

export function nodeSetImageFigmaUrlFileKeyFromArgv(args) {
  return parsed(args).node.fileKey;
}

function typed(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['nodeId', 'file', 'scale'].includes(key))) {
    throw new TypeError('Node Set Image request must be a closed object.');
  }
  if (typeof request.nodeId !== 'string' || typeof request.file !== 'string'
    || (request.scale !== undefined && typeof request.scale !== 'string')) {
    throw new TypeError('Node Set Image request fields must preserve their declared types.');
  }
  return Object.freeze({
    node: nodeValue(request.nodeId),
    file: fileValue(request.file),
    scale: scaleValue(request.scale ?? 'FILL'),
  });
}

function argv(input, node) {
  return ['node', 'set-image', node, '--scale', input.scale, '--', input.file];
}

export function nodeSetImageArgvFromRequest(request) {
  const input = typed(request);
  const args = argv(input, input.node.nodeId);
  parseNodeSetImageRequest(args);
  return args;
}

export function nodeSetImagePlanningArgvFromRequest(request) {
  const input = typed(request);
  const args = argv(input, input.node.planningValue);
  parseNodeSetImageRequest(args);
  return args;
}
