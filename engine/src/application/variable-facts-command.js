// Exact bounded Variable Facts Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseVariableFactsRequest,
  variableFactsArgvFromRequest,
} from './variable-facts-request.js';
import { isComposedColorValue } from '../lib/variable-values.js';

export { variableFactsArgvFromRequest } from './variable-facts-request.js';

const VARIABLE_FACTS_APPLICATION_ID = 'var.show';
export const MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS = 500_000;
export const MAX_VARIABLE_FACTS_DEPTH = 16;
export const MAX_VARIABLE_FACTS_CONTAINER_ENTRIES = 512;
export const MAX_VARIABLE_FACTS_VALUES = 10_000;
export const MAX_VARIABLE_FACTS_STRING_CODE_UNITS = 65_536;
const MAX_VARIABLE_FACTS_KEY_CODE_UNITS = 128;
const MAX_AMBIGUOUS_LABELS = 8;

const RESOLVED_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
const PUBLISH_STATUSES = new Set(['UNPUBLISHED', 'CURRENT', 'CHANGED']);
const VARIABLE_SCOPES = new Set([
  'ALL_SCOPES', 'TEXT_CONTENT', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP',
  'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR',
  'STROKE_FLOAT', 'EFFECT_FLOAT', 'EFFECT_COLOR', 'OPACITY', 'FONT_FAMILY',
  'FONT_STYLE', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING',
  'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT',
]);
const MOTION_EASINGS = new Set([
  'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK',
  'EASE_OUT_BACK', 'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE',
  'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING', 'HOLD',
]);

function normalizedRequest(request) {
  return parseVariableFactsRequest(variableFactsArgvFromRequest(request));
}

export function variableFactsCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.variable)};
    const collectionHint = ${JSON.stringify(input.collection)};
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    let selectedCollection = null;
    const safeLabel = (value) => String(value == null ? '' : value)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]/g, ' ')
      .slice(0, 256);
    const ambiguous = (kind, value, matches, label) => {
      const shown = matches.slice(0, ${MAX_AMBIGUOUS_LABELS}).map(label);
      const remainder = matches.length - shown.length;
      throw new Error('Ambiguous ' + kind + ' "' + safeLabel(value) + '": '
        + matches.length + ' matches (' + shown.join(', ')
        + (remainder > 0 ? ', +' + remainder + ' more' : '') + ')');
    };
    const resolveCollection = async (value) => {
      let direct = null;
      try { direct = await figma.variables.getVariableCollectionByIdAsync(value); } catch {}
      if (direct) return direct;
      const exact = collections.filter((item) => item.name === value);
      const matches = exact.length ? exact : collections.filter((item) =>
        item.name.toLowerCase().includes(String(value).toLowerCase()));
      if (matches.length > 1) ambiguous('collection', value, matches,
        (item) => safeLabel(item.name));
      if (!matches.length) throw new Error('Collection not found: ' + safeLabel(value));
      return matches[0];
    };
    if (collectionHint !== null) selectedCollection = await resolveCollection(collectionHint);

    let variable = null;
    try { variable = await figma.variables.getVariableByIdAsync(query); } catch {}
    if (variable && selectedCollection
      && variable.variableCollectionId !== selectedCollection.id) {
      throw new Error('Variable is not in collection: ' + safeLabel(collectionHint));
    }
    if (!variable) {
      let pool = await figma.variables.getLocalVariablesAsync();
      if (selectedCollection) {
        pool = pool.filter((item) => item.variableCollectionId === selectedCollection.id);
      }
      const exact = pool.filter((item) => item.name === query);
      const tail = pool.filter((item) => item.name.endsWith('/' + query));
      const partial = pool.filter((item) =>
        item.name.toLowerCase().includes(String(query).toLowerCase()));
      const matches = exact.length ? exact : (tail.length ? tail : partial);
      if (matches.length > 1) ambiguous('variable', query, matches, (item) => {
        const collection = collections.find((candidate) =>
          candidate.id === item.variableCollectionId);
        return safeLabel((collection ? collection.name + '/' : '') + item.name);
      });
      if (!matches.length) throw new Error('Variable not found: ' + safeLabel(query));
      variable = matches[0];
    }

    let collection = selectedCollection || collections.find((item) =>
      item.id === variable.variableCollectionId) || null;
    if (!collection) {
      collection = await figma.variables.getVariableCollectionByIdAsync(
        variable.variableCollectionId,
      );
    }
    const payload = {
      schemaVersion: 1,
      id: variable.id,
      key: variable.key || null,
      name: variable.name,
      description: variable.description || '',
      resolvedType: variable.resolvedType,
      remote: !!variable.remote,
      variableCollectionId: variable.variableCollectionId,
      collection: collection ? { id: collection.id, name: collection.name } : null,
      hiddenFromPublishing: !!variable.hiddenFromPublishing,
      scopes: variable.scopes,
      codeSyntax: variable.codeSyntax,
      valuesByMode: variable.valuesByMode,
      modes: collection ? collection.modes.map((mode) => ({
        modeId: mode.modeId,
        name: mode.name,
      })) : [],
      publishStatus: await variable.getPublishStatusAsync(),
    };

    let values = 0;
    const seen = new Set();
    const verify = (value, depth = 0) => {
      values++;
      if (values > ${MAX_VARIABLE_FACTS_VALUES}) {
        throw new Error('Variable Facts value limit exceeded.');
      }
      if (depth > ${MAX_VARIABLE_FACTS_DEPTH}) {
        throw new Error('Variable Facts depth limit exceeded.');
      }
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Variable Facts contain a non-finite number.');
        return;
      }
      if (typeof value === 'string') {
        if (value.length > ${MAX_VARIABLE_FACTS_STRING_CODE_UNITS}) {
          throw new Error('Variable Facts string limit exceeded.');
        }
        return;
      }
      if (typeof value !== 'object') throw new Error('Variable Facts contain a non-JSON value.');
      if (seen.has(value)) throw new Error('Variable Facts contain a cycle.');
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length > ${MAX_VARIABLE_FACTS_CONTAINER_ENTRIES}) {
          throw new Error('Variable Facts array limit exceeded.');
        }
        for (const item of value) verify(item, depth + 1);
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error('Variable Facts contain a non-plain object.');
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new Error('Variable Facts contain symbol properties.');
        }
        const keys = Object.keys(value);
        if (keys.length > ${MAX_VARIABLE_FACTS_CONTAINER_ENTRIES}) {
          throw new Error('Variable Facts object limit exceeded.');
        }
        for (const key of keys) {
          if (key.length > ${MAX_VARIABLE_FACTS_KEY_CODE_UNITS}) {
            throw new Error('Variable Facts key limit exceeded.');
          }
          verify(value[key], depth + 1);
        }
      }
      seen.delete(value);
    };
    verify(payload);
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS}) {
      throw new Error('Variable Facts serialized-size limit exceeded.');
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

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string'
    && (empty || value.length > 0)
    && value.length <= MAX_VARIABLE_FACTS_STRING_CODE_UNITS;
}

