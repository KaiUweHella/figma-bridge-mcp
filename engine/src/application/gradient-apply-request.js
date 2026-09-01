// Closed request Interface for `gradient apply`.

import { parseGradientPaint } from '../lib/gradient-paint.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

function requestError(message) { return new Error(`Invalid Gradient Apply command: ${message}.`); }
function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}
function fieldValue(value = 'fill') {
  const field = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!['fill', 'stroke'].includes(field)) throw requestError('field must be fill or stroke');
  return field;
}
function weightValue(value) {
  if (value === null || value === undefined) return null;
  const source = typeof value === 'string' ? value.trim() : value;
  const number = Number(source);
  if (source === '' || !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    throw requestError('strokeWeight must be a finite non-negative number');
  }
  return number;
}
function gradientValue(value) {
  try { return { source: String(value), paint: parseGradientPaint(value) }; }
  catch { throw requestError('gradient value is invalid'); }
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
function parsed(args) {
  if (!Array.isArray(args) || args[0] !== 'gradient' || args[1] !== 'apply') {
    throw new Error('Expected a gradient apply command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Gradient Apply arguments must be strings.');
  const positionals = []; const seen = new Set();
  let field = 'fill'; let strokeWeight = null; let json = false; let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const name = ['--field','--stroke-weight','--json'].find((candidate) => token === candidate
        || token.startsWith(`${candidate}=`));
      if (!name) throw requestError(`unknown option ${token}`);
      if (seen.has(name)) throw requestError(`${name} may be provided only once`);
      seen.add(name);
      if (name === '--json') {
        if (token !== name) throw requestError('--json does not accept a value');
        json = true; continue;
      }
      const inline = token.startsWith(`${name}=`) ? token.slice(name.length + 1) : null;
      const parsedValue = optionValue(args, index, name, inline); index = parsedValue.index;
      if (name === '--field') field = fieldValue(parsedValue.value);
      else strokeWeight = weightValue(parsedValue.value);
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError(positionals.length ? 'gradient value is required' : 'nodeId is required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return { node: nodeValue(positionals[0]), gradient: gradientValue(positionals[1]), field, strokeWeight, json };
}
function projected(input) {
  return Object.freeze({
    nodeId: input.node.nodeId, value: input.gradient.source, paint: input.gradient.paint,
    field: input.field, strokeWeight: input.strokeWeight, json: input.json,
  });
}
export function parseGradientApplyRequest(args) { return projected(parsed(args)); }
export function acceptsGradientApplyArgv(args) { try { parsed(args); return true; } catch { return false; } }
export function gradientApplyFigmaUrlFileKeyFromArgv(args) { return parsed(args).node.fileKey; }
function typed(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Gradient Apply request must be an object.');
  return {
    node: nodeValue(request.nodeId), gradient: gradientValue(request.value), field: fieldValue(request.field),
    strokeWeight: weightValue(request.strokeWeight), json: request.json === true,
  };
}
function argv(input, planning) {
  return ['gradient', 'apply', '--field', input.field,
    ...(input.strokeWeight === null ? [] : ['--stroke-weight', String(input.strokeWeight)]),
    ...(input.json ? ['--json'] : []), '--', planning ? input.node.planningValue : input.node.nodeId,
    input.gradient.source];
}
export function gradientApplyArgvFromRequest(request) { const args = argv(typed(request), false); parseGradientApplyRequest(args); return args; }
export function gradientApplyPlanningArgvFromRequest(request) { const args = argv(typed(request), true); parseGradientApplyRequest(args); return args; }
