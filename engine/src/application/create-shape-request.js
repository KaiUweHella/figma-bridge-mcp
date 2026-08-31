import { finiteNodeCoordinate } from './node-coordinate.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const CREATE_SHAPE_KINDS = Object.freeze(['rect', 'ellipse', 'polygon', 'star']);
export const MAX_CREATE_SHAPE_NAME_CODE_UNITS = 1_024;
export const MAX_CREATE_SHAPE_COLOR_CODE_UNITS = 512;
const KIND_ALIASES = Object.freeze({ rectangle: 'rect', circle: 'ellipse' });
const DEFAULT_NAMES = Object.freeze({ rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star' });

function requestError(message) { return new Error(`Invalid create shape command: ${message}.`); }
function kindValue(value) {
  const kind = KIND_ALIASES[value] || value;
  if (!CREATE_SHAPE_KINDS.includes(kind)) throw requestError('kind must be rect, ellipse, polygon, or star');
  return kind;
}
function nameValue(value, kind) {
  if (value === null || value === undefined) return DEFAULT_NAMES[kind];
  if (typeof value !== 'string' || value.length > MAX_CREATE_SHAPE_NAME_CODE_UNITS) {
    throw requestError(`name must be a string of at most ${MAX_CREATE_SHAPE_NAME_CODE_UNITS} code units`);
  }
  return value;
}
function numberValue(value, field, { minimum = -Infinity, maximum = Infinity } = {}) {
  let parsed;
  try { parsed = finiteNodeCoordinate(value, field); }
  catch (error) { throw requestError(error.message); }
  if (parsed < minimum || parsed > maximum) {
    throw requestError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
function integerValue(value, field, { minimum = 0 } = {}) {
  const parsed = numberValue(value, field, { minimum });
  if (!Number.isSafeInteger(parsed)) throw requestError(`${field} must be an integer`);
  return parsed;
}
function parentValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('parent must be a bounded Figma node id or URL containing node-id');
  }
}
function colorValue(value, field) {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_CREATE_SHAPE_COLOR_CODE_UNITS) {
    throw requestError(`${field} must be a bounded hex color or var:<name>`);
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
        || (code >= 0x2028 && code <= 0x202e)
        || (code >= 0x2066 && code <= 0x2069);
    })) throw requestError(`${field} Variable name contains unsafe control characters`);
    return { kind: 'variable', value: trimmed, variable };
  }
  throw requestError(`${field} must be a hex color or var:<name>`);
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
  if (inline !== null) {
    if (!inline.length) throw requestError(`${label} requires a value`);
    return { value: inline, cursor };
  }
  const value = args[cursor + 1];
  if (value === undefined || value === '--' || (!signed && value.startsWith('-'))) {
    throw requestError(`${token} requires a value`);
  }
  return { value, cursor: cursor + 1 };
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'create' || typeof args[1] !== 'string') {
    throw new Error('Expected a create shape command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Create Shape arguments must be strings.');
  const kind = kindValue(args[1]);
  const input = {
    name: DEFAULT_NAMES[kind],
    width: 100, height: null, x: null, y: 0,
    fill: colorValue('#D9D9D9', 'fill'), stroke: null,
    radius: null, opacity: null, points: null, innerRadius: null,
    parent: null, index: null,
  };
  const definitions = [
    { key: 'width', aliases: ['-w', '--width'], signed: true, parse: (v) => numberValue(v, 'width', { minimum: 0.01 }) },
    { key: 'height', aliases: ['-h', '--height'], signed: true, parse: (v) => numberValue(v, 'height', { minimum: 0.01 }) },
    { key: 'x', aliases: ['-x', '--x'], signed: true, parse: (v) => numberValue(v, 'x') },
    { key: 'y', aliases: ['-y', '--y'], signed: true, parse: (v) => numberValue(v, 'y') },
    { key: 'fill', aliases: ['--fill'], parse: (v) => colorValue(v, 'fill') },
    { key: 'stroke', aliases: ['--stroke'], parse: (v) => colorValue(v, 'stroke') },
    { key: 'radius', aliases: ['--radius'], signed: true, parse: (v) => numberValue(v, 'radius', { minimum: 0 }) },
    { key: 'opacity', aliases: ['--opacity'], signed: true, parse: (v) => numberValue(v, 'opacity', { minimum: 0, maximum: 1 }) },
    { key: 'points', aliases: ['--points'], signed: true, parse: (v) => integerValue(v, 'points', { minimum: 3 }) },
    { key: 'innerRadius', aliases: ['--inner-radius'], signed: true, parse: (v) => numberValue(v, 'inner-radius', { minimum: 0, maximum: 1 }) },
    { key: 'parent', aliases: ['--parent'], parse: parentValue },
    { key: 'index', aliases: ['--index'], signed: true, parse: (v) => integerValue(v, 'index') },
  ];
  const seen = new Set(); const positionals = []; let literal = false;
  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const definition = definitions.find(({ aliases }) => aliases.includes(token)
        || inlineValue(token, aliases) !== null);
      if (!definition) throw requestError(`unknown option ${token}`);
      if (seen.has(definition.key)) throw requestError(`${definition.aliases.at(-1)} may be provided only once`);
      seen.add(definition.key);
      const parsed = optionValue(args, cursor, token, inlineValue(token, definition.aliases),
        definition.aliases.at(-1), { signed: definition.signed });
      cursor = parsed.cursor; input[definition.key] = definition.parse(parsed.value);
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  input.name = nameValue(positionals[0], kind);
  if (input.height === null) input.height = kind === 'ellipse' ? input.width : 100;
  if (kind !== 'rect' && (input.radius !== null || input.opacity !== null)) {
    throw requestError('radius and opacity are available only for rect');
  }
  if (kind === 'polygon') input.points ??= 3;
  else if (kind === 'star') { input.points ??= 5; input.innerRadius ??= 0.382; }
  else if (input.points !== null || input.innerRadius !== null) {
    throw requestError('points and inner-radius require polygon or star');
  }
  if (kind === 'polygon' && input.innerRadius !== null) throw requestError('inner-radius requires star');
  return { kind, ...input };
}

