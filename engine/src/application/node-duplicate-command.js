// Plan-bound, rollback-verified Command Application for `node duplicate`.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_DUPLICATE_NAME_CODE_UNITS,
  MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS,
  nodeDuplicateArgvFromRequest,
  nodeDuplicatePlanningArgvFromRequest,
  parseNodeDuplicateRequest,
} from './node-duplicate-request.js';

export {
  nodeDuplicateArgvFromRequest,
  nodeDuplicatePlanningArgvFromRequest,
} from './node-duplicate-request.js';

const APPLICATION_ID = 'node.duplicate';
export const MAX_NODE_DUPLICATE_CHILDREN = 50_000;
export const MAX_NODE_DUPLICATE_RESULT_CODE_UNITS = 32_768;
export const NODE_DUPLICATE_VERIFY_EPSILON = 0.01;

function normalizedRequest(request) {
  return parseNodeDuplicateRequest(nodeDuplicateArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function nodeDuplicateCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const sourceId = ${jsValue(input.nodeId)};
    const requestedParentId = ${jsValue(input.parentId)};
    const requestedIndex = ${jsValue(input.index)};
    const requestedName = ${jsValue(input.name)};
    const offsetX = ${input.offsetX};
    const offsetY = ${input.offsetY};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_NODE_DUPLICATE_RESULT_CODE_UNITS}) {
        throw new Error('Node Duplicate result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const childrenOf = (node, label) => {
      if (!node || !Array.isArray(node.children)) {
        throw new Error(label + ' returned invalid child membership.');
      }
      if (node.children.length > ${MAX_NODE_DUPLICATE_CHILDREN}) {
        throw new Error(label + ' exceeds the bounded child count.');
      }
      const ids = node.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
        throw new Error(label + ' returned invalid child membership.');
      }
      return ids;
    };
    const sameIds = (left, right) => left.length === right.length
      && left.every((id, index) => id === right[index]);
    const refusal = (error) => bounded({
      schemaVersion: 1,
      status: 'refused',
      outcome: 'no-mutation',
      attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let source;
    let sourceParent;
    let targetParent;
    let beforeSourceIds;
    let beforeTargetIds;
    let sourceIndex;
    let expectedIndex;
    let expectedName;
    let expectedX;
    let expectedY;
    try {
      source = await figma.getNodeByIdAsync(sourceId);
      if (!source || source.type === 'DOCUMENT' || source.type === 'PAGE'
        || typeof source.clone !== 'function') {
        throw new Error('Node Duplicate requires an exact cloneable canvas node.');
      }
      if (!Number.isFinite(source.x) || !Number.isFinite(source.y)) {
        throw new Error('Source node has no finite canvas position.');
      }
      sourceParent = source.parent;
      if (!sourceParent || typeof sourceParent.appendChild !== 'function'
        || typeof sourceParent.insertChild !== 'function') {
        throw new Error('Source parent cannot retain a duplicate.');
      }
      targetParent = requestedParentId === null
        ? sourceParent
        : await figma.getNodeByIdAsync(requestedParentId);
      if (!targetParent || targetParent.type === 'DOCUMENT' || targetParent.remote === true
        || typeof targetParent.appendChild !== 'function'
        || typeof targetParent.insertChild !== 'function') {
        throw new Error('Target parent cannot contain a duplicate.');
      }
      beforeSourceIds = childrenOf(sourceParent, 'Source parent');
      beforeTargetIds = targetParent.id === sourceParent.id
        ? [...beforeSourceIds]
        : childrenOf(targetParent, 'Target parent');
      sourceIndex = beforeSourceIds.indexOf(source.id);
      if (sourceIndex < 0) throw new Error('Source parent does not contain the source node.');
      if (beforeSourceIds.indexOf(source.id, sourceIndex + 1) !== -1) {
        throw new Error('Source parent contains duplicate source identity.');
      }
      if (requestedIndex !== null && requestedIndex > beforeTargetIds.length) {
        throw new Error('Index out of range: ' + requestedIndex + '.');
      }
      expectedIndex = requestedParentId === null
        ? sourceIndex + 1
        : (requestedIndex === null ? beforeTargetIds.length : requestedIndex);
      expectedName = requestedName === null ? source.name : requestedName;
      expectedX = source.x + offsetX;
      expectedY = source.y + offsetY;
      if (!Number.isFinite(expectedX) || !Number.isFinite(expectedY)) {
        throw new Error('Requested duplicate position is not finite.');
      }
    } catch (error) {
      return refusal(error);
    }

    let copy = null;
    try {
      copy = source.clone();
      if (!copy || typeof copy.id !== 'string' || copy.id === source.id
        || typeof copy.remove !== 'function') {
        throw new Error('Source did not return a distinct removable duplicate.');
      }
      if (requestedParentId === null) sourceParent.insertChild(expectedIndex, copy);
      else if (requestedIndex === null) targetParent.appendChild(copy);
      else targetParent.insertChild(requestedIndex, copy);
      if (requestedName !== null) copy.name = requestedName;
      const positioning = targetParent.layoutMode && targetParent.layoutMode !== 'NONE'
        && copy.layoutPositioning !== 'ABSOLUTE'
        ? 'auto-layout-managed'
        : 'explicit-offset';
      copy.x = expectedX;
      copy.y = expectedY;

      const verifiedSource = await figma.getNodeByIdAsync(source.id);
      const verifiedCopy = await figma.getNodeByIdAsync(copy.id);
      const freshSourceParent = await figma.getNodeByIdAsync(sourceParent.id);
      const freshTargetParent = targetParent.id === sourceParent.id
        ? freshSourceParent
        : await figma.getNodeByIdAsync(targetParent.id);
      const afterSourceIds = childrenOf(freshSourceParent, 'Fresh source parent');
      const afterTargetIds = targetParent.id === sourceParent.id
        ? afterSourceIds
        : childrenOf(freshTargetParent, 'Fresh target parent');
      const expectedTargetIds = [...beforeTargetIds];
      expectedTargetIds.splice(expectedIndex, 0, copy.id);
      const expectedSourceIds = targetParent.id === sourceParent.id
        ? expectedTargetIds
        : beforeSourceIds;
      if (!verifiedSource || verifiedSource.id !== source.id
        || !verifiedCopy || verifiedCopy.id !== copy.id
        || verifiedCopy.type !== source.type
        || !verifiedCopy.parent || verifiedCopy.parent.id !== targetParent.id
        || !sameIds(afterSourceIds, expectedSourceIds)
        || !sameIds(afterTargetIds, expectedTargetIds)
        || afterTargetIds[expectedIndex] !== copy.id
        || verifiedCopy.name !== expectedName
        || !Number.isFinite(verifiedCopy.x) || !Number.isFinite(verifiedCopy.y)
        || (positioning === 'explicit-offset'
          && (Math.abs(verifiedCopy.x - expectedX) > ${NODE_DUPLICATE_VERIFY_EPSILON}
            || Math.abs(verifiedCopy.y - expectedY) > ${NODE_DUPLICATE_VERIFY_EPSILON}))) {
        throw new Error('Node Duplicate could not freshly verify the complete requested state.');
      }
      delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1,
        status: 'duplicated',
        source: {
          id: clean(source.id, ${MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS}),
          name: clean(source.name, ${MAX_NODE_DUPLICATE_NAME_CODE_UNITS}),
          type: clean(source.type, 64),
          parentId: clean(sourceParent.id, ${MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS}),
          index: sourceIndex,
          x: source.x,
          y: source.y,
          positioning: 'source',
        },
        copy: {
          id: clean(verifiedCopy.id, ${MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS}),
          name: clean(verifiedCopy.name, ${MAX_NODE_DUPLICATE_NAME_CODE_UNITS}),
          type: clean(verifiedCopy.type, 64),
          parentId: clean(targetParent.id, ${MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS}),
          index: expectedIndex,
          x: verifiedCopy.x,
          y: verifiedCopy.y,
          positioning,
        },
        requested: {
          parentId: requestedParentId,
          index: requestedIndex,
          name: requestedName,
          offsetX,
          offsetY,
        },
        attempted: 1,
        residue: [],
      });
    } catch (error) {
      const failure = clean(error && error.message ? error.message : String(error), 1024);
      if (!copy || typeof copy.id !== 'string') {
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: 'verification-unavailable',
          attempted: 1,
          restored: 0,
          residue: {
            copyId: null,
            copyPresent: false,
            sourceParentChanged: false,
            targetParentChanged: false,
          },
          failure,
        });
      }
      try { copy.remove(); } catch {}
      try {
        const freshCopy = await figma.getNodeByIdAsync(copy.id);
        const freshSourceParent = await figma.getNodeByIdAsync(sourceParent.id);
        const freshTargetParent = targetParent.id === sourceParent.id
          ? freshSourceParent
          : await figma.getNodeByIdAsync(targetParent.id);
        const restoredSourceIds = childrenOf(freshSourceParent, 'Restored source parent');
        const restoredTargetIds = targetParent.id === sourceParent.id
          ? restoredSourceIds
          : childrenOf(freshTargetParent, 'Restored target parent');
        const copyPresent = Boolean(freshCopy)
          || restoredSourceIds.includes(copy.id) || restoredTargetIds.includes(copy.id);
        const sourceParentChanged = !sameIds(restoredSourceIds, beforeSourceIds);
        const targetParentChanged = !sameIds(restoredTargetIds, beforeTargetIds);
        const restored = !copyPresent && !sourceParentChanged && !targetParentChanged;
        if (restored) delete globalThis.__invCache;
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: restored ? 'rolled-back' : 'partial-residue',
          attempted: 1,
          restored: restored ? 1 : 0,
          residue: {
            copyId: clean(copy.id, ${MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS}),
            copyPresent,
            sourceParentChanged,
            targetParentChanged,
          },
          failure,
        });
      } catch {
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: 'verification-unavailable',
          attempted: 1,
          restored: 0,
          residue: {
            copyId: clean(copy.id, ${MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS}),
            copyPresent: false,
            sourceParentChanged: false,
            targetParentChanged: false,
          },
          failure,
        });
      }
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
  return validString(value, MAX_NODE_DUPLICATE_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value);
}

