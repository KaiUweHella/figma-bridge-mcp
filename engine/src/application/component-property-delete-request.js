// Closed request Interface for `component prop delete`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_PROPERTY_DELETE_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;

function commandError(message) {
  return new Error(`Invalid component prop delete command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw commandError('componentId must not be empty');
    if (error.code === 'too-long') {
      throw commandError(`componentId must be at most ${MAX_COMPONENT_PROPERTY_DELETE_NODE_ID_CODE_UNITS} code units`);
    }
    throw commandError('componentId must be a Figma node id or URL containing node-id');
  }
}

function propertyName(value) {
  if (typeof value !== 'string') throw commandError('propName must be a string');
  if (value.length === 0) throw commandError('propName must not be empty');
  if (value.length > MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS) {
    throw commandError(`propName must be at most ${MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'prop' || args[2] !== 'delete') {
    throw new Error('Expected a component prop delete command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Property Delete arguments must be strings.');
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
  if (positionals.length < 2) throw commandError('componentId and propName are required');
  if (positionals.length > 2) throw commandError(`unexpected argument ${positionals[2]}`);
  const reference = nodeReference(positionals[0]);
  return {
    componentId: reference.nodeId,
    fileKey: reference.fileKey,
    reference,
    propName: propertyName(positionals[1]),
    json,
  };
}

export function parseComponentPropertyDeleteRequest(args) {
  const { componentId, propName, json } = parsedRequest(args);
  return Object.freeze({ componentId, propName, json });
}

export function acceptsComponentPropertyDeleteArgv(args) {
  try { parseComponentPropertyDeleteRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Property Delete request must be an object.');
  }
  const reference = nodeReference(request.componentId);
  return {
    componentId: reference.nodeId,
    reference,
    propName: propertyName(request.propName),
    json: request.json === true,
  };
}

export function componentPropertyDeleteArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = ['component', 'prop', 'delete', input.componentId];
  if (input.json) argv.push('--json');
  if (input.propName.startsWith('-')) argv.push('--');
  argv.push(input.propName);
  parseComponentPropertyDeleteRequest(argv);
  return argv;
}

export function componentPropertyDeletePlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = componentPropertyDeleteArgvFromRequest(input);
  if (input.reference.fileKey) {
    const componentIndex = argv.indexOf(input.componentId, 3);
    argv[componentIndex] = input.reference.planningValue;
  }
  return argv;
}

export function componentPropertyDeleteFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}
