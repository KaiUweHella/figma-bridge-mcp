import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_MEASUREMENT_ID_CODE_UNITS,
  MAX_MEASUREMENT_TEXT_CODE_UNITS,
  MEASUREMENT_MUTATION_ACTIONS,
  measurementMutationArgvFromRequest,
  measurementMutationPlanningArgvFromRequest,
  parseMeasurementMutationRequest,
} from './measurement-mutation-request.js';

export { measurementMutationArgvFromRequest, measurementMutationPlanningArgvFromRequest } from './measurement-mutation-request.js';
export const MAX_MEASUREMENT_MUTATION_COUNT = 50_000;
export const MAX_MEASUREMENT_MUTATION_RESULT_CODE_UNITS = 96_000;
const MAX_NAME = 1_024;
const APPLICATION_IDS = new Set(MEASUREMENT_MUTATION_ACTIONS.map((action) => `measure.${action}`));
const normalized = (request) => parseMeasurementMutationRequest(measurementMutationArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function measurementMutationCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_MEASUREMENT_MUTATION_RESULT_CODE_UNITS}) throw new Error('Measurement Mutation result exceeded the bounded response limit.'); return serialized; };
    const offset = (value) => { if (value && value.type === 'OUTER' && Number.isFinite(value.fixed)) return { type: 'OUTER', fixed: value.fixed }; if (value && value.type === 'INNER' && Number.isFinite(value.relative) && value.relative >= 0 && value.relative <= 1) return { type: 'INNER', relative: value.relative }; throw new Error('Measurement returned invalid offset facts.'); };
    const endpoint = (value) => { if (!value || !value.node || typeof value.node.id !== 'string' || !['TOP','RIGHT','BOTTOM','LEFT'].includes(value.side)) throw new Error('Measurement returned invalid endpoint facts.'); return { node: { id: clean(value.node.id, ${MAX_MEASUREMENT_ID_CODE_UNITS}), name: clean(String(value.node.name || ''), ${MAX_NAME}), type: clean(String(value.node.type || ''), 64) }, side: value.side }; };
    const fact = (value) => { if (!value || typeof value.id !== 'string' || !value.id.length || value.id.length > ${MAX_MEASUREMENT_ID_CODE_UNITS}) throw new Error('Measurement returned an invalid id.'); const freeText = typeof value.freeText === 'string' ? value.freeText : ''; if (freeText.length > ${MAX_MEASUREMENT_TEXT_CODE_UNITS}) throw new Error('Measurement text exceeds its bound.'); return { id: clean(value.id, ${MAX_MEASUREMENT_ID_CODE_UNITS}), start: endpoint(value.start), end: endpoint(value.end), offset: offset(value.offset), freeText }; };
    const facts = (page) => { const values = page.getMeasurements(); if (!Array.isArray(values) || values.length > ${MAX_MEASUREMENT_MUTATION_COUNT}) throw new Error('Measurement count exceeds its bound.'); const result = values.map(fact); const ids = result.map((item) => item.id); if (new Set(ids).size !== ids.length) throw new Error('Measurement ids must be unique.'); return result; };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const sameCollection = (left, right) => left.length === right.length && left.every((value, index) => same(value, right[index]));
    const expected = (before) => ({
      ...before,
      ...(request.offset === null ? {} : { offset: request.offset }),
      ...(request.text === null ? {} : { freeText: request.text }),
    });
    const desiredAdd = (value) => value.start.node.id === request.from.nodeId && value.start.side === request.from.side && value.end.node.id === request.to.nodeId && value.end.side === request.to.side && (request.offset === null || same(value.offset, request.offset)) && value.freeText === request.text;
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: request.action, outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    let page, before, target = null, startNode = null, endNode = null;
    try {
      if (figma.editorType !== 'dev') throw new Error('Measurements can only be changed in Figma Dev Mode.'); page = figma.currentPage;
      if (!page || page.type !== 'PAGE' || typeof page.getMeasurements !== 'function' || typeof page.addMeasurement !== 'function' || typeof page.editMeasurement !== 'function' || typeof page.deleteMeasurement !== 'function') throw new Error('Measurement Mutation requires a compatible current Page.');
      before = facts(page);
      if (request.action === 'add') {
        startNode = await figma.getNodeByIdAsync(request.from.nodeId); endNode = await figma.getNodeByIdAsync(request.to.nodeId);
        if (!startNode || !('x' in startNode)) throw new Error('Start scene node not found.'); if (!endNode || !('x' in endNode)) throw new Error('End scene node not found.');
      } else { target = before.find((item) => item.id === request.id) || null; if (!target) throw new Error('Measurement not found.'); }
    } catch (error) { return refusal(error); }
    let nativeValue = null; let mutationError = null;
    try {
      if (request.action === 'add') nativeValue = page.addMeasurement({ node: startNode, side: request.from.side }, { node: endNode, side: request.to.side }, { ...(request.offset === null ? {} : { offset: request.offset }), ...(request.text ? { freeText: request.text } : {}) });
      else if (request.action === 'edit') nativeValue = page.editMeasurement(request.id, { ...(request.offset === null ? {} : { offset: request.offset }), ...(request.text === null ? {} : { freeText: request.text }) });
      else page.deleteMeasurement(request.id);
    } catch (error) { mutationError = error; }
    try {
      const after = facts(page); const beforeIds = before.map((item) => item.id); const afterIds = after.map((item) => item.id); const warning = mutationError ? ['The native mutation reported an error, but fresh readback proved the exact requested state.'] : [];
      if (request.action === 'add') {
        const newIds = afterIds.filter((id) => !beforeIds.includes(id)); const missing = beforeIds.filter((id) => !afterIds.includes(id)); const created = newIds.length === 1 ? after.find((item) => item.id === newIds[0]) : null;
        if (!missing.length && created && desiredAdd(created)) return bounded({ schemaVersion: 1, status: 'created', action: request.action, outcome: mutationError ? 'verified-after-error' : 'verified', measurement: created, attempted: 1, residue: [], warnings: warning });
        const candidateId = nativeValue && typeof nativeValue.id === 'string' ? nativeValue.id : newIds.length === 1 ? newIds[0] : null;
        if (candidateId) { try { page.deleteMeasurement(candidateId); } catch {} }
        try { const restored = facts(page); if (sameCollection(restored, before)) return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: 'rolled-back', attempted: 1, restored: 1, residue: [], failure: clean(mutationError?.message || 'fresh add postcondition failed', 1024) }); const restoredIds = restored.map((item) => item.id); const residue = [...restoredIds.filter((id) => !beforeIds.includes(id)), ...beforeIds.filter((id) => !restoredIds.includes(id))].slice(0, 8); if (!residue.length) residue.push('measurement-state'); return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: 'partial-residue', attempted: 1, restored: 0, residue, failure: clean(mutationError?.message || 'fresh add postcondition failed', 1024) }); } catch {}
      } else if (request.action === 'edit') {
        const current = after.find((item) => item.id === request.id); const desired = expected(target); const siblingsMatch = before.filter((item) => item.id !== request.id).every((item) => { const fresh = after.find((candidate) => candidate.id === item.id); return fresh && same(fresh, item); }) && after.length === before.length;
        if (current && same(current, desired) && siblingsMatch) return bounded({ schemaVersion: 1, status: 'updated', action: request.action, outcome: mutationError ? 'verified-after-error' : 'verified', measurement: current, attempted: 1, residue: [], warnings: warning });
        try { page.editMeasurement(request.id, { offset: target.offset, freeText: target.freeText }); } catch {}
        try { const restored = facts(page); if (sameCollection(restored, before)) return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: 'rolled-back', attempted: 1, restored: 1, residue: [], failure: clean(mutationError?.message || 'fresh edit postcondition failed', 1024) }); return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: 'partial-residue', attempted: 1, restored: 0, residue: [request.id], failure: clean(mutationError?.message || 'fresh edit postcondition failed', 1024) }); } catch {}
      } else {
        const desired = before.filter((item) => item.id !== request.id); if (sameCollection(after, desired)) return bounded({ schemaVersion: 1, status: 'deleted', action: request.action, outcome: mutationError ? 'verified-after-error' : 'verified', measurement: target, attempted: 1, residue: [], warnings: warning }); const unchanged = sameCollection(after, before); const desiredIds = desired.map((item) => item.id); const residue = unchanged ? [request.id] : [...afterIds.filter((id) => !desiredIds.includes(id)), ...desiredIds.filter((id) => !afterIds.includes(id))].slice(0, 8); if (!residue.length) residue.push('measurement-state'); return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: unchanged ? 'unchanged' : 'partial-residue', attempted: 1, restored: 0, residue, failure: clean(mutationError?.message || 'fresh delete postcondition failed', 1024) });
      }
    } catch (error) { mutationError ||= error; }
    return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: 'verification-unavailable', attempted: 1, restored: 0, residue: [], failure: clean(mutationError?.message || 'fresh verification unavailable', 1024) });
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, max, empty = true) => typeof value === 'string' && value.length <= max && (empty || value.length > 0);
function validOffset(value) { return exact(value, value?.type === 'OUTER' ? ['type','fixed'] : ['type','relative']) && (value.type === 'OUTER' ? Number.isFinite(value.fixed) : value.type === 'INNER' && Number.isFinite(value.relative) && value.relative >= 0 && value.relative <= 1); }
function validMeasurement(value) { return exact(value, ['id','start','end','offset','freeText']) && text(value.id, MAX_MEASUREMENT_ID_CODE_UNITS, false) && exact(value.start, ['node','side']) && exact(value.end, ['node','side']) && [value.start,value.end].every((endpoint) => exact(endpoint.node, ['id','name','type']) && text(endpoint.node.id, MAX_MEASUREMENT_ID_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(endpoint.node.id) && text(endpoint.node.name, MAX_NAME) && text(endpoint.node.type, 64, false) && ['TOP','RIGHT','BOTTOM','LEFT'].includes(endpoint.side)) && validOffset(value.offset) && text(value.freeText, MAX_MEASUREMENT_TEXT_CODE_UNITS); }
function validSuccess(value, input) { return exact(value, ['schemaVersion','status','action','outcome','measurement','attempted','residue','warnings']) && value.schemaVersion === 1 && value.status === ({ add: 'created', edit: 'updated', delete: 'deleted' })[input.action] && value.action === input.action && ['verified','verified-after-error'].includes(value.outcome) && validMeasurement(value.measurement) && value.attempted === 1 && Array.isArray(value.residue) && !value.residue.length && Array.isArray(value.warnings) && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0) && value.warnings.every((item) => text(item, 1024, false)); }
function validRefusal(value, input) { return exact(value, ['schemaVersion','status','action','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.action === input.action && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validFailure(value, input) { return exact(value, ['schemaVersion','status','action','outcome','attempted','restored','residue','failure']) && value.schemaVersion === 1 && value.status === 'failed' && value.action === input.action && ['rolled-back','partial-residue','unchanged','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && Array.isArray(value.residue) && value.residue.length <= 8 && value.residue.every((item) => text(item, MAX_MEASUREMENT_ID_CODE_UNITS, false)) && text(value.failure, 1024, false) && (value.outcome !== 'rolled-back' || value.restored === 1 && !value.residue.length) && (value.outcome !== 'unchanged' || input.action === 'delete' && value.restored === 0 && value.residue.length === 1) && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0) && (value.outcome !== 'verification-unavailable' || value.restored === 0); }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
export function formatMeasurementMutationResult(result) { return JSON.stringify(result.measurement, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
export async function executeMeasurementMutation(request, adapters = {}) { if (typeof adapters.evaluate !== 'function') throw new TypeError('Measurement Mutation requires a Figma evaluate adapter.'); const input = normalized(request); const serialized = await adapters.evaluate(measurementMutationCode(input)); if (typeof serialized !== 'string' || serialized.length > MAX_MEASUREMENT_MUTATION_RESULT_CODE_UNITS) throw invalid('Measurement Mutation returned an invalid bounded result.'); let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Measurement Mutation returned invalid JSON.'); } if (payload?.status === 'refused') { if (!validRefusal(payload, input)) throw invalid('Measurement Mutation returned an invalid bounded result.'); throw mutationError(`Measurement Mutation made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); } if (payload?.status === 'failed') { if (!validFailure(payload, input)) throw invalid('Measurement Mutation returned an invalid bounded result.'); throw mutationError(`Measurement Mutation failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length }); } if (!validSuccess(payload, input)) throw invalid('Measurement Mutation returned an invalid bounded result.'); return { stdout: formatMeasurementMutationResult(payload), stderr: '', result: payload }; }
export function measurementMutationPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Measurement Mutation routing requires a Command Plan created by the Capability Catalog.'); return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-measurement-mutation'; }
export async function executeMeasurementMutationPlan(plan, adapters = {}) { if (measurementMutationPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Measurement Mutation.`); return executeMeasurementMutation(parseMeasurementMutationRequest(plan.argv), adapters); }
