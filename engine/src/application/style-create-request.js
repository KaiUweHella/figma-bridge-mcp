// Closed request Interface for `style create`.

import { isFigmaPositiveInfinity } from './figma-scalar.js';
import { isExactLayoutGridList } from './layout-grid-contract.js';
import { isStyleFactsDiscriminant } from './style-facts-contract.js';
import { parseStyleProperties, parseStyleType } from '../lib/style-management.js';

export const MAX_STYLE_CREATE_NAME_CODE_UNITS = 1_024;
export const MAX_STYLE_CREATE_DESCRIPTION_CODE_UNITS = 65_536;
export const MAX_STYLE_CREATE_PROPERTIES_CODE_UNITS = 128_000;
const MAX_STYLE_CREATE_DEPTH = 24;
const MAX_STYLE_CREATE_VALUES = 20_000;
const MAX_STYLE_CREATE_CONTAINER_ENTRIES = 2_048;
const MAX_STYLE_CREATE_KEY_CODE_UNITS = 128;
const UNSAFE_TEXT = /[\u0000\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid style create command: ${message}.`);
}

function nameValue(value) {
  if (typeof value !== 'string') throw requestError('name is required');
  const name = value.trim();
  if (!name) throw requestError('name must not be empty');
  if (name.length > MAX_STYLE_CREATE_NAME_CODE_UNITS) {
    throw requestError(`name exceeds ${MAX_STYLE_CREATE_NAME_CODE_UNITS} code units`);
  }
  if (UNSAFE_TEXT.test(name)) throw requestError('name contains unsafe control characters');
  return name;
}

function descriptionValue(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw requestError('description must be a string');
  if (value.length > MAX_STYLE_CREATE_DESCRIPTION_CODE_UNITS) {
    throw requestError(`description exceeds ${MAX_STYLE_CREATE_DESCRIPTION_CODE_UNITS} code units`);
  }
  if (UNSAFE_TEXT.test(value)) throw requestError('description contains unsafe control characters');
  return value;
}

function boundedGraph(value, type) {
  const stack = [{ value, depth: 0, path: 'properties' }];
  let values = 0;
  while (stack.length) {
    const entry = stack.pop();
    values++;
    if (values > MAX_STYLE_CREATE_VALUES) throw requestError('properties contain too many values');
    if (entry.depth > MAX_STYLE_CREATE_DEPTH) throw requestError('properties are nested too deeply');
    if (entry.value === null || typeof entry.value === 'boolean' || typeof entry.value === 'string') continue;
    if (typeof entry.value === 'number') {
      if (!Number.isFinite(entry.value)) throw requestError(`${entry.path} must contain only finite JSON numbers`);
      continue;
    }
    if (!entry.value || typeof entry.value !== 'object') {
      throw requestError(`${entry.path} contains an unsupported value`);
    }
    if (isFigmaPositiveInfinity(entry.value)) {
      if (type !== 'GRID' || !/\.layoutGrids\[\d+\]\.count$/u.test(entry.path)) {
        throw requestError(`${entry.path} uses an unsupported Figma scalar`);
      }
      continue;
    }
    const children = Array.isArray(entry.value)
      ? entry.value.map((child, index) => [String(index), child])
      : Object.entries(entry.value);
    if (children.length > MAX_STYLE_CREATE_CONTAINER_ENTRIES) {
      throw requestError(`${entry.path} contains too many entries`);
    }
    for (const [key, child] of children) {
      if (key.length > MAX_STYLE_CREATE_KEY_CODE_UNITS) throw requestError(`${entry.path} contains an oversized key`);
      stack.push({
        value: child,
        depth: entry.depth + 1,
        path: Array.isArray(entry.value) ? `${entry.path}[${key}]` : `${entry.path}.${key}`,
      });
    }
  }
}

function propertiesValue(raw, type) {
  let value = raw;
  if (value == null) value = {};
  if (typeof value === 'string') {
    if (value.length > MAX_STYLE_CREATE_PROPERTIES_CODE_UNITS) {
      throw requestError(`--properties exceeds ${MAX_STYLE_CREATE_PROPERTIES_CODE_UNITS} code units`);
    }
    try { value = JSON.parse(value); }
    catch { throw requestError('--properties must be valid JSON'); }
  }
  let properties;
  try { properties = parseStyleProperties(value, type); }
  catch (error) { throw requestError(error?.message || String(error)); }
  boundedGraph(properties, type);
  if (type === 'PAINT' && properties.paints !== undefined
    && (!Array.isArray(properties.paints)
      || properties.paints.length > MAX_STYLE_CREATE_CONTAINER_ENTRIES
      || !properties.paints.every((paint) => paint && typeof paint === 'object'
        && !Array.isArray(paint) && isStyleFactsDiscriminant('Paint', paint.type)))) {
    throw requestError('paints must be a bounded array of official Paint union values');
  }
  if (type === 'EFFECT' && properties.effects !== undefined
    && (!Array.isArray(properties.effects)
      || properties.effects.length > MAX_STYLE_CREATE_CONTAINER_ENTRIES
      || !properties.effects.every((effect) => effect && typeof effect === 'object'
        && !Array.isArray(effect) && isStyleFactsDiscriminant('Effect', effect.type)))) {
    throw requestError('effects must be a bounded array of official Effect union values');
  }
  if (type === 'GRID' && properties.layoutGrids !== undefined
    && !isExactLayoutGridList(properties.layoutGrids, {
      maxEntries: MAX_STYLE_CREATE_CONTAINER_ENTRIES,
      maxLabelCodeUnits: MAX_STYLE_CREATE_NAME_CODE_UNITS,
    })) {
    throw requestError('layoutGrids must match the exact ROWS, COLUMNS, or GRID Layout Guide contract');
  }
  if (type === 'TEXT' && properties.fontName !== undefined) {
    const font = properties.fontName;
    if (!font || typeof font !== 'object' || Array.isArray(font)
      || Object.keys(font).sort().join(',') !== 'family,style'
      || typeof font.family !== 'string' || !font.family
      || typeof font.style !== 'string' || !font.style
      || font.family.length > MAX_STYLE_CREATE_NAME_CODE_UNITS
      || font.style.length > MAX_STYLE_CREATE_NAME_CODE_UNITS) {
      throw requestError('fontName must contain bounded non-empty family and style strings');
    }
  }
  if (type === 'TEXT') {
    const finiteFields = ['fontSize', 'paragraphIndent', 'paragraphSpacing', 'listSpacing'];
    for (const field of finiteFields) {
      if (properties[field] !== undefined
        && (typeof properties[field] !== 'number' || !Number.isFinite(properties[field]))) {
        throw requestError(`${field} must be a finite number`);
      }
    }
    for (const field of ['hangingPunctuation', 'hangingList']) {
      if (properties[field] !== undefined && typeof properties[field] !== 'boolean') {
        throw requestError(`${field} must be a boolean`);
      }
    }
    const enums = {
      textDecoration: ['NONE', 'UNDERLINE', 'STRIKETHROUGH'],
      textCase: ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS', 'SMALL_CAPS_FORCED'],
      leadingTrim: ['CAP_HEIGHT', 'NONE'],
    };
    for (const [field, allowed] of Object.entries(enums)) {
      if (properties[field] !== undefined && !allowed.includes(properties[field])) {
        throw requestError(`${field} must be one of ${allowed.join(', ')}`);
      }
    }
    if (properties.letterSpacing !== undefined) {
      const spacing = properties.letterSpacing;
      if (!spacing || typeof spacing !== 'object' || Array.isArray(spacing)
        || Object.keys(spacing).sort().join(',') !== 'unit,value'
        || !['PIXELS', 'PERCENT'].includes(spacing.unit)
        || typeof spacing.value !== 'number' || !Number.isFinite(spacing.value)) {
        throw requestError('letterSpacing must contain a finite value and PIXELS or PERCENT unit');
      }
    }
    if (properties.lineHeight !== undefined) {
      const height = properties.lineHeight;
      const auto = height && typeof height === 'object' && !Array.isArray(height)
        && Object.keys(height).join(',') === 'unit' && height.unit === 'AUTO';
      const measured = height && typeof height === 'object' && !Array.isArray(height)
        && Object.keys(height).sort().join(',') === 'unit,value'
        && ['PIXELS', 'PERCENT'].includes(height.unit)
        && typeof height.value === 'number' && Number.isFinite(height.value);
      if (!auto && !measured) {
        throw requestError('lineHeight must be AUTO or contain a finite PIXELS/PERCENT value');
      }
    }
  }
  return properties;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || args[1] !== 'create') {
    throw new Error('Expected a style create command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Style Create arguments must be strings.');
  }
  let description = '';
  let properties = null;
  let sawDescription = false;
  let sawProperties = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const longDescription = !literal ? token.match(/^--description=(.*)$/s) : null;
    const shortDescription = !literal ? token.match(/^-d(.+)$/s) : null;
    if (!literal && (token === '--description' || token === '-d' || longDescription || shortDescription)) {
      if (sawDescription) throw requestError('--description may be provided only once');
      sawDescription = true;
      const inline = longDescription?.[1] ?? shortDescription?.[1];
      const raw = inline === undefined ? args[++index] : inline;
      if (raw === undefined) throw requestError('--description requires a value');
      description = descriptionValue(raw);
      continue;
    }
    const longProperties = !literal ? token.match(/^--properties=(.*)$/s) : null;
    const shortProperties = !literal ? token.match(/^-p(.+)$/s) : null;
    if (!literal && (token === '--properties' || token === '-p' || longProperties || shortProperties)) {
      if (sawProperties) throw requestError('--properties may be provided only once');
      sawProperties = true;
      const inline = longProperties?.[1] ?? shortProperties?.[1];
      properties = inline === undefined ? args[++index] : inline;
      if (properties === undefined) throw requestError('--properties requires a value');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 2) throw requestError('type and name are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  let type;
  try { type = parseStyleType(positionals[0]); }
  catch (error) { throw requestError(error?.message || String(error)); }
  return {
    type,
    name: nameValue(positionals[1]),
    description,
    properties: propertiesValue(properties, type),
  };
}

export function parseStyleCreateRequest(args) {
  return parsedRequest(args);
}

export function acceptsStyleCreateArgv(args) {
  try { parseStyleCreateRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Style Create request must be an object.');
  }
  let type;
  try { type = parseStyleType(request.type); }
  catch (error) { throw requestError(error?.message || String(error)); }
  return {
    type,
    name: nameValue(request.name),
    description: descriptionValue(request.description),
    properties: propertiesValue(request.properties, type),
  };
}

export function styleCreateArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    'style', 'create', '--description', input.description,
    '--properties', JSON.stringify(stableValue(input.properties)),
    '--', input.type, input.name,
  ];
}

export const styleCreatePlanningArgvFromRequest = styleCreateArgvFromRequest;
