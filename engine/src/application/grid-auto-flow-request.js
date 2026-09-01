// Closed request Interface for `layout grid auto-flow` writes.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

const AUTO_TRACKS = Object.freeze(['NONE', 'ROWS']);
const POSITIONING = Object.freeze(['MANUAL', 'ROW_AUTO_FLOW']);

function requestError(message) { return new Error(`Invalid Grid Auto Flow command: ${message}.`); }
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}
function enumValue(value, allowed, label) {
  if (typeof value !== 'string') throw requestError(`${label} requires a value`);
  const normalized = value.trim().toUpperCase();
  if (!allowed.includes(normalized)) {
    throw requestError(`${label} must be ${allowed.map((item) => item.toLowerCase()).join(' or ')}`);
  }
  return normalized;
}
function optionValue(args, index, name, inline) {
  if (inline !== null) {
    if (!inline.length) throw requestError(`${name} requires a value`);
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (value === undefined || value === '--' || value.startsWith('-')) {
    throw requestError(`${name} requires a value`);
  }
  return { value, index: index + 1 };
}
function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Grid Auto Flow arguments must be strings.');
  }
  if (args[0] !== 'layout' || args[1] !== 'grid' || args[2] !== 'auto-flow') {
    throw new Error('Expected a Grid Auto Flow command.');
  }
  const positionals = []; const options = new Map(); let literal = false;
  const accepted = ['--auto-tracks', '--positioning'];
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = accepted.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsed = optionValue(args, index, name, inline);
      index = parsed.index; options.set(name, parsed.value); continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  }
  if (!options.has('--auto-tracks')) throw requestError('--auto-tracks is required');
  if (!options.has('--positioning')) throw requestError('--positioning is required');
  return {
    node: nodeValue(positionals[0]),
    autoTracks: enumValue(options.get('--auto-tracks'), AUTO_TRACKS, '--auto-tracks'),
    positioning: enumValue(options.get('--positioning'), POSITIONING, '--positioning'),
  };
}
function projected(input) {
  return Object.freeze({
    nodeId: input.node.nodeId,
    autoTracks: input.autoTracks,
    positioning: input.positioning,
  });
}
export function parseGridAutoFlowRequest(args) { return projected(parsedRequest(args)); }
export function acceptsGridAutoFlowArgv(args) {
  try { parsedRequest(args); return true; } catch { return false; }
}
export function gridAutoFlowFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node.fileKey || null;
}
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Grid Auto Flow request must be an object.');
  }
  return {
    node: nodeValue(request.nodeId),
    autoTracks: enumValue(request.autoTracks, AUTO_TRACKS, 'autoTracks'),
    positioning: enumValue(request.positioning, POSITIONING, 'positioning'),
  };
}
function argvFrom(input, planning) {
  return [
    'layout', 'grid', 'auto-flow',
    '--auto-tracks', input.autoTracks.toLowerCase(),
    '--positioning', input.positioning.toLowerCase(),
    '--', planning ? input.node.planningValue : input.node.nodeId,
  ];
}
export function gridAutoFlowArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false); parseGridAutoFlowRequest(args); return args;
}
export function gridAutoFlowPlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true); parseGridAutoFlowRequest(args); return args;
}
