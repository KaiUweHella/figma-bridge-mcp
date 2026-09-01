import { finiteNodeCoordinate } from './node-coordinate.js';
import { NodeReferenceError, parseNodeReference } from './node-reference.js';

export const MAX_NODE_SET_TEXT_CODE_UNITS = 512;
export const MAX_NODE_SET_EFFECT_JSON_CODE_UNITS = 65_536;
export const MAX_NODE_SET_EFFECT_ENTRIES = 1_000;
export const MAX_NODE_SET_EFFECT_DEPTH = 16;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

export const NODE_SET_ENUMS = Object.freeze({
  blendMode: Object.freeze(['PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']),
  strokeAlign: Object.freeze(['CENTER', 'INSIDE', 'OUTSIDE']),
  strokeCap: Object.freeze(['NONE', 'ROUND', 'SQUARE', 'ARROW_LINES', 'ARROW_EQUILATERAL', 'DIAMOND_FILLED', 'TRIANGLE_FILLED', 'CIRCLE_FILLED']),
  strokeJoin: Object.freeze(['MITER', 'BEVEL', 'ROUND']),
  maskType: Object.freeze(['ALPHA', 'VECTOR', 'LUMINANCE']),
  layoutMode: Object.freeze(['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID']),
  layoutWrap: Object.freeze(['NO_WRAP', 'WRAP']),
  primaryAxisAlign: Object.freeze(['MIN', 'MAX', 'CENTER', 'SPACE_BETWEEN']),
  counterAxisAlign: Object.freeze(['MIN', 'MAX', 'CENTER', 'BASELINE']),
  layoutSizingHorizontal: Object.freeze(['FIXED', 'HUG', 'FILL']),
  layoutSizingVertical: Object.freeze(['FIXED', 'HUG', 'FILL']),
  layoutAlign: Object.freeze(['MIN', 'CENTER', 'MAX', 'STRETCH', 'INHERIT']),
  layoutPositioning: Object.freeze(['AUTO', 'ABSOLUTE']),
  constraintsHorizontal: Object.freeze(['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']),
  constraintsVertical: Object.freeze(['MIN', 'CENTER', 'MAX', 'STRETCH', 'SCALE']),
});

export const NODE_SET_PROPERTIES = Object.freeze({
  fill: 'paint', stroke: 'paint', effects: 'json-array',
  strokeWidth: 'number', strokeTopWidth: 'number', strokeRightWidth: 'number',
  strokeBottomWidth: 'number', strokeLeftWidth: 'number', strokeMiterLimit: 'number',
  strokeAlign: 'enum', strokeCap: 'enum', strokeJoin: 'enum', dashPattern: 'number-list',
  radius: 'number', radii: 'radii', cornerSmoothing: 'number',
  opacity: 'number', blendMode: 'enum', visible: 'boolean', locked: 'boolean',
  isMask: 'boolean', maskType: 'enum', clip: 'boolean', constrainProportions: 'boolean',
  x: 'number', y: 'number', width: 'number', height: 'number', rotation: 'number',
  minWidth: 'nullable-number', maxWidth: 'nullable-number', minHeight: 'nullable-number', maxHeight: 'nullable-number',
  name: 'string',
  constraintsHorizontal: 'enum', constraintsVertical: 'enum',
  layoutMode: 'enum', layoutWrap: 'enum', primaryAxisAlign: 'enum', counterAxisAlign: 'enum',
  layoutSizingHorizontal: 'enum', layoutSizingVertical: 'enum', layoutAlign: 'enum',
  layoutPositioning: 'enum', layoutGrow: 'number', itemSpacing: 'number', counterAxisSpacing: 'nullable-number',
  padding: 'number', paddingTop: 'number', paddingRight: 'number', paddingBottom: 'number', paddingLeft: 'number',
  pointCount: 'number', innerRadius: 'number', sectionContentsHidden: 'boolean',
});

export const NODE_SET_PROPERTY_FLAGS = Object.freeze(Object.fromEntries(
  Object.keys(NODE_SET_PROPERTIES).map((key) => [key, `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`]),
));
const FLAG_PROPERTIES = Object.freeze(Object.fromEntries(
  Object.entries(NODE_SET_PROPERTY_FLAGS).map(([key, flag]) => [flag, key]),
));
const ALIASES = Object.freeze({
  w: 'width', h: 'height', newName: 'name', label: 'name',
  cornerRadius: 'radius', strokeWeight: 'strokeWidth', rotate: 'rotation', clipsContent: 'clip',
});

function requestError(message) { return new Error(`Invalid node set command: ${message}.`); }

function nodeValue(value) {
  try { return parseNodeReference(String(value)); }
  catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError('nodeId must be a bounded Figma node id or URL containing node-id');
  }
}

