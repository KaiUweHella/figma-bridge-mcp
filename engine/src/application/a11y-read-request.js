// Closed request Interface for the read-only accessibility diagnostics.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const A11Y_READ_ACTIONS = Object.freeze([
  'contrast', 'touch', 'text', 'focus', 'audit',
]);
const ACTIONS = new Set(A11Y_READ_ACTIONS);
const LEVEL_ACTIONS = new Set(['contrast', 'audit']);
const FAIL_ACTIONS = new Set(['contrast', 'touch', 'text', 'audit']);
export const MAX_A11Y_TOUCH_MINIMUM = 10_000;

function requestError(message) {
  return new Error(`Invalid A11y read command: ${message}.`);
}

function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function levelValue(value) {
  if (typeof value !== 'string') throw requestError('level must be a string');
  const normalized = value.toUpperCase();
  if (!['AA', 'AAA'].includes(normalized)) throw requestError('level must be AA or AAA');
  return normalized;
}

function minimumValue(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw requestError('minimum touch size must be a positive integer');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > MAX_A11Y_TOUCH_MINIMUM) {
    throw requestError(`minimum touch size must not exceed ${MAX_A11Y_TOUCH_MINIMUM}`);
  }
  return number;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'a11y' || !ACTIONS.has(args[1])) {
    throw new Error('Expected an A11y read command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('A11y read arguments must be strings.');
  }
  const action = args[1];
  const seen = new Set();
  const positionals = [];
  let literal = false;
  let level = 'AA';
  let minimum = 44;
  let json = false;
  let failOnIssues = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--json') {
      if (seen.has('json')) throw requestError('--json may be provided only once');
      seen.add('json'); json = true; continue;
    }
    if (!literal && token === '--fail-on-issues') {
      if (!FAIL_ACTIONS.has(action)) {
        throw requestError(`--fail-on-issues is unavailable for ${action}`);
      }
      if (seen.has('fail')) throw requestError('--fail-on-issues may be provided only once');
      seen.add('fail'); failOnIssues = true; continue;
    }
    if (!literal && (token === '--level' || token.startsWith('--level='))) {
      if (!LEVEL_ACTIONS.has(action)) throw requestError(`--level is unavailable for ${action}`);
      if (seen.has('level')) throw requestError('--level may be provided only once');
      seen.add('level');
      const inline = token.startsWith('--level=') ? token.slice('--level='.length) : null;
      const value = inline === null ? args[++index] : inline;
      if (typeof value !== 'string' || !value || value === '--') {
        throw requestError('--level requires a value');
      }
      level = levelValue(value); continue;
    }
    if (!literal && (token === '--min' || token.startsWith('--min='))) {
      if (action !== 'touch') throw requestError(`--min is unavailable for ${action}`);
      if (seen.has('min')) throw requestError('--min may be provided only once');
      seen.add('min');
      const inline = token.startsWith('--min=') ? token.slice('--min='.length) : null;
      const value = inline === null ? args[++index] : inline;
      if (typeof value !== 'string' || !value || value === '--') {
        throw requestError('--min requires a value');
      }
      minimum = minimumValue(value); continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return {
    action,
    node: positionals.length ? nodeValue(positionals[0]) : null,
    level,
    minimum,
    json,
    failOnIssues,
  };
}

export function parseA11yReadRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    action: input.action,
    nodeId: input.node?.nodeId || null,
    level: input.level,
    minimum: input.minimum,
    json: input.json,
    failOnIssues: input.failOnIssues,
    warning: input.node?.warning || '',
  });
}

export function a11yReadFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node?.fileKey || null;
}

export function acceptsA11yReadArgv(args) {
  try { parseA11yReadRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('A11y read request must be an object.');
  }
  if (!ACTIONS.has(request.action)) throw requestError('action must name an A11y read');
  if (request.json != null && typeof request.json !== 'boolean') {
    throw requestError('json must be a boolean');
  }
  if (request.failOnIssues != null && typeof request.failOnIssues !== 'boolean') {
    throw requestError('failOnIssues must be a boolean');
  }
  if (request.failOnIssues && !FAIL_ACTIONS.has(request.action)) {
    throw requestError(`failOnIssues is unavailable for ${request.action}`);
  }
  const level = request.level == null ? 'AA' : levelValue(request.level);
  if (request.level != null && level !== 'AA' && !LEVEL_ACTIONS.has(request.action)) {
    throw requestError(`level is unavailable for ${request.action}`);
  }
  let minimum = 44;
  if (request.minimum != null) {
    minimum = minimumValue(String(request.minimum));
    if (minimum !== 44 && request.action !== 'touch') {
      throw requestError(`minimum is unavailable for ${request.action}`);
    }
  }
  return {
    action: request.action,
    node: request.nodeId == null ? null : nodeValue(request.nodeId),
    level,
    minimum,
    json: request.json === true,
    failOnIssues: request.failOnIssues === true,
  };
}

function argvFromInput(input, planning) {
  return [
    'a11y', input.action,
    ...(input.node ? [planning ? input.node.planningValue : input.node.nodeId] : []),
    ...(LEVEL_ACTIONS.has(input.action) && input.level !== 'AA'
      ? [`--level=${input.level}`] : []),
    ...(input.action === 'touch' && input.minimum !== 44
      ? [`--min=${input.minimum}`] : []),
    ...(input.json ? ['--json'] : []),
    ...(input.failOnIssues ? ['--fail-on-issues'] : []),
  ];
}

export function a11yReadArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseA11yReadRequest(args);
  return args;
}

export function a11yReadPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseA11yReadRequest(args);
  return args;
}
