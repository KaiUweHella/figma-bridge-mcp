import { finiteNodeCoordinate } from './node-coordinate.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_CREATE_AUTO_LAYOUT_NAME_CODE_UNITS = 1_024;
export const MAX_CREATE_AUTO_LAYOUT_COLOR_CODE_UNITS = 512;

function requestError(message) { return new Error(`Invalid create auto-layout command: ${message}.`); }
function nameValue(value) {
  if (value === null || value === undefined) return 'Auto Layout';
  if (typeof value !== 'string' || value.length > MAX_CREATE_AUTO_LAYOUT_NAME_CODE_UNITS) throw requestError(`name must be a string of at most ${MAX_CREATE_AUTO_LAYOUT_NAME_CODE_UNITS} code units`);
  return value;
}
function directionValue(value) { if (!['row', 'col'].includes(value)) throw requestError('direction must be row or col'); return value; }
function numberValue(value, field, { minimum = -Infinity } = {}) {
  let parsed; try { parsed = finiteNodeCoordinate(value, field); } catch (error) { throw requestError(error.message); }
  if (parsed < minimum) throw requestError(`${field} must be at least ${minimum}`); return parsed;
}
function indexValue(value) { const parsed = numberValue(value, 'index', { minimum: 0 }); if (!Number.isSafeInteger(parsed)) throw requestError('index must be a non-negative safe integer'); return parsed; }
function parentValue(value) { try { return parseNodeReference(value); } catch (error) { if (!(error instanceof NodeReferenceError)) throw error; throw requestError('parent must be a bounded Figma node id or URL containing node-id'); } }
function colorValue(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_CREATE_AUTO_LAYOUT_COLOR_CODE_UNITS) throw requestError('fill must be a bounded hex color or var:<name>');
  const trimmed = value.trim();
  if (/^#?[0-9a-f]{3}$/i.test(trimmed)) { const short = trimmed.replace(/^#/, '').toUpperCase(); return { kind: 'literal', value: `#${[...short].map((part) => part + part).join('')}`, variable: null }; }
  if (/^#?[0-9a-f]{6}$/i.test(trimmed)) return { kind: 'literal', value: `#${trimmed.replace(/^#/, '').toUpperCase()}`, variable: null };
  if (trimmed.startsWith('var:') && trimmed.length > 4) {
    const variable = trimmed.slice(4);
    if ([...variable].some((character) => { const code = character.codePointAt(0); return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069); })) throw requestError('fill Variable name contains unsafe control characters');
    return { kind: 'variable', value: trimmed, variable };
  }
  throw requestError('fill must be a hex color or var:<name>');
}
function inlineValue(token, aliases) {
  for (const alias of aliases) { if (alias.startsWith('--') && token.startsWith(`${alias}=`)) return token.slice(alias.length + 1); if (/^-[^-]$/.test(alias) && token.startsWith(`${alias}=`)) return token.slice(alias.length + 1); if (/^-[^-]$/.test(alias) && token.startsWith(alias) && token.length > alias.length) return token.slice(alias.length); }
  return null;
}
function optionValue(args, cursor, token, inline, label, { signed = false } = {}) { if (inline !== null) { if (!inline.length) throw requestError(`${label} requires a value`); return { value: inline, cursor }; } const value = args[cursor + 1]; if (value === undefined || value === '--' || (!signed && value.startsWith('-'))) throw requestError(`${token} requires a value`); return { value, cursor: cursor + 1 }; }
function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'create' || !['autolayout', 'al'].includes(args[1])) throw new Error('Expected a create auto-layout command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Create Auto Layout arguments must be strings.');
  const input = { name: 'Auto Layout', direction: 'row', gap: 8, padding: 16, x: null, y: 0, fill: null, radius: null, spacing: 100, parent: null, index: null };
  const definitions = [
    { key: 'direction', aliases: ['-d', '--direction'], parse: directionValue },
    { key: 'gap', aliases: ['-g', '--gap'], signed: true, parse: (v) => numberValue(v, 'gap', { minimum: 0 }) },
    { key: 'padding', aliases: ['-p', '--padding'], signed: true, parse: (v) => numberValue(v, 'padding', { minimum: 0 }) },
    { key: 'x', aliases: ['-x', '--x'], signed: true, parse: (v) => numberValue(v, 'x') },
    { key: 'y', aliases: ['-y', '--y'], signed: true, parse: (v) => numberValue(v, 'y') },
    { key: 'fill', aliases: ['--fill'], parse: colorValue },
    { key: 'radius', aliases: ['--radius'], signed: true, parse: (v) => numberValue(v, 'radius', { minimum: 0 }) },
    { key: 'spacing', aliases: ['--spacing'], signed: true, parse: (v) => numberValue(v, 'spacing', { minimum: 0 }) },
    { key: 'parent', aliases: ['--parent'], parse: parentValue },
    { key: 'index', aliases: ['--index'], signed: true, parse: indexValue },
  ];
  const seen = new Set(); const positionals = []; let literal = false;
  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor]; if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const definition = definitions.find(({ aliases }) => aliases.includes(token) || inlineValue(token, aliases) !== null);
      if (!definition) throw requestError(`unknown option ${token}`); if (seen.has(definition.key)) throw requestError(`${definition.aliases.at(-1)} may be provided only once`);
      seen.add(definition.key); const parsed = optionValue(args, cursor, token, inlineValue(token, definition.aliases), definition.aliases.at(-1), { signed: definition.signed }); cursor = parsed.cursor; input[definition.key] = definition.parse(parsed.value); continue;
    }
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`); input.name = nameValue(positionals[0]); return input;
}
export function parseCreateAutoLayoutRequest(args) { const input = parsedRequest(args); return Object.freeze({ name: input.name, direction: input.direction, layoutMode: input.direction === 'col' ? 'VERTICAL' : 'HORIZONTAL', gap: input.gap, padding: input.padding, x: input.x, y: input.y, fill: input.fill?.value || null, fillKind: input.fill?.kind || null, variable: input.fill?.variable || null, radius: input.radius, spacing: input.spacing, parentId: input.parent?.nodeId || null, index: input.index }); }
export function acceptsCreateAutoLayoutArgv(args) { try { parseCreateAutoLayoutRequest(args); return true; } catch { return false; } }
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Create Auto Layout request must be an object.');
  return { name: nameValue(request.name), direction: directionValue(request.direction ?? 'row'), gap: numberValue(request.gap ?? 8, 'gap', { minimum: 0 }), padding: numberValue(request.padding ?? 16, 'padding', { minimum: 0 }), x: request.x === null || request.x === undefined ? null : numberValue(request.x, 'x'), y: numberValue(request.y ?? 0, 'y'), fill: request.fill === null || request.fill === undefined ? null : colorValue(request.fill), radius: request.radius === null || request.radius === undefined ? null : numberValue(request.radius, 'radius', { minimum: 0 }), spacing: numberValue(request.spacing ?? 100, 'spacing', { minimum: 0 }), parent: request.parentId === null || request.parentId === undefined ? null : parentValue(request.parentId), index: request.index === null || request.index === undefined ? null : indexValue(request.index) };
}
function argvFromInput(input, { planning = false } = {}) { const args = ['create', 'autolayout']; if (input.name !== 'Auto Layout') args.push(input.name); if (input.direction !== 'row') args.push(`--direction=${input.direction}`); if (input.gap !== 8) args.push(`--gap=${input.gap}`); if (input.padding !== 16) args.push(`--padding=${input.padding}`); if (input.x !== null) args.push(`--x=${input.x}`); if (input.y !== 0) args.push(`--y=${input.y}`); if (input.fill) args.push(`--fill=${input.fill.value}`); if (input.radius !== null) args.push(`--radius=${input.radius}`); if (input.spacing !== 100) args.push(`--spacing=${input.spacing}`); if (input.parent) args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId); if (input.index !== null) args.push(`--index=${input.index}`); return args; }
export function createAutoLayoutArgvFromRequest(request) { const args = argvFromInput(typedRequest(request)); parseCreateAutoLayoutRequest(args); return args; }
export function createAutoLayoutPlanningArgvFromRequest(request) { const args = argvFromInput(typedRequest(request), { planning: true }); parseCreateAutoLayoutRequest(args); return args; }
export function createAutoLayoutFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).parent?.fileKey || null; }
