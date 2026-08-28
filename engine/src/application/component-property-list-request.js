// Closed request Interface for `component prop list`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_PROPERTY_LIST_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;

function commandError(message) {
  return new Error(`Invalid component prop list command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw commandError('componentId must not be empty');
    if (error.code === 'too-long') {
      throw commandError(`componentId must be at most ${MAX_COMPONENT_PROPERTY_LIST_NODE_ID_CODE_UNITS} code units`);
    }
    throw commandError('componentId must be a Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'prop' || args[2] !== 'list') {
    throw new Error('Expected a component prop list command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Property List arguments must be strings.');
  }
  const positionals = [];
  let json = false;
  let literal = false;
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (json) throw commandError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw commandError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw commandError(`unexpected argument ${positionals[1]}`);
  const reference = positionals.length ? nodeReference(positionals[0]) : null;
  return {
    componentId: reference?.nodeId || null,
    fileKey: reference?.fileKey || null,
    reference,
    json,
  };
}

export function parseComponentPropertyListRequest(args) {
  const { componentId, json } = parsedRequest(args);
  return Object.freeze({ componentId, json });
}

export function acceptsComponentPropertyListArgv(args) {
  try { parseComponentPropertyListRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Property List request must be an object.');
  }
  const reference = request.componentId == null ? null : nodeReference(request.componentId);
  return {
    componentId: reference?.nodeId || null,
    reference,
    json: request.json === true,
  };
}

export function componentPropertyListArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = ['component', 'prop', 'list'];
  if (input.json) argv.push('--json');
  if (input.componentId) argv.push(input.componentId);
  parseComponentPropertyListRequest(argv);
  return argv;
}

export function componentPropertyListPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = componentPropertyListArgvFromRequest(input);
  if (input.reference?.fileKey) {
    const componentIndex = argv.indexOf(input.componentId, 3);
    argv[componentIndex] = input.reference.planningValue;
  }
  return argv;
}

export function componentPropertyListFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}