function finiteUnit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function variableAlias(value) {
  return exactKeys(value, ['type', 'id'])
    && value.type === 'VARIABLE_ALIAS' && boundedString(value.id, { empty: false });
}

function colorValue(value) {
  const rgb = exactKeys(value, ['r', 'g', 'b']);
  const rgba = exactKeys(value, ['r', 'g', 'b', 'a']);
  return (rgb || rgba) && finiteUnit(value.r) && finiteUnit(value.g)
    && finiteUnit(value.b) && (!rgba || finiteUnit(value.a));
}

function easingValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !MOTION_EASINGS.has(value.type)) return false;
  const allowed = new Set(['type', 'easingFunctionCubicBezier', 'easingFunctionSpring']);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  if (value.easingFunctionCubicBezier !== undefined) {
    const bezier = value.easingFunctionCubicBezier;
    if (!exactKeys(bezier, ['x1', 'y1', 'x2', 'y2'])
      || !finiteUnit(bezier.x1) || !finiteUnit(bezier.x2)
      || !finiteNumber(bezier.y1) || !finiteNumber(bezier.y2)) return false;
  }
  if (value.easingFunctionSpring !== undefined) {
    const spring = value.easingFunctionSpring;
    if (!exactKeys(spring, ['bounce']) || !finiteUnit(spring.bounce)) return false;
  }
  return true;
}

function valueForType(value, resolvedType) {
  if (variableAlias(value)) return true;
  if (resolvedType === 'BOOLEAN') return typeof value === 'boolean';
  if (resolvedType === 'COLOR') return colorValue(value) || isComposedColorValue(value);
  if (resolvedType === 'EASING') return easingValue(value);
  if (resolvedType === 'FLOAT' || resolvedType === 'TIMING') {
    return finiteNumber(value);
  }
  return resolvedType === 'STRING' && boundedString(value);
}

