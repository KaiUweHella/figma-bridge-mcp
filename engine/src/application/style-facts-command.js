// Exact bounded local Style Facts Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseStyleFactsRequest,
  styleFactsArgvFromRequest,
  styleFactsPlanningArgvFromRequest,
} from './style-facts-request.js';

export {
  styleFactsArgvFromRequest,
  styleFactsPlanningArgvFromRequest,
} from './style-facts-request.js';

const STYLE_FACTS_APPLICATION_ID = 'style.show';
export const MAX_STYLE_FACTS_SERIALIZED_CODE_UNITS = 500_000;
export const MAX_STYLE_FACTS_DEPTH = 32;
export const MAX_STYLE_FACTS_CONTAINER_ENTRIES = 1024;
export const MAX_STYLE_FACTS_VALUES = 50_000;
export const MAX_STYLE_FACTS_STRING_CODE_UNITS = 65_536;
export const MAX_STYLE_FACTS_DOCUMENTATION_LINKS = 64;
export const MAX_STYLE_FACTS_CANDIDATES = 10_000;
const MAX_STYLE_FACTS_KEY_CODE_UNITS = 128;
const MAX_STYLE_FACTS_LABEL_CODE_UNITS = 1_024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const PAINT_TYPES = new Set([
  'SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR',
  'GRADIENT_DIAMOND', 'IMAGE', 'VIDEO', 'PATTERN', 'SHADER',
]);
const EFFECT_TYPES = new Set([
  'DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR',
  'NOISE', 'TEXTURE', 'GLASS', 'SHADER',
]);
const GRID_PATTERNS = new Set(['ROWS', 'COLUMNS', 'GRID']);
const TEXT_FIELDS = Object.freeze([
  'fontName', 'fontSize', 'textDecoration', 'textCase', 'letterSpacing',
  'lineHeight', 'leadingTrim', 'paragraphIndent', 'paragraphSpacing',
  'listSpacing', 'hangingPunctuation', 'hangingList',
]);
const TEXT_BINDING_FIELDS = new Set([
  'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing',
  'lineHeight', 'paragraphSpacing', 'paragraphIndent',
]);

function normalizedRequest(request) {
  return parseStyleFactsRequest(styleFactsArgvFromRequest(request));
}

