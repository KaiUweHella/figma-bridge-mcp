// Rollback-owned native `gradient apply` Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  gradientApplyArgvFromRequest,
  gradientApplyPlanningArgvFromRequest,
  parseGradientApplyRequest,
} from './gradient-apply-request.js';

export { gradientApplyArgvFromRequest, gradientApplyPlanningArgvFromRequest } from './gradient-apply-request.js';

const APPLICATION_ID = 'gradient.apply';
export const MAX_GRADIENT_APPLY_PAINTS = 10_000;
export const MAX_GRADIENT_APPLY_SNAPSHOT_CODE_UNITS = 262_144;
export const MAX_GRADIENT_APPLY_RESULT_CODE_UNITS = 65_536;
const MAX_NAME = 4_096;
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const normalized = (request) => parseGradientApplyRequest(gradientApplyArgvFromRequest(request));

export function gradientApplyCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js({ nodeId: input.nodeId, paint: input.paint, field: input.field, strokeWeight: input.strokeWeight })};
    const property = request.field === 'fill' ? 'fills' : 'strokes';
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (value.length > ${MAX_GRADIENT_APPLY_RESULT_CODE_UNITS}) throw new Error('Gradient Apply result exceeded its bounded response limit.'); return value; };
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const close = (left, right) => typeof left === 'number' && typeof right === 'number' && Math.abs(left - right) <= 1e-5;
    const same = (left, right) => {
      if (typeof left === 'number' || typeof right === 'number') return close(left, right);
      if (left === right) return true;
      if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => same(item, right[index]));
      if (!record(left) || !record(right)) return false;
      const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
      return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && same(left[key], right[key]));
    };
    const defaultPresentation = (paint) => (paint.opacity === undefined || close(paint.opacity, 1))
      && (paint.visible === undefined || paint.visible === true)
      && (paint.blendMode === undefined || paint.blendMode === 'NORMAL');
    const gradientMatches = (paint) => record(paint)
      && Object.keys(paint).every((key) => ['type','gradientStops','gradientTransform','opacity','visible','blendMode'].includes(key))
      && paint.type === request.paint.type
      && defaultPresentation(paint) && same(paint.gradientStops, request.paint.gradientStops)
      && same(paint.gradientTransform, request.paint.gradientTransform);
    const stateMatches = (node) => Array.isArray(node[property]) && node[property].length === 1
      && gradientMatches(node[property][0])
      && (request.strokeWeight === null || close(node.strokeWeight, request.strokeWeight));
    const nodeFact = (node) => ({ id: node.id, name: clean(node.name, ${MAX_NAME}), type: node.type });
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const success = (node, outcome, attempted, warning) => bounded({ schemaVersion: 1, status: 'applied', outcome, attempted, node: nodeFact(node), field: request.field,
      strokeWeight: 'strokeWeight' in node && Number.isFinite(node.strokeWeight) ? node.strokeWeight : null, residue: [], warnings: warning ? ['A native Gradient mutation reported an error, but fresh readback proved the complete requested state.'] : [] });
    let node, beforePaints, beforePaintsJson, beforeWeight = null;
    try {
      node = await figma.getNodeByIdAsync(request.nodeId);
      if (!node || node.id !== request.nodeId || typeof node.name !== 'string' || typeof node.type !== 'string'
        || node.type.length > 64 || !(property in node)) throw new Error('Gradient Apply requires one exact paint-capable canvas Node.');
      beforePaints = node[property];
      if (!Array.isArray(beforePaints) || beforePaints.length > ${MAX_GRADIENT_APPLY_PAINTS}) throw new Error('Gradient Apply requires a bounded non-mixed Paint list.');
      beforePaintsJson = JSON.stringify(beforePaints);
      if (typeof beforePaintsJson !== 'string' || beforePaintsJson.length > ${MAX_GRADIENT_APPLY_SNAPSHOT_CODE_UNITS}) throw new Error('Gradient Apply rollback snapshot exceeds its bounded limit.');
      beforePaints = JSON.parse(beforePaintsJson);
      if (request.strokeWeight !== null) {
        if (!('strokeWeight' in node) || !Number.isFinite(node.strokeWeight)) throw new Error('Gradient Apply cannot snapshot a finite stroke weight.');
        beforeWeight = node.strokeWeight;
      }
      if (stateMatches(node)) return success(node, 'no-op', 0, false);
    } catch (error) { return refusal(error); }
    let mutationError = null;
    try { node[property] = [request.paint]; } catch (error) { mutationError = error; }
    if (!mutationError && request.strokeWeight !== null) {
      try { node.strokeWeight = request.strokeWeight; } catch (error) { mutationError = error; }
    }
    let fresh = null;
    try {
      fresh = await figma.getNodeByIdAsync(request.nodeId);
      if (fresh && stateMatches(fresh)) {
        delete globalThis.__invCache;
        return success(fresh, mutationError ? 'verified-after-error' : 'verified', 1, mutationError);
      }
      if (fresh && same(fresh[property], beforePaints)
        && (request.strokeWeight === null || close(fresh.strokeWeight, beforeWeight))) {
        return bounded({ schemaVersion: 1, status: 'failed', outcome: 'unchanged', attempted: 1, restored: 0,
          failure: clean(mutationError && mutationError.message ? mutationError.message : 'Gradient Apply had no effect.', 1024), node: nodeFact(fresh), field: request.field, residue: ['gradient-state'] });
      }
    } catch (error) { mutationError ||= error; }
    try {
      node[property] = beforePaints;
      if (request.strokeWeight !== null) node.strokeWeight = beforeWeight;
      fresh = await figma.getNodeByIdAsync(request.nodeId);
      if (!fresh) throw new Error('Gradient Apply rollback target is unavailable.');
      const paintRestored = same(fresh[property], beforePaints);
      const weightRestored = request.strokeWeight === null || close(fresh.strokeWeight, beforeWeight);
      const residue = [...(paintRestored ? [] : [property]), ...(weightRestored ? [] : ['strokeWeight'])];
      const restored = residue.length === 0;
      if (restored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1, restored: restored ? 1 : 0,
        failure: clean(mutationError && mutationError.message ? mutationError.message : 'Gradient Apply postcondition failed.', 1024), node: nodeFact(fresh), field: request.field, residue });
    } catch (error) {
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0,
        failure: clean(mutationError && mutationError.message ? mutationError.message : error && error.message ? error.message : 'Gradient Apply verification failed.', 1024), node: nodeFact(node), field: request.field, residue: [] });
    }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function text(value, maximum, empty = true) { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0); }
