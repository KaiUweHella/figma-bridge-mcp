// Shared closed value contract for local Style creation and update.

import { isFigmaPositiveInfinity } from './figma-scalar.js';
import { isExactLayoutGridList } from './layout-grid-contract.js';
import { isStyleFactsDiscriminant } from './style-facts-contract.js';
import { parseStyleProperties, parseStyleType } from '../lib/style-management.js';

export const MAX_STYLE_MUTATION_NAME_CODE_UNITS = 1_024;
export const MAX_STYLE_MUTATION_DESCRIPTION_CODE_UNITS = 65_536;
export const MAX_STYLE_MUTATION_PROPERTIES_CODE_UNITS = 128_000;
const MAX_STYLE_MUTATION_DEPTH = 24;
const MAX_STYLE_MUTATION_VALUES = 20_000;
const MAX_STYLE_MUTATION_CONTAINER_ENTRIES = 2_048;
const MAX_STYLE_MUTATION_KEY_CODE_UNITS = 128;
const UNSAFE_TEXT = /[\u0000\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/** @returns {never} */
function invalid(error, message) {
  throw error(message);
}

export function styleMutationTypeValue(value, error) {
  try { return parseStyleType(value); }
  catch (cause) { return invalid(error, cause?.message || String(cause)); }
}

export function styleMutationNameValue(value, error) {
  if (typeof value !== 'string') return invalid(error, 'name is required');
  const name = value.trim();
  if (!name) return invalid(error, 'name must not be empty');
  if (name.length > MAX_STYLE_MUTATION_NAME_CODE_UNITS) {
    return invalid(error, `name exceeds ${MAX_STYLE_MUTATION_NAME_CODE_UNITS} code units`);
  }
  if (UNSAFE_TEXT.test(name)) return invalid(error, 'name contains unsafe control characters');
  return name;
}

export function styleMutationDescriptionValue(value, error) {
  if (value == null) return '';
  if (typeof value !== 'string') return invalid(error, 'description must be a string');
  if (value.length > MAX_STYLE_MUTATION_DESCRIPTION_CODE_UNITS) {
    return invalid(error, `description exceeds ${MAX_STYLE_MUTATION_DESCRIPTION_CODE_UNITS} code units`);
  }
  if (UNSAFE_TEXT.test(value)) return invalid(error, 'description contains unsafe control characters');
  return value;
}

function boundedGraph(value, type, error) {
  const stack = [{ value, depth: 0, path: 'properties' }];
  let values = 0;
  while (stack.length) {
    const entry = stack.pop();
    values++;
    if (values > MAX_STYLE_MUTATION_VALUES) invalid(error, 'properties contain too many values');
    if (entry.depth > MAX_STYLE_MUTATION_DEPTH) invalid(error, 'properties are nested too deeply');
    if (entry.value === null || typeof entry.value === 'boolean' || typeof entry.value === 'string') continue;
    if (typeof entry.value === 'number') {
      if (!Number.isFinite(entry.value)) invalid(error, `${entry.path} must contain only finite JSON numbers`);
      continue;
    }
    if (!entry.value || typeof entry.value !== 'object') {
      invalid(error, `${entry.path} contains an unsupported value`);
    }
    if (isFigmaPositiveInfinity(entry.value)) {
      if (type !== 'GRID' || !/\.layoutGrids\[\d+\]\.count$/u.test(entry.path)) {
        invalid(error, `${entry.path} uses an unsupported Figma scalar`);
      }
      continue;
    }
    const children = Array.isArray(entry.value)
      ? entry.value.map((child, index) => [String(index), child])
      : Object.entries(entry.value);
    if (children.length > MAX_STYLE_MUTATION_CONTAINER_ENTRIES) {
      invalid(error, `${entry.path} contains too many entries`);
    }
    for (const [key, child] of children) {
      if (key.length > MAX_STYLE_MUTATION_KEY_CODE_UNITS) {
        invalid(error, `${entry.path} contains an oversized key`);
      }
      stack.push({
        value: child,
        depth: entry.depth + 1,
        path: Array.isArray(entry.value) ? `${entry.path}[${key}]` : `${entry.path}.${key}`,
      });
    }
  }
}

export function styleMutationPropertiesValue(raw, type, error, { defaultEmpty = true } = {}) {
  let value = raw;
  if (value == null && defaultEmpty) value = {};
  if (typeof value === 'string') {
    if (value.length > MAX_STYLE_MUTATION_PROPERTIES_CODE_UNITS) {
      return invalid(error, `--properties exceeds ${MAX_STYLE_MUTATION_PROPERTIES_CODE_UNITS} code units`);
    }
    try { value = JSON.parse(value); }
    catch { return invalid(error, '--properties must be valid JSON'); }
  }
  let properties;
  try { properties = parseStyleProperties(value, type); }
  catch (cause) { return invalid(error, cause?.message || String(cause)); }
  boundedGraph(properties, type, error);
  if (type === 'PAINT' && properties.paints !== undefined
    && (!Array.isArray(properties.paints)
      || properties.paints.length > MAX_STYLE_MUTATION_CONTAINER_ENTRIES
      || !properties.paints.every((paint) => paint && typeof paint === 'object'
        && !Array.isArray(paint) && isStyleFactsDiscriminant('Paint', paint.type)))) {
    return invalid(error, 'paints must be a bounded array of official Paint union values');
  }
  if (type === 'EFFECT' && properties.effects !== undefined
    && (!Array.isArray(properties.effects)
      || properties.effects.length > MAX_STYLE_MUTATION_CONTAINER_ENTRIES
      || !properties.effects.every((effect) => effect && typeof effect === 'object'
        && !Array.isArray(effect) && isStyleFactsDiscriminant('Effect', effect.type)))) {
    return invalid(error, 'effects must be a bounded array of official Effect union values');
  }
  if (type === 'GRID' && properties.layoutGrids !== undefined
    && !isExactLayoutGridList(properties.layoutGrids, {
      maxEntries: MAX_STYLE_MUTATION_CONTAINER_ENTRIES,
      maxLabelCodeUnits: MAX_STYLE_MUTATION_NAME_CODE_UNITS,
    })) {
    return invalid(error, 'layoutGrids must match the exact ROWS, COLUMNS, or GRID Layout Guide contract');
  }
  if (type === 'TEXT' && properties.fontName !== undefined) {
    const font = properties.fontName;
    if (!font || typeof font !== 'object' || Array.isArray(font)
      || Object.keys(font).sort().join(',') !== 'family,style'
      || typeof font.family !== 'string' || !font.family
      || typeof font.style !== 'string' || !font.style
      || font.family.length > MAX_STYLE_MUTATION_NAME_CODE_UNITS
      || font.style.length > MAX_STYLE_MUTATION_NAME_CODE_UNITS) {
      return invalid(error, 'fontName must contain bounded non-empty family and style strings');
    }
  }
  if (type === 'TEXT') {
    for (const field of ['fontSize', 'paragraphIndent', 'paragraphSpacing', 'listSpacing']) {
      if (properties[field] !== undefined
        && (typeof properties[field] !== 'number' || !Number.isFinite(properties[field]))) {
        return invalid(error, `${field} must be a finite number`);
      }
    }
    for (const field of ['hangingPunctuation', 'hangingList']) {
      if (properties[field] !== undefined && typeof properties[field] !== 'boolean') {
        return invalid(error, `${field} must be a boolean`);
      }
    }
    const enums = {
      textDecoration: ['NONE', 'UNDERLINE', 'STRIKETHROUGH'],
      textCase: ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS', 'SMALL_CAPS_FORCED'],
      leadingTrim: ['CAP_HEIGHT', 'NONE'],
    };
    for (const [field, allowed] of Object.entries(enums)) {
      if (properties[field] !== undefined && !allowed.includes(properties[field])) {
        return invalid(error, `${field} must be one of ${allowed.join(', ')}`);
      }
    }
    if (properties.letterSpacing !== undefined) {
      const spacing = properties.letterSpacing;
      if (!spacing || typeof spacing !== 'object' || Array.isArray(spacing)
        || Object.keys(spacing).sort().join(',') !== 'unit,value'
        || !['PIXELS', 'PERCENT'].includes(spacing.unit)
        || typeof spacing.value !== 'number' || !Number.isFinite(spacing.value)) {
        return invalid(error, 'letterSpacing must contain a finite value and PIXELS or PERCENT unit');
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
        return invalid(error, 'lineHeight must be AUTO or contain a finite PIXELS/PERCENT value');
      }
    }
  }
  return properties;
}

export function stableStyleMutationValue(value) {
  if (Array.isArray(value)) return value.map(stableStyleMutationValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableStyleMutationValue(value[key])]),
  );
}
