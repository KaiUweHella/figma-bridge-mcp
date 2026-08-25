// Closed request Interface for `var resolve`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';
import { MAX_VARIABLE_FACTS_QUERY_CODE_UNITS } from './variable-facts-request.js';

const UNSAFE_QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function requestError(message) {
  return new Error(`Invalid var resolve command: ${message}.`);
}

function queryValue(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${field} is required`);
  if (value.length > MAX_VARIABLE_FACTS_QUERY_CODE_UNITS) {
    throw requestError(`${field} must be at most ${MAX_VARIABLE_FACTS_QUERY_CODE_UNITS} code units`);
  }
  if (UNSAFE_QUERY_CONTROLS.test(value)) {
    throw requestError(`${field} contains unsupported control characters`);
  }
  return value;
}

function nodeValue(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'var' || args[1] !== 'resolve') {
    throw new Error('Expected a var resolve command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Variable Resolution arguments must be strings.');
  }
  const positionals = [];
  let collection = null;
  let collectionSeen = false;
  let literal = false;
  const assignCollection = (value, option, { inline = false } = {}) => {
    if (collectionSeen) throw requestError('--collection may be provided only once');
    if (typeof value !== 'string' || !value.length || (!inline && value.startsWith('-'))) {
      throw requestError(`${option} requires a value`);
    }
    collection = queryValue(value, 'collection');
    collectionSeen = true;
  };

  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-c' || token === '--collection')) {
      assignCollection(args[index + 1], token);
      index++;
      continue;
    }
    if (!literal) {
      const long = token.match(/^--collection=(.*)$/s);
      if (long) {
        assignCollection(long[1], '--collection', { inline: true });
        continue;
      }
      const short = token.match(/^-c(?:=)?(.+)$/s);
      if (short) {
        assignCollection(short[1], '-c', { inline: true });
        continue;
      }
      if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }

  if (positionals.length < 2) throw requestError('variable and nodeId are required');
  if (positionals.length > 2) throw requestError('only one variable and one nodeId are accepted');
  return {
    variable: queryValue(positionals[0], 'variable'),
    node: nodeValue(positionals[1]),
    collection,
  };
}

export function parseVariableResolutionRequest(args) {
  const input = parsedRequest(args);
  return { variable: input.variable, nodeId: input.node.nodeId, collection: input.collection };
}

export function variableResolutionFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node.fileKey;
}

export function acceptsVariableResolutionArgv(args) {
  try {
    parseVariableResolutionRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Variable Resolution request must be an object.');
  }
  return {
    variable: queryValue(request.variable, 'variable'),
    node: nodeValue(request.nodeId),
    collection: request.collection == null ? null : queryValue(request.collection, 'collection'),
  };
}

function argvFromInput(input, nodeValue) {
  const collectionArgs = input.collection === null ? [] : (
    input.collection.startsWith('-')
      ? [`--collection=${input.collection}`]
      : ['--collection', input.collection]
  );
  if (input.variable.startsWith('-')) {
    return ['var', 'resolve', ...collectionArgs, '--', input.variable, nodeValue];
  }
  return [
    'var', 'resolve', input.variable, nodeValue,
    ...collectionArgs,
  ];
}

export function variableResolutionArgvFromRequest(request) {
  const input = typedRequest(request);
  return argvFromInput(input, input.node.nodeId);
}

export function variableResolutionPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  return argvFromInput(input, input.node.fileKey ? input.node.planningValue : input.node.nodeId);
}
