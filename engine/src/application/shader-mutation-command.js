// Freshly verified Shader materialization and field mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_SHADER_ID_CODE_UNITS,
  MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS,
  MAX_SHADER_PROPERTIES_CODE_UNITS,
  MAX_SHADER_PROPERTY_DEPTH,
  MAX_SHADER_PROPERTY_ENTRIES,
  MAX_SHADER_PROPERTY_STRING_CODE_UNITS,
  MAX_SHADER_PROPERTY_VALUES,
  SHADER_MUTATION_ACTIONS,
  parseShaderMutationRequest,
  shaderMutationArgvFromRequest,
  shaderMutationPlanningArgvFromRequest,
} from './shader-mutation-request.js';

export { shaderMutationArgvFromRequest, shaderMutationPlanningArgvFromRequest } from './shader-mutation-request.js';
export const MAX_SHADER_MUTATION_RESULT_CODE_UNITS = 500_000;
export { MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS } from './shader-mutation-request.js';
const APPLICATION_IDS = new Set(SHADER_MUTATION_ACTIONS.map((action) => `shader.${action}`));
const DEFINITION_TYPES = Object.freeze(['BOOLEAN','TEXT','NUMBER','IMAGE','INSTANCE_SWAP','SLOT','COLOR','POINT','LINE','CIRCLE','CIRCLE_POINT','COLOR_POINT','GRADIENT']);
const normalized = (request) => parseShaderMutationRequest(shaderMutationArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function shaderMutationCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_SHADER_MUTATION_RESULT_CODE_UNITS}) throw new Error('Shader Mutation result exceeded its bounded response limit.'); return serialized; };
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
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const warnings = [];
    const shaderFacts = (shader) => {
      if (!shader || typeof shader !== 'object' || typeof shader.id !== 'string' || !shader.id.length || shader.id.length > ${MAX_SHADER_ID_CODE_UNITS} || !['fill','effect'].includes(shader.type) || typeof shader.imported !== 'boolean') throw new Error('Shader identity is invalid.');
      let propertyDefinitions = null;
      if (shader.propertyDefinitions !== undefined) {
        if (!shader.propertyDefinitions || typeof shader.propertyDefinitions !== 'object' || Array.isArray(shader.propertyDefinitions)) throw new Error('Shader property definitions are invalid.');
        const entries = Object.entries(shader.propertyDefinitions); if (entries.length > ${MAX_SHADER_PROPERTY_ENTRIES}) throw new Error('Shader property definition limit exceeded.'); propertyDefinitions = {};
        for (const [id, definition] of entries) {
          if (!id.length || id.length > 256 || !definition || typeof definition !== 'object' || !${js(DEFINITION_TYPES)}.includes(definition.type)) throw new Error('Shader property definition is invalid.');
          const rawDescription = typeof definition.description === 'string' ? definition.description : '';
          if (rawDescription.length > ${MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS}) warnings.push('A Shader property description was truncated to the bounded response limit.');
          propertyDefinitions[clean(id, 256)] = { name: clean(String(definition.name || ''), 1024), type: definition.type, ...(Object.prototype.hasOwnProperty.call(definition, 'defaultValue') ? { defaultValue: json(definition.defaultValue, 'Shader default value') } : {}), description: clean(rawDescription, ${MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS}) };
        }
      }
      return { id: clean(shader.id, ${MAX_SHADER_ID_CODE_UNITS}), name: clean(String(shader.name || ''), 1024), type: shader.type, imported: shader.imported, propertyDefinitions };
    };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: request.action, outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const failure = (outcome, error, residue = []) => bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome, attempted: 1, restored: outcome === 'rolled-back' ? 1 : 0, residue, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Shader mutation verification failed.' });
    if (request.action === 'import') {
      try { if (typeof figma.listAvailableShaders !== 'function' || typeof figma.importShaderById !== 'function') throw new Error('Shaders are unavailable in this Figma editor.'); }
      catch (error) { return refusal(error); }
      let imported; try { imported = await figma.importShaderById(request.shaderId); } catch (error) { return failure('verification-unavailable', error); }
      try {
        if (!imported || imported.id !== request.shaderId || imported.imported !== true) throw new Error('Native Shader import returned an incompatible identity.');
        const available = await figma.listAvailableShaders();
        if (!Array.isArray(available) || available.length > 10_000) throw new Error('Fresh Shader inventory is unavailable.');
        const matches = available.filter((shader) => shader && shader.id === request.shaderId);
        if (matches.length !== 1 || matches[0].imported !== true) throw new Error('Fresh Shader import identity could not be verified.');
        const shader = shaderFacts(matches[0]);
        if (shader.id !== request.shaderId || shader.type !== imported.type) throw new Error('Fresh Shader facts disagree with the imported identity.');
        return bounded({ schemaVersion: 1, status: 'imported', action: request.action, outcome: 'verified', attempted: 1, shader, residue: [], warnings });
      } catch (error) { return failure('verification-unavailable', error); }
    }
    let node, shader, before, fieldName;
    try {
      if (figma.editorType !== 'figma') throw new Error('Shaders are only available in Figma Design.');
      if (typeof figma.listAvailableShaders !== 'function' || typeof figma.getNodeByIdAsync !== 'function') throw new Error('Shaders are unavailable in this Figma editor.');
      node = await figma.getNodeByIdAsync(request.nodeId); if (!node) throw new Error('Target node was not found.');
      const available = await figma.listAvailableShaders(); if (!Array.isArray(available) || available.length > 10_000) throw new Error('Shader inventory is unavailable.');
      const matches = available.filter((candidate) => candidate && candidate.id === request.shaderId);
      if (matches.length !== 1) throw new Error('Shader id must resolve exactly once.'); shader = shaderFacts(matches[0]);
      if (!shader.imported) throw new Error('Shader is not imported; run shader import first.');
      if (request.field === 'effect' ? shader.type !== 'effect' : shader.type !== 'fill') throw new Error('Shader type is incompatible with the requested field.');
      if (request.properties !== null) {
        if (!shader.propertyDefinitions) throw new Error('Shader property definitions are unavailable.');
        for (const key of Object.keys(request.properties)) if (!Object.prototype.hasOwnProperty.call(shader.propertyDefinitions, key)) throw new Error('Shader property id is not declared.');
      }
      fieldName = request.field === 'effect' ? 'effects' : request.field === 'fill' ? 'fills' : 'strokes';
      if (!(fieldName in node) || node[fieldName] === figma.mixed || !Array.isArray(node[fieldName])) throw new Error('Target node does not support a uniform Shader field.');
      before = json(node[fieldName], 'Shader field snapshot');
    } catch (error) { return refusal(error); }
    const paint = { type: 'SHADER', id: request.shaderId, ...(request.properties === null ? {} : { properties: request.properties }), ...(request.field === 'effect' ? { visible: true } : {}) };
    const desired = request.replace ? [paint] : [...before, paint]; let mutationError = null;
    try { node[fieldName] = desired; } catch (error) { mutationError = error; }
    const postcondition = (after) => {
      if (!Array.isArray(after) || after.length !== desired.length) return false;
      if (!request.replace && !before.every((value, index) => same(value, after[index]))) return false;
      const candidate = after[after.length - 1];
      if (!candidate || candidate.type !== 'SHADER' || candidate.id !== request.shaderId) return false;
      if (request.field === 'effect' && candidate.visible !== true) return false;
      if (request.properties !== null) {
        if (!candidate.properties || typeof candidate.properties !== 'object') return false;
        for (const [key, value] of Object.entries(request.properties)) if (!same(candidate.properties[key], value)) return false;
      }
      return true;
    };
    try {
      const fresh = await figma.getNodeByIdAsync(request.nodeId); if (!fresh || !(fieldName in fresh) || fresh[fieldName] === figma.mixed) throw new Error('Fresh Shader target is unavailable.');
      const after = json(fresh[fieldName], 'Fresh Shader field');
      if (postcondition(after)) return bounded({ schemaVersion: 1, status: 'applied', action: request.action, outcome: mutationError ? 'verified-after-error' : 'verified', attempted: 1, node: { id: clean(fresh.id, 512), name: clean(String(fresh.name || ''), 1024), type: clean(String(fresh.type || ''), 64) }, shader, field: request.field, count: after.length, residue: [], warnings: mutationError ? ['The native Shader assignment reported an error, but fresh readback proved the requested state.'] : warnings });
    } catch (error) { mutationError ||= error; }
    try { node[fieldName] = before; } catch {}
    try {
      const restoredNode = await figma.getNodeByIdAsync(request.nodeId); const restored = restoredNode && fieldName in restoredNode && restoredNode[fieldName] !== figma.mixed && same(json(restoredNode[fieldName], 'Restored Shader field'), before);
      return failure(restored ? 'rolled-back' : 'partial-residue', mutationError || new Error('Fresh Shader postcondition failed.'), restored ? [] : [request.field]);
    } catch (error) { return failure('verification-unavailable', mutationError || error); }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, maximum, empty = true) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
