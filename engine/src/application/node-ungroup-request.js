import { MAX_NODE_REFERENCE_CODE_UNITS, NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_NODE_UNGROUP_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
function requestError(message) { return new Error(`Invalid node ungroup command: ${message}.`); }
function reference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError('nodeId must not be empty');
    if (error.code === 'too-long') throw requestError('nodeId is too long');
    throw requestError('nodeId must be a Figma node id or URL containing node-id');
  }
}
function parsed(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'ungroup') throw new Error('Expected a node ungroup command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Node Ungroup arguments must be strings.');
  const positionals = []; let json = false; let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') { if (json) throw requestError('--json may be provided only once'); json = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { target: reference(positionals[0]), json };
}
export function parseNodeUngroupRequest(args) { const input = parsed(args); return Object.freeze({ nodeId: input.target.nodeId, json: input.json }); }
export function acceptsNodeUngroupArgv(args) { try { parseNodeUngroupRequest(args); return true; } catch { return false; } }
function typed(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Node Ungroup request must be an object.');
  return { target: reference(request.nodeId), json: request.json === true };
}
function argv(request, planning) { const input = typed(request); return ['node', 'ungroup', planning ? input.target.planningValue : input.target.nodeId, ...(input.json ? ['--json'] : [])]; }
export function nodeUngroupArgvFromRequest(request) { const args = argv(request, false); parseNodeUngroupRequest(args); return args; }
export function nodeUngroupPlanningArgvFromRequest(request) { const args = argv(request, true); parseNodeUngroupRequest(args); return args; }
export function nodeUngroupFigmaUrlFileKeyFromArgv(args) { return parsed(args).target.fileKey; }
