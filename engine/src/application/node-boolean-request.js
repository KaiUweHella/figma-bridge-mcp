import {
  MAX_NODE_FLATTEN_NAME_CODE_UNITS,
  MAX_NODE_FLATTEN_NODE_ID_CODE_UNITS,
  MAX_NODE_FLATTEN_NODES,
  nodeFlattenArgvFromRequest,
  nodeFlattenFigmaUrlFileKeyFromArgv,
  nodeFlattenPlanningArgvFromRequest,
  parseNodeFlattenRequest,
} from './node-flatten-request.js';

export const MAX_NODE_BOOLEAN_NAME_CODE_UNITS = MAX_NODE_FLATTEN_NAME_CODE_UNITS;
export const MAX_NODE_BOOLEAN_NODE_ID_CODE_UNITS = MAX_NODE_FLATTEN_NODE_ID_CODE_UNITS;
export const MAX_NODE_BOOLEAN_NODES = MAX_NODE_FLATTEN_NODES;
export const NODE_BOOLEAN_OPERATIONS = Object.freeze(['union', 'subtract', 'intersect', 'exclude']);

function requestError(message) { return new Error(`Invalid node boolean command: ${message}.`); }
function operation(value) {
  if (typeof value !== 'string' || !NODE_BOOLEAN_OPERATIONS.includes(value.toLowerCase())) {
    throw requestError('operation must be union, subtract, intersect, or exclude');
  }
  return value.toLowerCase();
}
function baseFromArgv(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'boolean') throw new Error('Expected a node boolean command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Node Boolean arguments must be strings.');
  if (args.length < 3) throw requestError('operation is required');
  const method = operation(args[2]);
  let base;
  try { base = parseNodeFlattenRequest(['node', 'flatten', ...args.slice(3)]); }
  catch (error) {
    if (error?.message?.startsWith('Invalid node flatten command:')) {
      throw new Error(error.message.replace('Invalid node flatten command:', 'Invalid node boolean command:'));
    }
    throw error;
  }
  if (base.nodeIds.length < 2) throw requestError('at least two node ids are required');
  return { method, base };
}
export function parseNodeBooleanRequest(args) { const input = baseFromArgv(args); return Object.freeze({ operation: input.method, ...input.base }); }
export function acceptsNodeBooleanArgv(args) { try { parseNodeBooleanRequest(args); return true; } catch { return false; } }
function booleanArgvFromRequest(request, planning) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Node Boolean request must be an object.');
  const method = operation(request.operation);
  const base = planning ? nodeFlattenPlanningArgvFromRequest(request) : nodeFlattenArgvFromRequest(request);
  const args = ['node', 'boolean', method, ...base.slice(2)]; parseNodeBooleanRequest(args); return args;
}
export function nodeBooleanArgvFromRequest(request) { return booleanArgvFromRequest(request, false); }
export function nodeBooleanPlanningArgvFromRequest(request) { return booleanArgvFromRequest(request, true); }
export function nodeBooleanFigmaUrlFileKeyFromArgv(args) {
  baseFromArgv(args);
  return nodeFlattenFigmaUrlFileKeyFromArgv(['node', 'flatten', ...args.slice(3)]);
}
