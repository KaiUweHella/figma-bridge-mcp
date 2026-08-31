// Closed request Interface for `jam connector`.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_JAM_CONNECTOR_TEXT_CODE_UNITS = 100_000;

function requestError(message) {
  return new Error(`Invalid Jam Connector command: ${message}.`);
}

function nodeReference(value, field) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError(`${field} must be a bounded Figma node id or URL containing node-id`);
  }
}

function textValue(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > MAX_JAM_CONNECTOR_TEXT_CODE_UNITS) {
    throw requestError(`text must be a string of at most ${MAX_JAM_CONNECTOR_TEXT_CODE_UNITS} code units`);
  }
  return value;
}

function lineValue(value) {
  return String(value ?? 'ELBOWED').toUpperCase() === 'STRAIGHT' ? 'STRAIGHT' : 'ELBOWED';
}

function optionValue(args, index, token, inline) {
  if (inline !== null) return { value: inline, index };
  if (args[index + 1] === undefined || args[index + 1] === '--') {
    throw requestError(`${token} requires a value`);
  }
  return { value: args[index + 1], index: index + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'jam' || args[1] !== 'connector') {
    throw new Error('Expected a jam connector command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Jam Connector arguments must be strings.');
  }
  let text = null;
  let line = 'ELBOWED';
  let literal = false;
  const seen = new Set();
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal) {
      let matched = false;
      for (const [field, name] of [['text', '--text'], ['line', '--line']]) {
        const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
        if (token !== name && inline === null) continue;
        if (seen.has(field)) throw requestError(`${name} may be provided only once`);
        seen.add(field);
        const item = optionValue(args, index, name, inline);
        index = item.index;
        if (field === 'text') text = textValue(item.value);
        else line = lineValue(item.value);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('fromId and toId are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  const from = nodeReference(positionals[0], 'fromId');
  const to = nodeReference(positionals[1], 'toId');
  const fileKeys = new Set([from.fileKey, to.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('fromId and toId target multiple Figma files');
  return { from, to, text, line };
}

export function parseJamConnectorRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    fromId: input.from.nodeId, toId: input.to.nodeId,
    text: input.text, line: input.line,
  });
}

export function acceptsJamConnectorArgv(args) {
  try { parseJamConnectorRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Jam Connector request must be an object.');
  }
  if (Object.keys(request).some((key) => !['fromId', 'toId', 'text', 'line'].includes(key))) {
    throw requestError('request contains an unknown field');
  }
  const from = nodeReference(request.fromId, 'fromId');
  const to = nodeReference(request.toId, 'toId');
  const fileKeys = new Set([from.fileKey, to.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('fromId and toId target multiple Figma files');
  return { from, to, text: textValue(request.text), line: lineValue(request.line) };
}

function argvFromInput(input, planning) {
  return [
    'jam', 'connector',
    planning ? input.from.planningValue : input.from.nodeId,
    planning ? input.to.planningValue : input.to.nodeId,
    ...(input.text === null ? [] : [`--text=${input.text}`]),
    ...(input.line === 'ELBOWED' ? [] : [`--line=${input.line}`]),
  ];
}

export function jamConnectorArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseJamConnectorRequest(args);
  return args;
}

export function jamConnectorPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseJamConnectorRequest(args);
  return args;
}

export function jamConnectorFigmaUrlFileKeyFromArgv(args) {
  const input = parsedRequest(args);
  return input.from.fileKey || input.to.fileKey || null;
}
