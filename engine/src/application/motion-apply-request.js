// Closed request Interface for `motion apply`.

import { parseMotionApplySource } from './motion-apply-source.js';

export const MAX_MOTION_APPLY_PATH_CODE_UNITS = 32_768;
const UNSAFE_PATH = /[\u0000\r\n\u2028\u2029]/u;

function requestError(message) { return new Error(`Invalid Motion Apply command: ${message}.`); }

function sourceValue(value) {
  if (typeof value !== 'string' || value.length === 0) throw requestError('spec is required');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw requestError('spec is required');
  if (trimmed.startsWith('{')) {
    return { sourceKind: 'inline', source: parseMotionApplySource(trimmed).canonical };
  }
  if (value.length > MAX_MOTION_APPLY_PATH_CODE_UNITS || UNSAFE_PATH.test(value)) {
    throw requestError('file path must be bounded control-safe text');
  }
  return { sourceKind: 'file', source: value };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'motion' || args[1] !== 'apply') {
    throw new Error('Expected a motion apply command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Motion Apply arguments must be strings.');
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'spec is required');
  }
  return sourceValue(positionals[0]);
}

export function parseMotionApplyRequest(args) { return Object.freeze(parsedRequest(args)); }
export function acceptsMotionApplyArgv(args) {
  try { parseMotionApplyRequest(args); return true; } catch { return false; }
}

function typedInput(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Motion Apply request must be an object.');
  if (Object.keys(request).some((key) => !['sourceKind','source'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  const input = sourceValue(request.source);
  if (request.sourceKind !== undefined && request.sourceKind !== input.sourceKind) {
    throw requestError('sourceKind does not match spec');
  }
  return input;
}

export function motionApplyArgvFromRequest(request) {
  const input = typedInput(request);
  const args = ['motion', 'apply', '--', input.source];
  parseMotionApplyRequest(args);
  return args;
}

export const motionApplyPlanningArgvFromRequest = motionApplyArgvFromRequest;