function validNode(value, input) { return exact(value, ['id','name','type']) && value.id === input.nodeId && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name, MAX_NAME) && text(value.type, 64, false); }
function validRefusal(value) { return exact(value, ['schemaVersion','status','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validSuccess(value, input) { return exact(value, ['schemaVersion','status','outcome','attempted','node','field','strokeWeight','residue','warnings']) && value.schemaVersion === 1 && value.status === 'applied' && ['verified','verified-after-error','no-op'].includes(value.outcome) && (value.outcome === 'no-op' ? value.attempted === 0 : value.attempted === 1) && validNode(value.node, input) && value.field === input.field && (value.strokeWeight === null || Number.isFinite(value.strokeWeight)) && (input.strokeWeight === null || Number.isFinite(value.strokeWeight) && Math.abs(value.strokeWeight - input.strokeWeight) <= 1e-5) && Array.isArray(value.residue) && value.residue.length === 0 && Array.isArray(value.warnings) && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0) && value.warnings.every((warning) => text(warning, 1024, false)); }
function validFailure(value, input) { return exact(value, ['schemaVersion','status','outcome','attempted','restored','failure','node','field','residue']) && value.schemaVersion === 1 && value.status === 'failed' && ['unchanged','rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && text(value.failure, 1024, false) && validNode(value.node, input) && value.field === input.field && Array.isArray(value.residue) && value.residue.length <= 2 && value.residue.every((item) => ['gradient-state','fills','strokes','strokeWeight'].includes(item)) && (value.outcome === 'rolled-back' ? value.restored === 1 && value.residue.length === 0 : value.restored === 0) && (value.outcome !== 'unchanged' || value.residue.length === 1 && value.residue[0] === 'gradient-state') && (value.outcome !== 'partial-residue' || value.residue.length > 0) && (value.outcome !== 'verification-unavailable' || value.residue.length === 0); }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, residue, restored = 0) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: { version: 1, outcome, attempted: outcome === 'no-mutation' ? 0 : 1, restored, residueCount: residue } }); return error; }
function formatted(payload) { return { id: payload.node.id, name: payload.node.name, type: payload.node.type, field: payload.field, strokeWeight: payload.strokeWeight }; }
export function formatGradientApplyResult(payload, { json = false } = {}) { return json ? JSON.stringify(formatted(payload), null, 2) : `Applied gradient ${payload.field} to ${payload.node.name} (${payload.node.id})`; }
export async function executeGradientApply(request, adapters = {}) { if (typeof adapters.evaluate !== 'function') throw new TypeError('Gradient Apply requires a Figma evaluate adapter.'); const input = normalized(request); const serialized = await adapters.evaluate(gradientApplyCode(input)); if (typeof serialized !== 'string' || serialized.length > MAX_GRADIENT_APPLY_RESULT_CODE_UNITS) throw invalid('Gradient Apply returned an invalid bounded result.'); let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Gradient Apply returned invalid JSON.'); } if (payload?.status === 'refused') { if (!validRefusal(payload)) throw invalid('Gradient Apply returned an invalid bounded result.'); throw mutationError(`Gradient Apply made no mutation: ${payload.failure}`, 'no-mutation', 0); } if (payload?.status === 'failed') { if (!validFailure(payload, input)) throw invalid('Gradient Apply returned an invalid bounded result.'); throw mutationError(`Gradient Apply failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length, payload.restored); } if (!validSuccess(payload, input)) throw invalid('Gradient Apply returned an invalid bounded result.'); return { stdout: formatGradientApplyResult(payload, input), stderr: payload.warnings.join('\n'), code: 0, result: payload }; }
export function gradientApplyPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Gradient Apply routing requires a Command Plan.'); return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-gradient-apply'; }
export function executeGradientApplyPlan(plan, adapters = {}) { if (gradientApplyPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Gradient Apply.`); return executeGradientApply(parseGradientApplyRequest(plan.argv), adapters); }
