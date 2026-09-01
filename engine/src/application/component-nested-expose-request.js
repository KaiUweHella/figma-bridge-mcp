// Closed request Interface for `component nested expose`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_NESTED_EXPOSE_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;

function commandError(message) {
  return new Error(`Invalid component nested expose command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw commandError('instanceId must not be empty');
    if (error.code === 'too-long') {
      throw commandError(`instanceId must be at most ${MAX_COMPONENT_NESTED_EXPOSE_NODE_ID_CODE_UNITS} code units`);
    }
    throw commandError('instanceId must be a Figma node id or URL containing node-id');
  }
}

function exposedValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') throw commandError('value must be true or false');
  const normalized = value.toLowerCase();
  if (!['true', 'false', '1', '0'].includes(normalized)) {
    throw commandError('value must be true or false');
  }
  return normalized === 'true' || normalized === '1';
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'nested' || args[2] !== 'expose') {
    throw new Error('Expected a component nested expose command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Nested Expose arguments must be strings.');
  }
  const positionals = [];
  let json = false;
  let literal = false;
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw commandError('--json may be provided only once');
      json = true; continue;
    }
    if (!literal && token.startsWith('-')) throw commandError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw commandError('instanceId and value are required');
  if (positionals.length > 2) throw commandError(`unexpected argument ${positionals[2]}`);
  const reference = nodeReference(positionals[0]);
  return {
    instanceId: reference.nodeId,
    reference,
    fileKey: reference.fileKey,
    exposed: exposedValue(positionals[1]),
    json,
  };
}

export function parseComponentNestedExposeRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({ instanceId: input.instanceId, exposed: input.exposed, json: input.json });
}

export function acceptsComponentNestedExposeArgv(args) {
  try { parseComponentNestedExposeRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Nested Expose request must be an object.');
  }
  return {
    reference: nodeReference(request.instanceId),
    exposed: exposedValue(request.exposed),
    json: request.json === true,
  };
}

export function componentNestedExposeArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = [
    'component', 'nested', 'expose', input.reference.nodeId,
    input.exposed ? 'true' : 'false',
  ];
  if (input.json) argv.push('--json');
  parseComponentNestedExposeRequest(argv);
  return argv;
}

export function componentNestedExposePlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = componentNestedExposeArgvFromRequest({
    instanceId: input.reference.nodeId,
    exposed: input.exposed,
    json: input.json,
  });
  if (input.reference.fileKey) argv[3] = input.reference.planningValue;
  return argv;
}

export function componentNestedExposeFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}
