// Closed request Interface for native Auto Layout Grid track reordering.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_GRID_TRACK_REORDER_INDICES = 4_096;

function requestError(message) { return new Error(`Invalid Grid Track Reorder command: ${message}.`); }
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}
function axisValue(value) {
  const axis = String(value || '').trim().toLowerCase();
  if (!['rows','columns'].includes(axis)) throw requestError('axis must be rows or columns');
  return axis;
}
function nonNegative(value, label) {
  if (typeof value === 'string' && value.trim() === '') throw requestError(`${label} must be a non-negative safe integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw requestError(`${label} must be a non-negative safe integer`);
  return number;
}
function indicesValue(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  if (!raw.length || raw.length > MAX_GRID_TRACK_REORDER_INDICES) throw requestError(`from must contain 1..${MAX_GRID_TRACK_REORDER_INDICES} indices`);
  if (raw.some((entry) => typeof entry === 'string' && entry.trim() === '')) throw requestError('from must contain comma-separated zero-based indices');
  return raw.map((entry) => nonNegative(entry, 'from index'));
}
function optionValue(args, index, name, inline) {
  if (inline !== null) {
    if (!inline.length) throw requestError(`${name} requires a value`);
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (value === undefined || value === '--') throw requestError(`${name} requires a value`);
  return { value, index: index + 1 };
}
function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new TypeError('Grid Track Reorder arguments must be strings.');
  if (args[0] !== 'layout' || args[1] !== 'grid' || !['reorder-rows','reorder-columns'].includes(args[2])) throw new Error('Expected a Grid Track Reorder command.');
  const options = new Map(); const positionals = []; let literal = false;
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = ['--from','--to'].find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsed = optionValue(args, index, name, inline); options.set(name, parsed.value); index = parsed.index; continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  if (!options.has('--from')) throw requestError('--from is required');
  if (!options.has('--to')) throw requestError('--to is required');
  return {
    axis: args[2] === 'reorder-rows' ? 'rows' : 'columns', node: nodeValue(positionals[0]),
    fromIndices: indicesValue(options.get('--from')), insertionIndex: nonNegative(options.get('--to'), '--to'),
  };
}
function projected(input) { return Object.freeze({ axis: input.axis, nodeId: input.node.nodeId, fromIndices: Object.freeze([...input.fromIndices]), insertionIndex: input.insertionIndex }); }
export function parseGridTrackReorderRequest(args) { return projected(parsedRequest(args)); }
export function acceptsGridTrackReorderArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }
export function gridTrackReorderFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).node.fileKey || null; }
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Grid Track Reorder request must be an object.');
  return { axis: axisValue(request.axis), node: nodeValue(request.nodeId), fromIndices: indicesValue(request.fromIndices ?? request.from), insertionIndex: nonNegative(request.insertionIndex, 'insertionIndex') };
}
function argvFrom(input, planning) {
  return ['layout', 'grid', `reorder-${input.axis}`, '--from', input.fromIndices.join(','), '--to', String(input.insertionIndex), '--', planning ? input.node.planningValue : input.node.nodeId];
}
export function gridTrackReorderArgvFromRequest(request) { const args = argvFrom(typedRequest(request), false); parseGridTrackReorderRequest(args); return args; }
export function gridTrackReorderPlanningArgvFromRequest(request) { const args = argvFrom(typedRequest(request), true); parseGridTrackReorderRequest(args); return args; }
