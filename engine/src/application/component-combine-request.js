// Closed request Interface for `component combine`.
//
// The legacy Commander adapter consumed only its first positional token. This
// request owns every accepted spelling so no Component identity can be lost
// between MCP planning, confirmation and Plugin dispatch.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_COMPONENT_COMBINE_COMPONENTS = 256;
export const MAX_COMPONENT_COMBINE_NAME_CODE_UNITS = 512;
const UNSAFE_NAME_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid component combine command: ${message}.`);
}

function nameValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('name is required');
  if (value.length > MAX_COMPONENT_COMBINE_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_COMPONENT_COMBINE_NAME_CODE_UNITS} code units`);
  }
  if (UNSAFE_NAME_CONTROLS.test(value)) {
    throw requestError('name contains unsupported control characters');
  }
  return value;
}

function nodeValue(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('every component must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'combine') {
    throw new Error('Expected a component combine command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Combine arguments must be strings.');
  }

  const positionals = [];
  let name = 'ComponentSet';
  let sawName = false;
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    const longName = !literal ? token.match(/^--name=(.*)$/s) : null;
    const shortName = !literal ? token.match(/^-n(.+)$/s) : null;
    if (!literal && (token === '--name' || token === '-n' || longName || shortName)) {
      if (sawName) throw requestError('--name may be provided only once');
      sawName = true;
      const inline = longName?.[1] ?? shortName?.[1];
      const raw = inline === undefined ? args[++index] : inline;
      if (raw === undefined || raw === '--' || (inline === undefined && raw.startsWith('-'))) {
        throw requestError('--name requires a value');
      }
      name = nameValue(raw);
      continue;
    }
    if (!literal && token === '--json') {
      if (json) throw requestError('--json may be provided only once');
      json = true;
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    const parts = token.split(',');
    if (parts.some((part) => !part.trim())) {
      throw requestError('component lists must not contain empty entries');
    }
    positionals.push(...parts.map((part) => part.trim()));
  }

  if (positionals.length < 2) throw requestError('at least two component ids are required');
  if (positionals.length > MAX_COMPONENT_COMBINE_COMPONENTS) {
    throw requestError(`at most ${MAX_COMPONENT_COMBINE_COMPONENTS} components may be combined`);
  }
  const nodes = positionals.map(nodeValue);
  const ids = nodes.map((node) => node.nodeId);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw requestError(`duplicate component id ${duplicate}`);
  return { nodes, name: nameValue(name), json };
}

export function parseComponentCombineRequest(args) {
  const input = parsedRequest(args);
  return {
    componentIds: input.nodes.map((node) => node.nodeId),
    name: input.name,
    json: input.json,
  };
}

export function componentCombineFigmaUrlFileKeyFromArgv(args) {
  const keys = new Set(parsedRequest(args).nodes.map((node) => node.fileKey).filter(Boolean));
  if (keys.size > 1) {
    throw requestError('component references target multiple Figma files');
  }
  return keys.values().next().value || null;
}

export function acceptsComponentCombineArgv(args) {
  try {
    parseComponentCombineRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Combine request must be an object.');
  }
  if (!Array.isArray(request.componentIds)) {
    throw requestError('componentIds must be an array');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  const nodes = request.componentIds.map(nodeValue);
  if (nodes.length < 2) throw requestError('at least two component ids are required');
  if (nodes.length > MAX_COMPONENT_COMBINE_COMPONENTS) {
    throw requestError(`at most ${MAX_COMPONENT_COMBINE_COMPONENTS} components may be combined`);
  }
  const ids = nodes.map((node) => node.nodeId);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw requestError(`duplicate component id ${duplicate}`);
  return {
    nodes,
    name: nameValue(request.name === undefined ? 'ComponentSet' : request.name),
    json: request.json === true,
  };
}

export function componentCombineArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'component', 'combine', ...input.nodes.map((node) => node.nodeId),
    `--name=${input.name}`,
    ...(input.json ? ['--json'] : []),
  ];
  parseComponentCombineRequest(args);
  return args;
}

export function componentCombinePlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'component', 'combine', ...input.nodes.map((node) => node.planningValue),
    `--name=${input.name}`,
    ...(input.json ? ['--json'] : []),
  ];
}
