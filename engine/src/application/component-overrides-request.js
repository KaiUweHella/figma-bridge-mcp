// Closed request Interface for `component overrides`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_OVERRIDES_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const COMPONENT_OVERRIDE_ACTIONS = Object.freeze(['reset', 'remove']);

function requestError(message) {
  return new Error(`Invalid component overrides command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError('instance must not be empty');
    if (error.code === 'too-long') {
      throw requestError(`instance must be at most ${MAX_COMPONENT_OVERRIDES_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError('instance must be a Figma node id or URL containing node-id');
  }
}

function action(value) {
  if (typeof value !== 'string') throw requestError('action must be a string');
  const normalized = value.toLowerCase();
  if (!COMPONENT_OVERRIDE_ACTIONS.includes(normalized)) {
    throw requestError('action must be reset or remove');
  }
  return normalized;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'overrides') {
    throw new Error('Expected a component overrides command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Overrides arguments must be strings.');
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
  if (positionals.length < 1) throw requestError('instance is required');
  if (positionals.length < 2) throw requestError('action is required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return { instance: nodeReference(positionals[0]), action: action(positionals[1]), json };
}

export function parseComponentOverridesRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    instanceId: input.instance.nodeId,
    action: input.action,
    json: input.json,
  });
}

export function acceptsComponentOverridesArgv(args) {
  try { parseComponentOverridesRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Overrides request must be an object.');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return {
    instance: nodeReference(request.instanceId),
    action: action(request.action),
    json: request.json === true,
  };
}

function argvFromInput(input, { planning = false } = {}) {
  return [
    'component', 'overrides', planning ? input.instance.planningValue : input.instance.nodeId,
    input.action,
    ...(input.json ? ['--json'] : []),
  ];
}

export function componentOverridesArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseComponentOverridesRequest(args);
  return args;
}

export function componentOverridesPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseComponentOverridesRequest(args);
  return args;
}

export function componentOverridesFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).instance.fileKey || null;
}
