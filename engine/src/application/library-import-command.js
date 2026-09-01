// Irreversible, freshly verified materialization of published library resources.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  LIBRARY_IMPORT_ACTIONS,
  MAX_LIBRARY_IMPORT_KEY_CODE_UNITS,
  libraryImportArgvFromRequest,
  parseLibraryImportRequest,
} from './library-import-request.js';

export { libraryImportArgvFromRequest } from './library-import-request.js';
export const MAX_LIBRARY_IMPORT_RESULT_CODE_UNITS = 32_000;
export const MAX_LIBRARY_IMPORT_DESCRIPTION_CODE_UNITS = 4_096;
const IDS = new Set(LIBRARY_IMPORT_ACTIONS.map((action) => `library.import-${action}`));
const STYLE_TYPES = Object.freeze(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const VARIABLE_TYPES = Object.freeze(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
const normalized = (request) => parseLibraryImportRequest(libraryImportArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function libraryImportCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_LIBRARY_IMPORT_RESULT_CODE_UNITS}) throw new Error('Library Import result exceeded its bounded response limit.'); return serialized; };
    const warning = [];
    const description = (value) => { const text = typeof value === 'string' ? value : ''; if (text.length > ${MAX_LIBRARY_IMPORT_DESCRIPTION_CODE_UNITS}) warning.push('The imported resource description was truncated to the bounded response limit.'); return clean(text, ${MAX_LIBRARY_IMPORT_DESCRIPTION_CODE_UNITS}); };
    const identity = (value, kind) => {
      if (!value || typeof value !== 'object') throw new Error('Imported resource identity is unavailable.');
      const common = { kind, id: clean(value.id, 512), key: clean(value.key, ${MAX_LIBRARY_IMPORT_KEY_CODE_UNITS}), name: clean(String(value.name || ''), 1024), remote: value.remote === true };
      if (!common.id || !common.key) throw new Error('Imported resource identity is incomplete.');
      if (kind === 'VARIABLE') return { ...common, resolvedType: clean(value.resolvedType, 32) };
      return { ...common, type: clean(value.type, 32), description: description(value.description) };
    };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: request.action, outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const failure = (outcome, error, resource = null) => bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome, attempted: 1, restored: 0, resource, residue: outcome === 'partial-residue' ? ['library-resource'] : [], failure: clean(error && error.message ? error.message : String(error), 1024) || 'Library import verification failed.' });
    let importResource, readResource, kind;
    try {
      if (request.action === 'variable') { importResource = figma.variables && figma.variables.importVariableByKeyAsync; readResource = figma.variables && figma.variables.getVariableByIdAsync; kind = 'VARIABLE'; }
      else if (request.action === 'style') { importResource = figma.importStyleByKeyAsync; readResource = figma.getStyleByIdAsync; kind = 'STYLE'; }
      else if (request.action === 'component') { importResource = figma.importComponentByKeyAsync; readResource = figma.getNodeByIdAsync; kind = 'COMPONENT'; }
      else { importResource = figma.importComponentSetByKeyAsync; readResource = figma.getNodeByIdAsync; kind = 'COMPONENT_SET'; }
      if (typeof importResource !== 'function' || typeof readResource !== 'function') throw new Error('This Figma runtime does not support the requested library import.');
      importResource = importResource.bind(request.action === 'variable' ? figma.variables : figma);
      readResource = readResource.bind(request.action === 'variable' ? figma.variables : figma);
      if (request.action === 'variable' && typeof figma.variables.getVariableCollectionByIdAsync !== 'function') throw new Error('This Figma runtime cannot verify an imported Variable collection.');
    } catch (error) { return refusal(error); }
    let imported;
    try { imported = await importResource(request.key); }
    catch (error) { return failure('verification-unavailable', error); }
    let compact = null;
    try {
      if (!imported || typeof imported.id !== 'string' || !imported.id.length || imported.id.length > 512) throw new Error('Native import returned no bounded resource id.');
      const fresh = await readResource(imported.id);
      compact = identity(fresh, kind);
      if (compact.id !== imported.id || compact.key !== request.key || compact.remote !== true) throw new Error('Fresh imported resource identity did not match the requested published key.');
      if (request.action === 'variable') {
        if (!${js(VARIABLE_TYPES)}.includes(compact.resolvedType)) throw new Error('Fresh imported Variable type is invalid.');
        const collectionId = fresh && fresh.variableCollectionId;
        if (typeof collectionId !== 'string' || !collectionId.length || collectionId.length > 512) throw new Error('Fresh imported Variable collection identity is unavailable.');
        const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
        if (!collection || collection.id !== collectionId || typeof collection.key !== 'string' || !collection.key.length || collection.key.length > ${MAX_LIBRARY_IMPORT_KEY_CODE_UNITS} || collection.remote !== true) throw new Error('Fresh imported Variable collection could not be verified.');
        compact.collection = { id: clean(collection.id, 512), key: clean(collection.key, ${MAX_LIBRARY_IMPORT_KEY_CODE_UNITS}), name: clean(String(collection.name || ''), 1024), remote: true };
      } else if (request.action === 'style') {
        if (!${js(STYLE_TYPES)}.includes(compact.type)) throw new Error('Fresh imported Style type is invalid.');
      } else if (compact.type !== kind) throw new Error('Fresh imported component kind is invalid.');
      return bounded({ schemaVersion: 1, status: 'imported', action: request.action, outcome: 'verified', attempted: 1, resource: compact, residue: [], warnings: warning });
    } catch (error) {
      return failure(compact ? 'partial-residue' : 'verification-unavailable', error, compact);
    }
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
const text = (value, maximum, empty = true) => typeof value === 'string'
  && value.length <= maximum && (empty || value.length > 0);
