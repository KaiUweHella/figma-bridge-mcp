// Closed request Interface for the mutating `a11y vision` simulation.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const A11Y_VISION_TYPES = Object.freeze([
  'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia',
]);
const TYPE_SET = new Set(A11Y_VISION_TYPES);

function requestError(message) {
  return new Error(`Invalid A11y Vision command: ${message}.`);
}

function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function typeValue(value) {
  if (typeof value !== 'string') throw requestError('type must be a string');
  const normalized = value.toLowerCase();
  if (normalized !== 'all' && !TYPE_SET.has(normalized)) {
    throw requestError(`type must be all or one of ${A11Y_VISION_TYPES.join(', ')}`);
  }
  return normalized;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'a11y' || args[1] !== 'vision') {
    throw new Error('Expected an a11y vision command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('A11y Vision arguments must be strings.');
  }
  const positionals = [];
  const seen = new Set();
  let type = 'all';
  let json = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (seen.has('json')) throw requestError('--json may be provided only once');
      seen.add('json');
      json = true;
      continue;
    }
    if (!literal && (token === '--type' || token.startsWith('--type='))) {
      if (seen.has('type')) throw requestError('--type may be provided only once');
      seen.add('type');
      const inline = token.startsWith('--type=') ? token.slice('--type='.length) : null;
      const value = inline === null ? args[++index] : inline;
      if (typeof value !== 'string' || !value || value === '--') {
        throw requestError('--type requires a value');
      }
      type = typeValue(value);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { node: positionals.length ? nodeValue(positionals[0]) : null, type, json };
}

export function parseA11yVisionRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    nodeId: input.node?.nodeId || null,
    type: input.type,
    json: input.json,
    warning: input.node?.warning || '',
  });
}

export function a11yVisionFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node?.fileKey || null;
}

export function acceptsA11yVisionArgv(args) {
  try { parseA11yVisionRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('A11y Vision request must be an object.');
  }
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  return {
    node: request.nodeId == null ? null : nodeValue(request.nodeId),
    type: request.type == null ? 'all' : typeValue(request.type),
    json: request.json === true,
  };
}

function argvFromInput(input, planning) {
  return [
    'a11y', 'vision',
    ...(input.node ? [planning ? input.node.planningValue : input.node.nodeId] : []),
    ...(input.type === 'all' ? [] : [`--type=${input.type}`]),
    ...(input.json ? ['--json'] : []),
  ];
}

export function a11yVisionArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseA11yVisionRequest(args);
  return args;
}

export function a11yVisionPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseA11yVisionRequest(args);
  return args;
}
