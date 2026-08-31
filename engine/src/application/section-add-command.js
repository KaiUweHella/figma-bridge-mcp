// Plan-bound, hierarchy-verified and rollback-owned `section add` batch mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  parseSectionAddRequest,
  sectionAddArgvFromRequest,
  sectionAddPlanningArgvFromRequest,
} from './section-add-request.js';

export {
  sectionAddArgvFromRequest,
  sectionAddPlanningArgvFromRequest,
} from './section-add-request.js';

const APPLICATION_ID = 'section.add';
export const MAX_SECTION_ADD_PARENT_CHILDREN = 50_000;
export const MAX_SECTION_ADD_TOTAL_MEMBERSHIPS = 100_000;
export const MAX_SECTION_ADD_ANCESTORS = 512;
export const MAX_SECTION_ADD_RESULT_CODE_UNITS = 2_000_000;
export const MAX_SECTION_ADD_SNAPSHOT_CODE_UNITS = 900_000;
export const SECTION_ADD_POSITION_EPSILON = 0.01;
const MAX_NAME_CODE_UNITS = 1_024;
const MAX_TYPE_CODE_UNITS = 64;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseSectionAddRequest(sectionAddArgvFromRequest(request));

function targetPosition(transform, absolute) {
  const [[a, c, tx], [b, d, ty]] = transform;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) <= 1e-9) return null;
  const dx = absolute.x - tx;
  const dy = absolute.y - ty;
  return {
    x: (d * dx - c * dy) / determinant,
    y: (-b * dx + a * dy) / determinant,
  };
}

function expectedState(before, input) {
  const parents = before.parents.map((parent) => ({
    id: parent.id, childIds: [...parent.childIds],
  }));
  const memberships = new Map(parents.map((parent) => [parent.id, parent.childIds]));
  const sectionChildren = memberships.get(input.sectionId);
  if (!sectionChildren) return null;
  for (const node of before.nodes) {
    const source = memberships.get(node.parentId);
    if (!source) return null;
    const sourceIndex = source.indexOf(node.id);
    if (sourceIndex < 0) return null;
    source.splice(sourceIndex, 1);
    sectionChildren.push(node.id);
  }
  const nodes = before.nodes.map((node) => {
    const local = targetPosition(before.sectionTransform, node.absolute);
    return local && {
      ...node,
      parentId: input.sectionId,
      index: sectionChildren.indexOf(node.id),
      x: local.x,
      y: local.y,
    };
  });
  return nodes.every(Boolean) ? {
    sectionTransform: before.sectionTransform.map((row) => [...row]), parents, nodes,
  } : null;
}

