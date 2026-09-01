import { finiteNodeCoordinate } from './node-coordinate.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_CREATE_LINE_COLOR_CODE_UNITS = 512;

function requestError(message) { return new Error(`Invalid create line command: ${message}.`); }
function numberValue(value, field, { minimum = -Infinity } = {}) {
  let parsed;
  try { parsed = finiteNodeCoordinate(value, field); } catch (error) { throw requestError(error.message); }
  if (parsed < minimum) throw requestError(`${field} must be at least ${minimum}`);
  return parsed;
}
function indexValue(value) {
  const parsed = numberValue(value, 'index', { minimum: 0 });
  if (!Number.isSafeInteger(parsed)) throw requestError('index must be a non-negative safe integer');
  return parsed;
}
function parentValue(value) {
  try { return parseNodeReference(value); } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('parent must be a bounded Figma node id or URL containing node-id');
  }
}
function colorValue(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_CREATE_LINE_COLOR_CODE_UNITS) {
    throw requestError('color must be a bounded hex color or var:<name>');
  }
  const trimmed = value.trim();
  if (/^#?[0-9a-f]{3}$/i.test(trimmed)) {
    const short = trimmed.replace(/^#/, '').toUpperCase();
    return { kind: 'literal', value: `#${[...short].map((part) => part + part).join('')}`, variable: null };
  }
  if (/^#?[0-9a-f]{6}$/i.test(trimmed)) {
    return { kind: 'literal', value: `#${trimmed.replace(/^#/, '').toUpperCase()}`, variable: null };
  }
  if (trimmed.startsWith('var:') && trimmed.length > 4) {
    const variable = trimmed.slice(4);
    if ([...variable].some((character) => {
      const code = character.codePointAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
        || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    })) throw requestError('color Variable name contains unsafe control characters');
    return { kind: 'variable', value: trimmed, variable };
  }
  throw requestError('color must be a hex color or var:<name>');
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
  if (!Array.isArray(args) || args[0] !== 'create' || args[1] !== 'line') throw new Error('Expected a create line command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Create Line arguments must be strings.');
  const input = { x1: null, y1: 0, x2: null, y2: 0, length: 100, color: colorValue('#000000'), weight: 1, spacing: 100, parent: null, index: null };
  const definitions = [
    { key: 'x1', aliases: ['--x1'], signed: true, parse: (v) => numberValue(v, 'x1') },
    { key: 'y1', aliases: ['--y1'], signed: true, parse: (v) => numberValue(v, 'y1') },
    { key: 'x2', aliases: ['--x2'], signed: true, parse: (v) => numberValue(v, 'x2') },
    { key: 'y2', aliases: ['--y2'], signed: true, parse: (v) => numberValue(v, 'y2') },
    { key: 'length', aliases: ['-l', '--length'], signed: true, parse: (v) => numberValue(v, 'length', { minimum: 0.01 }) },
    { key: 'color', aliases: ['-c', '--color'], parse: colorValue },
    { key: 'weight', aliases: ['-w', '--weight'], signed: true, parse: (v) => numberValue(v, 'weight', { minimum: 0 }) },
    { key: 'spacing', aliases: ['--spacing'], signed: true, parse: (v) => numberValue(v, 'spacing', { minimum: 0 }) },
    { key: 'parent', aliases: ['--parent'], parse: parentValue },
    { key: 'index', aliases: ['--index'], signed: true, parse: indexValue },
  ];
  const seen = new Set(); const positionals = []; let literal = false;
  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const definition = definitions.find(({ aliases }) => aliases.includes(token) || inlineValue(token, aliases) !== null);
      if (!definition) throw requestError(`unknown option ${token}`);
      if (seen.has(definition.key)) throw requestError(`${definition.aliases.at(-1)} may be provided only once`);
      seen.add(definition.key);
      const parsed = optionValue(args, cursor, token, inlineValue(token, definition.aliases), definition.aliases.at(-1), { signed: definition.signed });
      cursor = parsed.cursor; input[definition.key] = definition.parse(parsed.value); continue;
    }
    positionals.push(token);
  }
  if (positionals.length) throw requestError(`unexpected argument ${positionals[0]}`);
  return input;
}
export function parseCreateLineRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({ x1: input.x1, y1: input.y1, x2: input.x2, y2: input.y2, length: input.length, color: input.color.value, colorKind: input.color.kind, variable: input.color.variable, weight: input.weight, spacing: input.spacing, parentId: input.parent?.nodeId || null, index: input.index });
}
export function acceptsCreateLineArgv(args) { try { parseCreateLineRequest(args); return true; } catch { return false; } }
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Create Line request must be an object.');
  return {
    x1: request.x1 === null || request.x1 === undefined ? null : numberValue(request.x1, 'x1'),
    y1: numberValue(request.y1 ?? 0, 'y1'),
    x2: request.x2 === null || request.x2 === undefined ? null : numberValue(request.x2, 'x2'),
    y2: numberValue(request.y2 ?? 0, 'y2'),
    length: numberValue(request.length ?? 100, 'length', { minimum: 0.01 }),
    color: colorValue(request.color ?? '#000000'),
    weight: numberValue(request.weight ?? 1, 'weight', { minimum: 0 }),
    spacing: numberValue(request.spacing ?? 100, 'spacing', { minimum: 0 }),
    parent: request.parentId === null || request.parentId === undefined ? null : parentValue(request.parentId),
    index: request.index === null || request.index === undefined ? null : indexValue(request.index),
  };
}
function argvFromInput(input, { planning = false } = {}) {
  const args = ['create', 'line'];
  if (input.x1 !== null) args.push(`--x1=${input.x1}`); if (input.y1 !== 0) args.push(`--y1=${input.y1}`);
  if (input.x2 !== null) args.push(`--x2=${input.x2}`); if (input.y2 !== 0) args.push(`--y2=${input.y2}`);
  if (input.length !== 100) args.push(`--length=${input.length}`); if (input.color.value !== '#000000') args.push(`--color=${input.color.value}`);
  if (input.weight !== 1) args.push(`--weight=${input.weight}`); if (input.spacing !== 100) args.push(`--spacing=${input.spacing}`);
  if (input.parent) args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId);
  if (input.index !== null) args.push(`--index=${input.index}`); return args;
}
export function createLineArgvFromRequest(request) { const args = argvFromInput(typedRequest(request)); parseCreateLineRequest(args); return args; }
export function createLinePlanningArgvFromRequest(request) { const args = argvFromInput(typedRequest(request), { planning: true }); parseCreateLineRequest(args); return args; }
export function createLineFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).parent?.fileKey || null; }
