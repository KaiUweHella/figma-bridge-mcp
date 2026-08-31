// Closed discriminated request Interface for Annotation Category mutations.

import {
  ANNOTATION_CATEGORY_COLORS,
  MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS,
} from './annotation-category-facts.js';

const ACTIONS = new Set(['add', 'edit', 'remove']);

function requestError(message) {
  return new Error(`Invalid Annotation Category Mutation command: ${message}.`);
}

function actionFromSubcommand(value) {
  const action = String(value || '').replace(/^category-/, '');
  if (!ACTIONS.has(action)) throw new Error('Expected an Annotation Category mutation command.');
  return action;
}

function bounded(value, field, { empty = true } = {}) {
  if (typeof value !== 'string') throw requestError(`${field} must be a string`);
  if (!empty && value.length === 0) throw requestError(`${field} must not be empty`);
  if (value.length > MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS) {
    throw requestError(
      `${field} must be at most ${MAX_ANNOTATION_CATEGORY_LABEL_CODE_UNITS} code units`);
  }
  return value;
}

function colorValue(value) {
  if (typeof value !== 'string') throw requestError('color must be a string');
  const color = value.toLowerCase();
  if (!ANNOTATION_CATEGORY_COLORS.includes(color)) {
    throw requestError(`color must be one of: ${ANNOTATION_CATEGORY_COLORS.join(', ')}`);
  }
  return color;
}

function optionValue(args, index, token, inline) {
  if (inline !== null) return { value: inline, index };
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'annotate') {
    throw new Error('Expected an Annotation Category mutation command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Annotation Category Mutation arguments must be strings.');
  }
  const action = actionFromSubcommand(args[1]);
  const positionals = [];
  const seen = new Set();
  let label;
  let color;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal) {
      const definitions = [['label', '--label'], ['color', '--color']];
      let matched = false;
      for (const [field, option] of definitions) {
        const inline = token.startsWith(`${option}=`) ? token.slice(option.length + 1) : null;
        if (token !== option && inline === null) continue;
        if (seen.has(field)) throw requestError(`${option} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, option, inline);
        index = item.index;
        if (field === 'label') label = bounded(item.value, 'label');
        if (field === 'color') color = colorValue(item.value);
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
      ? `missing required argument ${action === 'add' ? 'label' : 'category'}`
      : `unexpected argument ${positionals[1]}`);
  }
  if (action === 'add') {
    if (label !== undefined) throw requestError('--label is not valid for category-add');
    if (color === undefined) throw requestError('--color is required for category-add');
    return { action, category: null, label: bounded(positionals[0], 'label'), color };
  }
  const category = bounded(positionals[0], 'category', { empty: false });
  if (action === 'remove') {
    if (label !== undefined || color !== undefined) {
      throw requestError('category-remove does not accept --label or --color');
    }
    return { action, category, label: undefined, color: undefined };
  }
  if (label === undefined && color === undefined) {
    throw requestError('provide --label or --color for category-edit');
  }
  return { action, category, label, color };
}

export function parseAnnotationCategoryMutationRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    action: input.action,
    category: input.category,
    label: input.label,
    color: input.color,
  });
}

export function acceptsAnnotationCategoryMutationArgv(args) {
  try {
    parseAnnotationCategoryMutationRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Annotation Category Mutation request must be an object.');
  }
  const action = actionFromSubcommand(request.action);
  if (action === 'add') {
    return {
      action,
      category: null,
      label: bounded(request.label, 'label'),
      color: colorValue(request.color),
    };
  }
  const category = bounded(request.category, 'category', { empty: false });
  if (action === 'remove') {
    return { action, category, label: undefined, color: undefined };
  }
  const label = request.label === undefined ? undefined : bounded(request.label, 'label');
  const color = request.color === undefined ? undefined : colorValue(request.color);
  if (label === undefined && color === undefined) {
    throw requestError('provide --label or --color for category-edit');
  }
  return { action, category, label, color };
}

export function annotationCategoryMutationArgvFromRequest(request) {
  const input = typedRequest(request);
  const positional = input.action === 'add' ? input.label : input.category;
  const args = [
    'annotate', `category-${input.action}`,
    ...(input.action === 'edit' && input.label !== undefined ? [`--label=${input.label}`] : []),
    ...(input.color === undefined ? [] : [`--color=${input.color}`]),
    ...(positional.length === 0 || positional.startsWith('-') ? ['--'] : []),
    positional,
  ];
  parseAnnotationCategoryMutationRequest(args);
  return args;
}

export const annotationCategoryMutationPlanningArgvFromRequest
  = annotationCategoryMutationArgvFromRequest;
