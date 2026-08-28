// Closed request Interface for `component detach`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_DETACH_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const MAX_COMPONENT_DETACH_NAME_CODE_UNITS = 1_024;

function requestError(message) {
  return new Error(`Invalid component detach command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw requestError('instance must not be empty');
    if (error.code === 'too-long') {
      throw requestError(`instance must be at most ${MAX_COMPONENT_DETACH_NODE_ID_CODE_UNITS} code units`);
    }
    throw requestError('instance must be a Figma node id or URL containing node-id');
  }
}

function frameName(value) {
  if (typeof value !== 'string') throw requestError('name must be a string');
  if (value.length > MAX_COMPONENT_DETACH_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_COMPONENT_DETACH_NAME_CODE_UNITS} code units`);
  }
  return value.length === 0 ? null : value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'detach') {
    throw new Error('Expected a component detach command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Detach arguments must be strings.');
  }

  const positionals = [];
  let name = null;
  let sawName = false;
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    const inlineName = !literal ? token.match(/^--name=(.*)$/s) : null;
    if (!literal && (token === '--name' || inlineName)) {
      if (sawName) throw requestError('--name may be provided only once');
      sawName = true;
      const raw = inlineName ? inlineName[1] : args[++index];
      if (raw === undefined || raw === '--' || (!inlineName && raw.startsWith('--'))) {
        throw requestError('--name requires a value');
      }
      name = frameName(raw);
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
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { instance: nodeReference(positionals[0]), name, json };
}

export function parseComponentDetachRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    instanceId: input.instance.nodeId,
    name: input.name,
    json: input.json,
  });
}

export function acceptsComponentDetachArgv(args) {
  try { parseComponentDetachRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Detach request must be an object.');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return {
    instance: nodeReference(request.instanceId),
    name: request.name === null || request.name === undefined ? null : frameName(request.name),
    json: request.json === true,
  };
}

function argvFromInput(input, { planning = false } = {}) {
  return [
    'component', 'detach', planning ? input.instance.planningValue : input.instance.nodeId,
    ...(input.name === null ? [] : [`--name=${input.name}`]),
    ...(input.json ? ['--json'] : []),
  ];
}

export function componentDetachArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseComponentDetachRequest(args);
  return args;
}

export function componentDetachPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseComponentDetachRequest(args);
  return args;
}

export function componentDetachFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).instance.fileKey || null;
}
