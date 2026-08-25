// Closed request Interface for `font inspect`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

const MAX_INDEX_CODE_UNITS = 32;

function requestError(message) {
  return new Error(`Invalid font inspect command: ${message}.`);
}

function nodeValue(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function indexValue(value, option) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_INDEX_CODE_UNITS) {
    throw requestError(`${option} requires a bounded non-negative integer`);
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw requestError(`${option} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw requestError(`${option} must be a safe integer`);
  return parsed;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'font' || args[1] !== 'inspect') {
    throw new Error('Expected a font inspect command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Font Inspection arguments must be strings.');
  }

  const positionals = [];
  let start = null;
  let end = null;
  let allOpenType = false;
  let literal = false;
  const seen = new Set();
  const assignIndex = (option, value, { inline = false } = {}) => {
    if (seen.has(option)) throw requestError(`${option} may be provided only once`);
    if (!inline && (typeof value !== 'string' || value.startsWith('-'))) {
      throw requestError(`${option} requires a value`);
    }
    const parsed = indexValue(value, option);
    if (option === '--start') start = parsed;
    else end = parsed;
    seen.add(option);
  };

  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && (token === '--start' || token === '--end')) {
      assignIndex(token, args[index + 1]);
      index++;
      continue;
    }
    if (!literal && token === '--all-open-type') {
      if (allOpenType) throw requestError('--all-open-type may be provided only once');
      allOpenType = true;
      continue;
    }
    if (!literal) {
      const match = token.match(/^(--start|--end)=(.*)$/s);
      if (match) {
        assignIndex(match[1], match[2], { inline: true });
        continue;
      }
      if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }

  if (positionals.length === 0) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError('only one nodeId is accepted');
  if (typeof start === 'number' && typeof end === 'number' && end < start) {
    throw requestError('--end must be greater than or equal to --start');
  }
  return { node: nodeValue(positionals[0]), start, end, allOpenType };
}

export function parseFontInspectionRequest(args) {
  const input = parsedRequest(args);
  return {
    nodeId: input.node.nodeId,
    start: input.start,
    end: input.end,
    allOpenType: input.allOpenType,
  };
}

export function fontInspectionFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node.fileKey;
}

export function acceptsFontInspectionArgv(args) {
  try {
    parseFontInspectionRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedIndex(value, option) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw requestError(`${option} must be a non-negative safe integer`);
  }
  return value;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Font Inspection request must be an object.');
  }
  if (request.allOpenType != null && typeof request.allOpenType !== 'boolean') {
    throw requestError('allOpenType must be a boolean');
  }
  const start = typedIndex(request.start, '--start');
  const end = typedIndex(request.end, '--end');
  if (start !== null && end !== null && end < start) {
    throw requestError('--end must be greater than or equal to --start');
  }
  return {
    node: nodeValue(request.nodeId),
    start,
    end,
    allOpenType: request.allOpenType === true,
  };
}

function argvFromInput(input, nodeValue) {
  return [
    'font', 'inspect', nodeValue,
    ...(input.start === null ? [] : ['--start', String(input.start)]),
    ...(input.end === null ? [] : ['--end', String(input.end)]),
    ...(input.allOpenType ? ['--all-open-type'] : []),
  ];
}

export function fontInspectionArgvFromRequest(request) {
  const input = typedRequest(request);
  return argvFromInput(input, input.node.nodeId);
}

export function fontInspectionPlanningArgvFromRequest(request) {
  const input = typedRequest(request);
  return argvFromInput(input, input.node.fileKey ? input.node.planningValue : input.node.nodeId);
}
