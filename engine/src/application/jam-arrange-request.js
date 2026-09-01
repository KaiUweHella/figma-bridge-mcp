// Closed request Interface for `jam arrange`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEFAULT_JAM_ARRANGE_COLUMNS = 5;
export const DEFAULT_JAM_ARRANGE_GAP = 48;
export const MAX_JAM_ARRANGE_COLUMNS = 1_024;
export const MAX_JAM_ARRANGE_GAP = 1_000_000;
export const MAX_JAM_ARRANGE_IDS = 4_096;

function requestError(message) {
  return new Error(`Invalid Jam Arrange command: ${message}.`);
}

function finiteNumber(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'string' && value.trim().length === 0)) {
    throw requestError(`${field} must be a finite number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw requestError(`${field} must be a finite number`);
  return Object.is(parsed, -0) ? 0 : parsed;
}

function columns(value) {
  const parsed = finiteNumber(value, 'columns');
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_JAM_ARRANGE_COLUMNS) {
    throw requestError(`columns must be an integer between 1 and ${MAX_JAM_ARRANGE_COLUMNS}`);
  }
  return parsed;
}

function gap(value) {
  const parsed = finiteNumber(value, 'gap');
  if (Math.abs(parsed) > MAX_JAM_ARRANGE_GAP) {
    throw requestError(`gap must be between -${MAX_JAM_ARRANGE_GAP} and ${MAX_JAM_ARRANGE_GAP}`);
  }
  return parsed;
}

function nodeId(value) {
  try { return parseNodeReference(value).nodeId; }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('ids must contain only bounded Figma node ids');
  }
}

function idsValue(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  const ids = raw.filter((item) => typeof item !== 'string' || item.length > 0).map(nodeId);
  if (ids.length === 0) throw requestError('--ids requires at least one node id');
  if (ids.length > MAX_JAM_ARRANGE_IDS) {
    throw requestError(`ids may contain at most ${MAX_JAM_ARRANGE_IDS} node ids`);
  }
  if (new Set(ids).size !== ids.length) throw requestError('ids must be unique');
  return ids;
}

function optionValue(args, index, token, inline) {
  if (inline !== null) return { value: inline, index };
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

export function parseJamArrangeRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'arrange') {
    throw new Error('Expected a jam arrange command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Arrange arguments must be strings.');
  }
  let columnCount = DEFAULT_JAM_ARRANGE_COLUMNS;
  let gapSize = DEFAULT_JAM_ARRANGE_GAP;
  let ids = null;
  let all = false;
  let literal = false;
  const positionals = [];
  const seen = new Set();
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--all') {
      if (seen.has('all')) throw requestError('--all may be provided only once');
      seen.add('all'); all = true; continue;
    }
    if (!literal) {
      const options = [
        ['columns', '--columns'],
        ['gap', '--gap'],
        ['ids', '--ids'],
      ];
      let matched = false;
      for (const [field, name] of options) {
        const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
        if (token !== name && inline === null) continue;
        if (seen.has(field)) throw requestError(`${name} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, name, inline);
        index = item.index;
        if (field === 'columns') columnCount = columns(item.value);
        else if (field === 'gap') gapSize = gap(item.value);
        else ids = idsValue(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length > 0) throw requestError(`unexpected argument ${positionals[0]}`);
  if (ids !== null && all) throw requestError('choose either --ids or --all, not both');
  return Object.freeze({
    columns: columnCount,
    gap: gapSize,
    ids: ids === null ? null : Object.freeze(ids),
    all,
    scope: ids !== null ? 'ids' : all ? 'page' : 'selection',
  });
}

export function acceptsJamArrangeArgv(args) {
  try { parseJamArrangeRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Arrange request must be an object.');
  }
  if (Object.keys(request).some((key) => !['columns', 'gap', 'ids', 'all', 'scope'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  if (request.all !== undefined && typeof request.all !== 'boolean') {
    throw requestError('all must be boolean');
  }
  const ids = request.ids === undefined || request.ids === null ? null : idsValue(request.ids);
  if (ids !== null && request.all === true) throw requestError('choose either ids or all, not both');
  const scope = ids !== null ? 'ids' : request.all === true ? 'page' : 'selection';
  if (request.scope !== undefined && request.scope !== scope) {
    throw requestError('scope does not match ids/all targeting');
  }
  return {
    columns: request.columns === undefined ? DEFAULT_JAM_ARRANGE_COLUMNS : columns(request.columns),
    gap: request.gap === undefined ? DEFAULT_JAM_ARRANGE_GAP : gap(request.gap),
    ids,
    all: request.all === true,
  };
}

export function jamArrangeArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = [
    'jam', 'arrange',
    ...(input.columns === DEFAULT_JAM_ARRANGE_COLUMNS ? [] : [`--columns=${input.columns}`]),
    ...(input.gap === DEFAULT_JAM_ARRANGE_GAP ? [] : [`--gap=${input.gap}`]),
    ...(input.ids === null ? [] : [`--ids=${input.ids.join(',')}`]),
    ...(input.all ? ['--all'] : []),
  ];
  parseJamArrangeRequest(args);
  return args;
}
