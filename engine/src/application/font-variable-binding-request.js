// Closed request Interface for node/range typography-variable binding.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_FONT_BINDING_QUERY_CODE_UNITS = 512;
const MAX_INDEX_CODE_UNITS = 32;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
export const FONT_VARIABLE_FIELDS = Object.freeze({
  fontFamily: 'STRING', fontSize: 'FLOAT', fontStyle: 'STRING', fontWeight: 'FLOAT',
  letterSpacing: 'FLOAT', lineHeight: 'FLOAT', paragraphSpacing: 'FLOAT', paragraphIndent: 'FLOAT',
});

const FIELD_ALIASES = Object.freeze({
  'font-family': 'fontFamily', 'font-size': 'fontSize', 'font-style': 'fontStyle',
  'font-weight': 'fontWeight', 'letter-spacing': 'letterSpacing', 'line-height': 'lineHeight',
  'paragraph-spacing': 'paragraphSpacing', 'paragraph-indent': 'paragraphIndent',
});

function requestError(message) { return new Error(`Invalid font variable binding command: ${message}.`); }
function bounded(value, name) {
  if (typeof value !== 'string' || !value.length) throw requestError(`${name} is required`);
  if (value.length > MAX_FONT_BINDING_QUERY_CODE_UNITS) throw requestError(`${name} is too long`);
  if (UNSAFE.test(value)) throw requestError(`${name} contains unsafe control characters`);
  return value;
}
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}
function fieldValue(value) {
  const raw = bounded(value, 'field');
  const field = FIELD_ALIASES[raw] || raw;
  if (!Object.hasOwn(FONT_VARIABLE_FIELDS, field)) {
    throw requestError(`field must be one of ${Object.keys(FONT_VARIABLE_FIELDS).join(', ')}`);
  }
  return field;
}
function indexValue(value, option) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_INDEX_CODE_UNITS
    || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw requestError(`${option} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw requestError(`${option} must be a safe integer`);
  return parsed;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'font' || !['bind', 'unbind'].includes(args[1])) {
    throw new Error('Expected a font bind or font unbind command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Font binding arguments must be strings.');
  const bind = args[1] === 'bind';
  const positionals = [];
  const seen = new Set();
  let collection = null; let start = null; let end = null; let literal = false;
  const optionValue = (option, value) => {
    if (seen.has(option)) throw requestError(`${option} may be provided only once`);
    if (value === undefined || value === '' || value.startsWith('-')) throw requestError(`${option} requires a value`);
    seen.add(option);
    if (option === '--collection') collection = bounded(value, 'collection');
    else if (option === '--start') start = indexValue(value, option);
    else end = indexValue(value, option);
  };
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal) {
      const name = token === '-c' ? '--collection' : token;
      if (['--collection', '--start', '--end'].includes(name)) {
        optionValue(name, args[++index]); continue;
      }
      const inline = token.match(/^(--collection|--start|--end)=(.*)$/s);
      if (inline) { optionValue(inline[1], inline[2]); continue; }
      if (token.startsWith('-')) throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }
  if (!bind && collection !== null) throw requestError('--collection is accepted only for bind');
  const expected = bind ? 3 : 2;
  if (positionals.length < expected) throw requestError(bind ? 'nodeId, field, and variable are required' : 'nodeId and field are required');
  if (positionals.length > expected) throw requestError(`unexpected argument ${positionals[expected]}`);
  if (typeof start === 'number' && typeof end === 'number' && end < start) {
    throw requestError('--end must be greater than or equal to --start');
  }
  return {
    action: bind ? 'bind' : 'unbind', node: nodeValue(positionals[0]), field: fieldValue(positionals[1]),
    variable: bind ? bounded(positionals[2], 'variable') : null, collection, start, end,
  };
}

export function parseFontVariableBindingRequest(args) {
  const input = parsedRequest(args);
  return { action: input.action, nodeId: input.node.nodeId, field: input.field, variable: input.variable,
    collection: input.collection, start: input.start, end: input.end };
}
export function fontVariableBindingFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).node.fileKey; }
export function acceptsFontVariableBindingArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }

function typedIndex(value, option) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw requestError(`${option} must be a non-negative safe integer`);
  return value;
}
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Font binding request must be an object.');
  if (!['bind', 'unbind'].includes(request.action)) throw requestError('action must be bind or unbind');
  const start = typedIndex(request.start, '--start'); const end = typedIndex(request.end, '--end');
  if (start !== null && end !== null && end < start) throw requestError('--end must be greater than or equal to --start');
  const collection = request.collection == null ? null : bounded(request.collection, 'collection');
  if (request.action === 'unbind' && collection !== null) throw requestError('--collection is accepted only for bind');
  return { action: request.action, node: nodeValue(request.nodeId), field: fieldValue(request.field),
    variable: request.action === 'bind' ? bounded(request.variable, 'variable') : null,
    collection, start, end };
}
function argvFrom(input, node) {
  return ['font', input.action,
    ...(input.collection === null ? [] : ['--collection', input.collection]),
    ...(input.start === null ? [] : ['--start', String(input.start)]),
    ...(input.end === null ? [] : ['--end', String(input.end)]),
    '--', node, input.field, ...(input.variable === null ? [] : [input.variable])];
}
export function fontVariableBindingArgvFromRequest(request) { const input = typedRequest(request); return argvFrom(input, input.node.nodeId); }
export function fontVariableBindingPlanningArgvFromRequest(request) { const input = typedRequest(request); return argvFrom(input, input.node.planningValue); }
