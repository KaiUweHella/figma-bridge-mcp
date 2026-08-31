// Closed request Interface for `slot inspect|validate`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const SLOT_READ_ACTIONS = Object.freeze(['inspect', 'validate']);

function requestError(message) {
  return new Error(`Invalid Slot Read command: ${message}.`);
}

function nodeValue(value, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw requestError('nodeId is required');
    return { nodeId: null, fileKey: null, warning: '', planningValue: null };
  }
  if (typeof value !== 'string') throw requestError('nodeId must be a string');
  try {
    const reference = parseNodeReference(value);
    return {
      nodeId: reference.nodeId,
      fileKey: reference.fileKey,
      warning: reference.warning,
      planningValue: reference.planningValue,
    };
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function actionValue(value) {
  if (!SLOT_READ_ACTIONS.includes(value)) throw requestError('action must be inspect or validate');
  return value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'slot' || !SLOT_READ_ACTIONS.includes(args[1])) {
    throw new Error('Expected a Slot Read command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slot Read arguments must be strings.');
  }
  const action = actionValue(args[1]);
  let literal = false;
  const positionals = [];
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
  return { action, node: nodeValue(positionals[0], action === 'inspect') };
}

function projected(input) {
  return Object.freeze({
    action: input.action,
    nodeId: input.node.nodeId,
    warning: input.node.warning,
  });
}

export function parseSlotReadRequest(args) {
  return projected(parsedRequest(args));
}

export function acceptsSlotReadArgv(args) {
  try {
    parsedRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function slotReadFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node.fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slot Read request must be an object.');
  }
  const action = actionValue(request.action);
  return { action, node: nodeValue(request.nodeId, action === 'inspect') };
}

function argvFrom(input, planning) {
  const node = planning ? input.node.planningValue : input.node.nodeId;
  return ['slot', input.action, ...(node ? ['--', node] : [])];
}

export function slotReadArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false);
  parseSlotReadRequest(args);
  return args;
}

export function slotReadPlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true);
  parseSlotReadRequest(args);
  return args;
}
