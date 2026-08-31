// Closed request Interface for `pin <edge>`.

import { GENERIC_NAME_PATTERNS } from '../lib/eval-snippets.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const PIN_EDGES = Object.freeze([
  'left', 'right', 'top', 'bottom',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'center-x', 'center-y', 'stretch-x', 'stretch-y', 'scale-x', 'scale-y',
]);
export const MAX_PIN_TARGETS = 512;
export const MAX_PIN_QUERY_CODE_UNITS = 512;
export const MAX_PIN_METRIC = 1_000_000;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) { return new Error(`Invalid pin command: ${message}.`); }
function finite(value, label) {
  if (typeof value === 'string' && !value.trim()) throw requestError(`${label} must be a finite number`);
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > MAX_PIN_METRIC) {
    throw requestError(`${label} must be a finite number between -${MAX_PIN_METRIC} and ${MAX_PIN_METRIC}`);
  }
  return Object.is(number, -0) ? 0 : number;
}
function inset(value, label) {
  if (typeof value === 'number') return String(finite(value, label));
  if (typeof value !== 'string' || !value.trim()) throw requestError(`${label} requires a value`);
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%)?$/);
  if (!match) throw requestError(`${label} must be a finite pixel number or percentage`);
  const number = finite(match[1], label);
  return `${number}${match[2] || ''}`;
}
function query(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('--query requires a non-empty value');
  const normalized = value.trim();
  if (normalized.length > MAX_PIN_QUERY_CODE_UNITS || UNSAFE_TEXT.test(normalized)) {
    throw requestError(`--query must be safe text of at most ${MAX_PIN_QUERY_CODE_UNITS} code units`);
  }
  if (GENERIC_NAME_PATTERNS.has(normalized.toLowerCase())) {
    throw requestError(`--query ${JSON.stringify(normalized)} matches a generic Figma node name; use --node with exact ids`);
  }
  return normalized;
}
function references(value) {
  if (typeof value !== 'string' || !value.trim()) throw requestError('--node requires one or more node ids');
  const raw = value.split(/[\s,]+/).filter(Boolean);
  if (!raw.length || raw.length > MAX_PIN_TARGETS) {
    throw requestError(`--node accepts between 1 and ${MAX_PIN_TARGETS} node ids`);
  }
  let parsed;
  try { parsed = raw.map((item) => parseNodeReference(item)); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('--node values must be bounded Figma node ids or URLs containing node-id');
  }
  const ids = parsed.map((item) => item.nodeId);
  if (new Set(ids).size !== ids.length) throw requestError('--node contains a duplicate node id');
  const fileKeys = new Set(parsed.map((item) => item.fileKey).filter(Boolean));
  if (fileKeys.size > 1) throw requestError('--node targets multiple Figma files');
  return parsed;
}
function option(args, index) {
  const token = args[index];
  const names = ['-n', '--node', '-q', '--query', '-o', '--offset', '--offset-x', '--offset-y', '--start', '--end'];
  const name = names.find((candidate) => token === candidate
    || (candidate.startsWith('--') && token.startsWith(`${candidate}=`))
    || (/^-[nqo]$/.test(candidate) && token.startsWith(candidate) && token !== candidate));
  if (!name) return null;
  const inline = token === name ? null
    : token.startsWith(`${name}=`) ? token.slice(name.length + 1) : token.slice(name.length);
  const value = inline === null ? args[index + 1] : inline;
  if (value === undefined || value === '--' || value === '') throw requestError(`${name} requires a value`);
  return { name, value, consumed: inline === null ? 1 : 0 };
}
function parsed(args) {
  if (!Array.isArray(args) || args[0] !== 'pin') throw new Error('Expected a pin command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Pin arguments must be strings.');
  const values = new Map(); const positionals = []; let literal = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const entry = !literal && option(args, index);
    if (entry) {
      const canonical = entry.name === '-n' ? '--node' : entry.name === '-q' ? '--query'
        : entry.name === '-o' ? '--offset' : entry.name;
      if (values.has(canonical)) throw requestError(`${canonical} may be provided only once`);
      values.set(canonical, entry.value); index += entry.consumed; continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError('edge is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  const edge = positionals[0].toLowerCase();
  if (!PIN_EDGES.includes(edge)) throw requestError(`edge must be one of ${PIN_EDGES.join(', ')}`);
  if (values.has('--node') && values.has('--query')) throw requestError('--node and --query are mutually exclusive');
  const offset = values.has('--offset') ? finite(values.get('--offset'), '--offset') : 0;
  const refs = values.has('--node') ? references(values.get('--node')) : null;
  return {
    edge,
    selector: refs ? { kind: 'nodes', nodeIds: refs.map((item) => item.nodeId) }
      : values.has('--query') ? { kind: 'query', query: query(values.get('--query')) }
        : { kind: 'selection' },
    references: refs,
    offsetX: values.has('--offset-x') ? finite(values.get('--offset-x'), '--offset-x') : offset,
    offsetY: values.has('--offset-y') ? finite(values.get('--offset-y'), '--offset-y') : offset,
    start: values.has('--start') ? inset(values.get('--start'), '--start') : null,
    end: values.has('--end') ? inset(values.get('--end'), '--end') : null,
  };
}
function projected(input) {
  return Object.freeze({
    edge: input.edge,
    selector: Object.freeze(input.selector.kind === 'nodes'
      ? { kind: 'nodes', nodeIds: Object.freeze([...input.selector.nodeIds]) }
      : { ...input.selector }),
    offsetX: input.offsetX, offsetY: input.offsetY, start: input.start, end: input.end,
  });
}
export function parsePinRequest(args) { return projected(parsed(args)); }
export function acceptsPinArgv(args) { try { parsed(args); return true; } catch { return false; } }
export function pinFigmaUrlFileKeyFromArgv(args) {
  const refs = parsed(args).references || [];
  return refs.find((item) => item.fileKey)?.fileKey || null;
}
function typed(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => ![
      'edge', 'node', 'query', 'selector', 'offset', 'offsetX', 'offsetY', 'start', 'end',
    ].includes(key))) throw new TypeError('Pin request must be a closed object.');
  if (typeof request.edge !== 'string') throw new TypeError('Pin edge must be a string.');
  if (request.node != null && typeof request.node !== 'string') {
    throw new TypeError('Pin node must be a string.');
  }
  if (request.query != null && typeof request.query !== 'string') {
    throw new TypeError('Pin query must be a string.');
  }
  for (const field of ['offset', 'offsetX', 'offsetY', 'start', 'end']) {
    if (request[field] != null && !['number', 'string'].includes(typeof request[field])) {
      throw new TypeError(`Pin ${field} must be a number or string.`);
    }
  }
  let node = request.node;
  let queryValue = request.query;
  if (request.selector !== undefined) {
    if (request.node != null || request.query != null) {
      throw new TypeError('Pin request cannot combine selector with node or query.');
    }
    if (!request.selector || typeof request.selector !== 'object' || Array.isArray(request.selector)
      || !['selection', 'nodes', 'query'].includes(request.selector.kind)) {
      throw new TypeError('Pin selector must be selection, nodes, or query.');
    }
    if (request.selector.kind === 'nodes') {
      if (Object.keys(request.selector).some((key) => !['kind', 'nodeIds'].includes(key))
        || !Array.isArray(request.selector.nodeIds)
        || request.selector.nodeIds.some((id) => typeof id !== 'string')) {
        throw new TypeError('Pin node selector requires only string nodeIds.');
      }
      node = request.selector.nodeIds.join(',');
    } else if (request.selector.kind === 'query') {
      if (Object.keys(request.selector).some((key) => !['kind', 'query'].includes(key))
        || typeof request.selector.query !== 'string') {
        throw new TypeError('Pin query selector requires only a string query.');
      }
      queryValue = request.selector.query;
    } else if (Object.keys(request.selector).some((key) => key !== 'kind')) {
      throw new TypeError('Pin selection selector accepts no extra fields.');
    }
  }
  return parsed([
    'pin',
    ...(node == null ? [] : [`--node=${node}`]),
    ...(queryValue == null ? [] : [`--query=${queryValue}`]),
    ...(request.offset == null ? [] : [`--offset=${request.offset}`]),
    ...(request.offsetX == null ? [] : [`--offset-x=${request.offsetX}`]),
    ...(request.offsetY == null ? [] : [`--offset-y=${request.offsetY}`]),
    ...(request.start == null ? [] : [`--start=${request.start}`]),
    ...(request.end == null ? [] : [`--end=${request.end}`]),
    '--', request.edge,
  ]);
}
function argv(input, planning) {
  const nodeValue = input.references?.map((item) => planning ? item.planningValue : item.nodeId).join(',');
  return [
    'pin', '--offset-x', String(input.offsetX), '--offset-y', String(input.offsetY),
    ...(input.start === null ? [] : ['--start', input.start]),
    ...(input.end === null ? [] : ['--end', input.end]),
    ...(nodeValue ? ['--node', nodeValue] : []),
    ...(input.selector.kind === 'query' ? ['--query', input.selector.query] : []),
    '--', input.edge,
  ];
}
export function pinArgvFromRequest(request) { const args = argv(typed(request), false); parsePinRequest(args); return args; }
export function pinPlanningArgvFromRequest(request) { const args = argv(typed(request), true); parsePinRequest(args); return args; }
