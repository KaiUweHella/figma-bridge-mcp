// Closed request Interface for `component swap`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_SWAP_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;

function requestError(message) {
  return new Error(`Invalid component swap command: ${message}.`);
}

function nodeReference(value, field) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError(`${field} must not be empty`);
    if (error.code === 'too-long') {
      throw requestError(`${field} must be at most ${MAX_COMPONENT_SWAP_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError(`${field} must be a Figma node id or URL containing node-id`);
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'swap') {
    throw new Error('Expected a component swap command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Swap arguments must be strings.');
  }

  const positionals = [];
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }

  if (positionals.length < 2) throw requestError('instance and component are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return {
    instance: nodeReference(positionals[0], 'instance'),
    component: nodeReference(positionals[1], 'component'),
    json,
  };
}

export function parseComponentSwapRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    instanceId: input.instance.nodeId,
    componentId: input.component.nodeId,
    json: input.json,
  });
}

export function acceptsComponentSwapArgv(args) {
  try { parseComponentSwapRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Swap request must be an object.');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return {
    instance: nodeReference(request.instanceId, 'instance'),
    component: nodeReference(request.componentId, 'component'),
    json: request.json === true,
  };
}

function argvFromInput(input, { planning = false } = {}) {
  return [
    'component', 'swap',
    planning ? input.instance.planningValue : input.instance.nodeId,
    planning ? input.component.planningValue : input.component.nodeId,
    ...(input.json ? ['--json'] : []),
  ];
}

export function componentSwapArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseComponentSwapRequest(args);
  return args;
}

export function componentSwapPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const keys = new Set([input.instance.fileKey, input.component.fileKey].filter(Boolean));
  if (keys.size > 1) throw requestError('instance and component target multiple Figma files');
  const args = argvFromInput(input, { planning: true });
  parseComponentSwapRequest(args);
  return args;
}

export function componentSwapFigmaUrlFileKeyFromArgv(args) {
  const input = parsedRequest(args);
  const keys = new Set([input.instance.fileKey, input.component.fileKey].filter(Boolean));
  if (keys.size > 1) throw requestError('instance and component target multiple Figma files');
  return keys.values().next().value || null;
}