export function styleFactsCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.style)};
    const requestedType = ${JSON.stringify(input.type)};
    const direct = await figma.getStyleByIdAsync(query);
    let style = direct && (!requestedType || direct.type === requestedType) ? direct : null;
    let resolution = 'id';
    if (!style) {
      const loaders = {
        PAINT: () => figma.getLocalPaintStylesAsync(),
        TEXT: () => figma.getLocalTextStylesAsync(),
        EFFECT: () => figma.getLocalEffectStylesAsync(),
        GRID: () => figma.getLocalGridStylesAsync(),
      };
      const lists = requestedType
        ? [await loaders[requestedType]()]
        : await Promise.all(Object.values(loaders).map((load) => load()));
      const pool = lists.flat();
      if (pool.length > ${MAX_STYLE_FACTS_CANDIDATES}) {
        throw new Error('Style Facts candidate limit exceeded. Use an exact style id.');
      }
      const exact = pool.filter((candidate) => candidate.name === query);
      const matches = exact.length
        ? exact
        : pool.filter((candidate) => candidate.name.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) {
        throw new Error('Style reference is ambiguous (' + matches.length + ' matches). Use an exact style id or name.');
      }
      if (matches.length === 0) throw new Error('Style not found in the targeted Figma document.');
      style = matches[0];
      resolution = exact.length ? 'exact-name' : 'partial-name';
    }
    if (style.documentationLinks.length > ${MAX_STYLE_FACTS_DOCUMENTATION_LINKS}) {
      throw new Error('Style Facts documentation-link limit exceeded.');
    }

    let values = 0;
    const seen = new Set();
    const encode = (value, depth = 0) => {
      values++;
      if (values > ${MAX_STYLE_FACTS_VALUES}) throw new Error('Style Facts value limit exceeded.');
      if (depth > ${MAX_STYLE_FACTS_DEPTH}) throw new Error('Style Facts depth limit exceeded.');
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;
        throw new Error('Style Facts contains a non-finite number.');
      }
      if (typeof value === 'string') {
        if (value.length > ${MAX_STYLE_FACTS_STRING_CODE_UNITS}) {
          throw new Error('Style Facts string limit exceeded.');
        }
        return value;
      }
      if (value === undefined) return undefined;
      if (!value || typeof value !== 'object') throw new Error('Style Facts contains a non-projectable value.');
      if (seen.has(value)) throw new Error('Style Facts contains a cycle.');
      seen.add(value);
      let output;
      if (Array.isArray(value)) {
        if (value.length > ${MAX_STYLE_FACTS_CONTAINER_ENTRIES}) {
          throw new Error('Style Facts array limit exceeded.');
        }
        output = value.map((item) => {
          const encoded = encode(item, depth + 1);
          if (encoded === undefined) throw new Error('Style Facts contains an undefined array value.');
          return encoded;
        });
      } else {
        const keys = Object.keys(value);
        if (keys.length > ${MAX_STYLE_FACTS_CONTAINER_ENTRIES}) {
          throw new Error('Style Facts object limit exceeded.');
        }
        output = Object.create(null);
        for (const key of keys) {
          if (key.length > ${MAX_STYLE_FACTS_KEY_CODE_UNITS}) {
            throw new Error('Style Facts key limit exceeded.');
          }
          const encoded = encode(value[key], depth + 1);
          if (encoded !== undefined) output[key] = encoded;
        }
      }
      seen.delete(value);
      return output;
    };

    const payload = {
      schemaVersion: 1,
      resolution,
      id: style.id,
      key: style.key || null,
      name: style.name,
      // Figma's runtime can omit either description field even though current
      // Plugin typings declare both required. Preserve that distinction.
      description: typeof style.description === 'string' ? style.description : null,
      descriptionMarkdown: typeof style.descriptionMarkdown === 'string'
        ? style.descriptionMarkdown
        : null,
      documentationLinks: style.documentationLinks,
      type: style.type,
      remote: !!style.remote,
    };
    if (style.boundVariables) payload.boundVariables = style.boundVariables;
    if (style.type === 'PAINT') payload.paints = style.paints;
    else if (style.type === 'TEXT') {
      for (const field of ${JSON.stringify(TEXT_FIELDS)}) payload[field] = style[field];
    } else if (style.type === 'EFFECT') payload.effects = style.effects;
    else if (style.type === 'GRID') {
      payload.layoutGrids = style.layoutGrids.map((grid) => (
        (grid.pattern === 'ROWS' || grid.pattern === 'COLUMNS') && grid.count === Infinity
          ? { ...grid, count: { $figmaScalar: 'Infinity' } }
          : grid
      ));
    }
    else throw new Error('Unsupported Figma style type.');

    const encoded = encode(payload);
    const serialized = JSON.stringify(encoded);
    if (serialized.length > ${MAX_STYLE_FACTS_SERIALIZED_CODE_UNITS}) {
      throw new Error('Style Facts serialized-size limit exceeded.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function boundedString(value, limit = MAX_STYLE_FACTS_STRING_CODE_UNITS, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= limit && (empty || value.length > 0);
}

function validTaggedScalar(value) {
  return exactKeys(value, ['$figmaScalar']) && value.$figmaScalar === 'Infinity';
}

function boundedFigmaValue(value, depth, state) {
  state.values++;
  if (state.values > MAX_STYLE_FACTS_VALUES || depth > MAX_STYLE_FACTS_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_STYLE_FACTS_STRING_CODE_UNITS;
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, '$figmaScalar')) return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_STYLE_FACTS_CONTAINER_ENTRIES
      && value.every((item) => boundedFigmaValue(item, depth + 1, state));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_STYLE_FACTS_CONTAINER_ENTRIES
    && entries.every(([key, item]) => key.length <= MAX_STYLE_FACTS_KEY_CODE_UNITS
      && boundedFigmaValue(item, depth + 1, state));
}

function validAlias(value) {
  return exactKeys(value, ['type', 'id'])
    && value.type === 'VARIABLE_ALIAS'
    && boundedString(value.id, MAX_STYLE_FACTS_LABEL_CODE_UNITS, { empty: false });
}

function exactOptionalKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validRgb(value, { alpha = false } = {}) {
  const keys = alpha ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'];
  return exactKeys(value, keys) && keys.every((key) => finiteNumber(value[key]));
}

function validVector(value) {
  return exactKeys(value, ['x', 'y']) && finiteNumber(value.x) && finiteNumber(value.y);
}

function validTransform(value) {
  return Array.isArray(value) && value.length === 2
    && value.every((row) => Array.isArray(row) && row.length === 3
      && row.every(finiteNumber));
}

function validAliasMap(value, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([field, alias]) => allowedFields.has(field)
    && validAlias(alias));
}

function validBoundVariables(value, type) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_STYLE_FACTS_CONTAINER_ENTRIES) return false;
  const allowed = type === 'TEXT' ? TEXT_BINDING_FIELDS
    : type === 'PAINT' ? new Set(['paints'])
      : type === 'EFFECT' ? new Set(['effects']) : new Set(['layoutGrids']);
  return entries.every(([field, binding]) => {
    if (!allowed.has(field)) return false;
    if (type === 'TEXT') return validAlias(binding);
    return Array.isArray(binding)
      && binding.length <= MAX_STYLE_FACTS_CONTAINER_ENTRIES
      && binding.every(validAlias);
  });
}

function validDocumentationLinks(value) {
  return Array.isArray(value)
    && value.length <= MAX_STYLE_FACTS_DOCUMENTATION_LINKS
    && value.every((link) => exactKeys(link, ['uri'])
      && boundedString(link.uri, MAX_STYLE_FACTS_STRING_CODE_UNITS));
}

function validCommonPaint(value) {
  return (value.visible === undefined || typeof value.visible === 'boolean')
    && (value.opacity === undefined || finiteNumber(value.opacity))
    && (value.blendMode === undefined || boundedString(value.blendMode, 64));
}

function validFilters(value) {
  const fields = new Set([
    'exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows',
  ]);
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.entries(value).every(([field, amount]) => fields.has(field) && finiteNumber(amount));
}

function validGradientStop(value) {
  return exactOptionalKeys(value, ['position', 'color'], ['boundVariables'])
    && finiteNumber(value.position) && validRgb(value.color, { alpha: true })
    && (value.boundVariables === undefined
      || validAliasMap(value.boundVariables, new Set(['color'])));
}

function validPaint(value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !PAINT_TYPES.has(value.type) || !validCommonPaint(value)) return false;
  const common = ['visible', 'opacity', 'blendMode'];
  let valid = false;
  if (value.type === 'SOLID') {
    valid = exactOptionalKeys(value, ['type', 'color'], [...common, 'boundVariables'])
      && validRgb(value.color)
      && (value.boundVariables === undefined
        || validAliasMap(value.boundVariables, new Set(['color'])));
  } else if (value.type.startsWith('GRADIENT_')) {
    valid = exactOptionalKeys(value, ['type', 'gradientTransform', 'gradientStops'], common)
      && validTransform(value.gradientTransform)
      && Array.isArray(value.gradientStops)
      && value.gradientStops.length <= MAX_STYLE_FACTS_CONTAINER_ENTRIES
      && value.gradientStops.every(validGradientStop);
  } else if (value.type === 'IMAGE' || value.type === 'VIDEO') {
    const hash = value.type === 'IMAGE' ? 'imageHash' : 'videoHash';
    const transform = value.type === 'IMAGE' ? 'imageTransform' : 'videoTransform';
    valid = exactOptionalKeys(value, ['type', 'scaleMode', hash], [
      transform, 'scalingFactor', 'rotation', 'filters', ...common,
    ])
      && ['FILL', 'FIT', 'CROP', 'TILE'].includes(value.scaleMode)
      && (value[hash] === null || boundedString(value[hash], MAX_STYLE_FACTS_LABEL_CODE_UNITS))
      && (value[transform] === undefined || validTransform(value[transform]))
      && (value.scalingFactor === undefined || finiteNumber(value.scalingFactor))
      && (value.rotation === undefined || finiteNumber(value.rotation))
      && (value.filters === undefined || validFilters(value.filters));
  } else if (value.type === 'PATTERN') {
    valid = exactOptionalKeys(value, [
      'type', 'sourceNodeId', 'tileType', 'scalingFactor', 'spacing', 'horizontalAlignment',
    ], common)
      && boundedString(value.sourceNodeId, MAX_STYLE_FACTS_LABEL_CODE_UNITS, { empty: false })
      && ['RECTANGULAR', 'HORIZONTAL_HEXAGONAL', 'VERTICAL_HEXAGONAL'].includes(value.tileType)
      && finiteNumber(value.scalingFactor) && validVector(value.spacing)
      && ['START', 'CENTER', 'END'].includes(value.horizontalAlignment);
  } else if (value.type === 'SHADER') {
    valid = exactOptionalKeys(value, ['type', 'id'], ['properties', ...common])
      && boundedString(value.id, MAX_STYLE_FACTS_LABEL_CODE_UNITS, { empty: false })
      && (value.properties === undefined || boundedFigmaValue(value.properties, 2, state));
  }
  return valid && boundedFigmaValue(value, 1, state);
}

