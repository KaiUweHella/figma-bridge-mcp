// Closed request Interface for `layout grid place` writes.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

const ALIGNMENTS = Object.freeze(['AUTO', 'MIN', 'CENTER', 'MAX']);

function requestError(message) { return new Error(`Invalid Grid Place command: ${message}.`); }
function nodeValue(value, label) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError(`${label} must be a bounded Figma node id or URL containing node-id`);
  }
}
function integer(value, label, minimum) {
  if (typeof value === 'string' && value.trim() === '') throw requestError(`${label} must be an integer >= ${minimum}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw requestError(`${label} must be an integer >= ${minimum}`);
  return number;
}
function alignment(value, label) {
  if (typeof value !== 'string') throw requestError(`${label} requires a value`);
  const normalized = value.trim().toUpperCase();
  if (!ALIGNMENTS.includes(normalized)) throw requestError(`${label} must be auto, min, center, or max`);
  return normalized;
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
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Grid Place arguments must be strings.');
  }
  if (args[0] !== 'layout' || args[1] !== 'grid' || args[2] !== 'place') {
    throw new Error('Expected a Grid Place command.');
  }
  const accepted = ['--row', '--column', '--row-span', '--column-span', '--horizontal-align', '--vertical-align'];
  const positionals = []; const options = new Map(); let literal = false;
  for (let index = 3; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = accepted.find((candidate) => token === candidate || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsed = optionValue(args, index, name, inline);
      options.set(name, parsed.value); index = parsed.index; continue;
    }
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('gridId and childId are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  if (!options.has('--row')) throw requestError('--row is required');
  if (!options.has('--column')) throw requestError('--column is required');
  const grid = nodeValue(positionals[0], 'gridId');
  const child = nodeValue(positionals[1], 'childId');
  const fileKeys = new Set([grid.fileKey, child.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('grid and child target multiple Figma files');
  return {
    grid, child,
    row: integer(options.get('--row'), '--row', 0),
    column: integer(options.get('--column'), '--column', 0),
    rowSpan: options.has('--row-span') ? integer(options.get('--row-span'), '--row-span', 1) : null,
    columnSpan: options.has('--column-span') ? integer(options.get('--column-span'), '--column-span', 1) : null,
    horizontalAlign: options.has('--horizontal-align') ? alignment(options.get('--horizontal-align'), '--horizontal-align') : null,
    verticalAlign: options.has('--vertical-align') ? alignment(options.get('--vertical-align'), '--vertical-align') : null,
  };
}
function projected(input) {
  return Object.freeze({
    gridId: input.grid.nodeId, childId: input.child.nodeId,
    row: input.row, column: input.column, rowSpan: input.rowSpan, columnSpan: input.columnSpan,
    horizontalAlign: input.horizontalAlign, verticalAlign: input.verticalAlign,
  });
}
export function parseGridPlaceRequest(args) { return projected(parsedRequest(args)); }
export function acceptsGridPlaceArgv(args) { try { parsedRequest(args); return true; } catch { return false; } }
export function gridPlaceFigmaUrlFileKeyFromArgv(args) {
  const input = parsedRequest(args); return input.grid.fileKey || input.child.fileKey || null;
}
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Grid Place request must be an object.');
  const grid = nodeValue(request.gridId, 'gridId'); const child = nodeValue(request.childId, 'childId');
  const fileKeys = new Set([grid.fileKey, child.fileKey].filter(Boolean));
  if (fileKeys.size > 1) throw requestError('grid and child target multiple Figma files');
  return {
    grid, child, row: integer(request.row, 'row', 0), column: integer(request.column, 'column', 0),
    rowSpan: request.rowSpan == null ? null : integer(request.rowSpan, 'rowSpan', 1),
    columnSpan: request.columnSpan == null ? null : integer(request.columnSpan, 'columnSpan', 1),
    horizontalAlign: request.horizontalAlign == null ? null : alignment(request.horizontalAlign, 'horizontalAlign'),
    verticalAlign: request.verticalAlign == null ? null : alignment(request.verticalAlign, 'verticalAlign'),
  };
}
function argvFrom(input, planning) {
  return [
    'layout', 'grid', 'place', '--row', String(input.row), '--column', String(input.column),
    ...(input.rowSpan === null ? [] : ['--row-span', String(input.rowSpan)]),
    ...(input.columnSpan === null ? [] : ['--column-span', String(input.columnSpan)]),
    ...(input.horizontalAlign === null ? [] : ['--horizontal-align', input.horizontalAlign.toLowerCase()]),
    ...(input.verticalAlign === null ? [] : ['--vertical-align', input.verticalAlign.toLowerCase()]),
    '--', planning ? input.grid.planningValue : input.grid.nodeId,
    planning ? input.child.planningValue : input.child.nodeId,
  ];
}
export function gridPlaceArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), false); parseGridPlaceRequest(args); return args;
}
export function gridPlacePlanningArgvFromRequest(request) {
  const args = argvFrom(typedRequest(request), true); parseGridPlaceRequest(args); return args;
}
