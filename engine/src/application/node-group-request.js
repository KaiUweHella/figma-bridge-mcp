// Closed request Interface for `node group`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_NODE_GROUP_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const MAX_NODE_GROUP_NAME_CODE_UNITS = 1_024;
export const MAX_NODE_GROUP_NODES = 64;

function requestError(message) { return new Error(`Invalid node group command: ${message}.`); }
function reference(value, field) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError(`${field} must not be empty`);
    if (error.code === 'too-long') throw requestError(`${field} is too long`);
    throw requestError(`${field} must be a Figma node id or URL containing node-id`);
  }
}
function childIndex(value) {
  if (typeof value === 'string' && value.trim().length === 0) throw requestError('index must be a non-negative safe integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw requestError('index must be a non-negative safe integer');
  return number;
}
function layerName(value) {
  if (typeof value !== 'string') throw requestError('name must be a string');
  if (value.length > MAX_NODE_GROUP_NAME_CODE_UNITS) throw requestError(`name must be at most ${MAX_NODE_GROUP_NAME_CODE_UNITS} code units`);
  return value;
}
function takeValue(args, cursor, token, inline, { empty = false } = {}) {
  if (inline !== null) {
    if (!empty && inline.length === 0) throw requestError(`${token} requires a value`);
    return { value: inline, cursor };
  }
  const value = args[cursor + 1];
  if (value === undefined || value === '--' || (!empty && value.startsWith('-'))
    || (empty && value.startsWith('--'))) throw requestError(`${token} requires a value`);
  return { value, cursor: cursor + 1 };
}
function parsed(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'group') throw new Error('Expected a node group command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Node Group arguments must be strings.');
  const nodes = [];
  let parent = null; let index = null; let name = null; let json = false; let literal = false;
  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') { if (json) throw requestError('--json may be provided only once'); json = true; continue; }
    const parentInline = !literal && token.startsWith('--parent=') ? token.slice(9) : null;
    if (!literal && (token === '--parent' || parentInline !== null)) {
      if (parent) throw requestError('--parent may be provided only once');
      const item = takeValue(args, cursor, '--parent', parentInline); cursor = item.cursor;
      parent = reference(item.value, 'parent'); continue;
    }
    const indexInline = !literal && token.startsWith('--index=') ? token.slice(8) : null;
    if (!literal && (token === '--index' || indexInline !== null)) {
      if (index !== null) throw requestError('--index may be provided only once');
      const item = takeValue(args, cursor, '--index', indexInline); cursor = item.cursor;
      index = childIndex(item.value); continue;
    }
    const nameInline = !literal && token.startsWith('--name=') ? token.slice(7) : null;
    if (!literal && (token === '--name' || nameInline !== null)) {
      if (name !== null) throw requestError('--name may be provided only once');
      const item = takeValue(args, cursor, '--name', nameInline, { empty: true }); cursor = item.cursor;
      name = layerName(item.value); continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    nodes.push(reference(token, `nodeIds[${nodes.length}]`));
  }
  if (nodes.length < 2) throw requestError('at least two node ids are required');
  if (nodes.length > MAX_NODE_GROUP_NODES) throw requestError(`at most ${MAX_NODE_GROUP_NODES} node ids are allowed`);
  const ids = nodes.map((item) => item.nodeId);
  if (new Set(ids).size !== ids.length) throw requestError('node ids must be unique');
  const fileKeys = new Set([...nodes.map((item) => item.fileKey), parent?.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('nodes and parent target multiple Figma files');
  return { nodes, parent, index, name, json };
}
export function parseNodeGroupRequest(args) {
  const input = parsed(args);
  return Object.freeze({ nodeIds: Object.freeze(input.nodes.map((item) => item.nodeId)), parentId: input.parent?.nodeId || null, index: input.index, name: input.name, json: input.json });
}
export function acceptsNodeGroupArgv(args) { try { parseNodeGroupRequest(args); return true; } catch { return false; } }
function typed(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Node Group request must be an object.');
  const args = ['node', 'group', ...(Array.isArray(request.nodeIds) ? request.nodeIds : [])];
  if (request.parentId !== null && request.parentId !== undefined) args.push('--parent', request.parentId);
  if (request.index !== null && request.index !== undefined) args.push('--index', String(request.index));
  if (request.name !== null && request.name !== undefined) args.push('--name', layerName(request.name));
  if (request.json === true) args.push('--json');
  return parsed(args);
}
function argv(input, planning) {
  const args = ['node', 'group', ...input.nodes.map((item) => planning ? item.planningValue : item.nodeId)];
  if (input.parent) args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId);
  if (input.index !== null) args.push('--index', String(input.index));
  if (input.name !== null) args.push('--name', input.name);
  if (input.json) args.push('--json');
  return args;
}
export function nodeGroupArgvFromRequest(request) { const args = argv(typed(request), false); parseNodeGroupRequest(args); return args; }
export function nodeGroupPlanningArgvFromRequest(request) { const args = argv(typed(request), true); parseNodeGroupRequest(args); return args; }
export function nodeGroupFigmaUrlFileKeyFromArgv(args) {
  const input = parsed(args);
  return input.nodes.find((item) => item.fileKey)?.fileKey || input.parent?.fileKey || null;
}
