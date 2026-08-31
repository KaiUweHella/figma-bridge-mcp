// Closed request Interface for irreversible `slot reset` writes.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) { return new Error(`Invalid Slot Reset command: ${message}.`); }
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}
function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Slot Reset arguments must be strings.');
  }
  if (args[0] !== 'slot' || args[1] !== 'reset') throw new Error('Expected a Slot Reset command.');
  const positionals = []; let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  }
  return nodeValue(positionals[0]);
}
export function parseSlotResetRequest(args) {
  return Object.freeze({ nodeId: parsedRequest(args).nodeId });
}
export function acceptsSlotResetArgv(args) {
  try { parsedRequest(args); return true; } catch { return false; }
}
export function slotResetFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey || null;
}
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Slot Reset request must be an object.');
  }
  return nodeValue(request.nodeId);
}
export function slotResetArgvFromRequest(request) {
  const node = typedRequest(request); const args = ['slot', 'reset', '--', node.nodeId];
  parseSlotResetRequest(args); return args;
}
export function slotResetPlanningArgvFromRequest(request) {
  const node = typedRequest(request); const args = ['slot', 'reset', '--', node.planningValue];
  parseSlotResetRequest(args); return args;
}
