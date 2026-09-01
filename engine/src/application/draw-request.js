// Closed request Interface for native Figma Draw reads and writes.

import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const DRAW_ACTIONS = Object.freeze([
  'inspect', 'text-path', 'transform-group', 'brush', 'stroke-profile', 'pattern',
]);
export const DRAW_WRITE_ACTIONS = Object.freeze(DRAW_ACTIONS.filter((action) => action !== 'inspect'));
export const DRAW_WIDTH_PROFILES = Object.freeze([
  'UNIFORM', 'WEDGE', 'TAPER', 'QUARTER_TAPER', 'EYE', 'MIRRORED_TAPER',
]);
export const MAX_DRAW_TEXT_CODE_UNITS = 65_536;
export const MAX_DRAW_JSON_CODE_UNITS = 64_000;
export const MAX_DRAW_JSON_VALUES = 4_096;
export const MAX_DRAW_JSON_DEPTH = 16;
export const MAX_DRAW_JSON_ENTRIES = 256;
export const MAX_DRAW_NODE_COUNT = 256;
const MAX_LABEL_CODE_UNITS = 1_024;
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) { return new Error(`Invalid Draw command: ${message}.`); }
function actionValue(value) {
  if (!DRAW_ACTIONS.includes(value)) throw requestError(`action must be one of: ${DRAW_ACTIONS.join(', ')}`);
  return value;
}
function boundedText(value, label, maximum = MAX_LABEL_CODE_UNITS, { allowEmpty = false, allowControls = false } = {}) {
  if (typeof value !== 'string') throw requestError(`${label} must be a string`);
  if ((!allowEmpty && !value.length) || value.length > maximum) throw requestError(`${label} has an invalid bounded length`);
  if (!allowControls && UNSAFE.test(value)) throw requestError(`${label} contains unsafe control characters`);
  return value;
}
function nodeValue(value, label = 'nodeId') {
  try { return parseNodeReference(value); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError(`${label} must be a bounded Figma node id or URL containing node-id`);
  }
}
function finiteNumber(value, label, { minimum = -Infinity, maximum = Infinity } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw requestError(`${label} must be a finite number between ${minimum} and ${maximum}`);
  return number;
}
function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = finiteNumber(value, label, { minimum, maximum });
  if (!Number.isSafeInteger(number)) throw requestError(`${label} must be an integer`);
  return number;
}
function boundedJson(value, label) {
  let values = 0;
  const seen = new Set();
  const visit = (item, depth) => {
    values += 1;
    if (values > MAX_DRAW_JSON_VALUES) throw requestError(`${label} value limit exceeded`);
    if (depth > MAX_DRAW_JSON_DEPTH) throw requestError(`${label} depth limit exceeded`);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw requestError(`${label} contains a non-finite number`);
      return item;
    }
    if (typeof item === 'string') {
      if (item.length > MAX_DRAW_TEXT_CODE_UNITS || UNSAFE.test(item)) throw requestError(`${label} contains an unsafe or oversized string`);
      return item;
    }
    if (!item || typeof item !== 'object' || seen.has(item)) throw requestError(`${label} must contain acyclic JSON values`);
    seen.add(item);
    let copy;
    if (Array.isArray(item)) {
      if (item.length > MAX_DRAW_JSON_ENTRIES) throw requestError(`${label} array limit exceeded`);
      copy = item.map((child) => visit(child, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw requestError(`${label} must contain plain JSON objects`);
      const keys = Object.keys(item);
      if (Object.getOwnPropertySymbols(item).length || keys.length > MAX_DRAW_JSON_ENTRIES) throw requestError(`${label} object limit exceeded`);
      copy = {};
      for (const key of keys) {
        if (!key.length || key.length > 256 || UNSAFE.test(key)) throw requestError(`${label} contains an unsafe object key`);
        copy[key] = visit(item[key], depth + 1);
      }
    }
    seen.delete(item);
    return copy;
  };
  const copy = visit(value, 0);
  const serialized = JSON.stringify(copy);
  if (serialized.length > MAX_DRAW_JSON_CODE_UNITS) throw requestError(`${label} serialized-size limit exceeded`);
  return copy;
}
function jsonOption(value, label) {
  if (typeof value !== 'string') return boundedJson(value, label);
  try { return boundedJson(JSON.parse(value), label); }
  catch (error) {
    if (String(error?.message).startsWith('Invalid Draw command:')) throw error;
    throw requestError(`${label} must be valid JSON`);
  }
}
function transformModifiersValue(value) {
  const modifiers = jsonOption(value, 'transform modifiers');
  if (!Array.isArray(modifiers) || !modifiers.length) throw requestError('transform modifiers must be a non-empty JSON array');
  for (const modifier of modifiers) {
    if (!modifier || modifier.type !== 'REPEAT' || !['LINEAR', 'RADIAL'].includes(modifier.repeatType)) throw requestError('only REPEAT LINEAR/RADIAL transform modifiers are supported by Figma');
    integer(modifier.count, 'repeat count', { minimum: 1, maximum: 10_000 });
    if (!['RELATIVE', 'PIXELS'].includes(modifier.unitType)) throw requestError('repeat modifiers require unitType RELATIVE or PIXELS');
    finiteNumber(modifier.offset, 'repeat offset');
    if (modifier.repeatType === 'LINEAR' && !['HORIZONTAL', 'VERTICAL'].includes(modifier.axis)) throw requestError('linear repeats require axis HORIZONTAL or VERTICAL');
  }
  return modifiers;
}
function complexStrokeValue(value) {
  const properties = jsonOption(value, 'complex stroke properties');
  if (!properties || Array.isArray(properties) || !['BRUSH', 'DYNAMIC', 'BASIC'].includes(properties.type)) throw requestError('complex stroke type must be BRUSH, DYNAMIC, or BASIC');
  if (properties.type === 'BRUSH' && !['STRETCH', 'SCATTER'].includes(properties.brushType)) throw requestError('brush type must be STRETCH or SCATTER');
  if (properties.type === 'BRUSH' && properties.brushName === 'CUSTOM') throw requestError('the Plugin API cannot set custom brushes');
  return properties;
}
function widthPointsValue(value) {
  const points = jsonOption(value, 'width points');
  if (!Array.isArray(points) || points.some((point) => !point || Array.isArray(point)
    || !Number.isFinite(point.position) || point.position < 0 || point.position > 1
    || !Number.isFinite(point.width) || point.width < 0)) {
    throw requestError('width points must be [{"position":0..1,"width":number>=0}]');
  }
  return points;
}
function nodeListValue(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  if (!raw.length || raw.length > MAX_DRAW_NODE_COUNT) throw requestError(`nodeIds must contain between 1 and ${MAX_DRAW_NODE_COUNT} values`);
  const nodes = raw.map((item) => nodeValue(typeof item === 'string' ? item.trim() : item, 'nodeIds'));
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) throw requestError('nodeIds must be unique');
  return nodes;
}
function targetFileKey(input) {
  const refs = [input.node, input.sourceNode, input.parent, ...(input.nodes || [])].filter(Boolean);
  const keys = [...new Set(refs.map((ref) => ref.fileKey).filter(Boolean))];
  if (keys.length > 1) throw requestError('all Figma node URLs must target the same file');
  return keys[0] || null;
}
function normalizedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Draw request must be an object.');
  const action = actionValue(request.action);
  if (action === 'inspect') return { action, node: nodeValue(request.nodeId) };
  if (action === 'text-path') return {
    action, node: nodeValue(request.nodeId),
    text: boundedText(String(request.text ?? ''), 'text', MAX_DRAW_TEXT_CODE_UNITS, { allowEmpty: true, allowControls: true }),
    segment: integer(request.segment ?? 0, 'segment', { minimum: 0, maximum: 1_000_000 }),
    position: finiteNumber(request.position ?? 0, 'position', { minimum: 0, maximum: 1 }),
    fontFamily: boundedText(String(request.fontFamily ?? 'Inter'), 'fontFamily'),
    fontStyle: boundedText(String(request.fontStyle ?? 'Regular'), 'fontStyle'),
  };
  if (action === 'transform-group') {
    const input = {
      action, nodes: nodeListValue(request.nodeIds),
      parent: request.parentId === null || request.parentId === undefined ? null : nodeValue(request.parentId, 'parentId'),
      index: request.index === null || request.index === undefined ? null : integer(request.index, 'index', { minimum: 0, maximum: 1_000_000 }),
      modifiers: transformModifiersValue(request.modifiers),
    };
    targetFileKey(input);
    return input;
  }
  if (action === 'brush') return { action, node: nodeValue(request.nodeId), properties: complexStrokeValue(request.properties) };
  if (action === 'stroke-profile') {
    const choices = [request.preset !== null && request.preset !== undefined, request.points !== null && request.points !== undefined, request.clear === true];
    if (choices.filter(Boolean).length !== 1) throw requestError('use exactly one of preset, points, or clear');
    let value = null;
    if (request.preset !== null && request.preset !== undefined) {
      const preset = String(request.preset).toUpperCase();
      if (!DRAW_WIDTH_PROFILES.includes(preset)) throw requestError(`preset must be one of: ${DRAW_WIDTH_PROFILES.join(', ')}`);
      value = { widthProfile: preset };
    } else if (request.points !== null && request.points !== undefined) {
      value = { widthProfile: 'CUSTOM', variableWidthPoints: widthPointsValue(request.points) };
    }
    return { action, node: nodeValue(request.nodeId), value, preset: value?.widthProfile === 'CUSTOM' ? null : value?.widthProfile || null, points: value?.variableWidthPoints || null, clear: value === null };
  }
  const field = String(request.field ?? '').toLowerCase();
  if (!['fill', 'stroke'].includes(field)) throw requestError('field must be fill or stroke');
  const tileType = String(request.tileType ?? 'RECTANGULAR').toUpperCase();
  if (!['RECTANGULAR', 'HORIZONTAL_HEXAGONAL', 'VERTICAL_HEXAGONAL'].includes(tileType)) throw requestError('tileType must be rectangular, horizontal_hexagonal, or vertical_hexagonal');
  const alignment = String(request.alignment ?? 'CENTER').toUpperCase();
  if (!['START', 'CENTER', 'END'].includes(alignment)) throw requestError('alignment must be start, center, or end');
  const input = {
    action, node: nodeValue(request.nodeId), sourceNode: nodeValue(request.sourceNodeId, 'sourceNodeId'), field, tileType,
    scalingFactor: finiteNumber(request.scalingFactor ?? 1, 'scalingFactor'),
    spacingX: finiteNumber(request.spacingX ?? 0, 'spacingX'),
    spacingY: finiteNumber(request.spacingY ?? 0, 'spacingY'),
    alignment, replace: request.replace === true,
  };
  targetFileKey(input);
  return input;
}

