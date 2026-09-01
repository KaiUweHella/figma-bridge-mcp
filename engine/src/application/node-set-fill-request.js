import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_NODE_SET_FILL_QUERY_CODE_UNITS = 512;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
function requestError(message) { return new Error(`Invalid node set-fill command: ${message}.`); }
function nodeValue(value) { try { return parseNodeReference(value); } catch (error) { if (!(error instanceof NodeReferenceError)) throw error; throw requestError('nodeId must be a bounded Figma node id or URL containing node-id'); } }
function colorValue(value) {
  if (typeof value !== 'string' || !value.length) throw requestError('color is required');
  if (value.length > MAX_NODE_SET_FILL_QUERY_CODE_UNITS || UNSAFE.test(value)) throw requestError('color is invalid or too long');
  const trimmed = value.trim();
  if (/^#?[0-9a-f]{6}$/i.test(trimmed)) return { kind: 'literal', value: `#${trimmed.replace(/^#/, '').toUpperCase()}`, query: null };
  if (trimmed.startsWith('var:') && trimmed.length > 4) return { kind: 'variable', value: trimmed, query: trimmed.slice(4) };
  throw requestError('color must be #RRGGBB or var:<name>');
}
function parsed(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'set-fill') throw new Error('Expected a node set-fill command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Node Set Fill arguments must be strings.');
  let values = args.slice(2); if (values[0] === '--') values = values.slice(1);
  if (values.length < 2) throw requestError('nodeId and color are required');
  if (values.length > 2) throw requestError(`unexpected argument ${values[2]}`);
  if (values.some((value) => value.startsWith('-'))) throw requestError(`unknown option ${values.find((value) => value.startsWith('-'))}`);
  return { node: nodeValue(values[0]), color: colorValue(values[1]) };
}
export function parseNodeSetFillRequest(args) { const input = parsed(args); return Object.freeze({ nodeId: input.node.nodeId, color: input.color.value, kind: input.color.kind, variable: input.color.query }); }
export function acceptsNodeSetFillArgv(args) { try { parsed(args); return true; } catch { return false; } }
export function nodeSetFillFigmaUrlFileKeyFromArgv(args) { return parsed(args).node.fileKey; }
function typed(request) { if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Node Set Fill request must be an object.'); return { node: nodeValue(request.nodeId), color: colorValue(request.color) }; }
function argv(input, node) { return ['node', 'set-fill', node, input.color.value]; }
export function nodeSetFillArgvFromRequest(request) { const input = typed(request); const args = argv(input, input.node.nodeId); parseNodeSetFillRequest(args); return args; }
export function nodeSetFillPlanningArgvFromRequest(request) { const input = typed(request); const args = argv(input, input.node.planningValue); parseNodeSetFillRequest(args); return args; }
