// Closed request Interface for `section fit`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DEFAULT_SECTION_FIT_PADDING = 64;
export const MAX_SECTION_FIT_PADDING = 1_000_000;

function requestError(message) {
  return new Error(`Invalid Section Fit command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('sectionId must be a bounded Figma node id or URL containing node-id');
  }
}

function padding(value) {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw requestError('pad must not be empty');
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_SECTION_FIT_PADDING) {
    throw requestError(
      `pad must be a finite number between 0 and ${MAX_SECTION_FIT_PADDING}`,
    );
  }
  return Object.is(parsed, -0) ? 0 : parsed;
}

function optionValue(args, index, token, inline) {
  if (inline !== null) return { value: inline, index };
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'section' || args[1] !== 'fit') {
    throw new Error('Expected a section fit command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Section Fit arguments must be strings.');
  }
  const positionals = [];
  let pad = DEFAULT_SECTION_FIT_PADDING;
  let sawPad = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '--pad' || token.startsWith('--pad='))) {
      if (sawPad) throw requestError('--pad may be provided only once');
      sawPad = true;
      const inline = token.startsWith('--pad=') ? token.slice('--pad='.length) : null;
      const item = optionValue(args, index, '--pad', inline);
      index = item.index;
      pad = padding(item.value);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('sectionId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { reference: nodeReference(positionals[0]), pad };
}

export function parseSectionFitRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({ sectionId: input.reference.nodeId, pad: input.pad });
}

export function acceptsSectionFitArgv(args) {
  try {
    parseSectionFitRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function sectionFitFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).reference.fileKey;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Section Fit request must be an object.');
  }
  return {
    reference: nodeReference(request.sectionId),
    pad: request.pad === undefined || request.pad === null
      ? DEFAULT_SECTION_FIT_PADDING : padding(request.pad),
  };
}

function argvFromInput(input, planning) {
  return [
    'section', 'fit', planning ? input.reference.planningValue : input.reference.nodeId,
    ...(input.pad === DEFAULT_SECTION_FIT_PADDING ? [] : [`--pad=${input.pad}`]),
  ];
}

export function sectionFitArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseSectionFitRequest(args);
  return args;
}

export function sectionFitPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseSectionFitRequest(args);
  return args;
}