const OPTION_NAMES = new Set([
  '--text', '--segment', '--position', '--font-family', '--font-style', '--modifiers', '--parent', '--index',
  '--properties', '--preset', '--points', '--clear', '--field', '--tile', '--scale', '--spacing-x', '--spacing-y',
  '--alignment', '--replace',
]);
const FLAG_OPTIONS = new Set(['--clear', '--replace']);
function parsedArgv(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new TypeError('Draw arguments must be strings.');
  if (args[0] !== 'draw' || !DRAW_ACTIONS.includes(args[1])) throw new Error('Expected a Draw command.');
  const action = actionValue(args[1]); const options = new Map(); const positionals = []; let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && token.startsWith('-')) {
      const equals = token.indexOf('='); const name = equals === -1 ? token : token.slice(0, equals);
      if (!OPTION_NAMES.has(name)) throw requestError(`unknown option ${name}`);
      if (options.has(name)) throw requestError(`${name} may be provided only once`);
      if (FLAG_OPTIONS.has(name)) {
        if (equals !== -1) throw requestError(`${name} does not accept a value`);
        options.set(name, true); continue;
      }
      const value = equals === -1 ? args[++index] : token.slice(equals + 1);
      if (value === undefined || value === '--') throw requestError(`${name} requires a value`);
      options.set(name, value); continue;
    }
    positionals.push(token);
  }
  const accepted = {
    inspect: [],
    'text-path': ['--text','--segment','--position','--font-family','--font-style'],
    'transform-group': ['--modifiers','--parent','--index'],
    brush: ['--properties'],
    'stroke-profile': ['--preset','--points','--clear'],
    pattern: ['--field','--tile','--scale','--spacing-x','--spacing-y','--alignment','--replace'],
  }[action];
  for (const name of options.keys()) if (!accepted.includes(name)) throw requestError(`${name} is not valid for ${action}`);
  const arity = action === 'pattern' ? 2 : 1;
  if (positionals.length !== arity) throw requestError(positionals.length < arity ? 'required node argument is missing' : `unexpected argument ${positionals[arity]}`);
  if (action === 'inspect') return normalizedRequest({ action, nodeId: positionals[0] });
  if (action === 'text-path') {
    if (!options.has('--text')) throw requestError('text-path requires --text');
    return normalizedRequest({ action, nodeId: positionals[0], text: options.get('--text'), segment: options.get('--segment'), position: options.get('--position'), fontFamily: options.get('--font-family'), fontStyle: options.get('--font-style') });
  }
  if (action === 'transform-group') {
    if (!options.has('--modifiers')) throw requestError('transform-group requires --modifiers');
    return normalizedRequest({ action, nodeIds: positionals[0], modifiers: options.get('--modifiers'), parentId: options.get('--parent'), index: options.get('--index') });
  }
  if (action === 'brush') {
    if (!options.has('--properties')) throw requestError('brush requires --properties');
    return normalizedRequest({ action, nodeId: positionals[0], properties: options.get('--properties') });
  }
  if (action === 'stroke-profile') return normalizedRequest({ action, nodeId: positionals[0], preset: options.get('--preset'), points: options.get('--points'), clear: options.has('--clear') });
  if (!options.has('--field')) throw requestError('pattern requires --field');
  return normalizedRequest({ action, nodeId: positionals[0], sourceNodeId: positionals[1], field: options.get('--field'), tileType: options.get('--tile'), scalingFactor: options.get('--scale'), spacingX: options.get('--spacing-x'), spacingY: options.get('--spacing-y'), alignment: options.get('--alignment'), replace: options.has('--replace') });
}
function projected(input) {
  if (input.action === 'inspect') return { action: input.action, nodeId: input.node.nodeId };
  if (input.action === 'text-path') return { action: input.action, nodeId: input.node.nodeId, text: input.text, segment: input.segment, position: input.position, fontFamily: input.fontFamily, fontStyle: input.fontStyle };
  if (input.action === 'transform-group') return { action: input.action, nodeIds: input.nodes.map((node) => node.nodeId), parentId: input.parent?.nodeId || null, index: input.index, modifiers: input.modifiers };
  if (input.action === 'brush') return { action: input.action, nodeId: input.node.nodeId, properties: input.properties };
  if (input.action === 'stroke-profile') return { action: input.action, nodeId: input.node.nodeId, value: input.value, preset: input.preset, points: input.points, clear: input.clear };
  return { action: input.action, nodeId: input.node.nodeId, sourceNodeId: input.sourceNode.nodeId, field: input.field, tileType: input.tileType, scalingFactor: input.scalingFactor, spacingX: input.spacingX, spacingY: input.spacingY, alignment: input.alignment, replace: input.replace };
}
function argvFrom(input, planning) {
  const ref = (node) => planning ? node.planningValue : node.nodeId;
  if (input.action === 'inspect') return ['draw', 'inspect', '--', ref(input.node)];
  if (input.action === 'text-path') return ['draw', 'text-path', '--text', input.text, '--segment', String(input.segment), '--position', String(input.position), '--font-family', input.fontFamily, '--font-style', input.fontStyle, '--', ref(input.node)];
  if (input.action === 'transform-group') return ['draw', 'transform-group', '--modifiers', JSON.stringify(input.modifiers), ...(input.parent ? ['--parent', ref(input.parent)] : []), ...(input.index === null ? [] : ['--index', String(input.index)]), '--', input.nodes.map(ref).join(',')];
  if (input.action === 'brush') return ['draw', 'brush', '--properties', JSON.stringify(input.properties), '--', ref(input.node)];
  if (input.action === 'stroke-profile') return ['draw', 'stroke-profile', ...(input.clear ? ['--clear'] : input.preset ? ['--preset', input.preset] : ['--points', JSON.stringify(input.points)]), '--', ref(input.node)];
  return ['draw', 'pattern', '--field', input.field, '--tile', input.tileType, '--scale', String(input.scalingFactor), '--spacing-x', String(input.spacingX), '--spacing-y', String(input.spacingY), '--alignment', input.alignment, ...(input.replace ? ['--replace'] : []), '--', ref(input.node), ref(input.sourceNode)];
}

export function parseDrawRequest(args) { return projected(parsedArgv(args)); }
export function acceptsDrawArgv(args) { try { parsedArgv(args); return true; } catch { return false; } }
export function drawFigmaUrlFileKeyFromArgv(args) { return targetFileKey(parsedArgv(args)); }
export function drawArgvFromRequest(request) { const input = normalizedRequest(request); const args = argvFrom(input, false); parseDrawRequest(args); return args; }
export function drawPlanningArgvFromRequest(request) { const input = normalizedRequest(request); const args = argvFrom(input, true); parseDrawRequest(args); return args; }