function commonResource(value, input, kind) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.kind === kind && text(value.id, 512, false)
    && value.key === input.key && value.remote === true && text(value.name, 1024);
}
function resourceValue(value, input) {
  if (input.action === 'variable') {
    return exact(value, ['kind','id','key','name','remote','resolvedType','collection'])
      && commonResource(value, input, 'VARIABLE') && VARIABLE_TYPES.includes(value.resolvedType)
      && exact(value.collection, ['id','key','name','remote'])
      && text(value.collection.id, 512, false)
      && text(value.collection.key, MAX_LIBRARY_IMPORT_KEY_CODE_UNITS, false)
      && text(value.collection.name, 1024) && value.collection.remote === true;
  }
  const kind = input.action === 'style' ? 'STYLE'
    : input.action === 'component' ? 'COMPONENT' : 'COMPONENT_SET';
  return exact(value, ['kind','id','key','name','remote','type','description'])
    && commonResource(value, input, kind)
    && text(value.type, 32, false) && text(value.description, MAX_LIBRARY_IMPORT_DESCRIPTION_CODE_UNITS)
    && (input.action === 'style' ? STYLE_TYPES.includes(value.type) : value.type === kind);
}
function partialResource(value, input) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = input.action === 'variable' ? 'VARIABLE' : input.action === 'style' ? 'STYLE'
    : input.action === 'component' ? 'COMPONENT' : 'COMPONENT_SET';
  const shape = input.action === 'variable'
    ? exact(value, ['kind','id','key','name','remote','resolvedType'])
      && text(value.resolvedType, 32)
    : exact(value, ['kind','id','key','name','remote','type','description'])
      && text(value.type, 32) && text(value.description, MAX_LIBRARY_IMPORT_DESCRIPTION_CODE_UNITS);
  return shape && value.kind === kind && text(value.id, 512, false)
    && text(value.key, MAX_LIBRARY_IMPORT_KEY_CODE_UNITS, false)
    && text(value.name, 1024) && typeof value.remote === 'boolean';
}
function validRefusal(value, input) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.action === input.action
    && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false);
}
function validSuccess(value, input) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','resource','residue','warnings'])
    && value.schemaVersion === 1 && value.status === 'imported' && value.action === input.action
    && value.outcome === 'verified' && value.attempted === 1 && resourceValue(value.resource, input)
    && Array.isArray(value.residue) && !value.residue.length
    && Array.isArray(value.warnings) && value.warnings.length <= 1
    && value.warnings.every((warning) => text(warning, 1024, false));
}
function validFailure(value, input) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','restored','resource','residue','failure'])
    && value.schemaVersion === 1 && value.status === 'failed' && value.action === input.action
    && ['partial-residue','verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && value.restored === 0 && partialResource(value.resource, input)
    && Array.isArray(value.residue) && value.residue.every((item) => item === 'library-resource')
    && (value.outcome === 'partial-residue' ? value.residue.length === 1 : !value.residue.length)
    && text(value.failure, 1024, false);
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report,
  });
  return error;
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed',
  });
  return error;
}
function safe(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function executeLibraryImport(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Library Import requires a Figma evaluate adapter.');
  const input = normalized(request);
  const serialized = await adapters.evaluate(libraryImportCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_LIBRARY_IMPORT_RESULT_CODE_UNITS) {
    throw invalid('Library Import returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw invalid('Library Import returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, input)) throw invalid('Library Import returned an invalid bounded result.');
    throw mutationError(`Library Import made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw invalid('Library Import returned an invalid bounded result.');
    throw mutationError(`Library Import failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: 1, restored: 0,
      residueCount: payload.outcome === 'partial-residue' ? payload.residue.length : 1,
    });
  }
  if (!validSuccess(payload, input)) throw invalid('Library Import returned an invalid bounded result.');
  return { stdout: safe(payload.resource), stderr: '', result: payload };
}

export function libraryImportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Library Import routing requires a Command Plan.');
  return plan.allowed && IDS.has(plan.id) ? 'command-application' : 'not-library-import';
}

export function executeLibraryImportPlan(plan, adapters = {}) {
  if (libraryImportPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Library Import.');
  }
  return executeLibraryImport(parseLibraryImportRequest(plan.argv), adapters);
}
