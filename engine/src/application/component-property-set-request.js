// Closed request Interface for `component prop set`.
//
// The property name and value are payloads, not policy. A literal delimiter
// keeps option-looking values writable while the instance reference remains
// available to Figma Target Context resolution.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_PROPERTY_VALUE_CODE_UNITS = 200_000;
export const MAX_COMPONENT_PROPERTY_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;

function commandError(message) {
  return new Error(`Invalid component prop set command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw commandError('instanceId must not be empty');
    if (error.code === 'too-long') {
      throw commandError(`instanceId must be at most ${MAX_COMPONENT_PROPERTY_NODE_ID_CODE_UNITS} code units`);
    }
    throw commandError('instanceId must be a Figma node id or URL containing node-id');
  }
}

function boundedString(value, label, maximum, { empty = false } = {}) {
  if (typeof value !== 'string') throw commandError(`${label} must be a string`);
  if (!empty && value.length === 0) throw commandError(`${label} must not be empty`);
  if (value.length > maximum) throw commandError(`${label} must be at most ${maximum} code units`);
  return value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'prop' || args[2] !== 'set') {
    throw new Error('Expected a component prop set command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Property Set arguments must be strings.');
  }
  const positionals = [];
  let json = false;
  let literal = false;
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token === '--json') {
      if (json) throw commandError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw commandError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 3) throw commandError('instanceId, name and value are required');
  if (positionals.length > 3) throw commandError(`unexpected argument ${positionals[3]}`);
  const reference = nodeReference(positionals[0]);
  return {
    instanceId: reference.nodeId,
    fileKey: reference.fileKey,
    reference,
    name: boundedString(positionals[1], 'name', MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS),
    value: boundedString(positionals[2], 'value', MAX_COMPONENT_PROPERTY_VALUE_CODE_UNITS, { empty: true }),
    json,
  };
}

export function parseComponentPropertySetRequest(args) {
  const { instanceId, name, value, json } = parsedRequest(args);
  return Object.freeze({ instanceId, name, value, json });
}

export function acceptsComponentPropertySetArgv(args) {
  try {
    parseComponentPropertySetRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Property Set request must be an object.');
  }
  const reference = nodeReference(request.instanceId);
  return {
    instanceId: reference.nodeId,
    reference,
    name: boundedString(request.name, 'name', MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS),
    value: boundedString(request.value, 'value', MAX_COMPONENT_PROPERTY_VALUE_CODE_UNITS, { empty: true }),
    json: request.json === true,
  };
}

export function componentPropertySetArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = ['component', 'prop', 'set', input.instanceId];
  if (input.name.startsWith('-') || input.value.startsWith('-') || input.value.length === 0) argv.push('--');
  argv.push(input.name, input.value);
  if (input.json && !argv.includes('--')) argv.push('--json');
  else if (input.json) argv.splice(3, 0, '--json');
  parseComponentPropertySetRequest(argv);
  return argv;
}

export function componentPropertySetPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = componentPropertySetArgvFromRequest(input);
  if (input.reference.fileKey) {
    const instanceIndex = argv.indexOf(input.instanceId, 3);
    argv[instanceIndex] = input.reference.planningValue;
  }
  return argv;
}

export function componentPropertySetFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}
