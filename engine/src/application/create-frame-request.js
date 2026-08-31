import { finiteNodeCoordinate } from './node-coordinate.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_CREATE_FRAME_NAME_CODE_UNITS = 1_024;
export const MAX_CREATE_FRAME_COLOR_CODE_UNITS = 512;

function requestError(message) {
  return new Error(`Invalid create frame command: ${message}.`);
}

function boundedName(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw requestError('name is required');
  }
  if (value.length > MAX_CREATE_FRAME_NAME_CODE_UNITS) {
    throw requestError(`name must be at most ${MAX_CREATE_FRAME_NAME_CODE_UNITS} code units`);
  }
  return value;
}

function number(value, field, { minimum = -Infinity } = {}) {
  let parsed;
  try { parsed = finiteNodeCoordinate(value, field); }
  catch (error) { throw requestError(error.message); }
  if (parsed < minimum) throw requestError(`${field} must be at least ${minimum}`);
  return parsed;
}

function indexValue(value) {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw requestError('index must be a non-negative safe integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw requestError('index must be a non-negative safe integer');
  }
  return parsed;
}

function parentValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('parent must be a bounded Figma node id or URL containing node-id');
  }
}

function colorValue(value) {
  if (typeof value !== 'string' || value.length === 0
    || value.length > MAX_CREATE_FRAME_COLOR_CODE_UNITS) {
    throw requestError('fill must be a bounded hex color or var:<name>');
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
    })) {
      throw requestError('fill Variable name contains unsafe control characters');
    }
    return { kind: 'variable', value: trimmed, variable };
  }
  throw requestError('fill must be a hex color or var:<name>');
}

function optionValue(args, cursor, token, inline, label, { signed = false } = {}) {
  if (inline !== null) {
    if (inline.length === 0) throw requestError(`${label} requires a value`);
    return { value: inline, cursor };
  }
  const value = args[cursor + 1];
  if (value === undefined || value === '--' || (!signed && value.startsWith('-'))) {
    throw requestError(`${token} requires a value`);
  }
  return { value, cursor: cursor + 1 };
}

function inlineValue(token, aliases) {
  for (const alias of aliases) {
    if (alias.startsWith('--') && token.startsWith(`${alias}=`)) {
      return token.slice(alias.length + 1);
    }
    if (/^-[^-]$/.test(alias) && token.startsWith(`${alias}=`)) {
      return token.slice(alias.length + 1);
    }
    if (/^-[^-]$/.test(alias) && token.startsWith(alias) && token.length > alias.length) {
      return token.slice(alias.length);
    }
  }
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'create' || args[1] !== 'frame') {
    throw new Error('Expected a create frame command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Create Frame arguments must be strings.');
  }
  const input = {
    width: 100, height: 100, x: null, y: 0, fill: null, radius: null,
    smart: false, gap: 100, parent: null, index: null,
  };
  const seen = new Set();
  const positionals = [];
  let literal = false;
  const definitions = [
    { key: 'width', aliases: ['-w', '--width'], signed: true, parse: (v) => number(v, 'width', { minimum: 0.01 }) },
    { key: 'height', aliases: ['-h', '--height'], signed: true, parse: (v) => number(v, 'height', { minimum: 0.01 }) },
    { key: 'x', aliases: ['-x', '--x'], signed: true, parse: (v) => number(v, 'x') },
    { key: 'y', aliases: ['-y', '--y'], signed: true, parse: (v) => number(v, 'y') },
    { key: 'fill', aliases: ['--fill'], parse: colorValue },
    { key: 'radius', aliases: ['--radius'], signed: true, parse: (v) => number(v, 'radius', { minimum: 0 }) },
    { key: 'gap', aliases: ['-g', '--gap'], signed: true, parse: (v) => number(v, 'gap', { minimum: 0 }) },
    { key: 'parent', aliases: ['--parent'], parse: parentValue },
    { key: 'index', aliases: ['--index'], signed: true, parse: indexValue },
  ];

  for (let cursor = 2; cursor < args.length; cursor++) {
    const token = args[cursor];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--smart') {
      if (seen.has('smart')) throw requestError('--smart may be provided only once');
      seen.add('smart'); input.smart = true; continue;
    }
    if (!literal && token.startsWith('-')) {
      const definition = definitions.find(({ aliases }) => aliases.includes(token)
        || inlineValue(token, aliases) !== null);
      if (!definition) throw requestError(`unknown option ${token}`);
      if (seen.has(definition.key)) {
        throw requestError(`${definition.aliases.at(-1)} may be provided only once`);
      }
      seen.add(definition.key);
      const inline = inlineValue(token, definition.aliases);
      const parsed = optionValue(args, cursor, token, inline,
        definition.aliases.at(-1), { signed: definition.signed });
      cursor = parsed.cursor;
      input[definition.key] = definition.parse(parsed.value);
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('name is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  input.name = boundedName(positionals[0]);
  return input;
}

export function parseCreateFrameRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    name: input.name,
    width: input.width,
    height: input.height,
    x: input.x,
    y: input.y,
    fill: input.fill?.value || null,
    fillKind: input.fill?.kind || null,
    variable: input.fill?.variable || null,
    radius: input.radius,
    smart: input.smart,
    gap: input.gap,
    parentId: input.parent?.nodeId || null,
    index: input.index,
  });
}

export function acceptsCreateFrameArgv(args) {
  try { parseCreateFrameRequest(args); return true; }
  catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Create Frame request must be an object.');
  }
  return {
    name: boundedName(request.name),
    width: number(request.width ?? 100, 'width', { minimum: 0.01 }),
    height: number(request.height ?? 100, 'height', { minimum: 0.01 }),
    x: request.x === null || request.x === undefined ? null : number(request.x, 'x'),
    y: number(request.y ?? 0, 'y'),
    fill: request.fill === null || request.fill === undefined ? null : colorValue(request.fill),
    radius: request.radius === null || request.radius === undefined
      ? null : number(request.radius, 'radius', { minimum: 0 }),
    smart: request.smart === true,
    gap: number(request.gap ?? 100, 'gap', { minimum: 0 }),
    parent: request.parentId === null || request.parentId === undefined
      ? null : parentValue(request.parentId),
    index: request.index === null || request.index === undefined ? null : indexValue(request.index),
  };
}

function argvFromInput(input, { planning = false } = {}) {
  const args = ['create', 'frame', input.name,
    `--width=${input.width}`, `--height=${input.height}`];
  if (input.x !== null) args.push(`--x=${input.x}`);
  args.push(`--y=${input.y}`);
  if (input.fill) args.push(`--fill=${input.fill.value}`);
  if (input.radius !== null) args.push(`--radius=${input.radius}`);
  if (input.smart) args.push('--smart');
  if (input.gap !== 100) args.push(`--gap=${input.gap}`);
  if (input.parent) {
    args.push('--parent', planning ? input.parent.planningValue : input.parent.nodeId);
  }
  if (input.index !== null) args.push(`--index=${input.index}`);
  return args;
}

export function createFrameArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseCreateFrameRequest(args);
  return args;
}

export function createFramePlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseCreateFrameRequest(args);
  return args;
}

export function createFrameFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).parent?.fileKey || null;
}
