// Plan-bound, hierarchy-verified `node boolean` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_BOOLEAN_NAME_CODE_UNITS,
  MAX_NODE_BOOLEAN_NODE_ID_CODE_UNITS,
  MAX_NODE_BOOLEAN_NODES,
  nodeBooleanArgvFromRequest,
  nodeBooleanPlanningArgvFromRequest,
  parseNodeBooleanRequest,
} from './node-boolean-request.js';

export { nodeBooleanArgvFromRequest, nodeBooleanPlanningArgvFromRequest } from './node-boolean-request.js';

const APPLICATION_ID = 'node.boolean';
export const MAX_NODE_BOOLEAN_CHILDREN = 50_000;
export const MAX_NODE_BOOLEAN_MEMBERSHIPS = 100_000;
export const MAX_NODE_BOOLEAN_ANCESTORS = 512;
export const MAX_NODE_BOOLEAN_RESULT_CODE_UNITS = 65_536;
export const NODE_BOOLEAN_RESULT_OPERATIONS = Object.freeze({
  union: 'UNION',
  subtract: 'SUBTRACT',
  intersect: 'INTERSECT',
  exclude: 'EXCLUDE',
});

function normalizedRequest(request) {
  return parseNodeBooleanRequest(nodeBooleanArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function nodeBooleanCode(request) {
  const input = normalizedRequest(request);
  const expectedOperation = NODE_BOOLEAN_RESULT_OPERATIONS[input.operation];
  return `(async () => {
    const operation = ${jsValue(input.operation)};
    const expectedOperation = ${jsValue(expectedOperation)};
    const nodeIds = ${jsValue(input.nodeIds)};
    const requestedParentId = ${jsValue(input.parentId)};
    const requestedIndex = ${jsValue(input.index)};
    const requestedName = ${jsValue(input.name)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_NODE_BOOLEAN_RESULT_CODE_UNITS}) throw new Error('Node Boolean result exceeded its bounded response limit.');
      return serialized;
    };
    let memberships = 0;
    const childIds = (parent, label) => {
      if (!parent || !Array.isArray(parent.children)) throw new Error(label + ' returned invalid child membership.');
      if (parent.children.length > ${MAX_NODE_BOOLEAN_CHILDREN}) throw new Error(label + ' exceeds the bounded child count.');
      memberships += parent.children.length;
      if (memberships > ${MAX_NODE_BOOLEAN_MEMBERSHIPS}) throw new Error('Node Boolean exceeds the bounded aggregate membership count.');
      const ids = parent.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error(label + ' returned invalid child membership.');
      return ids;
    };
    const same = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024) });

    let nodes, target, parentSnapshots, targetBefore;
    try {
      nodes = [];
      for (const id of nodeIds) {
        const node = await figma.getNodeByIdAsync(id);
        if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE'
          || typeof node.id !== 'string' || !node.parent) throw new Error('Node Boolean requires exact attached canvas nodes.');
        nodes.push(node);
      }
      target = requestedParentId === null ? nodes[0].parent : await figma.getNodeByIdAsync(requestedParentId);
      if (!target || typeof target.id !== 'string' || typeof target.appendChild !== 'function'
        || typeof target.insertChild !== 'function') throw new Error('Node Boolean target cannot contain children.');
      if (requestedParentId === null && nodes.some((node) => node.parent.id !== target.id)) {
        throw new Error('Nodes must share one parent unless --parent is provided.');
      }
      const selected = new Set(nodeIds);
      let cursor = target;
      for (let depth = 0; cursor && depth <= ${MAX_NODE_BOOLEAN_ANCESTORS}; depth++) {
        if (selected.has(cursor.id)) throw new Error('Cannot combine nodes into themselves or their descendants.');
        cursor = cursor.parent || null;
        if (depth === ${MAX_NODE_BOOLEAN_ANCESTORS} && cursor) throw new Error('Node Boolean ancestry exceeds its bounded depth.');
      }
      parentSnapshots = [];
      const seenParents = new Set();
      for (const node of nodes) {
        if (!node.parent || node.parent.children.indexOf(node) < 0) throw new Error('A source is detached from its parent.');
        if (seenParents.has(node.parent.id)) continue;
        seenParents.add(node.parent.id);
        parentSnapshots.push({ id: node.parent.id, ids: childIds(node.parent, 'Original parent') });
      }
      if (!seenParents.has(target.id)) parentSnapshots.push({ id: target.id, ids: childIds(target, 'Target parent') });
      targetBefore = parentSnapshots.find((item) => item.id === target.id).ids;
      const maximumIndex = targetBefore.filter((id) => !selected.has(id)).length;
      if (requestedIndex !== null && requestedIndex > maximumIndex) throw new Error('Index out of range: ' + requestedIndex + '.');
    } catch (error) { return refusal(error); }

    let result = null;
    let failure = 'Node Boolean could not freshly verify the complete requested hierarchy.';
    try {
      try {
        const insertionIndex = requestedIndex === null ? undefined : requestedIndex;
        if (operation === 'union') result = figma.union(nodes, target, insertionIndex);
        else if (operation === 'subtract') result = figma.subtract(nodes, target, insertionIndex);
        else if (operation === 'intersect') result = figma.intersect(nodes, target, insertionIndex);
        else result = figma.exclude(nodes, target, insertionIndex);
        if (requestedName !== null) result.name = requestedName;
      } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      if (result && typeof result.id === 'string') {
        const freshBoolean = await figma.getNodeByIdAsync(result.id);
        const freshTarget = await figma.getNodeByIdAsync(target.id);
        memberships = 0;
        const targetIds = childIds(freshTarget, 'Fresh target parent');
        const children = childIds(freshBoolean, 'Fresh boolean node');
        const booleanIndex = targetIds.indexOf(result.id);
        const expectedTarget = targetBefore.filter((id) => !nodeIds.includes(id));
        if (booleanIndex >= 0) expectedTarget.splice(booleanIndex, 0, result.id);
        let originalParentsMatch = true;
        for (const snapshot of parentSnapshots) {
          if (snapshot.id === target.id) continue;
          const parent = await figma.getNodeByIdAsync(snapshot.id);
          if (!same(childIds(parent, 'Fresh original parent'), snapshot.ids.filter((id) => !nodeIds.includes(id)))) {
            originalParentsMatch = false;
          }
        }
        const exactMembers = same(children, nodeIds);
        let memberParentsMatch = true;
        for (const id of nodeIds) {
          const member = await figma.getNodeByIdAsync(id);
          if (!member || !member.parent || member.parent.id !== result.id) memberParentsMatch = false;
        }
        if (freshBoolean && freshBoolean.type === 'BOOLEAN_OPERATION'
          && freshBoolean.booleanOperation === expectedOperation
          && freshBoolean.parent && freshBoolean.parent.id === target.id
          && booleanIndex >= 0 && (requestedIndex === null || booleanIndex === requestedIndex)
          && same(targetIds, expectedTarget) && originalParentsMatch
          && exactMembers && memberParentsMatch
          && (requestedName === null || freshBoolean.name === requestedName)) {
          delete globalThis.__invCache;
          return bounded({ schemaVersion: 1, status: 'combined',
            boolean: { id: clean(freshBoolean.id, ${MAX_NODE_BOOLEAN_NODE_ID_CODE_UNITS}), name: clean(freshBoolean.name, ${MAX_NODE_BOOLEAN_NAME_CODE_UNITS}), type: 'BOOLEAN_OPERATION', operation: expectedOperation, parentId: clean(target.id, ${MAX_NODE_BOOLEAN_NODE_ID_CODE_UNITS}), index: booleanIndex },
            childIds: children.map((id) => clean(id, ${MAX_NODE_BOOLEAN_NODE_ID_CODE_UNITS})),
            requested: { operation, nodeIds, parentId: requestedParentId, index: requestedIndex, name: requestedName }, attempted: 1, residue: [] });
        }
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }

    try {
      memberships = 0;
      let parentOrderChanges = 0;
      for (const snapshot of parentSnapshots) {
        const parent = await figma.getNodeByIdAsync(snapshot.id);
        if (!same(childIds(parent, 'Observed parent'), snapshot.ids)) parentOrderChanges++;
      }
      let nodeParentChanges = 0;
      for (const id of nodeIds) {
        const node = await figma.getNodeByIdAsync(id);
        const original = parentSnapshots.find((snapshot) => snapshot.ids.includes(id));
        if (!node || !node.parent || !original || node.parent.id !== original.id) nodeParentChanges++;
      }
      const booleanPresent = Boolean(result && typeof result.id === 'string' && await figma.getNodeByIdAsync(result.id));
      const unchanged = parentOrderChanges === 0 && nodeParentChanges === 0 && !booleanPresent;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: unchanged ? 'rolled-back' : 'partial-residue',
        attempted: 1, restored: unchanged ? 1 : 0, failure,
        residue: { booleanPresent, parentOrderChanges, nodeParentChanges } });
    } catch {
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, failure, residue: { booleanPresent: false, parentOrderChanges: 0, nodeParentChanges: 0 } });
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function validString(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}
function validId(value) {
  return validString(value, MAX_NODE_BOOLEAN_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value);
}
function validBoolean(value, input) {
  return exactKeys(value, ['id', 'name', 'type', 'operation', 'parentId', 'index'])
    && validId(value.id) && !input.nodeIds.includes(value.id)
    && validString(value.name, MAX_NODE_BOOLEAN_NAME_CODE_UNITS)
    && value.type === 'BOOLEAN_OPERATION'
    && value.operation === NODE_BOOLEAN_RESULT_OPERATIONS[input.operation]
    && validId(value.parentId) && (input.parentId === null || value.parentId === input.parentId)
    && Number.isSafeInteger(value.index) && value.index >= 0
    && (input.index === null || value.index === input.index);
}
function validRequested(value, input) {
  return exactKeys(value, ['operation', 'nodeIds', 'parentId', 'index', 'name'])
    && value.operation === input.operation
    && Array.isArray(value.nodeIds) && value.nodeIds.length === input.nodeIds.length
    && value.nodeIds.every((id, index) => id === input.nodeIds[index])
    && value.parentId === input.parentId && value.index === input.index && value.name === input.name;
}
function validSuccess(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'boolean', 'childIds', 'requested', 'attempted', 'residue'])
    && value.schemaVersion === 1 && value.status === 'combined'
    && validBoolean(value.boolean, input)
    && (input.name === null || value.boolean.name === input.name)
    && Array.isArray(value.childIds) && value.childIds.length === input.nodeIds.length
    && value.childIds.every((id, index) => validId(id) && id === input.nodeIds[index])
    && validRequested(value.requested, input) && value.attempted === 1
    && Array.isArray(value.residue) && value.residue.length === 0;
}
function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation'
    && value.attempted === 0 && validString(value.failure, 1024, false);
}
function validResidue(value) {
  return exactKeys(value, ['booleanPresent', 'parentOrderChanges', 'nodeParentChanges'])
    && typeof value.booleanPresent === 'boolean'
    && ['parentOrderChanges', 'nodeParentChanges'].every((key) => Number.isSafeInteger(value[key])
      && value[key] >= 0 && value[key] <= MAX_NODE_BOOLEAN_NODES + 1);
}
function validFailure(value) {
  const count = value?.residue ? Number(value.residue.booleanPresent)
    + value.residue.parentOrderChanges + value.residue.nodeParentChanges : 0;
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'failure', 'residue'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && validString(value.failure, 1024, false) && validResidue(value.residue)
    && (value.outcome === 'rolled-back' ? value.restored === 1 && count === 0 : value.restored === 0)
    && (value.outcome !== 'partial-residue' || count > 0);
}
function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report });
  return error;
}
function pluginResultError(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
  return error;
}

export function formatNodeBooleanResult(result, { json = false } = {}) {
  return json ? safeJson(result, true)
    : `${result.boolean.operation} created as ${safeJson(result.boolean.name)} (${result.boolean.id})`;
}

export async function executeNodeBoolean(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Boolean requires a Figma evaluate adapter.');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(nodeBooleanCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_BOOLEAN_RESULT_CODE_UNITS) {
    throw pluginResultError('Node Boolean returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Node Boolean returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Node Boolean returned an invalid bounded result.');
    throw mutationError(`Node Boolean made no mutation: ${payload.failure}`, 'no-mutation',
      { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw pluginResultError('Node Boolean returned an invalid bounded result.');
    const residueCount = Number(payload.residue.booleanPresent)
      + payload.residue.parentOrderChanges + payload.residue.nodeParentChanges;
    throw mutationError(`Node Boolean failed with ${payload.outcome}: ${payload.failure}`, payload.outcome,
      { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount });
  }
  if (!validSuccess(payload, input)) throw pluginResultError('Node Boolean returned an invalid bounded result.');
  return { stdout: formatNodeBooleanResult(payload, { json: input.json }), stderr: '', result: payload };
}

export function nodeBooleanPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Boolean routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-boolean';
}

export async function executeNodeBooleanPlan(plan, adapters = {}) {
  if (nodeBooleanPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Boolean.`);
  }
  return executeNodeBoolean(parseNodeBooleanRequest(plan.argv), adapters);
}
