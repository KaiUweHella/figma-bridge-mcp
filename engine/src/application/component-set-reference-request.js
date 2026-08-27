// Closed request Interface for `component add-variant`, whose set reference
// historically accepted either a node id or a component-set name.

import {
  parseUnionReference,
  unionReferenceArgvValue,
} from './union-reference.js';

const MAX_VARIANT_INPUT_CODE_UNITS = 4096;

function requestError(message) {
  return new Error(`Invalid Component Set command: ${message}.`);
}

function bounded(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw requestError(`${label} is required`);
  if (value.length > MAX_VARIANT_INPUT_CODE_UNITS) {
    throw requestError(`${label} exceeds ${MAX_VARIANT_INPUT_CODE_UNITS} code units`);
  }
  return value;
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
  const pairs = bounded(positionals[1], 'variant pairs');
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
    'component', 'add-variant', reference, bounded(input.pairs, 'variant pairs'),
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