function validPosition(value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE * 2;
}

function validNode(value) {
  return exactKeys(value, [
    'id', 'name', 'type', 'parentId', 'index', 'x', 'y', 'positioning',
  ])
    && validId(value.id)
    && validString(value.name, MAX_NODE_DUPLICATE_NAME_CODE_UNITS)
    && validString(value.type, 64, false)
    && validId(value.parentId)
    && Number.isSafeInteger(value.index) && value.index >= 0
    && validPosition(value.x) && validPosition(value.y)
    && ['source', 'explicit-offset', 'auto-layout-managed'].includes(value.positioning);
}

function validRequested(value) {
  return exactKeys(value, ['parentId', 'index', 'name', 'offsetX', 'offsetY'])
    && (value.parentId === null || validId(value.parentId))
    && (value.index === null || (Number.isSafeInteger(value.index) && value.index >= 0))
    && (value.name === null || validString(value.name, MAX_NODE_DUPLICATE_NAME_CODE_UNITS))
    && Number.isFinite(value.offsetX) && Math.abs(value.offsetX) <= MAX_ABSOLUTE_NODE_COORDINATE
    && Number.isFinite(value.offsetY) && Math.abs(value.offsetY) <= MAX_ABSOLUTE_NODE_COORDINATE;
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'source', 'copy', 'requested', 'attempted', 'residue',
  ])
    && value.schemaVersion === 1 && value.status === 'duplicated'
    && validNode(value.source) && validNode(value.copy) && validRequested(value.requested)
    && value.source.id === input.nodeId && value.copy.id !== input.nodeId
    && value.copy.type === value.source.type
    && value.copy.parentId === (input.parentId || value.source.parentId)
    && (input.index === null || value.copy.index === input.index)
    && (input.name === null || value.copy.name === input.name)
    && value.requested.parentId === input.parentId
    && value.requested.index === input.index
    && value.requested.name === input.name
    && value.requested.offsetX === input.offsetX
    && value.requested.offsetY === input.offsetY
    && (value.copy.positioning === 'auto-layout-managed'
      || (value.copy.positioning === 'explicit-offset'
        && Math.abs(value.copy.x - (value.source.x + input.offsetX)) <= NODE_DUPLICATE_VERIFY_EPSILON
        && Math.abs(value.copy.y - (value.source.y + input.offsetY)) <= NODE_DUPLICATE_VERIFY_EPSILON))
    && value.attempted === 1
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure',
  ])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && exactKeys(value.residue, [
      'copyId', 'copyPresent', 'sourceParentChanged', 'targetParentChanged',
    ])
    && (value.residue.copyId === null || validId(value.residue.copyId))
    && typeof value.residue.copyPresent === 'boolean'
    && typeof value.residue.sourceParentChanged === 'boolean'
    && typeof value.residue.targetParentChanged === 'boolean'
    && validString(value.failure, 1_024, false)
    && (value.outcome !== 'rolled-back'
      || (value.restored === 1 && value.residue.copyId !== null
        && !value.residue.copyPresent && !value.residue.sourceParentChanged
        && !value.residue.targetParentChanged))
    && (value.outcome !== 'partial-residue'
      || (value.restored === 0 && (value.residue.copyPresent
        || value.residue.sourceParentChanged || value.residue.targetParentChanged)))
    && (value.outcome !== 'verification-unavailable' || value.restored === 0);
}

