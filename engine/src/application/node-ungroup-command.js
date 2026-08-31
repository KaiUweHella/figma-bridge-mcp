import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import { MAX_NODE_UNGROUP_NODE_ID_CODE_UNITS, nodeUngroupArgvFromRequest, nodeUngroupPlanningArgvFromRequest, parseNodeUngroupRequest } from './node-ungroup-request.js';

export { nodeUngroupArgvFromRequest, nodeUngroupPlanningArgvFromRequest } from './node-ungroup-request.js';
const APPLICATION_ID = 'node.ungroup';
export const MAX_NODE_UNGROUP_CHILDREN = 50_000;
export const MAX_NODE_UNGROUP_RESULT_CODE_UNITS = 65_536;
export const MAX_NODE_UNGROUP_NAME_CODE_UNITS = 1_024;
function normalized(request) { return parseNodeUngroupRequest(nodeUngroupArgvFromRequest(request)); }
export function nodeUngroupCode(request) {
  const input = normalized(request);
  return `(async () => {
    const targetId = ${JSON.stringify(input.nodeId)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (value.length > ${MAX_NODE_UNGROUP_RESULT_CODE_UNITS}) throw new Error('Node Ungroup result exceeded its bounded response limit.'); return value; };
    const ids = (parent, label) => { if (!parent || !Array.isArray(parent.children) || parent.children.length > ${MAX_NODE_UNGROUP_CHILDREN}) throw new Error(label + ' has invalid or excessive child membership.'); const values = parent.children.map((child) => child && child.id); if (values.some((id) => typeof id !== 'string') || new Set(values).size !== values.length) throw new Error(label + ' has invalid child membership.'); return values; };
    const same = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    let target, parent, beforeParent, childIds, targetIndex;
    try {
      target = await figma.getNodeByIdAsync(targetId);
      if (!target || !['GROUP', 'TRANSFORM_GROUP'].includes(target.type) || typeof target.id !== 'string') throw new Error('Node Ungroup requires an exact Group or Transform Group.');
      parent = target.parent;
      if (!parent || typeof parent.id !== 'string' || !Array.isArray(parent.children)) throw new Error('Node Ungroup requires an attached parent.');
      beforeParent = ids(parent, 'Parent'); childIds = ids(target, 'Group'); targetIndex = beforeParent.indexOf(target.id);
      if (targetIndex < 0 || childIds.length === 0) throw new Error('Node Ungroup requires one attached non-empty group.');
    } catch (error) { return refusal(error); }
    let failure = 'Node Ungroup could not freshly verify the complete requested hierarchy.';
    try {
      try { figma.ungroup(target); } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      const freshTarget = await figma.getNodeByIdAsync(targetId); const freshParent = await figma.getNodeByIdAsync(parent.id);
      const afterParent = ids(freshParent, 'Fresh parent'); const expected = [...beforeParent]; expected.splice(targetIndex, 1, ...childIds);
      let childrenAttached = true;
      for (const childId of childIds) { const child = await figma.getNodeByIdAsync(childId); if (!child || !child.parent || child.parent.id !== parent.id) childrenAttached = false; }
      if (!freshTarget && same(afterParent, expected) && childrenAttached) { delete globalThis.__invCache; return bounded({ schemaVersion: 1, status: 'ungrouped', parentId: clean(parent.id, ${MAX_NODE_UNGROUP_NODE_ID_CODE_UNITS}), index: targetIndex, children: childIds.map((id) => clean(id, ${MAX_NODE_UNGROUP_NODE_ID_CODE_UNITS})), attempted: 1, residue: [] }); }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
    try {
      const freshTarget = await figma.getNodeByIdAsync(targetId); const freshParent = await figma.getNodeByIdAsync(parent.id); const afterParent = ids(freshParent, 'Observed parent');
      let childParentChanges = 0; for (const childId of childIds) { const child = await figma.getNodeByIdAsync(childId); if (!child || !child.parent || child.parent.id !== targetId) childParentChanges++; }
      const groupMissing = !freshTarget; const parentOrderChanged = !same(afterParent, beforeParent);
      const unchanged = !groupMissing && !parentOrderChanged && childParentChanges === 0;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: unchanged ? 'rolled-back' : 'partial-residue', attempted: 1, restored: unchanged ? 1 : 0, failure, residue: { groupMissing, parentOrderChanged, childParentChanges } });
    } catch { return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, failure, residue: { groupMissing: false, parentOrderChanged: false, childParentChanges: 0 } }); }
  })()`;
}
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function validString(value, max, empty = true) { return typeof value === 'string' && value.length <= max && (empty || value.length > 0); }
function validId(value) { return validString(value, MAX_NODE_UNGROUP_NODE_ID_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value); }
function validSuccess(value) { return exact(value, ['schemaVersion', 'status', 'parentId', 'index', 'children', 'attempted', 'residue']) && value.schemaVersion === 1 && value.status === 'ungrouped' && validId(value.parentId) && Number.isSafeInteger(value.index) && value.index >= 0 && Array.isArray(value.children) && value.children.length > 0 && value.children.length <= MAX_NODE_UNGROUP_CHILDREN && value.children.every(validId) && new Set(value.children).size === value.children.length && value.attempted === 1 && Array.isArray(value.residue) && value.residue.length === 0; }
function validRefusal(value) { return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation' && value.attempted === 0 && validString(value.failure, 1024, false); }
function validFailure(value) { const residue = value?.residue; const count = residue ? Number(residue.groupMissing) + Number(residue.parentOrderChanged) + residue.childParentChanges : 0; return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'failure', 'residue']) && value.schemaVersion === 1 && value.status === 'failed' && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0, 1].includes(value.restored) && validString(value.failure, 1024, false) && exact(residue, ['groupMissing', 'parentOrderChanged', 'childParentChanges']) && typeof residue.groupMissing === 'boolean' && typeof residue.parentOrderChanged === 'boolean' && Number.isSafeInteger(residue.childParentChanges) && residue.childParentChanges >= 0 && residue.childParentChanges <= MAX_NODE_UNGROUP_CHILDREN && (value.outcome === 'rolled-back' ? value.restored === 1 && count === 0 : value.restored === 0) && (value.outcome !== 'partial-residue' || count > 0); }
function errorWith(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
export function formatNodeUngroupResult(result, { json = false } = {}) { return json ? JSON.stringify(result, null, 2) : `Ungrouped ${result.children.length} nodes into ${result.parentId}`; }
export async function executeNodeUngroup(request, adapters = {}) { if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Ungroup requires a Figma evaluate adapter.'); const input = normalized(request); const serialized = await adapters.evaluate(nodeUngroupCode(input)); if (typeof serialized !== 'string' || serialized.length > MAX_NODE_UNGROUP_RESULT_CODE_UNITS) throw invalid('Node Ungroup returned an invalid bounded result.'); let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Node Ungroup returned invalid JSON.'); } if (payload?.status === 'refused') { if (!validRefusal(payload)) throw invalid('Node Ungroup returned an invalid bounded result.'); throw errorWith(`Node Ungroup made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); } if (payload?.status === 'failed') { if (!validFailure(payload)) throw invalid('Node Ungroup returned an invalid bounded result.'); const count = Number(payload.residue.groupMissing) + Number(payload.residue.parentOrderChanged) + payload.residue.childParentChanges; throw errorWith(`Node Ungroup failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: count }); } if (!validSuccess(payload)) throw invalid('Node Ungroup returned an invalid bounded result.'); return { stdout: formatNodeUngroupResult(payload, { json: input.json }), stderr: '', result: payload }; }
export function nodeUngroupPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Node Ungroup routing requires a Command Plan created by the Capability Catalog.'); return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-ungroup'; }
export async function executeNodeUngroupPlan(plan, adapters = {}) { if (nodeUngroupPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Ungroup.`); return executeNodeUngroup(parseNodeUngroupRequest(plan.argv), adapters); }
