// Closed request Interface for `motion styles` and `motion inspect`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MOTION_READ_ACTIONS = Object.freeze(['styles', 'inspect']);

function requestError(message) {
  return new Error(`Invalid Motion Read command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'motion' || !MOTION_READ_ACTIONS.includes(args[1])) {
    throw new Error('Expected a motion styles or motion inspect command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Motion Read arguments must be strings.');
  }
  let literal = false;
  const positionals = [];
  for (const token of args.slice(2)) {
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (args[1] === 'styles') {
    if (positionals.length) throw requestError(`unexpected argument ${positionals[0]}`);
    return { action: 'styles', node: null };
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  }
  const node = nodeReference(positionals[0]);
  return { action: 'inspect', node };
}

export function parseMotionReadRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({ action: input.action, nodeId: input.node?.nodeId || null });
}

export function acceptsMotionReadArgv(args) {
  try { parseMotionReadRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Motion Read request must be an object.');
  }
  if (Object.keys(request).some((key) => !['action', 'nodeId'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  if (!MOTION_READ_ACTIONS.includes(request.action)) {
    throw requestError(`action must be one of: ${MOTION_READ_ACTIONS.join(', ')}`);
  }
  if (request.action === 'styles') {
    if (request.nodeId !== undefined && request.nodeId !== null) {
      throw requestError('styles does not accept nodeId');
    }
    return { action: 'styles', node: null };
  }
  const node = nodeReference(request.nodeId);
  return { action: 'inspect', node };
}

export function motionReadArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = input.action === 'styles'
    ? ['motion', 'styles']
    : ['motion', 'inspect', '--', input.node.nodeId];
  parseMotionReadRequest(args);
  return args;
}

export function motionReadPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  if (input.action === 'styles') return motionReadArgvFromRequest(request);
  const args = ['motion', 'inspect', '--', input.node.planningValue];
  parseMotionReadRequest(args);
  return args;
}

export function motionReadFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node?.fileKey || null;
}