function boundedJson(value, depth, state) {
  state.values += 1; if (state.values > MAX_SHADER_PROPERTY_VALUES || depth > MAX_SHADER_PROPERTY_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_SHADER_PROPERTY_STRING_CODE_UNITS;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length <= MAX_SHADER_PROPERTY_ENTRIES && value.every((item) => boundedJson(item, depth + 1, state));
  const keys = Object.keys(value); return Object.getPrototypeOf(value) === Object.prototype && keys.length <= MAX_SHADER_PROPERTY_ENTRIES && keys.every((key) => key.length > 0 && key.length <= 256 && boundedJson(value[key], depth + 1, state));
}
function shaderValue(value, input) {
  if (!exact(value, ['id','name','type','imported','propertyDefinitions']) || value.id !== input.shaderId || !text(value.name, 1024) || !['fill','effect'].includes(value.type) || value.imported !== true) return false;
  if (value.propertyDefinitions === null) return true;
  if (!value.propertyDefinitions || typeof value.propertyDefinitions !== 'object' || Array.isArray(value.propertyDefinitions)) return false;
  const entries = Object.entries(value.propertyDefinitions); if (entries.length > MAX_SHADER_PROPERTY_ENTRIES) return false;
  return entries.every(([id, definition]) => text(id, 256, false) && exact(definition, ['name','type','description',...(Object.hasOwn(definition, 'defaultValue') ? ['defaultValue'] : [])]) && text(definition.name, 1024) && DEFINITION_TYPES.includes(definition.type) && text(definition.description, MAX_SHADER_DEFINITION_DESCRIPTION_CODE_UNITS) && (!Object.hasOwn(definition, 'defaultValue') || boundedJson(definition.defaultValue, 0, { values: 0 })));
}
function nodeValue(value, input) { return exact(value, ['id','name','type']) && value.id === input.nodeId && text(value.name, 1024) && text(value.type, 64, false); }
function validRefusal(value, input) { return exact(value, ['schemaVersion','status','action','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.action === input.action && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validFailure(value, input) { return exact(value, ['schemaVersion','status','action','outcome','attempted','restored','residue','failure']) && value.schemaVersion === 1 && value.status === 'failed' && value.action === input.action && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && Array.isArray(value.residue) && value.residue.every((item) => item === input.field) && value.residue.length <= 1 && text(value.failure, 1024, false) && (value.outcome === 'rolled-back' ? value.restored === 1 && !value.residue.length : value.restored === 0) && (value.outcome === 'partial-residue' ? value.residue.length === 1 : value.outcome === 'verification-unavailable' ? !value.residue.length : true); }
function validSuccess(value, input) {
  const common = value?.schemaVersion === 1 && value.action === input.action && ['verified','verified-after-error'].includes(value.outcome) && value.attempted === 1 && shaderValue(value.shader, input) && Array.isArray(value.residue) && !value.residue.length && Array.isArray(value.warnings) && value.warnings.every((warning) => text(warning, 1024, false));
  if (input.action === 'import') return exact(value, ['schemaVersion','status','action','outcome','attempted','shader','residue','warnings']) && common && value.status === 'imported' && value.outcome === 'verified';
  return exact(value, ['schemaVersion','status','action','outcome','attempted','node','shader','field','count','residue','warnings']) && common && value.status === 'applied' && nodeValue(value.node, input) && value.field === input.field && Number.isSafeInteger(value.count) && value.count >= 1 && value.count <= MAX_SHADER_PROPERTY_VALUES;
}
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' }); return error; }
function safe(value) { return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function legacy(payload) { return payload.action === 'import' ? payload.shader : { node: payload.node, shader: payload.shader, field: payload.field, count: payload.count }; }

export async function executeShaderMutation(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Shader Mutation requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(shaderMutationCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SHADER_MUTATION_RESULT_CODE_UNITS) throw invalid('Shader Mutation returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Shader Mutation returned invalid JSON.'); }
  if (payload?.status === 'refused') { if (!validRefusal(payload, input)) throw invalid('Shader Mutation returned an invalid bounded result.'); throw mutationError(`Shader Mutation made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); }
  if (payload?.status === 'failed') { if (!validFailure(payload, input)) throw invalid('Shader Mutation returned an invalid bounded result.'); throw mutationError(`Shader Mutation failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length }); }
  if (!validSuccess(payload, input)) throw invalid('Shader Mutation returned an invalid bounded result.');
  return { stdout: safe(legacy(payload)), stderr: '', result: payload };
}
export function shaderMutationPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Shader Mutation routing requires a Command Plan.'); return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-shader-mutation'; }
export function executeShaderMutationPlan(plan, adapters = {}) { if (shaderMutationPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Shader Mutation.'); return executeShaderMutation(parseShaderMutationRequest(plan.argv), adapters); }