export function parseCreateShapeRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    kind: input.kind, name: input.name, width: input.width, height: input.height,
    x: input.x, y: input.y,
    fill: input.fill.value, fillKind: input.fill.kind, fillVariable: input.fill.variable,
    stroke: input.stroke?.value || null, strokeKind: input.stroke?.kind || null,
    strokeVariable: input.stroke?.variable || null,
    radius: input.radius, opacity: input.opacity, points: input.points,
    innerRadius: input.innerRadius, parentId: input.parent?.nodeId || null, index: input.index,
  });
}
export function acceptsCreateShapeArgv(args) { try { parseCreateShapeRequest(args); return true; } catch { return false; } }

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Create Shape request must be an object.');
  const kind = kindValue(request.kind);
  const width = numberValue(request.width ?? 100, 'width', { minimum: 0.01 });
  const height = numberValue(request.height ?? (kind === 'ellipse' ? width : 100), 'height', { minimum: 0.01 });
  const radius = request.radius === null || request.radius === undefined ? null : numberValue(request.radius, 'radius', { minimum: 0 });
  const opacity = request.opacity === null || request.opacity === undefined ? null : numberValue(request.opacity, 'opacity', { minimum: 0, maximum: 1 });
  let points = request.points === null || request.points === undefined ? null : integerValue(request.points, 'points', { minimum: 3 });
  let innerRadius = request.innerRadius === null || request.innerRadius === undefined ? null : numberValue(request.innerRadius, 'inner-radius', { minimum: 0, maximum: 1 });
  if (kind !== 'rect' && (radius !== null || opacity !== null)) throw requestError('radius and opacity are available only for rect');
  if (kind === 'polygon') points ??= 3;
  else if (kind === 'star') { points ??= 5; innerRadius ??= 0.382; }
  else if (points !== null || innerRadius !== null) throw requestError('points and inner-radius require polygon or star');
  if (kind === 'polygon' && innerRadius !== null) throw requestError('inner-radius requires star');
  return {
    kind, name: nameValue(request.name, kind), width, height,
    x: request.x === null || request.x === undefined ? null : numberValue(request.x, 'x'),
    y: numberValue(request.y ?? 0, 'y'),
    fill: colorValue(request.fill ?? '#D9D9D9', 'fill'),
    stroke: request.stroke === null || request.stroke === undefined ? null : colorValue(request.stroke, 'stroke'),
    radius, opacity, points, innerRadius,
    parent: request.parentId === null || request.parentId === undefined ? null : parentValue(request.parentId),
    index: request.index === null || request.index === undefined ? null : integerValue(request.index, 'index'),
  };
}
function argvFromInput(input, { planning = false } = {}) {
  const args = ['create', input.kind];
  if (input.name !== DEFAULT_NAMES[input.kind]) args.push(input.name);
  if (input.width !== 100) args.push(`--width=${input.width}`);
  const defaultHeight = input.kind === 'ellipse' ? input.width : 100;
  if (input.height !== defaultHeight) args.push(`--height=${input.height}`);
  if (input.x !== null) args.push(`--x=${input.x}`);
  if (input.y !== 0) args.push(`--y=${input.y}`);
  if (input.fill.value !== '#D9D9D9') args.push(`--fill=${input.fill.value}`);
  if (input.stroke) args.push(`--stroke=${input.stroke.value}`);
  if (input.radius !== null) args.push(`--radius=${input.radius}`);
  if (input.opacity !== null) args.push(`--opacity=${input.opacity}`);
  const defaultPoints = input.kind === 'polygon' ? 3 : input.kind === 'star' ? 5 : null;
  if (input.points !== null && input.points !== defaultPoints) args.push(`--points=${input.points}`);
  if (input.innerRadius !== null && input.innerRadius !== 0.382) args.push(`--inner-radius=${input.innerRadius}`);
  if (input.parent) args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId);
  if (input.index !== null) args.push(`--index=${input.index}`);
  return args;
}
export function createShapeArgvFromRequest(request) { const args = argvFromInput(typedRequest(request)); parseCreateShapeRequest(args); return args; }
export function createShapePlanningArgvFromRequest(request) { const args = argvFromInput(typedRequest(request), { planning: true }); parseCreateShapeRequest(args); return args; }
export function createShapeFigmaUrlFileKeyFromArgv(args) { return parsedRequest(args).parent?.fileKey || null; }
