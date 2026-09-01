// Closed request Interface for `component prop add`.

import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from './node-reference.js';

export const MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_PROPERTY_ADD_VALUE_CODE_UNITS = 200_000;
export const MAX_COMPONENT_PROPERTY_ADD_OPTIONS_CODE_UNITS = 4_096;
export const MAX_COMPONENT_PROPERTY_ADD_PREFERRED_COUNT = 100;
export const MAX_COMPONENT_PROPERTY_ADD_PREFERRED_CODE_UNITS = 16_384;
export const MAX_COMPONENT_PROPERTY_ADD_NODE_ID_CODE_UNITS = MAX_NODE_REFERENCE_CODE_UNITS;
export const COMPONENT_PROPERTY_ADD_TYPES = Object.freeze({
  boolean: 'BOOLEAN',
  text: 'TEXT',
  'instance-swap': 'INSTANCE_SWAP',
  variant: 'VARIANT',
});

function commandError(message) {
  return new Error(`Invalid component prop add command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    if (error.code === 'empty') throw commandError('componentId must not be empty');
    if (error.code === 'too-long') {
      throw commandError(`componentId must be at most ${MAX_COMPONENT_PROPERTY_ADD_NODE_ID_CODE_UNITS} code units`);
    }
    throw commandError('componentId must be a Figma node id or URL containing node-id');
  }
}

function bounded(value, label, maximum, { empty = false } = {}) {
  if (typeof value !== 'string') throw commandError(`${label} must be a string`);
  if (!empty && value.length === 0) throw commandError(`${label} must not be empty`);
  if (value.length > maximum) throw commandError(`${label} must be at most ${maximum} code units`);
  return value;
}

function propertyType(value) {
  const raw = bounded(value, 'type', 64).toLowerCase();
  const normalized = COMPONENT_PROPERTY_ADD_TYPES[raw] || raw.toUpperCase();
  if (!Object.values(COMPONENT_PROPERTY_ADD_TYPES).includes(normalized)) {
    throw commandError('type must be boolean, text, instance-swap, or variant');
  }
  if (normalized === 'VARIANT') {
    throw commandError('VARIANT properties cannot be added directly; create one named Component per Variant and combine them with component combine');
  }
  return normalized;
}

function preferredValues(value) {
  if (value === null || value === undefined) return null;
  const rawValues = Array.isArray(value)
    ? value
    : bounded(value, '--preferred value', MAX_COMPONENT_PROPERTY_ADD_PREFERRED_CODE_UNITS).split(',');
  if (rawValues.length === 0 || rawValues.length > MAX_COMPONENT_PROPERTY_ADD_PREFERRED_COUNT) {
    throw commandError(`--preferred must contain 1-${MAX_COMPONENT_PROPERTY_ADD_PREFERRED_COUNT} component node ids`);
  }
  const ids = rawValues.map((raw, index) => {
    const reference = nodeReference(String(raw).trim());
    if (reference.fileKey) throw commandError(`--preferred item ${index + 1} must be a file-local node id`);
    return reference.nodeId;
  });
  if (new Set(ids).size !== ids.length) throw commandError('--preferred component ids must be unique');
  return ids;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'prop' || args[2] !== 'add') {
    throw new Error('Expected a component prop add command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Property Add arguments must be strings.');
  }
  const positionals = [];
  let options = null;
  let preferred = null;
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
    if (!literal && (token === '-o' || token === '--options'
      || token.startsWith('--options=') || (token.startsWith('-o') && token.length > 2))) {
      if (options !== null) throw commandError('--options may be provided only once');
      if (token.startsWith('--options=')) options = token.slice('--options='.length);
      else if (token.startsWith('-o') && token.length > 2) {
        options = token.slice(2).replace(/^=/, '');
      }
      else {
        if (args[index + 1] === undefined) throw commandError(`${token} requires a value`);
        options = args[++index];
      }
      bounded(options, '--options value', MAX_COMPONENT_PROPERTY_ADD_OPTIONS_CODE_UNITS, { empty: true });
      continue;
    }
    if (!literal && (token === '--preferred' || token.startsWith('--preferred='))) {
      if (preferred !== null) throw commandError('--preferred may be provided only once');
      let raw;
      if (token.startsWith('--preferred=')) raw = token.slice('--preferred='.length);
      else {
        if (args[index + 1] === undefined) throw commandError('--preferred requires a value');
        raw = args[++index];
      }
      preferred = preferredValues(raw);
      continue;
    }
    if (!literal && token.startsWith('-')) throw commandError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 4) throw commandError('componentId, name, type and defaultValue are required');
  if (positionals.length > 4) throw commandError(`unexpected argument ${positionals[4]}`);
  const reference = nodeReference(positionals[0]);
  const type = propertyType(positionals[2]);
  if (preferred !== null && type !== 'INSTANCE_SWAP') {
    throw commandError('--preferred is supported only for instance-swap properties');
  }
  return {
    componentId: reference.nodeId,
    fileKey: reference.fileKey,
    reference,
    name: bounded(positionals[1], 'name', MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS),
    type,
    defaultValue: bounded(
      positionals[3], 'defaultValue', MAX_COMPONENT_PROPERTY_ADD_VALUE_CODE_UNITS, { empty: true },
    ),
    options,
    preferred,
    json,
  };
}

export function parseComponentPropertyAddRequest(args) {
  const { componentId, name, type, defaultValue, options, preferred, json } = parsedRequest(args);
  return Object.freeze({ componentId, name, type, defaultValue, options, preferred, json });
}

export function acceptsComponentPropertyAddArgv(args) {
  try { parseComponentPropertyAddRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Component Property Add request must be an object.');
  }
  const reference = nodeReference(request.componentId);
  return {
    componentId: reference.nodeId,
    reference,
    name: bounded(request.name, 'name', MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS),
    type: propertyType(request.type),
    defaultValue: bounded(
      request.defaultValue, 'defaultValue', MAX_COMPONENT_PROPERTY_ADD_VALUE_CODE_UNITS, { empty: true },
    ),
    options: request.options == null ? null
      : bounded(request.options, '--options value', MAX_COMPONENT_PROPERTY_ADD_OPTIONS_CODE_UNITS, { empty: true }),
    preferred: preferredValues(request.preferred),
    json: request.json === true,
  };
}

export function componentPropertyAddArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = ['component', 'prop', 'add', input.componentId];
  const needsLiteral = input.name.startsWith('-') || input.defaultValue.startsWith('-')
    || input.defaultValue.length === 0;
  if (input.json) argv.push('--json');
  if (input.options !== null) argv.push('--options', input.options);
  if (input.preferred !== null) argv.push('--preferred', input.preferred.join(','));
  if (needsLiteral) argv.push('--');
  argv.push(input.name, input.type, input.defaultValue);
  parseComponentPropertyAddRequest(argv);
  return argv;
}

export function componentPropertyAddPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  const argv = componentPropertyAddArgvFromRequest(input);
  if (input.reference.fileKey) {
    const componentIndex = argv.indexOf(input.componentId, 3);
    argv[componentIndex] = input.reference.planningValue;
  }
  return argv;
}

export function componentPropertyAddFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).fileKey;
}