function validPaintList(value, state) {
  return Array.isArray(value) && value.length <= MAX_STYLE_FACTS_CONTAINER_ENTRIES
    && value.every((paint) => validPaint(paint, state));
}

function validEmptyBindings(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0;
}

function validEffect(value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !EFFECT_TYPES.has(value.type)) return false;
  let valid = false;
  if (value.type === 'DROP_SHADOW' || value.type === 'INNER_SHADOW') {
    valid = exactOptionalKeys(value, [
      'type', 'color', 'offset', 'radius', 'visible', 'blendMode',
    ], [
      'spread', 'boundVariables',
      ...(value.type === 'DROP_SHADOW' ? ['showShadowBehindNode'] : []),
    ])
      && validRgb(value.color, { alpha: true }) && validVector(value.offset)
      && finiteNumber(value.radius)
      && (value.spread === undefined || finiteNumber(value.spread))
      && typeof value.visible === 'boolean' && boundedString(value.blendMode, 64)
      && (value.showShadowBehindNode === undefined
        || typeof value.showShadowBehindNode === 'boolean')
      && (value.boundVariables === undefined || validAliasMap(
        value.boundVariables,
        new Set(['color', 'radius', 'spread', 'offsetX', 'offsetY']),
      ));
  } else if (value.type === 'LAYER_BLUR' || value.type === 'BACKGROUND_BLUR') {
    const progressive = value.blurType === 'PROGRESSIVE';
    valid = exactOptionalKeys(value, [
      'type', 'radius', 'visible', 'blurType',
      ...(progressive ? ['startRadius', 'startOffset', 'endOffset'] : []),
    ], ['boundVariables'])
      && ['NORMAL', 'PROGRESSIVE'].includes(value.blurType)
      && finiteNumber(value.radius) && typeof value.visible === 'boolean'
      && (!progressive || (finiteNumber(value.startRadius)
        && validVector(value.startOffset) && validVector(value.endOffset)))
      && (value.boundVariables === undefined
        || validAliasMap(value.boundVariables, new Set(['radius'])));
  } else if (value.type === 'NOISE') {
    const extra = value.noiseType === 'DUOTONE' ? ['secondaryColor']
      : value.noiseType === 'MULTITONE' ? ['opacity'] : [];
    valid = exactOptionalKeys(value, [
      'type', 'color', 'visible', 'blendMode', 'noiseSize', 'density', 'noiseType', ...extra,
    ], ['noiseSizeVector', 'boundVariables'])
      && ['MONOTONE', 'DUOTONE', 'MULTITONE'].includes(value.noiseType)
      && validRgb(value.color, { alpha: true }) && typeof value.visible === 'boolean'
      && boundedString(value.blendMode, 64) && finiteNumber(value.noiseSize)
      && finiteNumber(value.density)
      && (value.noiseSizeVector === undefined || validVector(value.noiseSizeVector))
      && (value.secondaryColor === undefined || validRgb(value.secondaryColor, { alpha: true }))
      && (value.opacity === undefined || finiteNumber(value.opacity))
      && (value.boundVariables === undefined || validEmptyBindings(value.boundVariables));
  } else if (value.type === 'TEXTURE') {
    valid = exactOptionalKeys(value, [
      'type', 'visible', 'noiseSize', 'radius', 'clipToShape',
    ], ['noiseSizeVector', 'boundVariables'])
      && typeof value.visible === 'boolean' && finiteNumber(value.noiseSize)
      && finiteNumber(value.radius) && typeof value.clipToShape === 'boolean'
      && (value.noiseSizeVector === undefined || validVector(value.noiseSizeVector))
      && (value.boundVariables === undefined || validEmptyBindings(value.boundVariables));
  } else if (value.type === 'GLASS') {
    valid = exactOptionalKeys(value, [
      'type', 'visible', 'lightIntensity', 'lightAngle', 'refraction',
      'depth', 'dispersion', 'radius',
    ], ['boundVariables'])
      && typeof value.visible === 'boolean'
      && ['lightIntensity', 'lightAngle', 'refraction', 'depth', 'dispersion', 'radius']
        .every((field) => finiteNumber(value[field]))
      && (value.boundVariables === undefined || validEmptyBindings(value.boundVariables));
  } else if (value.type === 'SHADER') {
    valid = exactOptionalKeys(value, ['type', 'visible', 'id'], ['properties'])
      && typeof value.visible === 'boolean'
      && boundedString(value.id, MAX_STYLE_FACTS_LABEL_CODE_UNITS, { empty: false })
      && (value.properties === undefined || boundedFigmaValue(value.properties, 2, state));
  }
  return valid && boundedFigmaValue(value, 1, state);
}

