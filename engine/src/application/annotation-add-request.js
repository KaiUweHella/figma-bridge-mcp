// Closed discriminated request Interface for single-node and query `annotate add`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';
import {
  ANNOTATION_PROPERTY_TYPES,
  MAX_ANNOTATION_LABEL_CODE_UNITS,
  MAX_ANNOTATION_READ_PROPERTIES,
} from './annotation-facts.js';

export const MAX_ANNOTATION_ADD_QUERY_CODE_UNITS = 1_024;
export const MAX_ANNOTATION_ADD_CATEGORY_CODE_UNITS = 1_024;

function requestError(message) {
  return new Error(`Invalid Annotation Add command: ${message}.`);
}

function bounded(value, field, maximum, { empty = true } = {}) {
  if (typeof value !== 'string') throw requestError(`${field} must be a string`);
  if (!empty && value.length === 0) throw requestError(`${field} must not be empty`);
  if (value.length > maximum) {
    throw requestError(`${field} must be at most ${maximum} code units`);
  }
  return value;
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('node must be a bounded Figma node id or URL containing node-id');
  }
}

function propertyValues(value) {
  if (value === undefined) return undefined;
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((item) => item.trim()).filter(Boolean)
      : null;
  if (!values || values.length > MAX_ANNOTATION_READ_PROPERTIES
    || values.some((item) => typeof item !== 'string'
      || !ANNOTATION_PROPERTY_TYPES.includes(item))) {
    throw requestError('properties must contain only supported Figma annotation property names');
  }
  return Object.freeze([...values]);
}

function optionValue(args, index, token, inline) {
  if (inline !== null) return { value: inline, index };
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'annotate' || args[1] !== 'add') {
    throw new Error('Expected an annotate add command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Annotation Add arguments must be strings.');
  }
  const positionals = [];
  const seen = new Set();
  let markdown = false;
  let node = null;
  let query;
  let category = null;
  let properties;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '-m' || token === '--markdown')) {
      if (seen.has('markdown')) throw requestError('--markdown may be provided only once');
      seen.add('markdown');
      markdown = true;
      continue;
    }
    if (!literal) {
      const options = [
        ['node', '-n', '--node'],
        ['query', '-q', '--query'],
        ['category', '-c', '--category'],
        ['properties', '-p', '--properties'],
      ];
      let matched = false;
      for (const [field, short, long] of options) {
        const longInline = token.startsWith(`${long}=`) ? token.slice(long.length + 1) : null;
        const shortInline = token.startsWith(short) && token !== short
          ? token.slice(short.length).replace(/^=/, '') : null;
        if (token !== short && token !== long && longInline === null && shortInline === null) continue;
        if (seen.has(field)) throw requestError(`${long} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, long, longInline ?? shortInline);
        index = item.index;
        if (field === 'node') node = nodeReference(item.value);
        if (field === 'query') {
          query = bounded(item.value, 'query', MAX_ANNOTATION_ADD_QUERY_CODE_UNITS);
        }
        if (field === 'category') {
          category = item.value === '' ? null : bounded(
            item.value, 'category', MAX_ANNOTATION_ADD_CATEGORY_CODE_UNITS, { empty: false });
        }
        if (field === 'properties') properties = propertyValues(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1) {
    throw requestError(positionals.length === 0
      ? 'missing required argument text' : `unexpected argument ${positionals[1]}`);
  }
  if (!node && query === undefined) throw requestError('provide --node or --query');
  return {
    selector: node ? 'node' : 'query',
    node,
    query: query ?? null,
    text: bounded(positionals[0], 'text', MAX_ANNOTATION_LABEL_CODE_UNITS),
    markdown,
    category,
    properties,
    warning: node && query !== undefined ? '--query was ignored because --node takes precedence' : '',
  };
}

export function parseAnnotationAddRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    selector: input.selector,
    nodeId: input.node?.nodeId || null,
    query: input.query,
    text: input.text,
    markdown: input.markdown,
    category: input.category,
    properties: input.properties,
    warning: input.warning,
  });
}

export function acceptsAnnotationAddArgv(args) {
  try {
    parseAnnotationAddRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function annotationAddFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node?.fileKey || null;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Annotation Add request must be an object.');
  }
  const node = request.nodeId == null || request.nodeId === '' ? null : nodeReference(request.nodeId);
  const query = request.query === undefined || request.query === null
    ? undefined
    : bounded(request.query, 'query', MAX_ANNOTATION_ADD_QUERY_CODE_UNITS);
  if (!node && query === undefined) throw requestError('provide --node or --query');
  return {
    selector: node ? 'node' : 'query',
    node,
    query: query ?? null,
    text: bounded(request.text, 'text', MAX_ANNOTATION_LABEL_CODE_UNITS),
    markdown: request.markdown === true,
    category: request.category == null || request.category === '' ? null : bounded(
      request.category, 'category', MAX_ANNOTATION_ADD_CATEGORY_CODE_UNITS, { empty: false }),
    properties: propertyValues(request.properties),
  };
}

function argvFromInput(input, planning) {
  return [
    'annotate', 'add',
    ...(input.markdown ? ['--markdown'] : []),
    ...(input.node ? [`--node=${planning ? input.node.planningValue : input.node.nodeId}`] : []),
    ...(input.query === null ? [] : [`--query=${input.query}`]),
    ...(input.category === null ? [] : [`--category=${input.category}`]),
    ...(input.properties === undefined ? [] : [`--properties=${input.properties.join(',')}`]),
    '--', input.text,
  ];
}

export function annotationAddArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseAnnotationAddRequest(args);
  return args;
}

export function annotationAddPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseAnnotationAddRequest(args);
  return args;
}