function boundedText(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length)) throw requestError(`${label} is required`);
  if (value.length > MAX_NODE_SET_TEXT_CODE_UNITS || UNSAFE.test(value)) throw requestError(`${label} is invalid or too long`);
  return value;
}

function sanitizeEffects(value) {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.length > MAX_NODE_SET_EFFECT_JSON_CODE_UNITS) throw requestError('effects JSON is too long');
    try { parsed = JSON.parse(value); }
    catch (error) { throw requestError(`effects must be valid JSON: ${error.message}`); }
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_NODE_SET_EFFECT_ENTRIES
    || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw requestError('effects must be a bounded JSON array of Figma effect objects');
  }
  let entries = 0;
  const stack = parsed.map((item) => ({ value: item, depth: 1 }));
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > MAX_NODE_SET_EFFECT_DEPTH) throw requestError('effects nesting is too deep');
    if (current.value && typeof current.value === 'object') {
      const values = Array.isArray(current.value) ? current.value : Object.values(current.value);
      entries += values.length;
      if (entries > MAX_NODE_SET_EFFECT_ENTRIES * 32) throw requestError('effects structure is too large');
      for (const child of values) {
        if (typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
          throw requestError('effects contains an unsupported value');
        }
        if (child && typeof child === 'object') stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  let json;
  try { json = JSON.stringify(parsed); } catch { throw requestError('effects must be JSON serializable'); }
  if (typeof json !== 'string' || json.length > MAX_NODE_SET_EFFECT_JSON_CODE_UNITS) {
    throw requestError('effects JSON is too long');
  }
  const sanitized = JSON.parse(json);
  const freeze = (item) => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(sanitized);
}

function propertyValue(key, value) {
  const want = NODE_SET_PROPERTIES[key];
  if (want === 'number') {
    let number;
    try { number = key === 'x' || key === 'y' ? finiteNodeCoordinate(value, key) : Number(value); }
    catch (error) { throw requestError(error.message); }
    if (!Number.isFinite(number)) throw requestError(`${key} must be a number`);
    return number;
  }
  if (want === 'nullable-number') {
    if (value === null || /^(none|null)$/i.test(String(value))) return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw requestError(`${key} must be a number or null`);
    return number;
  }
  if (want === 'boolean') {
    if (value === true || value === false) return value;
    if (/^(true|false)$/i.test(String(value))) return String(value).toLowerCase() === 'true';
    throw requestError(`${key} must be true or false`);
  }
  if (want === 'enum') {
    let normalized = String(value).trim().toUpperCase().replace(/[ -]+/g, '_');
    if (key === 'layoutMode' && normalized === 'ROW') normalized = 'HORIZONTAL';
    if (key === 'layoutMode' && ['COL', 'COLUMN'].includes(normalized)) normalized = 'VERTICAL';
    if (!NODE_SET_ENUMS[key].includes(normalized)) {
      throw requestError(`${key} must be one of: ${NODE_SET_ENUMS[key].join(', ')}`);
    }
    return normalized;
  }
  if (want === 'number-list' || want === 'radii') {
    const values = Array.isArray(value) ? value : String(value).split(',');
    const numbers = values.map((item) => Number(item));
    if (numbers.length > 1_000 || numbers.some((number) => !Number.isFinite(number) || number < 0)) {
      throw requestError(`${key} must contain bounded non-negative numbers`);
    }
    if (want === 'radii' && numbers.length !== 4) {
      throw requestError('radii must contain four values: top-left, top-right, bottom-right, bottom-left');
    }
    return Object.freeze(numbers);
  }
  if (want === 'json-array') return sanitizeEffects(value);
  if (want === 'paint') {
    const paint = boundedText(String(value), key);
    if (!/^#?[a-f\d]{6}$/i.test(paint) && !/^var:.+$/u.test(paint)) {
      throw requestError(`${key} must be a six-digit hex colour or var:<name>`);
    }
    return paint;
  }
  return boundedText(String(value), key, { allowEmpty: true });
}

function finish(node, entries, collection = null) {
  const props = {};
  const seen = new Set();
  for (const [rawKey, value] of entries) {
    if (value === undefined) continue;
    const key = ALIASES[rawKey] ?? rawKey;
    if (!(key in NODE_SET_PROPERTIES)) {
      throw requestError(`unknown property ${JSON.stringify(rawKey)}. Known: ${Object.keys(NODE_SET_PROPERTIES).join(', ')}`);
    }
    if (seen.has(key)) throw requestError(`${key} may be provided only once`);
    seen.add(key);
    props[key] = propertyValue(key, value);
  }
  if (!Object.keys(props).length) throw requestError('no properties to set');
  if (('width' in props) !== ('height' in props)) throw requestError('width and height must be set together (Figma resizes in one call)');
  if ('opacity' in props && (typeof props.opacity !== 'number' || props.opacity < 0 || props.opacity > 1)) throw requestError('opacity must be between 0 and 1');
  if ('cornerSmoothing' in props && (typeof props.cornerSmoothing !== 'number' || props.cornerSmoothing < 0 || props.cornerSmoothing > 1)) throw requestError('cornerSmoothing must be between 0 and 1');
  if ('innerRadius' in props && (typeof props.innerRadius !== 'number' || props.innerRadius < 0 || props.innerRadius > 1)) throw requestError('innerRadius must be between 0 and 1');
  if ('pointCount' in props && (typeof props.pointCount !== 'number' || !Number.isInteger(props.pointCount) || props.pointCount < 3)) throw requestError('pointCount must be an integer of at least 3');
  return Object.freeze({
    nodeId: node.nodeId,
    props: Object.freeze(props),
    collection: collection == null ? null : boundedText(String(collection), 'collection'),
  });
}

/** Object parser retained as the typed convenience surface used by tests and Commander. */
export function parseSetRequest(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw requestError('request must be an object');
  const rawId = entry.node ?? entry.nodeId ?? entry.id;
  if (rawId == null || rawId === '') throw requestError('missing node id');
  return finish(nodeValue(rawId), Object.entries(entry).filter(([key]) => !['node', 'nodeId', 'id', 'collection'].includes(key)), entry.collection ?? null);
}

function parsedArgv(args) {
  if (!Array.isArray(args) || args[0] !== 'node' || args[1] !== 'set') throw new Error('Expected a node set command.');
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Node Set arguments must be strings.');
  const entries = [];
  const positionals = [];
  let collection = null;
  let collectionSeen = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && (token === '-c' || token === '--collection' || token.startsWith('--collection=') || token.startsWith('-c='))) {
      if (collectionSeen) throw requestError('--collection may be provided only once');
      collectionSeen = true;
      const inline = token.includes('=');
      const value = inline ? token.slice(token.indexOf('=') + 1) : args[++index];
      if (typeof value !== 'string') throw requestError('--collection requires a value');
      collection = value;
      continue;
    }
    if (!literal && token === '--batch') throw requestError('--batch is disabled');
    if (!literal && token.startsWith('--')) {
      const equals = token.indexOf('=');
      const flag = equals === -1 ? token : token.slice(0, equals);
      const key = FLAG_PROPERTIES[flag];
      if (!key) throw requestError(`unknown option ${flag}`);
      const value = equals === -1 ? args[++index] : token.slice(equals + 1);
      if (typeof value !== 'string') throw requestError(`${flag} requires a value`);
      entries.push([key, value]);
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (!positionals.length) throw requestError('nodeId is required');
  if (positionals.length > 1) throw requestError(`unexpected argument ${positionals[1]}`);
  return { node: nodeValue(positionals[0]), entries, collection };
}

export function parseNodeSetRequest(args) {
  const input = parsedArgv(args);
  return finish(input.node, input.entries, input.collection);
}

export function acceptsNodeSetArgv(args) {
  try { parseNodeSetRequest(args); return true; } catch { return false; }
}

export function nodeSetFigmaUrlFileKeyFromArgv(args) { return parsedArgv(args).node.fileKey; }

function typed(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['nodeId', 'props', 'collection'].includes(key))
    || typeof request.nodeId !== 'string' || !request.props || typeof request.props !== 'object'
    || Array.isArray(request.props) || (request.collection != null && typeof request.collection !== 'string')) {
    throw new TypeError('Node Set request must be a closed typed object.');
  }
  return finish(nodeValue(request.nodeId), Object.entries(request.props), request.collection ?? null);
}

function optionValue(key, value) {
  if (NODE_SET_PROPERTIES[key] === 'json-array') return JSON.stringify(value);
  if (Array.isArray(value)) return value.join(',');
  if (value === null) return 'null';
  return String(value);
}

function argv(input, node) {
  const args = ['node', 'set', node];
  for (const key of Object.keys(NODE_SET_PROPERTIES)) {
    if (Object.hasOwn(input.props, key)) args.push(`${NODE_SET_PROPERTY_FLAGS[key]}=${optionValue(key, input.props[key])}`);
  }
  if (input.collection !== null) args.push(`--collection=${input.collection}`);
  return args;
}

export function nodeSetArgvFromRequest(request) {
  const input = typed(request);
  const args = argv(input, input.nodeId);
  parseNodeSetRequest(args);
  return args;
}

export function nodeSetPlanningArgvFromRequest(request) {
  const input = typed(request);
  const node = nodeValue(request.nodeId);
  const args = argv(input, node.planningValue);
  parseNodeSetRequest(args);
  return args;
}
