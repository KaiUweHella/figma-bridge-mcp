// Exact bounded Variable Resolution Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseVariableResolutionRequest,
  variableResolutionArgvFromRequest,
  variableResolutionPlanningArgvFromRequest,
} from './variable-resolution-request.js';

export {
  variableResolutionArgvFromRequest,
  variableResolutionPlanningArgvFromRequest,
} from './variable-resolution-request.js';

const VARIABLE_RESOLUTION_APPLICATION_ID = 'var.resolve';
export const MAX_VARIABLE_RESOLUTION_SERIALIZED_CODE_UNITS = 100_000;
export const MAX_VARIABLE_RESOLUTION_STRING_CODE_UNITS = 65_536;
const MAX_AMBIGUOUS_LABELS = 8;
const RESOLVED_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
const MOTION_EASINGS = new Set([
  'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK',
  'EASE_OUT_BACK', 'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE',
  'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING', 'HOLD',
]);

function normalizedRequest(request) {
  return parseVariableResolutionRequest(variableResolutionArgvFromRequest(request));
}

export function variableResolutionCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.variable)};
    const collectionHint = ${JSON.stringify(input.collection)};
    const nodeId = ${JSON.stringify(input.nodeId)};
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
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
    const selectedCollection = collectionHint === null
      ? null : await resolveCollection(collectionHint);
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
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
      throw new Error('Scene node not found: ' + safeLabel(nodeId));
    }
    const collection = selectedCollection || collections.find((item) =>
      item.id === variable.variableCollectionId)
      || await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    if (!collection) throw new Error('Variable collection not found for: ' + safeLabel(query));
    const payload = {
      schemaVersion: 1,
      variable: {
        id: variable.id,
        name: variable.name,
        resolvedType: variable.resolvedType,
        collection: { id: collection.id, name: collection.name },
      },
      consumer: { id: node.id, name: node.name, type: node.type },
      resolved: variable.resolveForConsumer(node),
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_VARIABLE_RESOLUTION_SERIALIZED_CODE_UNITS}) {
      throw new Error('Variable Resolution serialized-size limit exceeded.');
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
  return typeof value === 'string' && (empty || value.length > 0)
    && value.length <= MAX_VARIABLE_RESOLUTION_STRING_CODE_UNITS;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteUnit(value) {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

function variableAlias(value) {
  return exactKeys(value, ['type', 'id']) && value.type === 'VARIABLE_ALIAS'
    && boundedString(value.id, { empty: false });
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
  if (resolvedType === 'COLOR') return colorValue(value);
  if (resolvedType === 'EASING') return easingValue(value);
  if (resolvedType === 'FLOAT' || resolvedType === 'TIMING') return finiteNumber(value);
  return resolvedType === 'STRING' && boundedString(value);
}

function validPayload(value) {
  if (!exactKeys(value, ['schemaVersion', 'variable', 'consumer', 'resolved'])
    || value.schemaVersion !== 1
    || !exactKeys(value.variable, ['id', 'name', 'resolvedType', 'collection'])
    || !boundedString(value.variable.id, { empty: false })
    || !boundedString(value.variable.name, { empty: false })
    || !RESOLVED_TYPES.has(value.variable.resolvedType)
    || !exactKeys(value.variable.collection, ['id', 'name'])
    || !boundedString(value.variable.collection.id, { empty: false })
    || !boundedString(value.variable.collection.name, { empty: false })
    || !exactKeys(value.consumer, ['id', 'name', 'type'])
    || !boundedString(value.consumer.id, { empty: false })
    || !boundedString(value.consumer.name)
    || !boundedString(value.consumer.type, { empty: false })
    || !exactKeys(value.resolved, ['value', 'resolvedType'])
    || value.resolved.resolvedType !== value.variable.resolvedType) return false;
  return valueForType(value.resolved.value, value.resolved.resolvedType);
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeVariableResolution(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableResolution requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableResolutionCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_RESOLUTION_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Resolution returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Resolution returned invalid JSON.'); }
  if (!validPayload(payload)) {
    throw new Error('Variable Resolution returned an invalid bounded result.');
  }
  const { schemaVersion: _schemaVersion, ...projection } = payload;
  return { stdout: safePrettyJson(projection), stderr: '', result: payload };
}

export function variableResolutionPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Resolution routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_RESOLUTION_APPLICATION_ID
    ? 'command-application' : 'not-variable-resolution';
}

export async function executeVariableResolutionPlan(plan, adapters = {}) {
  if (variableResolutionPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Variable Resolution Command Application.`);
  }
  return executeVariableResolution(parseVariableResolutionRequest(plan.argv), adapters);
}
