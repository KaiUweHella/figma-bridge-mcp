// Closed request Interface for `motion timeline` reads and writes.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) {
  return new Error(`Invalid Motion Timeline command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function durationValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw requestError('duration must be a finite number greater than zero');
  }
  const source = typeof value === 'string' ? value.trim() : value;
  const duration = Number(source);
  if (source === '' || !Number.isFinite(duration) || duration <= 0
    || duration > Number.MAX_SAFE_INTEGER) {
    throw requestError('duration must be a finite number greater than zero');
  }
  return duration;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'motion' || args[1] !== 'timeline') {
    throw new Error('Expected a motion timeline command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Motion Timeline arguments must be strings.');
  }
  let literal = false;
  let duration = null;
  let durationSeen = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '-d' || token === '--duration')) {
      if (durationSeen) throw requestError('duration may be provided only once');
      const value = args[index + 1];
      if (value === undefined || value === '--') throw requestError(`${token} requires a value`);
      duration = durationValue(value); durationSeen = true; index += 1; continue;
    }
    if (!literal) {
      const combined = token.match(/^(?:-d=?|--duration=)(.*)$/);
      if (combined) {
        if (durationSeen) throw requestError('duration may be provided only once');
        if (!combined[1]) throw requestError('duration requires a value');
        duration = durationValue(combined[1]); durationSeen = true; continue;
      }
      if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  }
  return { node: nodeReference(positionals[0]), duration };
}

export function parseMotionTimelineRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({ nodeId: input.node.nodeId, duration: input.duration });
}

export function acceptsMotionTimelineArgv(args) {
  try { parsedRequest(args); return true; }
  catch { return false; }
}

export function motionTimelineFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node.fileKey || null;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Motion Timeline request must be an object.');
  }
  if (Object.keys(request).some((key) => !['nodeId', 'duration'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  return {
    node: nodeReference(request.nodeId),
    duration: request.duration === undefined || request.duration === null
      ? null : durationValue(request.duration),
  };
}

function argvFrom(input, planning) {
  return ['motion', 'timeline',
    ...(input.duration === null ? [] : ['--duration', String(input.duration)]),
    '--', planning ? input.node.planningValue : input.node.nodeId];
}

export function motionTimelineArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false);
  parseMotionTimelineRequest(args);
  return args;
}

export function motionTimelinePlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true);
  parseMotionTimelineRequest(args);
  return args;
}