function validEffectList(value, state) {
  return Array.isArray(value) && value.length <= MAX_STYLE_FACTS_CONTAINER_ENTRIES
    && value.every((effect) => validEffect(effect, state));
}

function validGridList(value, state) {
  return Array.isArray(value)
    && value.length <= MAX_STYLE_FACTS_CONTAINER_ENTRIES
    && value.every((grid) => {
      if (!grid || typeof grid !== 'object' || Array.isArray(grid)
        || !GRID_PATTERNS.has(grid.pattern)) return false;
      if (grid.pattern === 'GRID') {
        if (!exactOptionalKeys(grid, ['pattern', 'sectionSize'], [
          'visible', 'color', 'boundVariables',
        ]) || !finiteNumber(grid.sectionSize)
          || (grid.boundVariables !== undefined
            && !validAliasMap(grid.boundVariables, new Set(['sectionSize'])))) return false;
      } else {
        if (!exactOptionalKeys(grid, ['pattern', 'alignment', 'gutterSize', 'count'], [
          'sectionSize', 'offset', 'visible', 'color', 'boundVariables',
        ]) || !['MIN', 'MAX', 'STRETCH', 'CENTER'].includes(grid.alignment)
          || !finiteNumber(grid.gutterSize)
          || (grid.sectionSize !== undefined && !finiteNumber(grid.sectionSize))
          || (grid.offset !== undefined && !finiteNumber(grid.offset))
          || (grid.boundVariables !== undefined && !validAliasMap(
            grid.boundVariables,
            new Set(['sectionSize', 'count', 'offset', 'gutterSize']),
          ))) return false;
        const countIsFinite = typeof grid.count === 'number' && Number.isFinite(grid.count);
        const countIsAuto = validTaggedScalar(grid.count)
          && grid.count.$figmaScalar === 'Infinity';
        if (!countIsFinite && !countIsAuto) return false;
      }
      if ((grid.visible !== undefined && typeof grid.visible !== 'boolean')
        || (grid.color !== undefined && !validRgb(grid.color, { alpha: true }))) return false;
      return boundedFigmaValue(
        validTaggedScalar(grid.count) ? { ...grid, count: 0 } : grid,
        1,
        state,
      );
    });
}

