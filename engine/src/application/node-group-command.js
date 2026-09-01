// Plan-bound, hierarchy-verified and rollback-owned `node group` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_GROUP_NAME_CODE_UNITS,
  MAX_NODE_GROUP_NODE_ID_CODE_UNITS,
  MAX_NODE_GROUP_NODES,
  nodeGroupArgvFromRequest,
  nodeGroupPlanningArgvFromRequest,
  parseNodeGroupRequest,
} from './node-group-request.js';

export { nodeGroupArgvFromRequest, nodeGroupPlanningArgvFromRequest } from './node-group-request.js';

const APPLICATION_ID = 'node.group';
export const MAX_NODE_GROUP_CHILDREN = 50_000;
export const MAX_NODE_GROUP_MEMBERSHIPS = 100_000;
export const MAX_NODE_GROUP_ANCESTORS = 512;
export const MAX_NODE_GROUP_RESULT_CODE_UNITS = 65_536;
export const NODE_GROUP_POSITION_EPSILON = 0.01;

function normalizedRequest(request) { return parseNodeGroupRequest(nodeGroupArgvFromRequest(request)); }
function jsValue(value) { return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

export function nodeGroupCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const nodeIds = ${jsValue(input.nodeIds)};
    const requestedParentId = ${jsValue(input.parentId)};
    const requestedIndex = ${jsValue(input.index)};
    const requestedName = ${jsValue(input.name)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_NODE_GROUP_RESULT_CODE_UNITS}) throw new Error('Node Group result exceeded its bounded response limit.');
      return serialized;
    };
    let memberships = 0;
    const childIds = (parent, label) => {
      if (!parent || !Array.isArray(parent.children)) throw new Error(label + ' returned invalid child membership.');
      if (parent.children.length > ${MAX_NODE_GROUP_CHILDREN}) throw new Error(label + ' exceeds the bounded child count.');
      memberships += parent.children.length;
      if (memberships > ${MAX_NODE_GROUP_MEMBERSHIPS}) throw new Error('Node Group exceeds the bounded aggregate membership count.');
      const ids = parent.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error(label + ' returned invalid child membership.');
      return ids;
    };
    const same = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
    const close = (left, right) => Math.abs(left - right) <= ${NODE_GROUP_POSITION_EPSILON};
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });

    let nodes, target, originals, parentSnapshots, targetBefore;
    try {
      nodes = [];
      for (const id of nodeIds) {
        const node = await figma.getNodeByIdAsync(id);
        if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE'
          || typeof node.id !== 'string' || typeof node.name !== 'string'
          || typeof node.type !== 'string' || !node.parent) throw new Error('Node Group requires exact attached canvas nodes.');
        nodes.push(node);
      }
      target = requestedParentId === null ? nodes[0].parent : await figma.getNodeByIdAsync(requestedParentId);
      if (!target || typeof target.id !== 'string' || typeof target.appendChild !== 'function'
        || typeof target.insertChild !== 'function') throw new Error('Node Group target cannot contain children.');
      if (requestedParentId === null && nodes.some((node) => node.parent.id !== target.id)) throw new Error('Nodes must share one parent unless --parent is provided.');
      const selected = new Set(nodeIds);
      let cursor = target;
      for (let depth = 0; cursor && depth <= ${MAX_NODE_GROUP_ANCESTORS}; depth++) {
        if (selected.has(cursor.id)) throw new Error('Cannot group nodes into themselves or their descendants.');
        cursor = cursor.parent || null;
        if (depth === ${MAX_NODE_GROUP_ANCESTORS} && cursor) throw new Error('Node Group ancestry exceeds its bounded depth.');
      }
      originals = nodes.map((node) => ({ node, parentId: node.parent.id,
        index: node.parent.children.indexOf(node), x: Number.isFinite(node.x) ? node.x : null,
        y: Number.isFinite(node.y) ? node.y : null }));
      if (originals.some((item) => item.index < 0)) throw new Error('An original parent does not contain its selected child.');
      parentSnapshots = [];
      const seenParents = new Set();
      for (const item of originals) {
        if (seenParents.has(item.parentId)) continue;
        seenParents.add(item.parentId);
        parentSnapshots.push({ id: item.parentId, ids: childIds(item.node.parent, 'Original parent') });
      }
      if (!seenParents.has(target.id)) parentSnapshots.push({ id: target.id, ids: childIds(target, 'Target parent') });
      targetBefore = parentSnapshots.find((item) => item.id === target.id).ids;
      const maximumIndex = targetBefore.filter((id) => !selected.has(id)).length;
      if (requestedIndex !== null && requestedIndex > maximumIndex) throw new Error('Index out of range: ' + requestedIndex + '.');
    } catch (error) { return refusal(error); }

    let group = null;
    let failure = 'Node Group could not freshly verify the complete requested hierarchy.';
    try {
      try {
        group = figma.group(nodes, target, requestedIndex === null ? undefined : requestedIndex);
        if (requestedName !== null) group.name = requestedName;
      } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      if (group && typeof group.id === 'string') {
        const freshGroup = await figma.getNodeByIdAsync(group.id);
        const freshTarget = await figma.getNodeByIdAsync(target.id);
        memberships = 0;
        const targetIds = childIds(freshTarget, 'Fresh target parent');
        const children = childIds(freshGroup, 'Fresh group');
        const expectedOutside = targetBefore.filter((id) => !nodeIds.includes(id));
        const groupIndex = targetIds.indexOf(group.id);
        const expectedTarget = [...expectedOutside];
        if (groupIndex >= 0) expectedTarget.splice(groupIndex, 0, group.id);
        const exactMembers = children.length === nodeIds.length
          && nodeIds.every((id) => children.includes(id));
        const memberParents = [];
        for (const id of nodeIds) {
          const member = await figma.getNodeByIdAsync(id);
          memberParents.push(Boolean(member && member.parent && member.parent.id === group.id));
        }
        let originalParentsMatch = true;
        for (const snapshot of parentSnapshots) {
          if (snapshot.id === target.id) continue;
          const parent = await figma.getNodeByIdAsync(snapshot.id);
          const ids = childIds(parent, 'Fresh original parent');
          if (!same(ids, snapshot.ids.filter((id) => !nodeIds.includes(id)))) {
            originalParentsMatch = false;
          }
        }
        if (freshGroup && freshGroup.type === 'GROUP' && freshGroup.parent
          && freshGroup.parent.id === target.id && groupIndex >= 0
          && (requestedIndex === null || groupIndex === requestedIndex)
          && same(targetIds, expectedTarget) && originalParentsMatch
          && exactMembers && memberParents.every(Boolean)
          && (requestedName === null || freshGroup.name === requestedName)) {
          delete globalThis.__invCache;
          return bounded({ schemaVersion: 1, status: 'grouped',
            group: { id: clean(freshGroup.id, ${MAX_NODE_GROUP_NODE_ID_CODE_UNITS}), name: clean(freshGroup.name, ${MAX_NODE_GROUP_NAME_CODE_UNITS}), type: clean(freshGroup.type, 64), parentId: clean(target.id, ${MAX_NODE_GROUP_NODE_ID_CODE_UNITS}), index: groupIndex },
            childIds: children.map((id) => clean(id, ${MAX_NODE_GROUP_NODE_ID_CODE_UNITS})),
            requested: { nodeIds, parentId: requestedParentId, index: requestedIndex, name: requestedName }, attempted: 1, residue: [] });
        }
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }

    try {
      if (group && typeof group.id === 'string') { try { figma.ungroup(group); } catch {} }
      for (const snapshot of parentSnapshots) {
        const parent = await figma.getNodeByIdAsync(snapshot.id);
        if (!parent || typeof parent.insertChild !== 'function') continue;
        for (let index = 0; index < snapshot.ids.length; index++) {
          const id = snapshot.ids[index];
          if (!nodeIds.includes(id)) continue;
          const node = await figma.getNodeByIdAsync(id);
          if (node) { try { parent.insertChild(index, node); } catch {} }
        }
      }
      for (const original of originals) {
        const node = await figma.getNodeByIdAsync(original.node.id);
        if (!node) continue;
        try { if (original.x !== null) node.x = original.x; } catch {}
        try { if (original.y !== null) node.y = original.y; } catch {}
      }
      const freshGroup = group && typeof group.id === 'string' ? await figma.getNodeByIdAsync(group.id) : null;
      memberships = 0;
      let parentOrderChanges = 0;
      for (const snapshot of parentSnapshots) {
        const parent = await figma.getNodeByIdAsync(snapshot.id);
        if (!same(childIds(parent, 'Restored parent'), snapshot.ids)) parentOrderChanges++;
      }
      let nodeParentChanges = 0; let positionChanges = 0;
      for (const original of originals) {
        const node = await figma.getNodeByIdAsync(original.node.id);
        if (!node || !node.parent || node.parent.id !== original.parentId) nodeParentChanges++;
        if (!node || (original.x !== null && !close(node.x, original.x)) || (original.y !== null && !close(node.y, original.y))) positionChanges++;
      }
      const groupPresent = Boolean(freshGroup);
      const restored = !groupPresent && parentOrderChanges === 0 && nodeParentChanges === 0 && positionChanges === 0;
      if (restored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1, restored: restored ? 1 : 0, failure,
        residue: { groupPresent, parentOrderChanges, nodeParentChanges, positionChanges } });
    } catch {
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, failure,
        residue: { groupPresent: false, parentOrderChanges: 0, nodeParentChanges: 0, positionChanges: 0 } });
    }
  })()`;
}

function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function validString(value, max, empty = true) { return typeof value === 'string' && value.length <= max && (empty || value.length > 0); }
function validId(value) { return validString(value, MAX_NODE_GROUP_NODE_ID_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value); }
function validGroup(value, input) { return exactKeys(value, ['id', 'name', 'type', 'parentId', 'index']) && validId(value.id) && !input.nodeIds.includes(value.id) && validString(value.name, MAX_NODE_GROUP_NAME_CODE_UNITS) && value.type === 'GROUP' && validId(value.parentId) && (input.parentId === null || value.parentId === input.parentId) && Number.isSafeInteger(value.index) && value.index >= 0 && (input.index === null || value.index === input.index); }
function validRequested(value, input) { return exactKeys(value, ['nodeIds', 'parentId', 'index', 'name']) && Array.isArray(value.nodeIds) && value.nodeIds.length === input.nodeIds.length && value.nodeIds.every((id, index) => id === input.nodeIds[index]) && value.parentId === input.parentId && value.index === input.index && value.name === input.name; }
function validSuccess(value, input) { return exactKeys(value, ['schemaVersion', 'status', 'group', 'childIds', 'requested', 'attempted', 'residue']) && value.schemaVersion === 1 && value.status === 'grouped' && validGroup(value.group, input) && (input.name === null || value.group.name === input.name) && Array.isArray(value.childIds) && value.childIds.length === input.nodeIds.length && value.childIds.every(validId) && new Set(value.childIds).size === value.childIds.length && input.nodeIds.every((id) => value.childIds.includes(id)) && validRequested(value.requested, input) && value.attempted === 1 && Array.isArray(value.residue) && value.residue.length === 0; }
function validRefusal(value) { return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation' && value.attempted === 0 && validString(value.failure, 1024, false); }
function validResidue(value) { return exactKeys(value, ['groupPresent', 'parentOrderChanges', 'nodeParentChanges', 'positionChanges']) && typeof value.groupPresent === 'boolean' && ['parentOrderChanges', 'nodeParentChanges', 'positionChanges'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= MAX_NODE_GROUP_NODES + 1); }
function validFailure(value) { const count = value?.residue ? Number(value.residue.groupPresent) + value.residue.parentOrderChanges + value.residue.nodeParentChanges + value.residue.positionChanges : 0; return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'failure', 'residue']) && value.schemaVersion === 1 && value.status === 'failed' && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0, 1].includes(value.restored) && validString(value.failure, 1024, false) && validResidue(value.residue) && (value.outcome === 'rolled-back' ? value.restored === 1 && count === 0 : value.restored === 0) && (value.outcome !== 'partial-residue' || count > 0); }
function safeJson(value, pretty = false) { return JSON.stringify(value, null, pretty ? 2 : 0).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function mutationError(message, outcome, report) { /** @type {Error & {kind?:string,phase?:string,outcome?:string,dispatchState?:string,mutationOutcome?:unknown,mutationReport?:unknown}} */ const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function pluginResultError(message) { /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */ const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }

export function formatNodeGroupResult(result, { json = false } = {}) { return json ? safeJson(result, true) : `Grouped ${result.childIds.length} nodes as ${safeJson(result.group.name)} (${result.group.id})`; }
export async function executeNodeGroup(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Group requires a Figma evaluate adapter.');
  const input = normalizedRequest(request); const serialized = await adapters.evaluate(nodeGroupCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_GROUP_RESULT_CODE_UNITS) throw pluginResultError('Node Group returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Node Group returned invalid JSON.'); }
  if (payload?.status === 'refused') { if (!validRefusal(payload)) throw pluginResultError('Node Group returned an invalid bounded result.'); throw mutationError(`Node Group made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); }
  if (payload?.status === 'failed') { if (!validFailure(payload)) throw pluginResultError('Node Group returned an invalid bounded result.'); const residueCount = Number(payload.residue.groupPresent) + payload.residue.parentOrderChanges + payload.residue.nodeParentChanges + payload.residue.positionChanges; throw mutationError(payload.outcome === 'rolled-back' ? `Node Group failed and restored the prior hierarchy: ${payload.failure}` : `Node Group failed; the prior hierarchy could not be fully restored: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount }); }
  if (!validSuccess(payload, input)) throw pluginResultError('Node Group returned an invalid bounded result.');
  return { stdout: formatNodeGroupResult(payload, { json: input.json }), stderr: '', result: payload };
}
export function nodeGroupPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Node Group routing requires a Command Plan created by the Capability Catalog.'); return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-group'; }
export async function executeNodeGroupPlan(plan, adapters = {}) { if (nodeGroupPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Group.`); return executeNodeGroup(parseNodeGroupRequest(plan.argv), adapters); }
