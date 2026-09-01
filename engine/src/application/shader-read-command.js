// Bounded Shader discovery behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_SHADER_ID_CODE_UNITS,
  MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS,
  MAX_SHADER_PROPERTIES_CODE_UNITS,
  MAX_SHADER_PROPERTY_DEPTH,
  MAX_SHADER_PROPERTY_ENTRIES,
  MAX_SHADER_PROPERTY_STRING_CODE_UNITS,
  MAX_SHADER_PROPERTY_VALUES,
} from './shader-mutation-request.js';
import { parseShaderReadRequest, shaderReadArgvFromRequest } from './shader-read-request.js';

export { shaderReadArgvFromRequest } from './shader-read-request.js';
export const MAX_SHADER_READ_ITEMS = 10_000;
export const MAX_SHADER_READ_RESULT_CODE_UNITS = 2_000_000;
const DEFINITION_TYPES = Object.freeze([
  'BOOLEAN', 'TEXT', 'NUMBER', 'IMAGE', 'INSTANCE_SWAP', 'SLOT', 'COLOR',
  'POINT', 'LINE', 'CIRCLE', 'CIRCLE_POINT', 'COLOR_POINT', 'GRADIENT',
]);
const APPLICATION_ID = 'shader.list';
const normalized = (request) => parseShaderReadRequest(shaderReadArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function shaderReadCode(request = {}) {
  normalized(request);
  return `(async () => {
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (value) => { const serialized = JSON.stringify(value); if (serialized.length > ${MAX_SHADER_READ_RESULT_CODE_UNITS}) throw new Error('Shader Read result exceeded its bounded response limit.'); return serialized; };
    const json = (value, label) => {
      let values = 0; const seen = new Set();
      const visit = (item, depth = 0) => {
        values++; if (values > ${MAX_SHADER_PROPERTY_VALUES}) throw new Error(label + ' value limit exceeded.');
        if (depth > ${MAX_SHADER_PROPERTY_DEPTH}) throw new Error(label + ' depth limit exceeded.');
        if (item === null || typeof item === 'boolean') return item;
        if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error(label + ' contains a non-finite number.'); return item; }
        if (typeof item === 'string') { if (item.length > ${MAX_SHADER_PROPERTY_STRING_CODE_UNITS}) throw new Error(label + ' string limit exceeded.'); return clean(item, ${MAX_SHADER_PROPERTY_STRING_CODE_UNITS}); }
        if (!item || typeof item !== 'object' || seen.has(item)) throw new Error(label + ' must contain acyclic JSON values.');
        seen.add(item); let copy;
        if (Array.isArray(item)) { if (item.length > ${MAX_SHADER_PROPERTY_ENTRIES}) throw new Error(label + ' array limit exceeded.'); copy = item.map((child) => visit(child, depth + 1)); }
        else { const keys = Object.keys(item); if (keys.length > ${MAX_SHADER_PROPERTY_ENTRIES}) throw new Error(label + ' object limit exceeded.'); copy = {}; for (const key of keys) { if (!key.length || key.length > 256) throw new Error(label + ' key limit exceeded.'); copy[clean(key, 256)] = visit(item[key], depth + 1); } }
        seen.delete(item); return copy;
      };
      const copy = visit(value); if (JSON.stringify(copy).length > ${MAX_SHADER_PROPERTIES_CODE_UNITS}) throw new Error(label + ' serialized-size limit exceeded.'); return copy;
    };
    const facts = (shader) => {
      if (!shader || typeof shader.id !== 'string' || !shader.id.length || shader.id.length > ${MAX_SHADER_ID_CODE_UNITS} || typeof shader.name !== 'string' || shader.name.length > 1024 || !['fill','effect'].includes(shader.type) || typeof shader.imported !== 'boolean') throw new Error('Shader identity is invalid.');
      let propertyDefinitions = null;
      if (shader.propertyDefinitions !== undefined && shader.propertyDefinitions !== null) {
        if (typeof shader.propertyDefinitions !== 'object' || Array.isArray(shader.propertyDefinitions)) throw new Error('Shader property definitions are invalid.');
        const entries = Object.entries(shader.propertyDefinitions); if (entries.length > ${MAX_SHADER_PROPERTY_ENTRIES}) throw new Error('Shader property definition limit exceeded.'); propertyDefinitions = {};
        for (const [id, definition] of entries) {
          if (!id.length || id.length > 256 || !definition || typeof definition !== 'object' || Array.isArray(definition) || typeof definition.name !== 'string' || definition.name.length > 1024 || !${js(DEFINITION_TYPES)}.includes(definition.type) || definition.description !== undefined && (typeof definition.description !== 'string' || definition.description.length > ${MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS})) throw new Error('Shader property definition is invalid.');
          propertyDefinitions[clean(id, 256)] = { name: clean(definition.name, 1024), type: definition.type, ...(definition.defaultValue !== undefined ? { defaultValue: json(definition.defaultValue, 'Shader default value') } : {}), ...(definition.description !== undefined ? { description: clean(definition.description, ${MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS}) } : {}) };
        }
      }
      return { id: clean(shader.id, ${MAX_SHADER_ID_CODE_UNITS}), name: clean(shader.name, 1024), type: shader.type, imported: shader.imported, propertyDefinitions };
    };
    if (typeof figma.listAvailableShaders !== 'function') throw new Error('Shaders are unavailable in this Figma editor.');
    const shaders = await figma.listAvailableShaders();
    if (!Array.isArray(shaders) || shaders.length > ${MAX_SHADER_READ_ITEMS}) throw new Error('Shader inventory exceeded its bounded item limit.');
    const result = shaders.map(facts);
    if (new Set(result.map((shader) => shader.id)).size !== result.length) throw new Error('Shader ids must be unique.');
    return bounded(result);
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
const text = (value, maximum, empty = true) => typeof value === 'string'
  && value.length <= maximum && (empty || value.length > 0);
function boundedJson(value, depth, state) {
  state.values += 1;
  if (state.values > MAX_SHADER_PROPERTY_VALUES || depth > MAX_SHADER_PROPERTY_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_SHADER_PROPERTY_STRING_CODE_UNITS;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length <= MAX_SHADER_PROPERTY_ENTRIES
    && value.every((item) => boundedJson(item, depth + 1, state));
  const keys = Object.keys(value);
  return Object.getPrototypeOf(value) === Object.prototype && keys.length <= MAX_SHADER_PROPERTY_ENTRIES
    && keys.every((key) => text(key, 256, false) && boundedJson(value[key], depth + 1, state));
}
function definitionValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => ['name', 'type', 'defaultValue', 'description'].includes(key))
    || !keys.includes('name') || !keys.includes('type')) return false;
  return text(value.name, 1024) && DEFINITION_TYPES.includes(value.type)
    && (!Object.hasOwn(value, 'description')
      || text(value.description, MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS))
    && (!Object.hasOwn(value, 'defaultValue')
      || boundedJson(value.defaultValue, 0, { values: 0 }));
}
function shaderValue(value) {
  if (!exact(value, ['id', 'name', 'type', 'imported', 'propertyDefinitions'])
    || !text(value.id, MAX_SHADER_ID_CODE_UNITS, false) || !text(value.name, 1024)
    || !['fill', 'effect'].includes(value.type) || typeof value.imported !== 'boolean') return false;
  if (value.propertyDefinitions === null) return true;
  if (!value.propertyDefinitions || typeof value.propertyDefinitions !== 'object'
    || Array.isArray(value.propertyDefinitions)) return false;
  const entries = Object.entries(value.propertyDefinitions);
  return entries.length <= MAX_SHADER_PROPERTY_ENTRIES
    && entries.every(([id, definition]) => text(id, 256, false) && definitionValue(definition));
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed',
  });
  return error;
}
function safe(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function executeShaderRead(request = {}, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Shader Read requires a Figma evaluate adapter.');
  normalized(request);
  const serialized = await adapters.evaluate(shaderReadCode(request));
  if (typeof serialized !== 'string' || serialized.length > MAX_SHADER_READ_RESULT_CODE_UNITS) {
    throw invalid('Shader Read returned an invalid bounded result.');
  }
  let result;
  try { result = JSON.parse(serialized); } catch { throw invalid('Shader Read returned invalid JSON.'); }
  if (!Array.isArray(result) || result.length > MAX_SHADER_READ_ITEMS || !result.every(shaderValue)
    || new Set(result.map((shader) => shader.id)).size !== result.length) {
    throw invalid('Shader Read returned an invalid bounded result.');
  }
  return { stdout: safe(result), stderr: '', result };
}

export function shaderReadPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Shader Read routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-shader-read';
}

export function executeShaderReadPlan(plan, adapters = {}) {
  if (shaderReadPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Shader Read.');
  return executeShaderRead(parseShaderReadRequest(plan.argv), adapters);
}
