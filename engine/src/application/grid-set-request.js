// Closed request Interface for `layout grid set` configuration writes.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_GRID_SET_TRACKS = 4_096;
const TRACK_TYPES = Object.freeze(['FLEX', 'FIXED', 'HUG']);
const OPTIONS = Object.freeze([
  '--rows', '--columns', '--row-gap', '--column-gap', '--row-sizes', '--column-sizes',
]);

function requestError(message) { return new Error(`Invalid Grid Set command: ${message}.`); }
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}
function positiveInteger(value, label) {
  if (typeof value === 'string' && value.trim() === '') throw requestError(`${label} must be an integer from 1 to ${MAX_GRID_SET_TRACKS}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_GRID_SET_TRACKS) throw requestError(`${label} must be an integer from 1 to ${MAX_GRID_SET_TRACKS}`);
  return number;
}
function gapValue(value, label) {
  if (typeof value === 'string' && value.trim() === '') throw requestError(`${label} must be a non-negative finite number`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw requestError(`${label} must be a non-negative finite number`);
  return number;
}
function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function trackSizesValue(value, label) {
  let values = value;
  if (typeof value === 'string') {
    try { values = JSON.parse(value); }
    catch { throw requestError(`${label} must be a JSON array of Grid track sizes`); }
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_GRID_SET_TRACKS) {
    throw requestError(`${label} must contain 1..${MAX_GRID_SET_TRACKS} Grid track sizes`);
  }
  return values.map((entry) => {
    const hasValue = Object.hasOwn(entry || {}, 'value');
    if (!exactObject(entry, hasValue ? ['type', 'value'] : ['type'])) throw requestError(`${label} track entries accept only type and optional value`);
    const type = typeof entry.type === 'string' ? entry.type.trim().toUpperCase() : '';
    if (!TRACK_TYPES.includes(type)) throw requestError(`${label} track type must be flex, fixed, or hug`);
    if (!hasValue) return Object.freeze({ type });
    const number = Number(entry.value);
    if (!Number.isFinite(number) || number < 0) throw requestError(`${label} track values must be non-negative finite numbers`);
    return Object.freeze({ type, value: number });
  });
}
function optionValue(args, index, name, inline) {
  if (inline !== null) {
    if (!inline.length) throw requestError(`${name} requires a value`);
    return { value: inline, index };
  }
  const value = args[index + 1];
  if (value === undefined || value === '--') throw requestError(`${name} requires a value`);
  return { value, index: index + 1 };
}
function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new TypeError('Grid Set arguments must be strings.');
  if (args[0] !== 'layout' || args[1] !== 'grid' || args[2] !== 'set') throw new Error('Expected a Grid Set command.');
  const options = new Map(); const positionals = []; let literal = false;
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = OPTIONS.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsed = optionValue(args, index, name, inline); options.set(name, parsed.value); index = parsed.index; continue;
    }
    positionals.push(token);
  }
  if (positionals.length !== 1) throw requestError(positionals.length ? `unexpected argument ${positionals[1]}` : 'nodeId is required');
  if (!options.size) throw requestError('provide grid dimensions, gaps, or track sizes');
  const rows = options.has('--rows') ? positiveInteger(options.get('--rows'), '--rows') : undefined;
  const columns = options.has('--columns') ? positiveInteger(options.get('--columns'), '--columns') : undefined;
  const rowSizes = options.has('--row-sizes') ? trackSizesValue(options.get('--row-sizes'), '--row-sizes') : undefined;
  const columnSizes = options.has('--column-sizes') ? trackSizesValue(options.get('--column-sizes'), '--column-sizes') : undefined;
  if (rows !== undefined && rowSizes && rows !== rowSizes.length) throw requestError('--row-sizes length must equal --rows');
  if (columns !== undefined && columnSizes && columns !== columnSizes.length) throw requestError('--column-sizes length must equal --columns');
  return {
    node: nodeValue(positionals[0]), rows, columns,
    rowGap: options.has('--row-gap') ? gapValue(options.get('--row-gap'), '--row-gap') : undefined,
    columnGap: options.has('--column-gap') ? gapValue(options.get('--column-gap'), '--column-gap') : undefined,
    rowSizes, columnSizes,
  };
}
function projected(input) {
  return Object.freeze({
    nodeId: input.node.nodeId,
    ...(input.rows === undefined ? {} : { rows: input.rows }),
    ...(input.columns === undefined ? {} : { columns: input.columns }),
    ...(input.rowGap === undefined ? {} : { rowGap: input.rowGap }),
    ...(input.columnGap === undefined ? {} : { columnGap: input.columnGap }),
    ...(input.rowSizes === undefined ? {} : { rowSizes: Object.freeze([...input.rowSizes]) }),
    ...(input.columnSizes === undefined ? {} : { columnSizes: Object.freeze([...input.columnSizes]) }),
  });
}
export function parseGridSetRequest(args) { return projected(parsedRequest(args)); }
export function acceptsGridSetArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }
export function gridSetFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).node.fileKey || null; }
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Grid Set request must be an object.');
  const input = {
    node: nodeValue(request.nodeId),
    rows: request.rows === undefined ? undefined : positiveInteger(request.rows, 'rows'),
    columns: request.columns === undefined ? undefined : positiveInteger(request.columns, 'columns'),
    rowGap: request.rowGap === undefined ? undefined : gapValue(request.rowGap, 'rowGap'),
    columnGap: request.columnGap === undefined ? undefined : gapValue(request.columnGap, 'columnGap'),
    rowSizes: request.rowSizes === undefined ? undefined : trackSizesValue(request.rowSizes, 'rowSizes'),
    columnSizes: request.columnSizes === undefined ? undefined : trackSizesValue(request.columnSizes, 'columnSizes'),
  };
  if ([input.rows,input.columns,input.rowGap,input.columnGap,input.rowSizes,input.columnSizes].every((value) => value === undefined)) throw requestError('provide grid dimensions, gaps, or track sizes');
  if (input.rows !== undefined && input.rowSizes && input.rows !== input.rowSizes.length) throw requestError('rowSizes length must equal rows');
  if (input.columns !== undefined && input.columnSizes && input.columns !== input.columnSizes.length) throw requestError('columnSizes length must equal columns');
  return input;
}
function argvFrom(input, planning) {
  const args = ['layout', 'grid', 'set'];
  if (input.rows !== undefined) args.push('--rows', String(input.rows));
  if (input.columns !== undefined) args.push('--columns', String(input.columns));
  if (input.rowGap !== undefined) args.push('--row-gap', String(input.rowGap));
  if (input.columnGap !== undefined) args.push('--column-gap', String(input.columnGap));
  if (input.rowSizes) args.push('--row-sizes', JSON.stringify(input.rowSizes));
  if (input.columnSizes) args.push('--column-sizes', JSON.stringify(input.columnSizes));
  args.push('--', planning ? input.node.planningValue : input.node.nodeId);
  return args;
}
export function gridSetArgvFromRequest(request) { const args = argvFrom(typedRequest(request), false); parseGridSetRequest(args); return args; }
export function gridSetPlanningArgvFromRequest(request) { const args = argvFrom(typedRequest(request), true); parseGridSetRequest(args); return args; }
