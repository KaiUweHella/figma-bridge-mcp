// Closed request Interface for `grid set|clear` Layout Guide mutations.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_LAYOUT_GUIDE_COUNT = 1_000_000;

function requestError(message) {
  return new Error(`Invalid Layout Guide mutation: ${message}.`);
}

function nodeValue(value) {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function numberValue(value, field, { integer = false, minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw requestError(`${field} must be a number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed))
    || parsed < minimum || parsed > maximum) {
    throw requestError(`${field} must be ${integer ? 'a safe integer' : 'a finite number'} from ${minimum} to ${maximum}`);
  }
  return Object.is(parsed, -0) ? 0 : parsed;
}

function colorValue(value) {
  if (typeof value !== 'string' || !/^#?[0-9a-f]{6}$/i.test(value.trim())) {
    throw requestError('color must be a six-digit hex color');
  }
  return `#${value.trim().replace(/^#/, '').toUpperCase()}`;
}

function alignmentValue(value) {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!['STRETCH', 'MIN', 'CENTER', 'MAX'].includes(normalized)) {
    throw requestError('alignment must be stretch, min, center, or max');
  }
  return normalized;
}

function inlineValue(token, aliases) {
  for (const alias of aliases) {
    if (token.startsWith(`${alias}=`)) return token.slice(alias.length + 1);
    if (/^-[^-]$/.test(alias) && token.startsWith(alias) && token.length > alias.length) {
      return token.slice(alias.length);
    }
  }
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'grid' || !['set', 'clear'].includes(args[1])) {
    throw new Error('Expected a grid set or grid clear command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Layout Guide mutation arguments must be strings.');
  }
  const action = args[1];
  const input = {
    columns: null, rows: null, gutter: 16, margin: 0,
    alignment: 'STRETCH', color: '#FF008B', opacity: 0.1, append: false,
  };
  const definitions = [
    { key: 'columns', aliases: ['-c', '--columns'], parse: (v) => numberValue(v, 'columns', { integer: true, minimum: 1, maximum: MAX_LAYOUT_GUIDE_COUNT }) },
    { key: 'rows', aliases: ['-r', '--rows'], parse: (v) => numberValue(v, 'rows', { integer: true, minimum: 1, maximum: MAX_LAYOUT_GUIDE_COUNT }) },
    { key: 'gutter', aliases: ['-g', '--gutter'], parse: (v) => numberValue(v, 'gutter') },
    { key: 'margin', aliases: ['-m', '--margin'], parse: (v) => numberValue(v, 'margin') },
    { key: 'alignment', aliases: ['-a', '--alignment'], parse: alignmentValue },
    { key: 'color', aliases: ['--color'], parse: colorValue },
    { key: 'opacity', aliases: ['--opacity'], parse: (v) => numberValue(v, 'opacity', { maximum: 1 }) },
  ];
  const seen = new Set();
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token === '--append') {
      if (action !== 'set') throw requestError('--append is only valid for grid set');
      if (seen.has('append')) throw requestError('--append may be provided only once');
      seen.add('append'); input.append = true; continue;
    }
    if (!literal && token.startsWith('-')) {
      if (action !== 'set') throw requestError(`unknown option ${token}`);
      const definition = definitions.find(({ aliases }) => aliases.includes(token)
        || inlineValue(token, aliases) !== null);
      if (!definition) throw requestError(`unknown option ${token}`);
      if (seen.has(definition.key)) {
        throw requestError(`${definition.aliases.at(-1)} may be provided only once`);
      }
      seen.add(definition.key);
      const inline = inlineValue(token, definition.aliases);
      const raw = inline === null ? args[++index] : inline;
      if (raw === undefined || raw === '--') {
        throw requestError(`${definition.aliases.at(-1)} requires a value`);
      }
      input[definition.key] = definition.parse(raw);
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length === 0) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  if (action === 'set' && input.columns === null && input.rows === null) {
    throw requestError('grid set requires --columns or --rows');
  }
  return { action, node: nodeValue(positionals[0]), ...input };
}

export function parseLayoutGuideMutationRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    action: input.action,
    nodeId: input.node.nodeId,
    columns: input.action === 'set' ? input.columns : null,
    rows: input.action === 'set' ? input.rows : null,
    gutter: input.action === 'set' ? input.gutter : null,
    margin: input.action === 'set' ? input.margin : null,
    alignment: input.action === 'set' ? input.alignment : null,
    color: input.action === 'set' ? input.color : null,
    opacity: input.action === 'set' ? input.opacity : null,
    append: input.action === 'set' && input.append,
    warning: input.node.warning || '',
  });
}

export function acceptsLayoutGuideMutationArgv(args) {
  try { parseLayoutGuideMutationRequest(args); return true; }
  catch { return false; }
}

export function layoutGuideMutationFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node.fileKey || null;
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Layout Guide mutation request must be an object.');
  }
  if (!['set', 'clear'].includes(request.action)) {
    throw requestError('action must be set or clear');
  }
  const node = nodeValue(request.nodeId);
  if (request.action === 'clear') return { action: 'clear', node };
  const columns = request.columns === null || request.columns === undefined ? null
    : numberValue(request.columns, 'columns', { integer: true, minimum: 1, maximum: MAX_LAYOUT_GUIDE_COUNT });
  const rows = request.rows === null || request.rows === undefined ? null
    : numberValue(request.rows, 'rows', { integer: true, minimum: 1, maximum: MAX_LAYOUT_GUIDE_COUNT });
  if (columns === null && rows === null) throw requestError('grid set requires columns or rows');
  return {
    action: 'set', node, columns, rows,
    gutter: numberValue(request.gutter ?? 16, 'gutter'),
    margin: numberValue(request.margin ?? 0, 'margin'),
    alignment: alignmentValue(request.alignment ?? 'STRETCH'),
    color: colorValue(request.color ?? '#FF008B'),
    opacity: numberValue(request.opacity ?? 0.1, 'opacity', { maximum: 1 }),
    append: request.append === true,
  };
}

function argvFromInput(input, planning) {
  const args = ['grid', input.action, planning ? input.node.planningValue : input.node.nodeId];
  if (input.action === 'clear') return args;
  if (input.columns !== null) args.push(`--columns=${input.columns}`);
  if (input.rows !== null) args.push(`--rows=${input.rows}`);
  if (input.gutter !== 16) args.push(`--gutter=${input.gutter}`);
  if (input.margin !== 0) args.push(`--margin=${input.margin}`);
  if (input.alignment !== 'STRETCH') args.push(`--alignment=${input.alignment.toLowerCase()}`);
  if (input.color !== '#FF008B') args.push(`--color=${input.color}`);
  if (input.opacity !== 0.1) args.push(`--opacity=${input.opacity}`);
  if (input.append) args.push('--append');
  return args;
}

export function layoutGuideMutationArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), false);
  parseLayoutGuideMutationRequest(args);
  return args;
}

export function layoutGuideMutationPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), true);
  parseLayoutGuideMutationRequest(args);
  return args;
}