export function sectionAddCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${JSON.stringify(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SECTION_ADD_RESULT_CODE_UNITS}) {
        throw new Error('Section Add result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const finite = (value) => Number.isFinite(value)
      && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE};
    const transform = (node, invertible = true) => {
      const value = node && node.absoluteTransform;
      if (!Array.isArray(value) || value.length !== 2
        || value.some((row) => !Array.isArray(row) || row.length !== 3
          || row.some((entry) => !finite(entry)))) {
        throw new Error('Section Add requires finite absolute transforms.');
      }
      const result = value.map((row) => [...row]);
      const determinant = result[0][0] * result[1][1] - result[1][0] * result[0][1];
      if (invertible && Math.abs(determinant) <= 1e-9) {
        throw new Error('Section Add requires an invertible Section transform.');
      }
      return result;
    };
    const absolute = (node) => {
      const value = transform(node, false);
      return { x: value[0][2], y: value[1][2] };
    };
    const identity = (node) => ({
      id: clean(node.id, ${MAX_NODE_REFERENCE_CODE_UNITS}),
      name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
      type: 'SECTION',
    });
    const parentChildren = (parent, label) => {
      if (!parent || typeof parent.id !== 'string' || !nodeIdPattern.test(parent.id)
        || parent.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
        || typeof parent.appendChild !== 'function'
        || typeof parent.insertChild !== 'function'
        || !Array.isArray(parent.children)
        || parent.children.length > ${MAX_SECTION_ADD_PARENT_CHILDREN}) {
        throw new Error(label + ' cannot provide a bounded restorable child inventory.');
      }
      const ids = parent.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string' || !nodeIdPattern.test(id)
        || id.length > ${MAX_NODE_REFERENCE_CODE_UNITS})
        || new Set(ids).size !== ids.length) {
        throw new Error(label + ' returned invalid child membership.');
      }
      return ids;
    };
    const targetPosition = (sectionTransform, position) => {
      const a = sectionTransform[0][0], c = sectionTransform[0][1], tx = sectionTransform[0][2];
      const b = sectionTransform[1][0], d = sectionTransform[1][1], ty = sectionTransform[1][2];
      const determinant = a * d - b * c;
      if (Math.abs(determinant) <= 1e-9) throw new Error('Section Add requires an invertible Section transform.');
      const dx = position.x - tx, dy = position.y - ty;
      const value = {
        x: (d * dx - c * dy) / determinant,
        y: (-b * dx + a * dy) / determinant,
      };
      if (!finite(value.x) || !finite(value.y)) {
        throw new Error('Section Add target position exceeded the bounded coordinate limit.');
      }
      return value;
    };
    const snapshot = async (parentIds, nodeIds) => {
      const section = await figma.getNodeByIdAsync(request.sectionId);
      if (!section || section.id !== request.sectionId || section.type !== 'SECTION'
        || typeof section.name !== 'string' || section.name.length > ${MAX_NAME_CODE_UNITS}) {
        throw new Error('Section Add requires one exact bounded Section node.');
      }
      const parents = [];
      let memberships = 0;
      for (const parentId of parentIds) {
        const parent = parentId === section.id ? section : await figma.getNodeByIdAsync(parentId);
        if (!parent || parent.id !== parentId) throw new Error('Section Add parent identity changed.');
        const childIds = parentChildren(parent, 'Section Add parent');
        memberships += childIds.length;
        if (memberships > ${MAX_SECTION_ADD_TOTAL_MEMBERSHIPS}) {
          throw new Error('Section Add exceeds the bounded total child inventory.');
        }
        parents.push({ id: parentId, childIds });
      }
      const allChildIds = parents.flatMap((parent) => parent.childIds);
      if (new Set(allChildIds).size !== allChildIds.length) {
        throw new Error('Section Add parent inventories overlap.');
      }
      const membershipByParent = new Map(parents.map((parent) => [parent.id, parent.childIds]));
      const nodes = [];
      for (const nodeId of nodeIds) {
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node || node.id !== nodeId || node.type === 'DOCUMENT' || node.type === 'PAGE'
          || typeof node.name !== 'string' || node.name.length > ${MAX_NAME_CODE_UNITS}
          || typeof node.type !== 'string' || node.type.length === 0
          || node.type.length > ${MAX_TYPE_CODE_UNITS}
          || !node.parent || typeof node.parent.id !== 'string'
          || !finite(node.x) || !finite(node.y)) {
          throw new Error('Section Add requires exact bounded canvas nodes.');
        }
        const childIds = membershipByParent.get(node.parent.id);
        const index = childIds ? childIds.indexOf(node.id) : -1;
        if (!childIds || index < 0 || childIds.indexOf(node.id, index + 1) !== -1) {
          throw new Error('Section Add source membership changed.');
        }
        nodes.push({
          id: node.id, name: node.name, type: node.type,
          parentId: node.parent.id, index, x: node.x, y: node.y,
          absolute: absolute(node),
        });
      }
      const value = { sectionTransform: transform(section), parents, nodes };
      if (JSON.stringify(value).length > ${MAX_SECTION_ADD_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Section Add snapshot exceeded its bounded limit.');
      }
      return { section, value };
    };
    const close = (left, right) => Math.abs(left - right) <= ${SECTION_ADD_POSITION_EPSILON};
    const same = (left, right) => left.parents.length === right.parents.length
      && left.nodes.length === right.nodes.length
      && left.sectionTransform.every((row, rowIndex) => row.every(
        (value, columnIndex) => close(value, right.sectionTransform[rowIndex][columnIndex])))
      && left.parents.every((parent, index) => parent.id === right.parents[index].id
        && parent.childIds.length === right.parents[index].childIds.length
        && parent.childIds.every((id, childIndex) => id === right.parents[index].childIds[childIndex]))
      && left.nodes.every((node, index) => {
        const other = right.nodes[index];
        return node.id === other.id && node.name === other.name && node.type === other.type
          && node.parentId === other.parentId && node.index === other.index
          && close(node.x, other.x) && close(node.y, other.y)
          && close(node.absolute.x, other.absolute.x)
          && close(node.absolute.y, other.absolute.y);
      });
    const differences = (left, right) => {
      let count = 0;
      if (left.parents.length !== right.parents.length || left.nodes.length !== right.nodes.length) count += 1;
      for (let index = 0; index < Math.min(left.parents.length, right.parents.length); index++) {
        const a = left.parents[index], b = right.parents[index];
        if (a.id !== b.id || a.childIds.length !== b.childIds.length
          || a.childIds.some((id, childIndex) => id !== b.childIds[childIndex])) count += 1;
      }
      for (let index = 0; index < Math.min(left.nodes.length, right.nodes.length); index++) {
        const a = left.nodes[index], b = right.nodes[index];
        if (a.id !== b.id || a.name !== b.name || a.type !== b.type
          || a.parentId !== b.parentId || a.index !== b.index
          || !close(a.x, b.x) || !close(a.y, b.y)
          || !close(a.absolute.x, b.absolute.x) || !close(a.absolute.y, b.absolute.y)) count += 1;
      }
      return Math.max(1, count);
    };
    const expectedState = (before) => {
      const parents = before.parents.map((parent) => ({ id: parent.id, childIds: [...parent.childIds] }));
      const memberships = new Map(parents.map((parent) => [parent.id, parent.childIds]));
      const sectionChildren = memberships.get(request.sectionId);
      if (!sectionChildren) throw new Error('Section Add destination inventory is unavailable.');
      for (const node of before.nodes) {
        const source = memberships.get(node.parentId);
        const sourceIndex = source ? source.indexOf(node.id) : -1;
        if (!source || sourceIndex < 0) throw new Error('Section Add source inventory is unavailable.');
        source.splice(sourceIndex, 1);
        sectionChildren.push(node.id);
      }
      return {
        sectionTransform: before.sectionTransform.map((row) => [...row]), parents,
        nodes: before.nodes.map((node) => ({
          ...node, parentId: request.sectionId,
          index: sectionChildren.indexOf(node.id),
          ...targetPosition(before.sectionTransform, node.absolute),
        })),
      };
    };
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Section Add preflight failed'),
    });
    const success = (status, outcome, attempted, section, before, actual, warnings) => bounded({
      schemaVersion: 1, status, outcome, attempted, restored: 0, residueCount: 0,
      node: identity(section), request, before, actual, warnings,
    });
    const failed = (outcome, attempted, restored, residueCount, section, before, actual, failure) => bounded({
      schemaVersion: 1, status: 'failed', outcome, attempted, restored, residueCount,
      node: identity(section), request, before, actual,
      failure: failureText(failure, 'fresh Section Add postcondition failed'),
    });

    let section;
    let before;
    let expected;
    const parentIds = [request.sectionId];
    try {
      section = await figma.getNodeByIdAsync(request.sectionId);
      if (!section || section.id !== request.sectionId || section.type !== 'SECTION') {
        throw new Error('Section Add target was not found in the targeted Figma document.');
      }
      const nodes = [];
      for (const nodeId of request.nodeIds) {
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node || node.id !== nodeId || !node.parent) {
          throw new Error('Section Add node was not found in the targeted Figma document.');
        }
        let cursor = section;
        for (let depth = 0; cursor && depth <= ${MAX_SECTION_ADD_ANCESTORS}; depth++) {
          if (cursor.id === node.id) throw new Error('Cannot add a Section ancestor into that Section.');
          cursor = cursor.parent || null;
          if (depth === ${MAX_SECTION_ADD_ANCESTORS} && cursor) {
            throw new Error('Section Add ancestry exceeds its bounded depth.');
          }
        }
        nodes.push(node);
        if (!parentIds.includes(node.parent.id)) parentIds.push(node.parent.id);
      }
      const captured = await snapshot(parentIds, request.nodeIds);
      section = captured.section;
      before = captured.value;
      expected = expectedState(before);
    } catch (error) { return refusal(error); }
    if (same(before, expected)) return success('unchanged', 'no-mutation', 0, section, before, before, []);

    try {
      const current = await snapshot(parentIds, request.nodeIds);
      if (!same(current.value, before)) {
        return refusal(new Error('Section Add precondition changed before mutation.'));
      }
      section = current.section;
    } catch (error) { return refusal(error); }

    let attempted = 0;
    let mutationError = null;
    try {
      for (const fact of before.nodes) {
        const node = await figma.getNodeByIdAsync(fact.id);
        if (!node || node.id !== fact.id) throw new Error('Section Add node identity changed before mutation.');
        const local = targetPosition(before.sectionTransform, fact.absolute);
        attempted += 1;
        section.appendChild(node);
        node.x = local.x;
        node.y = local.y;
      }
    } catch (error) { mutationError = error; }
    let failure = mutationError;
    try {
      const after = await snapshot(parentIds, request.nodeIds);
      if (same(after.value, expected)) {
        delete globalThis.__invCache;
        return success('added', mutationError ? 'verified-after-error' : 'verified',
          attempted, after.section, before, after.value,
          mutationError ? [failureText(mutationError, 'native acknowledgement failed')] : []);
      }
      if (same(after.value, before)) {
        return failed('unchanged', attempted, 0, 1, after.section, before, after.value,
          mutationError || new Error('Fresh Section Add postcondition was unchanged.'));
      }
      failure ||= new Error('Fresh Section Add postcondition failed.');
    } catch (error) { failure ||= error; }

    let rollbackSection = section;
    try {
      const parentMap = new Map();
      for (const parentFact of before.parents) {
        const parent = await figma.getNodeByIdAsync(parentFact.id);
        if (!parent || parent.id !== parentFact.id || typeof parent.insertChild !== 'function') {
          throw new Error('Section Add rollback parent identity is unavailable.');
        }
        parentMap.set(parentFact.id, parent);
      }
      rollbackSection = parentMap.get(request.sectionId) || section;
      for (const parentFact of before.parents) {
        const parent = parentMap.get(parentFact.id);
        const requestedChildren = before.nodes
          .filter((node) => node.parentId === parentFact.id)
          .sort((left, right) => left.index - right.index);
        for (const fact of requestedChildren) {
          const child = await figma.getNodeByIdAsync(fact.id);
          if (!child || child.id !== fact.id) {
            throw new Error('Section Add rollback child identity is unavailable.');
          }
          parent.insertChild(fact.index, child);
        }
      }
      for (const fact of before.nodes) {
        const node = await figma.getNodeByIdAsync(fact.id);
        if (!node || node.id !== fact.id) throw new Error('Section Add rollback node identity is unavailable.');
        node.x = fact.x;
        node.y = fact.y;
      }
    } catch (error) { failure ||= error; }
    try {
      const restored = await snapshot(parentIds, request.nodeIds);
      if (same(restored.value, before)) {
        delete globalThis.__invCache;
        return failed('rolled-back', attempted, request.nodeIds.length, 0,
          restored.section, before, restored.value, failure);
      }
      return failed('partial-residue', attempted, 0, differences(before, restored.value),
        restored.section, before, restored.value, failure);
    } catch (error) {
      return failed('verification-unavailable', attempted, 0, 1,
        rollbackSection || section, before, null, failure || error);
    }
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}
function finite(value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE;
}
function validId(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}
function validTransform(value) {
  return Array.isArray(value) && value.length === 2
    && value.every((row) => Array.isArray(row) && row.length === 3 && row.every(finite))
    && Math.abs(value[0][0] * value[1][1] - value[1][0] * value[0][1]) > 1e-9;
}
function validParent(value) {
  return exact(value, ['id', 'childIds']) && validId(value.id)
    && Array.isArray(value.childIds) && value.childIds.length <= MAX_SECTION_ADD_PARENT_CHILDREN
    && value.childIds.every(validId)
    && new Set(value.childIds).size === value.childIds.length;
}
function validNode(value) {
  return exact(value, ['id', 'name', 'type', 'parentId', 'index', 'x', 'y', 'absolute'])
    && validId(value.id) && text(value.name, MAX_NAME_CODE_UNITS)
    && text(value.type, MAX_TYPE_CODE_UNITS, false) && validId(value.parentId)
    && Number.isSafeInteger(value.index) && value.index >= 0
    && finite(value.x) && finite(value.y)
    && exact(value.absolute, ['x', 'y']) && finite(value.absolute.x) && finite(value.absolute.y);
}
function validState(value, input) {
  const allChildIds = Array.isArray(value?.parents)
    ? value.parents.flatMap((parent) => Array.isArray(parent?.childIds) ? parent.childIds : [])
    : [];
  if (!exact(value, ['sectionTransform', 'parents', 'nodes'])
    || !validTransform(value.sectionTransform)
    || !Array.isArray(value.parents) || value.parents.length < 1
    || value.parents.length > input.nodeIds.length + 1 || !value.parents.every(validParent)
    || value.parents[0].id !== input.sectionId
    || new Set(value.parents.map((parent) => parent.id)).size !== value.parents.length
    || value.parents.reduce((sum, parent) => sum + parent.childIds.length, 0)
      > MAX_SECTION_ADD_TOTAL_MEMBERSHIPS
    || new Set(allChildIds).size !== allChildIds.length
    || !Array.isArray(value.nodes) || value.nodes.length !== input.nodeIds.length
    || !value.nodes.every(validNode)
    || value.nodes.some((node, index) => node.id !== input.nodeIds[index])
    || JSON.stringify(value).length > MAX_SECTION_ADD_SNAPSHOT_CODE_UNITS) return false;
  const memberships = new Map(value.parents.map((parent) => [parent.id, parent.childIds]));
  return value.nodes.every((node) => {
    const children = memberships.get(node.parentId);
    return children && children[node.index] === node.id;
  });
}
function close(left, right) { return Math.abs(left - right) <= SECTION_ADD_POSITION_EPSILON; }
function sameState(left, right) {
  return left.parents.length === right.parents.length && left.nodes.length === right.nodes.length
    && left.sectionTransform.every((row, rowIndex) => row.every(
      (value, columnIndex) => close(value, right.sectionTransform[rowIndex][columnIndex])))
    && left.parents.every((parent, index) => parent.id === right.parents[index].id
      && parent.childIds.length === right.parents[index].childIds.length
      && parent.childIds.every((id, childIndex) => id === right.parents[index].childIds[childIndex]))
    && left.nodes.every((node, index) => {
      const other = right.nodes[index];
      return node.id === other.id && node.name === other.name && node.type === other.type
        && node.parentId === other.parentId && node.index === other.index
        && close(node.x, other.x) && close(node.y, other.y)
        && close(node.absolute.x, other.absolute.x)
        && close(node.absolute.y, other.absolute.y);
    });
}
function differenceCount(left, right) {
  let count = 0;
  if (left.parents.length !== right.parents.length || left.nodes.length !== right.nodes.length) count += 1;
  for (let index = 0; index < Math.min(left.parents.length, right.parents.length); index++) {
    const a = left.parents[index], b = right.parents[index];
    if (a.id !== b.id || a.childIds.length !== b.childIds.length
      || a.childIds.some((id, childIndex) => id !== b.childIds[childIndex])) count += 1;
  }
  for (let index = 0; index < Math.min(left.nodes.length, right.nodes.length); index++) {
    const a = left.nodes[index], b = right.nodes[index];
    if (a.id !== b.id || a.name !== b.name || a.type !== b.type
      || a.parentId !== b.parentId || a.index !== b.index
      || !close(a.x, b.x) || !close(a.y, b.y)
      || !close(a.absolute.x, b.absolute.x) || !close(a.absolute.y, b.absolute.y)) count += 1;
  }
  return Math.max(1, count);
}
function validRequest(value, input) {
  return exact(value, ['sectionId', 'nodeIds', 'warning'])
    && value.sectionId === input.sectionId
    && Array.isArray(value.nodeIds) && value.nodeIds.length === input.nodeIds.length
    && value.nodeIds.every((id, index) => id === input.nodeIds[index])
    && value.warning === input.warning;
}
function validSection(value, input) {
  return exact(value, ['id', 'name', 'type']) && value.id === input.sectionId
    && validId(value.id) && text(value.name, MAX_NAME_CODE_UNITS) && value.type === 'SECTION';
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}
const SUCCESS_KEYS = [
  'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
  'node', 'request', 'before', 'actual', 'warnings',
];
function validSuccess(value, input) {
  if (!exact(value, SUCCESS_KEYS) || value.schemaVersion !== 1
    || !['unchanged', 'added'].includes(value.status)
    || !['no-mutation', 'verified', 'verified-after-error'].includes(value.outcome)
    || !Number.isSafeInteger(value.attempted) || value.attempted < 0
    || value.attempted > input.nodeIds.length || value.restored !== 0 || value.residueCount !== 0
    || !validSection(value.node, input) || !validRequest(value.request, input)
    || !validState(value.before, input) || !validState(value.actual, input)
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || !value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false))) return false;
  const expected = expectedState(value.before, input);
  if (!expected || !validState(expected, input) || !sameState(value.actual, expected)) return false;
  if (value.outcome === 'no-mutation') {
    return value.status === 'unchanged' && value.attempted === 0
      && value.warnings.length === 0 && sameState(value.before, value.actual);
  }
  return value.status === 'added' && value.attempted === input.nodeIds.length
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
const FAILURE_KEYS = [
  'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
  'node', 'request', 'before', 'actual', 'failure',
];
function validFailure(value, input) {
  if (!exact(value, FAILURE_KEYS) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'rolled-back', 'partial-residue', 'verification-unavailable']
      .includes(value.outcome)
    || !Number.isSafeInteger(value.attempted) || value.attempted < 1
    || value.attempted > input.nodeIds.length
    || !Number.isSafeInteger(value.restored) || value.restored < 0
    || value.restored > input.nodeIds.length
    || !Number.isSafeInteger(value.residueCount) || value.residueCount < 0
    || value.residueCount > input.nodeIds.length + input.nodeIds.length + 2
    || !validSection(value.node, input) || !validRequest(value.request, input)
    || !validState(value.before, input) || !text(value.failure, MAX_FAILURE_CODE_UNITS, false)) return false;
  if (value.outcome === 'verification-unavailable') {
    return value.restored === 0 && value.residueCount === 1 && value.actual === null;
  }
  if (!validState(value.actual, input)) return false;
  const restored = sameState(value.before, value.actual);
  const desired = sameState(expectedState(value.before, input), value.actual);
  if (value.outcome === 'unchanged') {
    return value.restored === 0 && value.residueCount === 1 && restored && !desired;
  }
  if (value.outcome === 'rolled-back') {
    return value.restored === input.nodeIds.length && value.residueCount === 0 && restored;
  }
  return value.restored === 0 && !restored && !desired
    && value.residueCount === differenceCount(value.before, value.actual);
}
function pluginResultError(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch',
  });
  return error;
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report,
  });
  return error;
}
function safeText(value) { return String(value).replace(UNSAFE_TEXT_CONTROLS, ' '); }

export function formatSectionAddResult(result) {
  return `✓ Added ${result.request.nodeIds.length} node(s) to ${JSON.stringify(
    safeText(result.node.name))} (${result.node.id}). Total children: ${result.actual.parents[0].childIds.length}`;
}

export async function executeSectionAdd(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Section Add requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(sectionAddCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SECTION_ADD_RESULT_CODE_UNITS) {
    throw pluginResultError('Section Add returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Section Add returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Section Add returned an invalid bounded result.');
    throw mutationError(`Section Add made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw pluginResultError('Section Add returned an invalid bounded result.');
    }
    throw mutationError(`Section Add failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: payload.attempted,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Section Add returned an invalid bounded result.');
  }
  return {
    stdout: formatSectionAddResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function sectionAddPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Section Add routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-section-add';
}
export function executeSectionAddPlan(plan, adapters = {}) {
  if (sectionAddPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Section Add.');
  }
  return executeSectionAdd(parseSectionAddRequest(plan.argv), adapters);
}
