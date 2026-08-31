// Closed request Interface for `component prop bind`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_PROPERTY_BIND_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;

function commandError(message) {
  return new Error(`Invalid component prop bind command: ${message}.`);
}

function nodeReference(value, label) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw commandError(`${label} must not be empty`);
    if (error.code === 'too-long') {
      throw commandError(`${label} must be at most ${MAX_COMPONENT_PROPERTY_BIND_NODE_ID_CODE_UNITS} code units`);
    }
    throw commandError(`${label} must be a Figma node id or URL containing node-id`);
  }
}

function propertyName(value) {
  if (typeof value !== 'string') throw commandError('propertyName must be a string');
  if (!value) throw commandError('propertyName must not be empty');
  if (value.length > MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS) {
    throw commandError(`propertyName must be at most ${MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'prop' || args[2] !== 'bind') {
    throw new Error('Expected a component prop bind command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Property Bind arguments must be strings.');
  }
  const positionals = [];
  let json = false;
  let remove = false;
  let replace = false;
  let literal = false;
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw commandError('--json may be provided only once');
      json = true; continue;
    }
    if (!literal && token === '--remove') {
      if (remove) throw commandError('--remove may be provided only once');
      remove = true; continue;
    }
    if (!literal && token === '--replace') {
      if (replace) throw commandError('--replace may be provided only once');
      replace = true; continue;
    }
    if (!literal && token.startsWith('-')) throw commandError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (remove && replace) throw commandError('--remove and --replace cannot be combined');
  if (positionals.length < 3) throw commandError('componentId, propertyName and nodeId are required');
  if (positionals.length > 3) throw commandError(`unexpected argument ${positionals[3]}`);
  const component = nodeReference(positionals[0], 'componentId');
  const node = nodeReference(positionals[2], 'nodeId');
  if (component.fileKey && node.fileKey && component.fileKey !== node.fileKey) {
    throw commandError('componentId and nodeId URLs must target the same Figma file');
  }
  return {
    componentId: component.nodeId,
    component,
    propertyName: propertyName(positionals[1]),
    nodeId: node.nodeId,
    node,
    fileKey: component.fileKey || node.fileKey || null,
    remove,
    replace,
    json,
  };
}

export function parseComponentPropertyBindRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    componentId: input.componentId,
    propertyName: input.propertyName,
    nodeId: input.nodeId,
    remove: input.remove,
    replace: input.replace,
    json: input.json,
  });
}

export function acceptsComponentPropertyBindArgv(args) {
  try { parseComponentPropertyBindRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Property Bind request must be an object.');
  }
  const component = nodeReference(request.componentId, 'componentId');
  const node = nodeReference(request.nodeId, 'nodeId');
  if (component.fileKey && node.fileKey && component.fileKey !== node.fileKey) {
    throw commandError('componentId and nodeId URLs must target the same Figma file');
  }
  if (request.remove === true && request.replace === true) {
    throw commandError('--remove and --replace cannot be combined');
  }
  return {
    component,
    node,
    propertyName: propertyName(request.propertyName),
    remove: request.remove === true,
    replace: request.replace === true,
    json: request.json === true,
  };
}

export function componentPropertyBindArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = ['component', 'prop', 'bind', input.component.nodeId];
  if (input.json) argv.push('--json');
  if (input.remove) argv.push('--remove');
  if (input.replace) argv.push('--replace');
  if (input.propertyName.startsWith('-')) argv.push('--');
  argv.push(input.propertyName, input.node.nodeId);
  parseComponentPropertyBindRequest(argv);
  return argv;
}

export function componentPropertyBindPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = componentPropertyBindArgvFromRequest({
    componentId: input.component.nodeId,
    propertyName: input.propertyName,
    nodeId: input.node.nodeId,
    remove: input.remove,
    replace: input.replace,
    json: input.json,
  });
  if (input.component.fileKey) argv[3] = input.component.planningValue;
  if (input.node.fileKey) argv[argv.length - 1] = input.node.planningValue;
  return argv;
}

export function componentPropertyBindFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}
