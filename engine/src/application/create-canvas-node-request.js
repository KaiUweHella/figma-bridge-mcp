import { finiteNodeCoordinate } from './node-coordinate.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const CREATE_CANVAS_NODE_KINDS = Object.freeze(['vector', 'slice']);
export const MAX_CREATE_CANVAS_NODE_NAME_CODE_UNITS = 1_024;
export const MAX_CREATE_CANVAS_NODE_NETWORK_CODE_UNITS = 262_144;
export const MAX_CREATE_CANVAS_NODE_NETWORK_VALUES = 100_000;
const DEFAULT_NAMES = Object.freeze({ vector: 'Vector', slice: 'Slice' });

function requestError(message) { return new Error(`Invalid create canvas node command: ${message}.`); }
function kindValue(value) { if (!CREATE_CANVAS_NODE_KINDS.includes(value)) throw requestError('kind must be vector or slice'); return value; }
function nameValue(value, kind) {
  if (value === null || value === undefined) return DEFAULT_NAMES[kind];
  if (typeof value !== 'string' || value.length > MAX_CREATE_CANVAS_NODE_NAME_CODE_UNITS) throw requestError(`name must be a string of at most ${MAX_CREATE_CANVAS_NODE_NAME_CODE_UNITS} code units`);
  return value;
}
function numberValue(value, field, { minimum = -Infinity } = {}) {
  let parsed; try { parsed = finiteNodeCoordinate(value, field); } catch (error) { throw requestError(error.message); }
  if (parsed < minimum) throw requestError(`${field} must be at least ${minimum}`); return parsed;
}
function indexValue(value) { const parsed = numberValue(value, 'index', { minimum: 0 }); if (!Number.isSafeInteger(parsed)) throw requestError('index must be a non-negative safe integer'); return parsed; }
function parentValue(value) { try { return parseNodeReference(value); } catch (error) { if (!(error instanceof NodeReferenceError)) throw error; throw requestError('parent must be a bounded Figma node id or URL containing node-id'); } }
function networkValue(value) {
  let parsed;
  if (typeof value === 'string') {
    if (!value.length || value.length > MAX_CREATE_CANVAS_NODE_NETWORK_CODE_UNITS) throw requestError('network must be bounded JSON');
    try { parsed = JSON.parse(value); } catch (error) { throw requestError(`network must be valid JSON: ${error.message}`); }
  } else {
    try { parsed = JSON.parse(JSON.stringify(value)); } catch { throw requestError('network must be JSON-compatible'); }
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
    || !Array.isArray(parsed.vertices) || !Array.isArray(parsed.segments)) {
    throw requestError('network must contain vertices and segments arrays');
  }
  const stack = [{ value: parsed, depth: 0 }]; let count = 0;
  while (stack.length) {
    const { value: item, depth } = stack.pop(); count += 1;
    if (count > MAX_CREATE_CANVAS_NODE_NETWORK_VALUES || depth > 32) throw requestError('network exceeds its structure limit');
    if (typeof item === 'number' && !Number.isFinite(item)) throw requestError('network numbers must be finite');
    if (item && typeof item === 'object') {
      for (const child of Array.isArray(item) ? item : Object.values(item)) stack.push({ value: child, depth: depth + 1 });
    } else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw requestError('network contains an unsupported value');
  }
  const serialized = JSON.stringify(parsed);
  if (serialized.length > MAX_CREATE_CANVAS_NODE_NETWORK_CODE_UNITS) throw requestError('network exceeds its serialized limit');
  return parsed;
}
function inlineValue(token, aliases) {
  for (const alias of aliases) {
    if (alias.startsWith('--') && token.startsWith(`${alias}=`)) return token.slice(alias.length + 1);
    if (/^-[^-]$/.test(alias) && token.startsWith(`${alias}=`)) return token.slice(alias.length + 1);
    if (/^-[^-]$/.test(alias) && token.startsWith(alias) && token.length > alias.length) return token.slice(alias.length);
  }
  return null;
}
function optionValue(args, cursor, token, inline, label, { signed = false } = {}) {
  if (inline !== null) { if (!inline.length) throw requestError(`${label} requires a value`); return { value: inline, cursor }; }
  const value = args[cursor + 1];
  if (value === undefined || value === '--' || (!signed && value.startsWith('-'))) throw requestError(`${token} requires a value`);
  return { value, cursor: cursor + 1 };
}
function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'create' || typeof args[1] !== 'string') throw new Error('Expected a create canvas node command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Create Canvas Node arguments must be strings.');
  const kind = kindValue(args[1]);
  const input = { name: DEFAULT_NAMES[kind], width: null, height: null, x: null, y: 0, network: null, parent: null, index: null };
  const definitions = [
    { key: 'width', aliases: ['-w', '--width'], signed: true, parse: (v) => numberValue(v, 'width', { minimum: 0.01 }) },
    { key: 'height', aliases: ['-h', '--height'], signed: true, parse: (v) => numberValue(v, 'height', { minimum: 0.01 }) },
    { key: 'x', aliases: ['-x', '--x'], signed: true, parse: (v) => numberValue(v, 'x') },
    { key: 'y', aliases: ['-y', '--y'], signed: true, parse: (v) => numberValue(v, 'y') },
    { key: 'network', aliases: ['--network'], parse: networkValue },
    { key: 'parent', aliases: ['--parent'], parse: parentValue },
    { key: 'index', aliases: ['--index'], signed: true, parse: indexValue },
  ];
  const seen = new Set(); const positionals = []; let literal = false;
  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor]; if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const definition = definitions.find(({ aliases }) => aliases.includes(token) || inlineValue(token, aliases) !== null);
      if (!definition) throw requestError(`unknown option ${token}`);
      if (seen.has(definition.key)) throw requestError(`${definition.aliases.at(-1)} may be provided only once`);
      seen.add(definition.key); const parsed = optionValue(args, cursor, token, inlineValue(token, definition.aliases), definition.aliases.at(-1), { signed: definition.signed });
      cursor = parsed.cursor; input[definition.key] = definition.parse(parsed.value); continue;
    }
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  input.name = nameValue(positionals[0], kind);
  if (kind === 'vector' && (input.width !== null || input.height !== null)) throw requestError('width and height require slice');
  if (kind === 'slice') {
    if (input.network !== null) throw requestError('network requires vector');
    input.width ??= 100; input.height ??= 100;
  }
  return { kind, ...input };
}
export function parseCreateCanvasNodeRequest(args) { const input = parsedRequest(args); return Object.freeze({ kind: input.kind, name: input.name, width: input.width, height: input.height, x: input.x, y: input.y, network: input.network, parentId: input.parent?.nodeId || null, index: input.index }); }
export function acceptsCreateCanvasNodeArgv(args) { try { parseCreateCanvasNodeRequest(args); return true; } catch { return false; } }
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Create Canvas Node request must be an object.');
  const kind = kindValue(request.kind); let width = null; let height = null; let network = null;
  if (kind === 'slice') { width = numberValue(request.width ?? 100, 'width', { minimum: 0.01 }); height = numberValue(request.height ?? 100, 'height', { minimum: 0.01 }); if (request.network !== null && request.network !== undefined) throw requestError('network requires vector'); }
  else { if (request.width !== null && request.width !== undefined || request.height !== null && request.height !== undefined) throw requestError('width and height require slice'); network = request.network === null || request.network === undefined ? null : networkValue(request.network); }
  return { kind, name: nameValue(request.name, kind), width, height, x: request.x === null || request.x === undefined ? null : numberValue(request.x, 'x'), y: numberValue(request.y ?? 0, 'y'), network, parent: request.parentId === null || request.parentId === undefined ? null : parentValue(request.parentId), index: request.index === null || request.index === undefined ? null : indexValue(request.index) };
}
function argvFromInput(input, { planning = false } = {}) {
  const args = ['create', input.kind]; if (input.name !== DEFAULT_NAMES[input.kind]) args.push(input.name);
  if (input.kind === 'slice') { if (input.width !== 100) args.push(`--width=${input.width}`); if (input.height !== 100) args.push(`--height=${input.height}`); }
  if (input.x !== null) args.push(`--x=${input.x}`); if (input.y !== 0) args.push(`--y=${input.y}`);
  if (input.network !== null) args.push(`--network=${JSON.stringify(input.network)}`);
  if (input.parent) args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId);
  if (input.index !== null) args.push(`--index=${input.index}`); return args;
}
export function createCanvasNodeArgvFromRequest(request) { const args = argvFromInput(typedRequest(request)); parseCreateCanvasNodeRequest(args); return args; }
export function createCanvasNodePlanningArgvFromRequest(request) { const args = argvFromInput(typedRequest(request), { planning: true }); parseCreateCanvasNodeRequest(args); return args; }
export function createCanvasNodeFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).parent?.fileKey || null; }
