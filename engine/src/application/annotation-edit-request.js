// Closed request Interface for `annotate edit`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';
import {
  ANNOTATION_PROPERTY_TYPES,
  MAX_ANNOTATION_LABEL_CODE_UNITS,
  MAX_ANNOTATION_READ_PROPERTIES,
} from './annotation-facts.js';

export const MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS = 1_024;

function requestError(message) {
  return new Error(`Invalid Annotation Edit command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function annotationIndex(value) {
  if (typeof value === 'string' && value.trim() === '') {
    throw requestError('index must be a non-negative safe integer');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw requestError('index must be a non-negative safe integer');
  }
  return number;
}

function boundedText(value) {
  if (typeof value !== 'string') throw requestError('text must be a string');
  if (value.length > MAX_ANNOTATION_LABEL_CODE_UNITS) {
    throw requestError(`text must be at most ${MAX_ANNOTATION_LABEL_CODE_UNITS} code units`);
  }
  return value;
}

function categoryValue(value) {
  if (typeof value !== 'string') throw requestError('category must be a string');
  if (value.length > MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS) {
    throw requestError(
      `category must be at most ${MAX_ANNOTATION_EDIT_CATEGORY_CODE_UNITS} code units`);
  }
  return value;
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
  if (!Array.isArray(args) || args[0] !== 'annotate' || args[1] !== 'edit') {
    throw new Error('Expected an annotate edit command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Annotation Edit arguments must be strings.');
  }
  const positionals = [];
  const seen = new Set();
  let text;
  let markdown = false;
  let category;
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
        ['text', '-t', '--text'],
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
        if (field === 'text') text = boundedText(item.value);
        if (field === 'category') category = categoryValue(item.value);
        if (field === 'properties') properties = propertyValues(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('missing required arguments nodeId, index');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  if (text === undefined && category === undefined && properties === undefined) {
    throw requestError('provide --text, --category, or --properties');
  }
  return {
    reference: nodeReference(positionals[0]),
    index: annotationIndex(positionals[1]),
    text,
    markdown,
    category,
    properties,
  };
}

export function parseAnnotationEditRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    nodeId: input.reference.nodeId,
    index: input.index,
    text: input.text,
    markdown: input.markdown,
    category: input.category,
    properties: input.properties,
  });
}

export function acceptsAnnotationEditArgv(args) {
  try {
    parseAnnotationEditRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function annotationEditFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Annotation Edit request must be an object.');
  }
  const text = request.text === undefined ? undefined : boundedText(request.text);
  const category = request.category === undefined ? undefined : categoryValue(request.category);
  const properties = propertyValues(request.properties);
  if (text === undefined && category === undefined && properties === undefined) {
    throw requestError('provide --text, --category, or --properties');
  }
  return {
    reference: nodeReference(request.nodeId),
    index: annotationIndex(request.index),
    text,
    markdown: request.markdown === true,
    category,
    properties,
  };
}

function argvFromInput(input, planning) {
  return [
    'annotate', 'edit',
    planning ? input.reference.planningValue : input.reference.nodeId,
    String(input.index),
    ...(input.text === undefined ? [] : [`--text=${input.text}`]),
    ...(input.markdown ? ['--markdown'] : []),
    ...(input.category === undefined ? [] : [`--category=${input.category}`]),
    ...(input.properties === undefined ? [] : [`--properties=${input.properties.join(',')}`]),
  ];
}

export function annotationEditArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseAnnotationEditRequest(args);
  return args;
}

export function annotationEditPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseAnnotationEditRequest(args);
  return args;
}