function boundedJsonValue(value, depth, state) {
  state.values++;
  if (state.values > MAX_VARIABLE_FACTS_VALUES || depth > MAX_VARIABLE_FACTS_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_VARIABLE_FACTS_STRING_CODE_UNITS;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_VARIABLE_FACTS_CONTAINER_ENTRIES
      && value.every((item) => boundedJsonValue(item, depth + 1, state));
  }
  const keys = Object.keys(value);
  return Object.getPrototypeOf(value) === Object.prototype
    && keys.length <= MAX_VARIABLE_FACTS_CONTAINER_ENTRIES
    && keys.every((key) => key.length <= MAX_VARIABLE_FACTS_KEY_CODE_UNITS
      && boundedJsonValue(value[key], depth + 1, state));
}

export function isVariableFactsPayload(value) {
  if (!exactKeys(value, [
    'schemaVersion', 'id', 'key', 'name', 'description', 'resolvedType', 'remote',
    'variableCollectionId', 'collection', 'hiddenFromPublishing', 'scopes',
    'codeSyntax', 'valuesByMode', 'modes', 'publishStatus',
  ]) || value.schemaVersion !== 1
    || !boundedString(value.id, { empty: false })
    || !(value.key === null || boundedString(value.key, { empty: false }))
    || !boundedString(value.name, { empty: false }) || !boundedString(value.description)
    || !RESOLVED_TYPES.has(value.resolvedType)
    || typeof value.remote !== 'boolean'
    || !boundedString(value.variableCollectionId, { empty: false })
    || !exactKeys(value.collection, ['id', 'name'])
    || value.collection.id !== value.variableCollectionId
    || !boundedString(value.collection.name, { empty: false })
    || typeof value.hiddenFromPublishing !== 'boolean'
    || !Array.isArray(value.scopes) || !value.scopes.every((scope) => VARIABLE_SCOPES.has(scope))
    || !value.codeSyntax || typeof value.codeSyntax !== 'object'
    || Array.isArray(value.codeSyntax)
    || !Object.keys(value.codeSyntax).every((platform) =>
      ['WEB', 'ANDROID', 'iOS'].includes(platform) && boundedString(value.codeSyntax[platform]))
    || !value.valuesByMode || typeof value.valuesByMode !== 'object'
    || Array.isArray(value.valuesByMode)
    || !Array.isArray(value.modes)
    || value.modes.length > MAX_VARIABLE_FACTS_CONTAINER_ENTRIES
    || !PUBLISH_STATUSES.has(value.publishStatus)) return false;

  const modeIds = new Set();
  for (const mode of value.modes) {
    if (!exactKeys(mode, ['modeId', 'name'])
      || !boundedString(mode.modeId, { empty: false }) || !boundedString(mode.name, { empty: false })
      || modeIds.has(mode.modeId)) return false;
    modeIds.add(mode.modeId);
  }
  const values = Object.entries(value.valuesByMode);
  if (values.length > MAX_VARIABLE_FACTS_CONTAINER_ENTRIES
    || !values.every(([modeId, modeValue]) => modeId.length <= MAX_VARIABLE_FACTS_KEY_CODE_UNITS
      && modeIds.has(modeId) && valueForType(modeValue, value.resolvedType))) return false;
  return boundedJsonValue(value, 0, { values: 0 });
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeVariableFacts(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableFacts requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableFactsCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Facts returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error('Variable Facts returned an invalid bounded result.');
  }
  if (!isVariableFactsPayload(payload)) {
    throw new Error('Variable Facts returned an invalid bounded result.');
  }
  return { stdout: safePrettyJson(variableFactsLegacyProjection(payload)), stderr: '', result: payload };
}

export function variableFactsLegacyProjection(payload) {
  if (!isVariableFactsPayload(payload)) {
    throw new Error('Variable Facts projection requires a valid bounded payload.');
  }
  const { schemaVersion: _schemaVersion, ...legacyProjection } = payload;
  return legacyProjection;
}

export function variableFactsPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Facts routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_FACTS_APPLICATION_ID
    ? 'command-application'
    : 'not-variable-facts';
}

export async function executeVariableFactsPlan(plan, adapters = {}) {
  if (variableFactsPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Variable Facts Command Application.`);
  }
  return executeVariableFacts(parseVariableFactsRequest(plan.argv), adapters);
}
