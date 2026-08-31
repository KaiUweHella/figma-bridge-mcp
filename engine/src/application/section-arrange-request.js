// Closed request Interface for `section arrange`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEFAULT_SECTION_ARRANGE_COLUMNS = 4;
export const DEFAULT_SECTION_ARRANGE_GAP = 48;
export const DEFAULT_SECTION_ARRANGE_PADDING = 64;
export const MAX_SECTION_ARRANGE_COLUMNS = 1_024;
export const MAX_SECTION_ARRANGE_SPACING = 1_000_000;

function requestError(message) {
  return new Error(`Invalid Section Arrange command: ${message}.`);
}

function nodeReference(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('sectionId must be a bounded Figma node id or URL containing node-id');
  }
}

function nonemptyNumber(value, field) {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw requestError(`${field} must not be empty`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw requestError(`${field} must be a finite number`);
  return Object.is(parsed, -0) ? 0 : parsed;
}

function columns(value) {
  const parsed = nonemptyNumber(value, 'cols');
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SECTION_ARRANGE_COLUMNS) {
    throw requestError(`cols must be an integer between 1 and ${MAX_SECTION_ARRANGE_COLUMNS}`);
  }
  return parsed;
}

function spacing(value, field) {
  const parsed = nonemptyNumber(value, field);
  if (parsed < 0 || parsed > MAX_SECTION_ARRANGE_SPACING) {
    throw requestError(`${field} must be between 0 and ${MAX_SECTION_ARRANGE_SPACING}`);
  }
  return parsed;
}

function optionValue(args, index, token, inline) {
  if (inline !== null) return { value: inline, index };
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'section' || args[1] !== 'arrange') {
    throw new Error('Expected a section arrange command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Section Arrange arguments must be strings.');
  }
  const positionals = [];
  const seen = new Set();
  const values = {
    cols: DEFAULT_SECTION_ARRANGE_COLUMNS,
    gap: DEFAULT_SECTION_ARRANGE_GAP,
    pad: DEFAULT_SECTION_ARRANGE_PADDING,
  };
  let groupRows = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--group-rows') {
      if (seen.has('groupRows')) throw requestError('--group-rows may be provided only once');
      seen.add('groupRows');
      groupRows = true;
      continue;
    }
    if (!literal) {
      const options = [
        ['cols', '-c', '--cols'],
        ['gap', '-g', '--gap'],
        ['pad', null, '--pad'],
      ];
      let matched = false;
      for (const [field, short, long] of options) {
        const longInline = token.startsWith(`${long}=`) ? token.slice(long.length + 1) : null;
        const shortInline = short && token.startsWith(short) && token !== short
          ? token.slice(short.length).replace(/^=/, '') : null;
        if (token !== short && token !== long && longInline === null && shortInline === null) continue;
        if (seen.has(field)) throw requestError(`${long} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, long, longInline ?? shortInline);
        index = item.index;
        values[field] = field === 'cols'
          ? columns(item.value) : spacing(item.value, field);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('sectionId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { reference: nodeReference(positionals[0]), ...values, groupRows };
}

export function parseSectionArrangeRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    sectionId: input.reference.nodeId,
    cols: input.cols,
    gap: input.gap,
    pad: input.pad,
    groupRows: input.groupRows,
  });
}

export function acceptsSectionArrangeArgv(args) {
  try { parseSectionArrangeRequest(args); return true; }
  catch { return false; }
}

export function sectionArrangeFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Section Arrange request must be an object.');
  }
  if (request.groupRows != null && typeof request.groupRows !== 'boolean') {
    throw requestError('groupRows must be a boolean');
  }
  return {
    reference: nodeReference(request.sectionId),
    cols: request.cols == null ? DEFAULT_SECTION_ARRANGE_COLUMNS : columns(request.cols),
    gap: request.gap == null ? DEFAULT_SECTION_ARRANGE_GAP : spacing(request.gap, 'gap'),
    pad: request.pad == null ? DEFAULT_SECTION_ARRANGE_PADDING : spacing(request.pad, 'pad'),
    groupRows: request.groupRows === true,
  };
}

function argvFromInput(input, planning) {
  return [
    'section', 'arrange', planning ? input.reference.planningValue : input.reference.nodeId,
    ...(input.cols === DEFAULT_SECTION_ARRANGE_COLUMNS ? [] : [`--cols=${input.cols}`]),
    ...(input.gap === DEFAULT_SECTION_ARRANGE_GAP ? [] : [`--gap=${input.gap}`]),
    ...(input.pad === DEFAULT_SECTION_ARRANGE_PADDING ? [] : [`--pad=${input.pad}`]),
    ...(input.groupRows ? ['--group-rows'] : []),
  ];
}

export function sectionArrangeArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseSectionArrangeRequest(args);
  return args;
}

export function sectionArrangePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseSectionArrangeRequest(args);
  return args;
}
