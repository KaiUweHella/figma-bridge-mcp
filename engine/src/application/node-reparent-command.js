// Plan-bound, hierarchy-verified and rollback-owned `node reparent` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_REPARENT_NODE_ID_CODE_UNITS,
  nodeReparentArgvFromRequest,
  nodeReparentPlanningArgvFromRequest,
  parseNodeReparentRequest,
} from './node-reparent-request.js';

export { nodeReparentArgvFromRequest, nodeReparentPlanningArgvFromRequest } from './node-reparent-request.js';

const APPLICATION_ID = 'node.reparent';
export const MAX_NODE_REPARENT_CHILDREN = 50_000;
export const MAX_NODE_REPARENT_ANCESTORS = 512;
export const MAX_NODE_REPARENT_RESULT_CODE_UNITS = 32_768;
export const MAX_NODE_REPARENT_NAME_CODE_UNITS = 1_024;
export const NODE_REPARENT_POSITION_EPSILON = 0.01;

function normalizedRequest(request) {
  return parseNodeReparentRequest(nodeReparentArgvFromRequest(request));
}

export function nodeReparentCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const childId = ${JSON.stringify(input.nodeId)};
    const destinationId = ${JSON.stringify(input.parentId)};
    const requestedIndex = ${JSON.stringify(input.index)};
    const preservePosition = ${input.preservePosition};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_NODE_REPARENT_RESULT_CODE_UNITS}) throw new Error('Node Reparent result exceeded its bounded response limit.');
      return serialized;
    };
    const childIds = (parent, label) => {
      if (!parent || !Array.isArray(parent.children)) throw new Error(label + ' returned invalid child membership.');
      if (parent.children.length > ${MAX_NODE_REPARENT_CHILDREN}) throw new Error(label + ' exceeds the bounded child count.');
      const ids = parent.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error(label + ' returned invalid child membership.');
      return ids;
    };
    const same = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
    const absolutePosition = (node) => {
      const transform = node && node.absoluteTransform;
      return transform && transform[0] && transform[1]
        && Number.isFinite(transform[0][2]) && Number.isFinite(transform[1][2])
        ? { x: transform[0][2], y: transform[1][2] } : null;
    };
    const close = (left, right) => Math.abs(left - right) <= ${NODE_REPARENT_POSITION_EPSILON};
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });

    let child, destination, source, beforeSource, beforeDestination, oldIndex, expectedIndex;
    let oldX, oldY, oldAbsolute;
    try {
      child = await figma.getNodeByIdAsync(childId);
      destination = await figma.getNodeByIdAsync(destinationId);
      if (!child || child.type === 'DOCUMENT' || child.type === 'PAGE'
        || typeof child.id !== 'string' || typeof child.name !== 'string'
        || typeof child.type !== 'string') throw new Error('Node Reparent requires an exact canvas node.');
      if (!destination || typeof destination.id !== 'string'
        || typeof destination.appendChild !== 'function'
        || typeof destination.insertChild !== 'function') throw new Error('Node Reparent target cannot contain children.');
      source = child.parent;
      if (!source || typeof source.id !== 'string'
        || typeof source.appendChild !== 'function'
        || typeof source.insertChild !== 'function') throw new Error('Node Reparent source cannot restore its child.');
      let cursor = destination;
      for (let depth = 0; cursor && depth <= ${MAX_NODE_REPARENT_ANCESTORS}; depth++) {
        if (cursor.id === child.id) throw new Error('Cannot reparent a node into itself or one of its descendants.');
        cursor = cursor.parent || null;
        if (depth === ${MAX_NODE_REPARENT_ANCESTORS} && cursor) throw new Error('Node Reparent ancestry exceeds its bounded depth.');
      }
      beforeSource = childIds(source, 'Source parent');
      beforeDestination = source.id === destination.id ? [...beforeSource] : childIds(destination, 'Destination parent');
      oldIndex = beforeSource.indexOf(child.id);
      if (oldIndex < 0 || beforeSource.indexOf(child.id, oldIndex + 1) !== -1) throw new Error('Source parent does not contain exactly one child identity.');
      const maximumIndex = source.id === destination.id
        ? beforeDestination.length - 1 : beforeDestination.length;
      if (requestedIndex !== null && requestedIndex > maximumIndex) throw new Error('Index out of range: ' + requestedIndex + '.');
      const destinationWithoutChild = source.id === destination.id
        ? beforeDestination.filter((id) => id !== child.id) : [...beforeDestination];
      expectedIndex = requestedIndex === null ? destinationWithoutChild.length : requestedIndex;
      oldX = Number.isFinite(child.x) ? child.x : null;
      oldY = Number.isFinite(child.y) ? child.y : null;
      oldAbsolute = absolutePosition(child);
    } catch (error) { return refusal(error); }

    const requested = { parentId: destinationId, index: requestedIndex, preservePosition };
    const nodeIdentity = (node) => ({ id: clean(node.id, ${MAX_NODE_REPARENT_NODE_ID_CODE_UNITS}), name: clean(node.name, ${MAX_NODE_REPARENT_NAME_CODE_UNITS}), type: clean(node.type, 64) });
    if (source.id === destination.id && requestedIndex === null) {
      return bounded({ schemaVersion: 1, status: 'reparented', node: nodeIdentity(child), from: { parentId: clean(source.id, ${MAX_NODE_REPARENT_NODE_ID_CODE_UNITS}), index: oldIndex }, to: { parentId: clean(destination.id, ${MAX_NODE_REPARENT_NODE_ID_CODE_UNITS}), index: oldIndex }, requested, positionPreserved: true, attempted: 0, residue: [] });
    }

    let failure = 'Node Reparent could not freshly verify the complete requested hierarchy.';
    let positionPreserved = false;
    try {
      try {
        if (requestedIndex === null) destination.appendChild(child);
        else destination.insertChild(expectedIndex, child);
        const canPosition = preservePosition && oldAbsolute && 'x' in child && 'y' in child
          && (destination.type === 'PAGE' || !('layoutMode' in destination) || destination.layoutMode === 'NONE');
        if (canPosition && destination.type === 'PAGE') {
          child.x = oldAbsolute.x; child.y = oldAbsolute.y; positionPreserved = true;
        } else if (canPosition) {
          const t = destination.absoluteTransform;
          const a = t[0][0], c = t[0][1], tx = t[0][2];
          const b = t[1][0], d = t[1][1], ty = t[1][2];
          const det = a * d - b * c;
          if (Math.abs(det) > 1e-9) {
            const dx = oldAbsolute.x - tx, dy = oldAbsolute.y - ty;
            child.x = (d * dx - c * dy) / det; child.y = (-b * dx + a * dy) / det;
            positionPreserved = true;
          }
        }
      } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      const verifiedChild = await figma.getNodeByIdAsync(childId);
      const freshSource = await figma.getNodeByIdAsync(source.id);
      const freshDestination = source.id === destination.id ? freshSource : await figma.getNodeByIdAsync(destination.id);
      const sourceIds = childIds(freshSource, 'Fresh source parent');
      const destinationIds = source.id === destination.id ? sourceIds : childIds(freshDestination, 'Fresh destination parent');
      const expectedDestination = (source.id === destination.id ? beforeSource : beforeDestination).filter((id) => id !== child.id);
      expectedDestination.splice(expectedIndex, 0, child.id);
      const expectedSource = source.id === destination.id ? expectedDestination : beforeSource.filter((id) => id !== child.id);
      const actualAbsolute = absolutePosition(verifiedChild);
      if (verifiedChild && verifiedChild.parent && verifiedChild.parent.id === destination.id
        && same(sourceIds, expectedSource) && same(destinationIds, expectedDestination)
        && destinationIds.indexOf(child.id) === expectedIndex
        && (!positionPreserved || (actualAbsolute && oldAbsolute
          && close(actualAbsolute.x, oldAbsolute.x) && close(actualAbsolute.y, oldAbsolute.y)))) {
        delete globalThis.__invCache;
        return bounded({ schemaVersion: 1, status: 'reparented', node: nodeIdentity(verifiedChild), from: { parentId: clean(source.id, ${MAX_NODE_REPARENT_NODE_ID_CODE_UNITS}), index: oldIndex }, to: { parentId: clean(destination.id, ${MAX_NODE_REPARENT_NODE_ID_CODE_UNITS}), index: expectedIndex }, requested, positionPreserved, attempted: 1, residue: [] });
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }

    try {
      const rollbackChild = await figma.getNodeByIdAsync(childId);
      const rollbackSource = await figma.getNodeByIdAsync(source.id);
      const rollbackDestination = source.id === destination.id ? rollbackSource : await figma.getNodeByIdAsync(destination.id);
      if (!rollbackChild || !rollbackSource || !rollbackDestination) throw new Error('Node Reparent rollback identity is unavailable.');
      try { rollbackSource.insertChild(oldIndex, rollbackChild); } catch {}
      try { if (oldX !== null) rollbackChild.x = oldX; } catch {}
      try { if (oldY !== null) rollbackChild.y = oldY; } catch {}
      const restoredChild = await figma.getNodeByIdAsync(childId);
      const restoredSource = await figma.getNodeByIdAsync(source.id);
      const restoredDestination = source.id === destination.id ? restoredSource : await figma.getNodeByIdAsync(destination.id);
      const sourceIds = childIds(restoredSource, 'Restored source parent');
      const destinationIds = source.id === destination.id ? sourceIds : childIds(restoredDestination, 'Restored destination parent');
      const restoredPosition = oldX === null || oldY === null || (close(restoredChild.x, oldX) && close(restoredChild.y, oldY));
      const childParentChanged = !restoredChild.parent || restoredChild.parent.id !== source.id;
      const sourceOrderChanged = !same(sourceIds, beforeSource);
      const destinationOrderChanged = !same(destinationIds, beforeDestination);
      const positionChanged = !restoredPosition;
      const restored = !childParentChanged && !sourceOrderChanged && !destinationOrderChanged && !positionChanged;
      if (restored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1, restored: restored ? 1 : 0, failure, residue: { childParentChanged, sourceOrderChanged, destinationOrderChanged, positionChanged } });
    } catch {
      return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, failure, residue: { childParentChanged: false, sourceOrderChanged: false, destinationOrderChanged: false, positionChanged: false } });
    }
  })()`;
}

function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function validString(value, max, empty = true) { return typeof value === 'string' && value.length <= max && (empty || value.length > 0); }
function validId(value) { return validString(value, MAX_NODE_REPARENT_NODE_ID_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value); }
function validNode(value, input) { return exactKeys(value, ['id', 'name', 'type']) && value.id === input.nodeId && validId(value.id) && validString(value.name, MAX_NODE_REPARENT_NAME_CODE_UNITS) && validString(value.type, 64, false); }
function validPosition(value) { return exactKeys(value, ['parentId', 'index']) && validId(value.parentId) && Number.isSafeInteger(value.index) && value.index >= 0; }
function validRequested(value, input) { return exactKeys(value, ['parentId', 'index', 'preservePosition']) && value.parentId === input.parentId && value.index === input.index && value.preservePosition === input.preservePosition; }
function validSuccess(value, input) { return exactKeys(value, ['schemaVersion', 'status', 'node', 'from', 'to', 'requested', 'positionPreserved', 'attempted', 'residue']) && value.schemaVersion === 1 && value.status === 'reparented' && validNode(value.node, input) && validPosition(value.from) && validPosition(value.to) && validRequested(value.requested, input) && value.to.parentId === input.parentId && (input.index === null || value.to.index === input.index) && typeof value.positionPreserved === 'boolean' && [0, 1].includes(value.attempted) && (value.attempted !== 0 || (input.index === null && value.from.parentId === value.to.parentId && value.from.index === value.to.index)) && Array.isArray(value.residue) && value.residue.length === 0; }
function validRefusal(value) { return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation' && value.attempted === 0 && validString(value.failure, 1024, false); }
function validResidue(value) { return exactKeys(value, ['childParentChanged', 'sourceOrderChanged', 'destinationOrderChanged', 'positionChanged']) && Object.values(value).every((entry) => typeof entry === 'boolean'); }
function validFailure(value) { const count = value?.residue && Object.values(value.residue).filter(Boolean).length; return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'failure', 'residue']) && value.schemaVersion === 1 && value.status === 'failed' && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0, 1].includes(value.restored) && validString(value.failure, 1024, false) && validResidue(value.residue) && (value.outcome === 'rolled-back' ? value.restored === 1 && count === 0 : value.restored === 0) && (value.outcome !== 'partial-residue' || count > 0); }
function safeJson(value, pretty = false) { return JSON.stringify(value, null, pretty ? 2 : 0).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function mutationError(message, outcome, report) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string,dispatchState?:string,mutationOutcome?:unknown,mutationReport?:unknown}} */
  const error = new Error(message);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = outcome;
  error.mutationReport = report;
  return error;
}
function pluginResultError(message) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */
  const error = new Error(message);
  error.kind = 'plugin-result';
  error.phase = 'plugin-response';
  error.outcome = 'unknown-after-dispatch';
  return error;
}

export function formatNodeReparentResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  return `Moved ${safeJson(result.node.name)} (${result.node.id}) into ${result.to.parentId} at index ${result.to.index}${result.positionPreserved ? ' with canvas position preserved' : ''}`;
}
export async function executeNodeReparent(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Reparent requires a Figma evaluate adapter.');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(nodeReparentCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_REPARENT_RESULT_CODE_UNITS) throw pluginResultError('Node Reparent returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Node Reparent returned invalid JSON.'); }
  if (payload?.status === 'refused') { if (!validRefusal(payload)) throw pluginResultError('Node Reparent returned an invalid bounded result.'); throw mutationError(`Node Reparent made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); }
  if (payload?.status === 'failed') { if (!validFailure(payload)) throw pluginResultError('Node Reparent returned an invalid bounded result.'); const residueCount = Object.values(payload.residue).filter(Boolean).length; throw mutationError(payload.outcome === 'rolled-back' ? `Node Reparent failed and restored the prior hierarchy: ${payload.failure}` : `Node Reparent failed; the prior hierarchy could not be fully restored: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount }); }
  if (!validSuccess(payload, input)) throw pluginResultError('Node Reparent returned an invalid bounded result.');
  return { stdout: formatNodeReparentResult(payload, { json: input.json }), stderr: '', result: payload };
}
export function nodeReparentPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Node Reparent routing requires a Command Plan created by the Capability Catalog.'); return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-reparent'; }
export async function executeNodeReparentPlan(plan, adapters = {}) { if (nodeReparentPlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Reparent.`); return executeNodeReparent(parseNodeReparentRequest(plan.argv), adapters); }
