import { finiteNodeCoordinate } from './node-coordinate.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_CREATE_TEXT_CONTENT_CODE_UNITS = 262_144;
export const MAX_CREATE_TEXT_FONT_FAMILY_CODE_UNITS = 1_024;
export const MAX_CREATE_TEXT_COLOR_CODE_UNITS = 512;
const STYLES = Object.freeze({ regular: 'Regular', medium: 'Medium', semibold: 'Semi Bold', bold: 'Bold' });

function requestError(message) { return new Error(`Invalid create text command: ${message}.`); }
function contentValue(value) { if (typeof value !== 'string') throw requestError('content is required'); if (value.length > MAX_CREATE_TEXT_CONTENT_CODE_UNITS) throw requestError(`content must be at most ${MAX_CREATE_TEXT_CONTENT_CODE_UNITS} code units`); return value; }
function unsafeControl(value) { return [...value].some((character) => { const code = character.codePointAt(0); return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069); }); }
function familyValue(value) { if (typeof value !== 'string' || !value.length || value.length > MAX_CREATE_TEXT_FONT_FAMILY_CODE_UNITS || unsafeControl(value)) throw requestError('font must be a bounded family without unsafe control characters'); return value; }
function weightValue(value) { if (typeof value !== 'string') throw requestError('weight must be regular, medium, semibold, or bold'); const weight = value.toLowerCase(); if (!Object.hasOwn(STYLES, weight)) throw requestError('weight must be regular, medium, semibold, or bold'); return weight; }
function numberValue(value, field, { minimum = -Infinity } = {}) { let parsed; try { parsed = finiteNodeCoordinate(value, field); } catch (error) { throw requestError(error.message); } if (parsed < minimum) throw requestError(`${field} must be at least ${minimum}`); return parsed; }
function indexValue(value) { const parsed = numberValue(value, 'index', { minimum: 0 }); if (!Number.isSafeInteger(parsed)) throw requestError('index must be a non-negative safe integer'); return parsed; }
function parentValue(value) { try { return parseNodeReference(value); } catch (error) { if (!(error instanceof NodeReferenceError)) throw error; throw requestError('parent must be a bounded Figma node id or URL containing node-id'); } }
function colorValue(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_CREATE_TEXT_COLOR_CODE_UNITS) throw requestError('color must be a bounded hex color or var:<name>'); const trimmed = value.trim();
  if (/^#?[0-9a-f]{3}$/i.test(trimmed)) { const short = trimmed.replace(/^#/, '').toUpperCase(); return { kind: 'literal', value: `#${[...short].map((part) => part + part).join('')}`, variable: null }; }
  if (/^#?[0-9a-f]{6}$/i.test(trimmed)) return { kind: 'literal', value: `#${trimmed.replace(/^#/, '').toUpperCase()}`, variable: null };
  if (trimmed.startsWith('var:') && trimmed.length > 4) { const variable = trimmed.slice(4); if (unsafeControl(variable)) throw requestError('color Variable name contains unsafe control characters'); return { kind: 'variable', value: trimmed, variable }; }
  throw requestError('color must be a hex color or var:<name>');
}
function inlineValue(token, aliases) { for (const alias of aliases) { if (alias.startsWith('--') && token.startsWith(`${alias}=`)) return token.slice(alias.length + 1); if (/^-[^-]$/.test(alias) && token.startsWith(`${alias}=`)) return token.slice(alias.length + 1); if (/^-[^-]$/.test(alias) && token.startsWith(alias) && token.length > alias.length) return token.slice(alias.length); } return null; }
function optionValue(args, cursor, token, inline, label, { signed = false } = {}) { if (inline !== null) { if (!inline.length) throw requestError(`${label} requires a value`); return { value: inline, cursor }; } const value = args[cursor + 1]; if (value === undefined || value === '--' || (!signed && value.startsWith('-'))) throw requestError(`${token} requires a value`); return { value, cursor: cursor + 1 }; }
function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'create' || args[1] !== 'text') throw new Error('Expected a create text command.'); if (args.some((value) => typeof value !== 'string')) throw new TypeError('Create Text arguments must be strings.');
  const input = { content: null, x: null, y: 0, size: 16, color: colorValue('#000000'), weight: 'regular', family: 'Inter', width: null, spacing: 100, parent: null, index: null };
  const definitions = [
    { key: 'x', aliases: ['-x', '--x'], signed: true, parse: (v) => numberValue(v, 'x') },
    { key: 'y', aliases: ['-y', '--y'], signed: true, parse: (v) => numberValue(v, 'y') },
    { key: 'size', aliases: ['-s', '--size'], signed: true, parse: (v) => numberValue(v, 'size', { minimum: 0.01 }) },
    { key: 'color', aliases: ['-c', '--color'], parse: colorValue },
    { key: 'weight', aliases: ['-w', '--weight'], parse: weightValue },
    { key: 'family', aliases: ['--font'], parse: familyValue },
    { key: 'width', aliases: ['--width'], signed: true, parse: (v) => numberValue(v, 'width', { minimum: 0.01 }) },
    { key: 'spacing', aliases: ['--spacing'], signed: true, parse: (v) => numberValue(v, 'spacing', { minimum: 0 }) },
    { key: 'parent', aliases: ['--parent'], parse: parentValue },
    { key: 'index', aliases: ['--index'], signed: true, parse: indexValue },
  ];
  const seen = new Set(); const positionals = []; let literal = false;
  for (let cursor = 2; cursor < args.length; cursor++) { const token = args[cursor]; if (!literal && token === '--') { literal = true; continue; } if (!literal && token.startsWith('-')) { const definition = definitions.find(({ aliases }) => aliases.includes(token) || inlineValue(token, aliases) !== null); if (!definition) throw requestError(`unknown option ${token}`); if (seen.has(definition.key)) throw requestError(`${definition.aliases.at(-1)} may be provided only once`); seen.add(definition.key); const parsed = optionValue(args, cursor, token, inlineValue(token, definition.aliases), definition.aliases.at(-1), { signed: definition.signed }); cursor = parsed.cursor; input[definition.key] = definition.parse(parsed.value); continue; } positionals.push(token); }
  if (!positionals.length) throw requestError('content is required'); if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`); input.content = contentValue(positionals[0]); return input;
}
export function parseCreateTextRequest(args) { const input = parsedRequest(args); return Object.freeze({ content: input.content, x: input.x, y: input.y, size: input.size, color: input.color.value, colorKind: input.color.kind, variable: input.color.variable, weight: input.weight, font: Object.freeze({ family: input.family, style: STYLES[input.weight] }), width: input.width, spacing: input.spacing, parentId: input.parent?.nodeId || null, index: input.index }); }
export function acceptsCreateTextArgv(args) { try { parseCreateTextRequest(args); return true; } catch { return false; } }
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Create Text request must be an object.'); const weight = weightValue(request.weight ?? 'regular');
  const family = familyValue(typeof request.font === 'object' && request.font !== null ? request.font.family : request.font ?? 'Inter');
  if (typeof request.font === 'object' && request.font !== null && request.font.style !== STYLES[weight]) throw requestError('font style must match weight');
  return { content: contentValue(request.content), x: request.x === null || request.x === undefined ? null : numberValue(request.x, 'x'), y: numberValue(request.y ?? 0, 'y'), size: numberValue(request.size ?? 16, 'size', { minimum: 0.01 }), color: colorValue(request.color ?? '#000000'), weight, family, width: request.width === null || request.width === undefined ? null : numberValue(request.width, 'width', { minimum: 0.01 }), spacing: numberValue(request.spacing ?? 100, 'spacing', { minimum: 0 }), parent: request.parentId === null || request.parentId === undefined ? null : parentValue(request.parentId), index: request.index === null || request.index === undefined ? null : indexValue(request.index) };
}
function argvFromInput(input, { planning = false } = {}) { const contentNeedsTerminator = input.content.startsWith('-'); const args = ['create', 'text']; if (!contentNeedsTerminator) args.push(input.content); if (input.x !== null) args.push(`--x=${input.x}`); if (input.y !== 0) args.push(`--y=${input.y}`); if (input.size !== 16) args.push(`--size=${input.size}`); if (input.color.value !== '#000000') args.push(`--color=${input.color.value}`); if (input.weight !== 'regular') args.push(`--weight=${input.weight}`); if (input.family !== 'Inter') args.push(`--font=${input.family}`); if (input.width !== null) args.push(`--width=${input.width}`); if (input.spacing !== 100) args.push(`--spacing=${input.spacing}`); if (input.parent) args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId); if (input.index !== null) args.push(`--index=${input.index}`); if (contentNeedsTerminator) args.push('--', input.content); return args; }
export function createTextArgvFromRequest(request) { const args = argvFromInput(typedRequest(request)); parseCreateTextRequest(args); return args; }
export function createTextPlanningArgvFromRequest(request) { const args = argvFromInput(typedRequest(request), { planning: true }); parseCreateTextRequest(args); return args; }
export function createTextFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).parent?.fileKey || null; }
