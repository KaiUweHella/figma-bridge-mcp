// Closed request Interface for `component add-variant`, whose set reference
// historically accepted either a node id or a component-set name.

import {
  parseUnionReference,
  unionReferenceArgvValue,
} from './union-reference.js';
import { parseVariantPairs } from '../lib/variant-snippets.js';

export const MAX_COMPONENT_ADD_VARIANT_INPUT_CODE_UNITS = 4096;
export const MAX_COMPONENT_ADD_VARIANT_AXES = 32;
export const MAX_COMPONENT_ADD_VARIANT_AXIS_CODE_UNITS = 256;
export const MAX_COMPONENT_ADD_VARIANT_VALUE_CODE_UNITS = 512;
const UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid Component Set command: ${message}.`);
}

function bounded(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw requestError(`${label} is required`);
  if (value.length > MAX_COMPONENT_ADD_VARIANT_INPUT_CODE_UNITS) {
    throw requestError(`${label} exceeds ${MAX_COMPONENT_ADD_VARIANT_INPUT_CODE_UNITS} code units`);
  }
  if (UNSAFE_CONTROLS.test(value)) throw requestError(`${label} contains unsupported controls`);
  return value;
}

function pairsValue(value) {
  let parsed;
  if (typeof value === 'string') {
    try { parsed = parseVariantPairs(bounded(value, 'variant pairs')); }
    catch (error) { throw requestError(error.message); }
  } else if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype) {
    parsed = value;
  } else {
    throw requestError('variant pairs must be a string or plain object');
  }
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > MAX_COMPONENT_ADD_VARIANT_AXES) {
    throw requestError(`variant pairs must contain 1-${MAX_COMPONENT_ADD_VARIANT_AXES} axes`);
  }
  const result = {};
  for (const [axis, selected] of entries) {
    if (typeof axis !== 'string' || !axis || axis.length > MAX_COMPONENT_ADD_VARIANT_AXIS_CODE_UNITS
      || UNSAFE_CONTROLS.test(axis) || axis.includes(',') || axis.includes('=')) {
      throw requestError('variant axis is empty, unsafe or too long');
    }
    if (typeof selected !== 'string' || !selected
      || selected.length > MAX_COMPONENT_ADD_VARIANT_VALUE_CODE_UNITS
      || UNSAFE_CONTROLS.test(selected) || selected.includes(',')) {
      throw requestError(`value for axis ${axis} is empty, unsafe or too long`);
    }
    Object.defineProperty(result, axis, {
      value: selected, enumerable: true, configurable: true, writable: true,
    });
  }
  return Object.freeze(result);
}

function pairsText(value) {
  return Object.entries(pairsValue(value)).map(([axis, selected]) => `${axis}=${selected}`).join(', ');
}

export function parseComponentSetReferenceRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'component' || args[1] !== 'add-variant') {
    throw new Error('Expected a component add-variant command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Component Set arguments must be strings.');
  }

  const positionals = [];
  let fromName = null;
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
    if (!literal && (token === '--from' || token.startsWith('--from='))) {
      if (fromName !== null) throw requestError('--from may be provided only once');
      const equals = token.indexOf('=');
      if (equals !== -1) fromName = bounded(token.slice(equals + 1), '--from value');
      else {
        fromName = bounded(args[index + 1], '--from value');
        index++;
      }
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('set reference and variant pairs are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);

  let reference;
  try {
    reference = parseUnionReference(bounded(positionals[0], 'set reference'), {
      allowedKinds: ['node', 'name', 'query'],
    });
  } catch (error) {
    throw requestError(error.message);
  }
  const pairs = pairsValue(positionals[1]);
  return Object.freeze({ action: 'add-variant', reference, pairs, fromName, json });
}

export function acceptsComponentSetReferenceArgv(args) {
  try {
    parseComponentSetReferenceRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function componentSetReferenceArgvFromRequest(request) {
  const input = request?.reference
    ? request
    : parseComponentSetReferenceRequest(request?.argv || request);
  const reference = unionReferenceArgvValue(input.reference, {
    allowedKinds: ['node', 'name', 'query'],
  });
  return [
    'component', 'add-variant', reference, pairsText(input.pairs),
    ...(input.fromName == null ? [] : [`--from=${bounded(input.fromName, '--from value')}`]),
    ...(input.json === true ? ['--json'] : []),
  ];
}

export function componentSetReferencePlanningArgvFromRequest(request) {
  const input = request?.reference
    ? request
    : parseComponentSetReferenceRequest(request?.argv || request);
  const result = componentSetReferenceArgvFromRequest(input);
  if (input.reference.kind === 'node') {
    result[2] = `node:${input.reference.planningValue}`;
  }
  return result;
}

export function componentSetReferenceFigmaUrlFileKeyFromArgv(args) {
  return parseComponentSetReferenceRequest(args).reference.fileKey;
}
