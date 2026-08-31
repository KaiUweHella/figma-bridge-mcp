// Closed request Interface for metadata-only variable-font axis intent.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const FONT_AXIS_METADATA_ACTIONS = Object.freeze(['axes', 'remember-axes', 'forget-axes']);
export const MAX_FONT_AXIS_COUNT = 64;
export const MAX_FONT_AXIS_INDEX = 10_000_000;
const AXIS_TAG = /^[A-Za-z0-9]{4}$/;
const RANGE_OPTIONS = Object.freeze(['--start', '--end']);

function requestError(message) { return new Error(`Invalid Font Axis Metadata command: ${message}.`); }
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}
function indexValue(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && !/^(?:0|[1-9][0-9]*)$/.test(value)) throw requestError(`${label} must be a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_FONT_AXIS_INDEX) throw requestError(`${label} must be a non-negative integer`);
  return number;
}
function axesValue(value) {
  if (typeof value !== 'string') throw requestError('axes must be a string');
  const parts = value.trim() ? value.split(',') : [];
  if (!parts.length || parts.length > MAX_FONT_AXIS_COUNT) throw requestError(`axes must contain 1..${MAX_FONT_AXIS_COUNT} entries`);
  const axes = {};
  for (const rawPart of parts) {
    const part = rawPart.trim(); const split = part.indexOf('=');
    if (split < 0) throw requestError(`axis ${part || '(empty)'} must use tag=value`);
    const tag = part.slice(0, split).trim(); const rawValue = part.slice(split + 1).trim();
    if (!AXIS_TAG.test(tag)) throw requestError(`axis tag ${tag || '(empty)'} must be exactly four letters or digits`);
    if (Object.hasOwn(axes, tag)) throw requestError(`axis ${tag} may be provided only once`);
    const number = Number(rawValue);
    if (!rawValue || !Number.isFinite(number)) throw requestError(`axis ${tag} must have a finite number`);
    axes[tag] = number;
  }
  return Object.freeze(axes);
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
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new TypeError('Font Axis Metadata arguments must be strings.');
  if (args[0] !== 'font' || !FONT_AXIS_METADATA_ACTIONS.includes(args[1])) throw new Error('Expected a Font Axis Metadata command.');
  const action = args[1]; const options = new Map(); const positionals = []; let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      if (action === 'axes') throw requestError(`unknown option ${token}`);
      const name = RANGE_OPTIONS.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsed = optionValue(args, index, name, inline); options.set(name, parsed.value); index = parsed.index; continue;
    }
    positionals.push(token);
  }
  const expected = action === 'remember-axes' ? 2 : 1;
  if (positionals.length !== expected) throw requestError(positionals.length > expected ? `unexpected argument ${positionals[expected]}` : action === 'remember-axes' ? 'nodeId and axes are required' : 'nodeId is required');
  const start = options.has('--start') ? indexValue(options.get('--start'), '--start') : null;
  const end = options.has('--end') ? indexValue(options.get('--end'), '--end') : null;
  if (start !== null && end !== null && end < start) throw requestError('--end must be greater than or equal to --start');
  return { action, node: nodeValue(positionals[0]), axes: action === 'remember-axes' ? axesValue(positionals[1]) : null, start, end };
}
function projected(input) {
  return Object.freeze({ action: input.action, nodeId: input.node.nodeId, ...(input.axes ? { axes: input.axes } : {}), ...(input.action === 'axes' ? {} : { start: input.start, end: input.end }), warning: input.node.warning });
}
export function parseFontAxisMetadataRequest(args) { return projected(parsedRequest(args)); }
export function acceptsFontAxisMetadataArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }
export function fontAxisMetadataFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).node.fileKey || null; }
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Font Axis Metadata request must be an object.');
  if (!FONT_AXIS_METADATA_ACTIONS.includes(request.action)) throw requestError('action must be axes, remember-axes, or forget-axes');
  const action = request.action;
  const start = action === 'axes' ? null : indexValue(request.start, 'start');
  const end = action === 'axes' ? null : indexValue(request.end, 'end');
  if (start !== null && end !== null && end < start) throw requestError('end must be greater than or equal to start');
  let axes = null;
  if (action === 'remember-axes') {
    if (typeof request.axes === 'string') axes = axesValue(request.axes);
    else {
      if (!request.axes || typeof request.axes !== 'object' || Array.isArray(request.axes)) throw requestError('axes must be an object or tag=value string');
      axes = axesValue(Object.entries(request.axes).map(([tag, value]) => `${tag}=${value}`).join(','));
    }
  }
  return { action, node: nodeValue(request.nodeId), axes, start, end };
}
function argvFrom(input, planning) {
  const args = ['font', input.action];
  if (input.start !== null) args.push('--start', String(input.start));
  if (input.end !== null) args.push('--end', String(input.end));
  args.push('--', planning ? input.node.planningValue : input.node.nodeId);
  if (input.axes) args.push(Object.entries(input.axes).map(([tag, value]) => `${tag}=${value}`).join(','));
  return args;
}
export function fontAxisMetadataArgvFromRequest(request) { const args = argvFrom(typedRequest(request), false); parseFontAxisMetadataRequest(args); return args; }
export function fontAxisMetadataPlanningArgvFromRequest(request) { const args = argvFrom(typedRequest(request), true); parseFontAxisMetadataRequest(args); return args; }
