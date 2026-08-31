// Plan-bound, freshly verified Auto Layout Grid auto-flow mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  gridAutoFlowArgvFromRequest,
  gridAutoFlowPlanningArgvFromRequest,
  parseGridAutoFlowRequest,
} from './grid-auto-flow-request.js';

export { gridAutoFlowArgvFromRequest, gridAutoFlowPlanningArgvFromRequest } from './grid-auto-flow-request.js';
export const MAX_GRID_AUTO_FLOW_RESULT_CODE_UNITS = 64_000;
const APPLICATION_ID = 'layout.grid.auto-flow';
const AUTO_TRACKS = Object.freeze(['NONE', 'ROWS']);
const POSITIONING = Object.freeze(['MANUAL', 'ROW_AUTO_FLOW']);
const normalized = (request) => parseGridAutoFlowRequest(gridAutoFlowArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function gridAutoFlowCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_GRID_AUTO_FLOW_RESULT_CODE_UNITS}) throw new Error('Grid Auto Flow result exceeded its bounded response limit.'); return serialized; };
    const state = (node) => {
      const autoTracks = node && node.gridAutoTracks;
      const positioning = node && node.gridItemsPositioning;
      if (!${js(AUTO_TRACKS)}.includes(autoTracks) || !${js(POSITIONING)}.includes(positioning)) throw new Error('Grid auto-flow facts are invalid.');
      return { autoTracks, positioning };
    };
    const same = (left, right) => left.autoTracks === right.autoTracks && left.positioning === right.positioning;
    const nodeFacts = (node) => ({ id: clean(node.id, 512), name: clean(String(node.name || ''), 1024), type: clean(String(node.type || ''), 64) });
    const desired = { autoTracks: request.autoTracks, positioning: request.positioning };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: 'auto-flow', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const failure = (outcome, error, residue) => bounded({ schemaVersion: 1, status: 'failed', action: 'auto-flow', outcome, attempted: 1, restored: outcome === 'rolled-back' ? 2 : 0, residue, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Grid Auto Flow verification failed.' });
    let node, before;
    try {
      if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Figma node lookup is unavailable.');
      node = await figma.getNodeByIdAsync(request.nodeId);
      if (!node || node.layoutMode !== 'GRID' || !('gridAutoTracks' in node) || !('gridItemsPositioning' in node)) throw new Error('Grid Auto Flow requires one native Auto Layout Grid container.');
      before = state(node);
    } catch (error) { return refusal(error); }
    if (same(before, desired)) return bounded({ schemaVersion: 1, status: 'unchanged', action: 'auto-flow', outcome: 'no-mutation', attempted: 0, node: nodeFacts(node), before, after: before, residue: [], warnings: [] });
    let mutationError = null;
    try { node.gridAutoTracks = desired.autoTracks; node.gridItemsPositioning = desired.positioning; }
    catch (error) { mutationError = error; }
    try {
      const fresh = await figma.getNodeByIdAsync(request.nodeId);
      if (!fresh || fresh.layoutMode !== 'GRID') throw new Error('Fresh Grid Auto Flow target is unavailable.');
      const after = state(fresh);
      if (same(after, desired)) return bounded({ schemaVersion: 1, status: 'applied', action: 'auto-flow', outcome: mutationError ? 'verified-after-error' : 'verified', attempted: 1, node: nodeFacts(fresh), before, after, residue: [], warnings: mutationError ? ['A native Grid auto-flow setter reported an error, but fresh readback proved the requested state.'] : [] });
      mutationError ||= new Error('Fresh Grid Auto Flow postcondition failed.');
    } catch (error) { mutationError ||= error; }
    try { node.gridItemsPositioning = before.positioning; } catch {}
    try { node.gridAutoTracks = before.autoTracks; } catch {}
    try {
      const restoredNode = await figma.getNodeByIdAsync(request.nodeId);
      if (!restoredNode || restoredNode.layoutMode !== 'GRID') throw new Error('Fresh Grid Auto Flow rollback target is unavailable.');
      const restored = state(restoredNode); const residue = [];
      if (restored.autoTracks !== before.autoTracks) residue.push('autoTracks');
      if (restored.positioning !== before.positioning) residue.push('positioning');
      return failure(residue.length ? 'partial-residue' : 'rolled-back', mutationError, residue);
    } catch (error) { return failure('verification-unavailable', mutationError || error, []); }
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
const text = (value, maximum, empty = true) => typeof value === 'string'
  && value.length <= maximum && (empty || value.length > 0);
function validNode(value, input) {
  return exact(value, ['id', 'name', 'type']) && value.id === input.nodeId
    && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id)
    && text(value.name, 1_024) && text(value.type, 64, false);
}
function validState(value) {
  return exact(value, ['autoTracks', 'positioning'])
    && AUTO_TRACKS.includes(value.autoTracks) && POSITIONING.includes(value.positioning);
}
function validRefusal(value) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.action === 'auto-flow'
    && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1_024, false);
}
function validSuccess(value, input) {
  const beforeIsDesired = value?.before?.autoTracks === input.autoTracks
    && value?.before?.positioning === input.positioning;
  const statusConsistent = value?.status === 'unchanged'
    ? value.outcome === 'no-mutation' && value.attempted === 0 && beforeIsDesired
    : value?.status === 'applied' && ['verified','verified-after-error'].includes(value.outcome)
      && value.attempted === 1 && !beforeIsDesired;
  const warningsConsistent = value?.outcome === 'verified-after-error'
    ? value.warnings?.length === 1 : value?.warnings?.length === 0;
  return exact(value, ['schemaVersion','status','action','outcome','attempted','node','before','after','residue','warnings'])
    && value.schemaVersion === 1 && ['unchanged','applied'].includes(value.status) && value.action === 'auto-flow'
    && statusConsistent && validNode(value.node, input)
    && validState(value.before) && validState(value.after)
    && value.after.autoTracks === input.autoTracks && value.after.positioning === input.positioning
    && Array.isArray(value.residue) && !value.residue.length
    && Array.isArray(value.warnings) && value.warnings.length <= 1
    && value.warnings.every((warning) => text(warning, 1_024, false))
    && warningsConsistent;
}
function validFailure(value) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','restored','residue','failure'])
    && value.schemaVersion === 1 && value.status === 'failed' && value.action === 'auto-flow'
    && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && value.restored === (value.outcome === 'rolled-back' ? 2 : 0)
    && Array.isArray(value.residue) && value.residue.length <= 2
    && value.residue.every((item, index, array) => ['autoTracks','positioning'].includes(item) && array.indexOf(item) === index)
    && (value.outcome === 'rolled-back' ? !value.residue.length
      : value.outcome === 'partial-residue' ? value.residue.length > 0 : !value.residue.length)
    && text(value.failure, 1_024, false);
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report });
  return error;
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' });
  return error;
}
function safe(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function executeGridAutoFlow(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Grid Auto Flow requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(gridAutoFlowCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_GRID_AUTO_FLOW_RESULT_CODE_UNITS) throw invalid('Grid Auto Flow returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Grid Auto Flow returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Grid Auto Flow returned an invalid bounded result.');
    throw mutationError(`Grid Auto Flow made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw invalid('Grid Auto Flow returned an invalid bounded result.');
    throw mutationError(`Grid Auto Flow failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 2 : payload.residue.length });
  }
  if (!validSuccess(payload, input)) throw invalid('Grid Auto Flow returned an invalid bounded result.');
  return { stdout: safe({ id: payload.node.id, name: payload.node.name, before: payload.before, after: payload.after }), stderr: '', result: payload };
}
export function gridAutoFlowPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Grid Auto Flow routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-grid-auto-flow';
}
export function executeGridAutoFlowPlan(plan, adapters = {}) {
  if (gridAutoFlowPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Grid Auto Flow.');
  return executeGridAutoFlow(parseGridAutoFlowRequest(plan.argv), adapters);
}