function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && validString(value.failure, 1_024, false);
}

function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatNodeDuplicateResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  return `Duplicated ${safeJson(result.source.name)} (${result.source.id}) as `
    + `${safeJson(result.copy.name)} (${result.copy.id}) in ${result.copy.parentId} `
    + `at index ${result.copy.index}, x=${result.copy.x}, y=${result.copy.y} `
    + `(${result.copy.positioning})`;
}

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

export async function executeNodeDuplicate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Node Duplicate requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(nodeDuplicateCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_DUPLICATE_RESULT_CODE_UNITS) {
    throw pluginResultError('Node Duplicate returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Node Duplicate returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Node Duplicate returned an invalid bounded result.');
    throw mutationError(`Node Duplicate made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw pluginResultError('Node Duplicate returned an invalid bounded result.');
    const residueCount = Number(payload.residue.copyPresent)
      + Number(payload.residue.sourceParentChanged)
      + Number(payload.residue.targetParentChanged);
    const message = payload.outcome === 'rolled-back'
      ? `Node Duplicate failed and removed the new copy: ${payload.failure}`
      : `Node Duplicate failed; the new copy outcome could not be fully restored: ${payload.failure}`;
    throw mutationError(message, payload.outcome, {
      version: 1,
      outcome: payload.outcome,
      attempted: 1,
      restored: payload.restored,
      residueCount,
    });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Node Duplicate returned an invalid bounded result.');
  }
  return {
    stdout: formatNodeDuplicateResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function nodeDuplicatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Duplicate routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-node-duplicate';
}

export async function executeNodeDuplicatePlan(plan, adapters = {}) {
  if (nodeDuplicatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Duplicate.`);
  }
  return executeNodeDuplicate(parseNodeDuplicateRequest(plan.argv), adapters);
}