function validTextFacts(value, state) {
  return exactKeys(value.fontName, ['family', 'style'])
    && boundedString(value.fontName.family, MAX_STYLE_FACTS_LABEL_CODE_UNITS)
    && boundedString(value.fontName.style, MAX_STYLE_FACTS_LABEL_CODE_UNITS)
    && typeof value.fontSize === 'number' && Number.isFinite(value.fontSize)
    && ['NONE', 'UNDERLINE', 'STRIKETHROUGH'].includes(value.textDecoration)
    && ['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS', 'SMALL_CAPS_FORCED']
      .includes(value.textCase)
    && typeof value.paragraphIndent === 'number' && Number.isFinite(value.paragraphIndent)
    && typeof value.paragraphSpacing === 'number' && Number.isFinite(value.paragraphSpacing)
    && typeof value.listSpacing === 'number' && Number.isFinite(value.listSpacing)
    && typeof value.hangingPunctuation === 'boolean'
    && typeof value.hangingList === 'boolean'
    && exactKeys(value.letterSpacing, ['value', 'unit'])
    && finiteNumber(value.letterSpacing.value)
    && ['PIXELS', 'PERCENT'].includes(value.letterSpacing.unit)
    && exactOptionalKeys(value.lineHeight, ['unit'], ['value'])
    && (value.lineHeight.unit === 'AUTO'
      ? value.lineHeight.value === undefined
      : ['PIXELS', 'PERCENT'].includes(value.lineHeight.unit)
        && finiteNumber(value.lineHeight.value))
    && ['CAP_HEIGHT', 'NONE'].includes(value.leadingTrim)
    && boundedFigmaValue(value.letterSpacing, 1, state)
    && boundedFigmaValue(value.lineHeight, 1, state);
}

function validPayload(value, input) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || !STYLE_TYPES.has(value.type)) return false;
  const familyFields = value.type === 'PAINT' ? ['paints']
    : value.type === 'TEXT' ? TEXT_FIELDS
      : value.type === 'EFFECT' ? ['effects'] : ['layoutGrids'];
  if (!exactOptionalKeys(value, [
    'schemaVersion', 'resolution', 'id', 'key', 'name', 'description', 'descriptionMarkdown',
    'documentationLinks', 'type', 'remote', ...familyFields,
  ], ['boundVariables'])
    || !['id', 'exact-name', 'partial-name'].includes(value.resolution)
    || (value.resolution === 'id' && value.id !== input.style)
    || (value.resolution === 'exact-name' && value.name !== input.style)
    || (value.resolution === 'partial-name'
      && (value.name === input.style
        || !value.name.toLowerCase().includes(input.style.toLowerCase())))
    || (input.type !== null && value.type !== input.type)
    || !boundedString(value.id, MAX_STYLE_FACTS_LABEL_CODE_UNITS, { empty: false })
    || !(value.key === null || boundedString(value.key, MAX_STYLE_FACTS_LABEL_CODE_UNITS))
    || !boundedString(value.name, MAX_STYLE_FACTS_LABEL_CODE_UNITS)
    || !(value.description === null || boundedString(value.description))
    || !(value.descriptionMarkdown === null || boundedString(value.descriptionMarkdown))
    || !validDocumentationLinks(value.documentationLinks)
    || typeof value.remote !== 'boolean'
    || (value.boundVariables !== undefined
      && !validBoundVariables(value.boundVariables, value.type))) return false;

  const state = { values: 0 };
  if (value.type === 'PAINT'
    && !validPaintList(value.paints, state)) return false;
  if (value.type === 'EFFECT'
    && !validEffectList(value.effects, state)) return false;
  if (value.type === 'GRID'
    && !validGridList(value.layoutGrids, state)) return false;
  if (value.type === 'TEXT' && !validTextFacts(value, state)) return false;
  const boundedProjection = value.type === 'GRID'
    ? {
      ...value,
      layoutGrids: value.layoutGrids.map((grid) => (
        validTaggedScalar(grid.count) ? { ...grid, count: 0 } : grid
      )),
    }
    : value;
  return boundedFigmaValue(boundedProjection, 0, { values: 0 });
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeStyleFacts(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeStyleFacts requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(styleFactsCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_STYLE_FACTS_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Facts returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Style Facts returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Style Facts returned an invalid bounded result.');
  }
  const { schemaVersion: _schemaVersion, resolution: _resolution, ...projection } = payload;
  return { stdout: safePrettyJson(projection), stderr: '', result: payload };
}

export function styleFactsPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Style Facts routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === STYLE_FACTS_APPLICATION_ID
    ? 'command-application' : 'not-style-facts';
}

export async function executeStyleFactsPlan(plan, adapters = {}) {
  if (styleFactsPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Style Facts Command Application.`);
  }
  return executeStyleFacts(parseStyleFactsRequest(plan.argv), adapters);
}
