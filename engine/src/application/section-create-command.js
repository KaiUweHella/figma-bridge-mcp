// Plan-bound, fully verified and rollback-owned `section create` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  MAX_SECTION_CREATE_NAME_CODE_UNITS,
  parseSectionCreateRequest,
  sectionCreateArgvFromRequest,
  sectionCreatePlanningArgvFromRequest,
} from './section-create-request.js';

export {
  sectionCreateArgvFromRequest,
  sectionCreatePlanningArgvFromRequest,
} from './section-create-request.js';

const APPLICATION_ID = 'section.create';
export const SECTION_CREATE_PAD = 64;
export const SECTION_CREATE_HEADER = 40;
export const SECTION_CREATE_VERIFY_EPSILON = 0.01;
export const MAX_SECTION_CREATE_PARENT_CHILDREN = 50_000;
export const MAX_SECTION_CREATE_TOTAL_MEMBERSHIPS = 100_000;
export const MAX_SECTION_CREATE_RESULT_CODE_UNITS = 2_000_000;
export const MAX_SECTION_CREATE_SNAPSHOT_CODE_UNITS = 900_000;
const MAX_TYPE_CODE_UNITS = 64;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseSectionCreateRequest(sectionCreateArgvFromRequest(request));

function fittedGeometry(nodes) {
  if (nodes.length === 0) return null;
  const minX = Math.min(...nodes.map((node) => node.absolute.x));
  const minY = Math.min(...nodes.map((node) => node.absolute.y));
  const maxX = Math.max(...nodes.map((node) => node.absolute.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.absolute.y + node.height));
  return {
    x: minX - SECTION_CREATE_PAD,
    y: minY - SECTION_CREATE_PAD - SECTION_CREATE_HEADER,
    width: maxX - minX + 2 * SECTION_CREATE_PAD,
    height: maxY - minY + 2 * SECTION_CREATE_PAD + SECTION_CREATE_HEADER,
  };
}

function expectedParents(before, createdId) {
  const parents = before.parents.map((parent) => ({
    id: parent.id, childIds: [...parent.childIds],
  }));
  const memberships = new Map(parents.map((parent) => [parent.id, parent.childIds]));
  memberships.get(before.pageId)?.push(createdId);
  for (const node of before.nodes) {
    const source = memberships.get(node.parentId);
    const index = source?.indexOf(node.id) ?? -1;
    if (index < 0) return null;
    source.splice(index, 1);
  }
  return parents;
}

export function sectionCreateCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${JSON.stringify(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SECTION_CREATE_RESULT_CODE_UNITS}) {
        throw new Error('Section Create result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const finite = (value, dimension = false) => Number.isFinite(value)
      && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE}
      && (!dimension || value > 0);
    const matrix = (node, invertible = false) => {
      const value = node && node.absoluteTransform;
      if (!Array.isArray(value) || value.length !== 2
        || value.some((row) => !Array.isArray(row) || row.length !== 3
          || row.some((entry) => !finite(entry)))) {
        throw new Error('Section Create requires finite absolute transforms.');
      }
      const result = value.map((row) => [...row]);
      const determinant = result[0][0] * result[1][1] - result[1][0] * result[0][1];
      if (invertible && Math.abs(determinant) <= 1e-9) {
        throw new Error('Section Create requires an invertible Section transform.');
      }
      return result;
    };
    const absolute = (node) => {
      const transform = matrix(node);
      return { x: transform[0][2], y: transform[1][2] };
    };
    const targetPosition = (transform, position) => {
      const a = transform[0][0], c = transform[0][1], tx = transform[0][2];
      const b = transform[1][0], d = transform[1][1], ty = transform[1][2];
      const determinant = a * d - b * c;
      if (Math.abs(determinant) <= 1e-9) throw new Error('Section Create requires an invertible Section transform.');
      const dx = position.x - tx, dy = position.y - ty;
      const local = {
        x: (d * dx - c * dy) / determinant,
        y: (-b * dx + a * dy) / determinant,
      };
      if (!finite(local.x) || !finite(local.y)) {
        throw new Error('Section Create target position exceeded the bounded coordinate limit.');
      }
      return local;
    };
    const childIds = (parent, label) => {
      if (!parent || typeof parent.id !== 'string' || !nodeIdPattern.test(parent.id)
        || parent.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
        || typeof parent.appendChild !== 'function'
        || typeof parent.insertChild !== 'function'
        || !Array.isArray(parent.children)
        || parent.children.length > ${MAX_SECTION_CREATE_PARENT_CHILDREN}) {
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
    const sameIds = (left, right) => left.length === right.length
      && left.every((id, index) => id === right[index]);
    const close = (left, right) => Math.abs(left - right) <= ${SECTION_CREATE_VERIFY_EPSILON};
    const originalSnapshot = async (pageId, parentIds, nodeIds, relaxed = false) => {
      const page = await figma.getNodeByIdAsync(pageId);
      if (!page || page.id !== pageId || page.type !== 'PAGE') {
        throw new Error('Section Create current Page identity changed.');
      }
      const parents = [];
      let memberships = 0;
      for (const parentId of parentIds) {
        const parent = parentId === pageId ? page : await figma.getNodeByIdAsync(parentId);
        if (!parent || parent.id !== parentId) throw new Error('Section Create parent identity changed.');
        const ids = childIds(parent, 'Section Create parent');
        memberships += ids.length;
        if (memberships > ${MAX_SECTION_CREATE_TOTAL_MEMBERSHIPS}) {
          throw new Error('Section Create exceeds the bounded total child inventory.');
        }
        parents.push({ id: parentId, childIds: ids });
      }
      const allChildIds = parents.flatMap((parent) => parent.childIds);
      if (new Set(allChildIds).size !== allChildIds.length) {
        throw new Error('Section Create parent inventories overlap.');
      }
      const membershipByParent = new Map(parents.map((parent) => [parent.id, parent.childIds]));
      const nodes = [];
      for (const nodeId of nodeIds) {
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node || node.id !== nodeId || node.type === 'DOCUMENT' || node.type === 'PAGE'
          || typeof node.name !== 'string' || node.name.length > ${MAX_SECTION_CREATE_NAME_CODE_UNITS}
          || typeof node.type !== 'string' || node.type.length === 0
          || node.type.length > ${MAX_TYPE_CODE_UNITS}
          || !node.parent || typeof node.parent.id !== 'string'
          || !finite(node.x) || !finite(node.y)
          || !finite(node.width, true) || !finite(node.height, true)) {
          throw new Error('Section Create requires exact bounded canvas nodes.');
        }
        let ids = membershipByParent.get(node.parent.id);
        if (!ids && relaxed) ids = childIds(node.parent, 'Relaxed Section Create parent');
        const index = ids ? ids.indexOf(node.id) : -1;
        if (!ids || index < 0 || ids.indexOf(node.id, index + 1) !== -1) {
          throw new Error('Section Create source membership changed.');
        }
        nodes.push({
          id: node.id, name: node.name, type: node.type,
          parentId: node.parent.id, index, x: node.x, y: node.y,
          width: node.width, height: node.height, absolute: absolute(node),
        });
      }
      const value = { pageId, parents, nodes };
      if (JSON.stringify(value).length > ${MAX_SECTION_CREATE_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Section Create snapshot exceeded its bounded limit.');
      }
      return { page, value };
    };
    const actualSnapshot = async (before, sectionId) => {
      const page = await figma.getNodeByIdAsync(before.pageId);
      const section = await figma.getNodeByIdAsync(sectionId);
      if (!page || page.id !== before.pageId || page.type !== 'PAGE'
        || !section || section.id !== sectionId || section.type !== 'SECTION'
        || typeof section.name !== 'string' || section.name.length > ${MAX_SECTION_CREATE_NAME_CODE_UNITS}
        || !section.parent || section.parent.id !== before.pageId
        || typeof section.resizeWithoutConstraints !== 'function'
        || !finite(section.x) || !finite(section.y)
        || !finite(section.width, true) || !finite(section.height, true)) {
        throw new Error('Fresh Section Create identity or geometry is invalid.');
      }
      const parents = [];
      let memberships = 0;
      for (const parentFact of before.parents) {
        const parent = parentFact.id === before.pageId
          ? page : await figma.getNodeByIdAsync(parentFact.id);
        if (!parent || parent.id !== parentFact.id) throw new Error('Fresh Section Create parent identity changed.');
        const ids = childIds(parent, 'Fresh Section Create parent');
        memberships += ids.length;
        if (memberships > ${MAX_SECTION_CREATE_TOTAL_MEMBERSHIPS}) {
          throw new Error('Fresh Section Create exceeds the bounded total child inventory.');
        }
        parents.push({ id: parent.id, childIds: ids });
      }
      const sectionChildIds = childIds(section, 'Fresh created Section');
      const allChildIds = [...parents.flatMap((parent) => parent.childIds), ...sectionChildIds];
      if (new Set(allChildIds).size !== allChildIds.length) {
        throw new Error('Fresh Section Create parent inventories overlap.');
      }
      const membershipByParent = new Map(parents.map((parent) => [parent.id, parent.childIds]));
      membershipByParent.set(section.id, sectionChildIds);
      const nodes = [];
      for (const nodeId of request.nodeIds) {
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node || node.id !== nodeId || !node.parent
          || typeof node.name !== 'string' || node.name.length > ${MAX_SECTION_CREATE_NAME_CODE_UNITS}
          || typeof node.type !== 'string' || node.type.length === 0
          || node.type.length > ${MAX_TYPE_CODE_UNITS}
          || !finite(node.x) || !finite(node.y)
          || !finite(node.width, true) || !finite(node.height, true)) {
          throw new Error('Fresh Section Create node facts are invalid.');
        }
        const ids = membershipByParent.get(node.parent.id);
        const index = ids ? ids.indexOf(node.id) : -1;
        if (!ids || index < 0 || ids.indexOf(node.id, index + 1) !== -1) {
          throw new Error('Fresh Section Create membership is invalid.');
        }
        nodes.push({
          id: node.id, name: node.name, type: node.type,
          parentId: node.parent.id, index, x: node.x, y: node.y,
          width: node.width, height: node.height, absolute: absolute(node),
        });
      }
      const pageIds = parents[0].childIds;
      const sectionIndex = pageIds.indexOf(section.id);
      if (sectionIndex < 0 || pageIds.indexOf(section.id, sectionIndex + 1) !== -1) {
        throw new Error('Fresh created Section is not an exact Page child.');
      }
      const value = {
        pageId: before.pageId, parents, nodes,
        section: {
          id: section.id, name: section.name, type: 'SECTION',
          parentId: before.pageId, index: sectionIndex,
          x: section.x, y: section.y, width: section.width, height: section.height,
          transform: matrix(section, true), childIds: sectionChildIds,
        },
      };
      if (JSON.stringify(value).length > ${MAX_SECTION_CREATE_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Fresh Section Create snapshot exceeded its bounded limit.');
      }
      return { page, section, value };
    };
    const expectedParents = (before, sectionId) => {
      const parents = before.parents.map((parent) => ({ id: parent.id, childIds: [...parent.childIds] }));
      const memberships = new Map(parents.map((parent) => [parent.id, parent.childIds]));
      memberships.get(before.pageId).push(sectionId);
      for (const node of before.nodes) {
        const source = memberships.get(node.parentId);
        const index = source ? source.indexOf(node.id) : -1;
        if (!source || index < 0) throw new Error('Section Create source inventory is unavailable.');
        source.splice(index, 1);
      }
      return parents;
    };
    const fittedGeometry = (nodes) => {
      if (nodes.length === 0) return null;
      const minX = Math.min(...nodes.map((node) => node.absolute.x));
      const minY = Math.min(...nodes.map((node) => node.absolute.y));
      const maxX = Math.max(...nodes.map((node) => node.absolute.x + node.width));
      const maxY = Math.max(...nodes.map((node) => node.absolute.y + node.height));
      const value = {
        x: minX - ${SECTION_CREATE_PAD},
        y: minY - ${SECTION_CREATE_PAD} - ${SECTION_CREATE_HEADER},
        width: maxX - minX + 2 * ${SECTION_CREATE_PAD},
        height: maxY - minY + 2 * ${SECTION_CREATE_PAD} + ${SECTION_CREATE_HEADER},
      };
      if (!finite(value.x) || !finite(value.y)
        || !finite(value.width, true) || !finite(value.height, true)) {
        throw new Error('Section Create fitted geometry exceeded the bounded coordinate limit.');
      }
      return value;
    };
    const matchesExpected = (before, actual) => {
      const expectedParentFacts = expectedParents(before, actual.section.id);
      if (actual.pageId !== before.pageId
        || actual.parents.length !== expectedParentFacts.length
        || actual.parents.some((parent, index) => parent.id !== expectedParentFacts[index].id
          || !sameIds(parent.childIds, expectedParentFacts[index].childIds))
        || actual.section.name !== request.name
        || actual.section.parentId !== before.pageId
        || actual.section.index !== actual.parents[0].childIds.indexOf(actual.section.id)
        || !sameIds(actual.section.childIds, request.nodeIds)
        || actual.nodes.length !== before.nodes.length) return false;
      const transform = actual.section.transform;
      if (!close(transform[0][0], 1) || !close(transform[0][1], 0)
        || !close(transform[1][0], 0) || !close(transform[1][1], 1)
        || !close(transform[0][2], actual.section.x)
        || !close(transform[1][2], actual.section.y)) return false;
      const fitted = fittedGeometry(before.nodes);
      if (fitted && !['x', 'y', 'width', 'height'].every(
        (field) => close(actual.section[field], fitted[field]))) return false;
      return actual.nodes.every((node, index) => {
        const prior = before.nodes[index];
        return node.id === prior.id && node.name === prior.name && node.type === prior.type
          && node.parentId === actual.section.id && node.index === index
          && close(node.width, prior.width) && close(node.height, prior.height)
          && close(node.absolute.x, prior.absolute.x) && close(node.absolute.y, prior.absolute.y)
          && (!fitted || (close(node.x, prior.absolute.x - fitted.x)
            && close(node.y, prior.absolute.y - fitted.y)));
      });
    };
    const sameOriginal = (left, right) => left.pageId === right.pageId
      && left.parents.length === right.parents.length && left.nodes.length === right.nodes.length
      && left.parents.every((parent, index) => parent.id === right.parents[index].id
        && sameIds(parent.childIds, right.parents[index].childIds))
      && left.nodes.every((node, index) => {
        const other = right.nodes[index];
        return node.id === other.id && node.name === other.name && node.type === other.type
          && node.parentId === other.parentId && node.index === other.index
          && close(node.x, other.x) && close(node.y, other.y)
          && close(node.width, other.width) && close(node.height, other.height)
          && close(node.absolute.x, other.absolute.x) && close(node.absolute.y, other.absolute.y);
      });
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Section Create preflight failed'),
    });
    const success = (outcome, before, actual, warnings) => bounded({
      schemaVersion: 1, status: 'created', outcome, attempted: 1,
      restored: 0, residueCount: 0, request, before, actual, warnings,
    });
    const failed = (outcome, restored, residue, failure) => bounded({
      schemaVersion: 1, status: 'failed', outcome, attempted: 1, restored,
      residue, failure: failureText(failure, 'fresh Section Create postcondition failed'),
    });

    let page;
    let pageId;
    let parentIds;
    let before;
    try {
      page = figma.currentPage;
      if (!page || page.type !== 'PAGE' || typeof page.id !== 'string'
        || !nodeIdPattern.test(page.id) || page.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}) {
        throw new Error('Section Create requires one current Figma Page.');
      }
      pageId = page.id;
      parentIds = [pageId];
      for (const nodeId of request.nodeIds) {
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node || node.id !== nodeId || !node.parent) {
          throw new Error('Section Create node was not found in the targeted Figma document.');
        }
        if (!parentIds.includes(node.parent.id)) parentIds.push(node.parent.id);
      }
      const captured = await originalSnapshot(pageId, parentIds, request.nodeIds);
      page = captured.page;
      before = captured.value;
    } catch (error) { return refusal(error); }

    try {
      if (!figma.currentPage || figma.currentPage.id !== pageId) {
        return refusal(new Error('Section Create current Page changed before mutation.'));
      }
      const current = await originalSnapshot(pageId, parentIds, request.nodeIds);
      if (!sameOriginal(current.value, before)) {
        return refusal(new Error('Section Create precondition changed before mutation.'));
      }
      page = current.page;
    } catch (error) { return refusal(error); }

    let section = null;
    let sectionId = null;
    let mutationError = null;
    try {
      section = figma.createSection();
      if (!section || typeof section.id !== 'string' || !nodeIdPattern.test(section.id)
        || section.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
        || section.type !== 'SECTION' || typeof section.remove !== 'function'
        || typeof section.resizeWithoutConstraints !== 'function') {
        throw new Error('Figma did not return a bounded removable Section.');
      }
      sectionId = section.id;
      section.name = request.name;
      for (const fact of before.nodes) {
        const node = await figma.getNodeByIdAsync(fact.id);
        if (!node || node.id !== fact.id) throw new Error('Section Create node identity changed before mutation.');
        const local = targetPosition(matrix(section, true), fact.absolute);
        section.appendChild(node);
        node.x = local.x;
        node.y = local.y;
      }
      if (before.nodes.length > 0) {
        const minX = Math.min(...section.children.map((child) => child.x));
        const minY = Math.min(...section.children.map((child) => child.y));
        const maxX = Math.max(...section.children.map((child) => child.x + child.width));
        const maxY = Math.max(...section.children.map((child) => child.y + child.height));
        const dx = minX - ${SECTION_CREATE_PAD};
        const dy = minY - ${SECTION_CREATE_PAD} - ${SECTION_CREATE_HEADER};
        section.x += dx;
        section.y += dy;
        section.resizeWithoutConstraints(
          maxX - minX + 2 * ${SECTION_CREATE_PAD},
          maxY - minY + 2 * ${SECTION_CREATE_PAD} + ${SECTION_CREATE_HEADER});
        for (const child of section.children) {
          child.x -= dx;
          child.y -= dy;
        }
      }
    } catch (error) { mutationError = error; }

    if (!sectionId) {
      try {
        const freshPage = await figma.getNodeByIdAsync(pageId);
        const freshIds = childIds(freshPage, 'Fresh Section Create Page');
        const additions = freshIds.filter((id) => !before.parents[0].childIds.includes(id));
        if (additions.length === 1) {
          const candidate = await figma.getNodeByIdAsync(additions[0]);
          if (candidate && candidate.id === additions[0] && candidate.type === 'SECTION') {
            section = candidate;
            sectionId = candidate.id;
          }
        }
      } catch {}
    }

    let failure = mutationError;
    if (sectionId) {
      try {
        const after = await actualSnapshot(before, sectionId);
        if (matchesExpected(before, after.value)) {
          delete globalThis.__invCache;
          return success(mutationError ? 'verified-after-error' : 'verified',
            before, after.value,
            mutationError ? [failureText(mutationError, 'native acknowledgement failed')] : []);
        }
        failure ||= new Error('Fresh Section Create postcondition failed.');
      } catch (error) { failure ||= error; }
    } else {
      failure ||= new Error('Created Section identity is unavailable.');
    }

    try {
      const parentMap = new Map();
      for (const parentFact of before.parents) {
        const parent = await figma.getNodeByIdAsync(parentFact.id);
        if (!parent || parent.id !== parentFact.id || typeof parent.insertChild !== 'function') {
          throw new Error('Section Create rollback parent identity is unavailable.');
        }
        parentMap.set(parent.id, parent);
      }
      for (const parentFact of before.parents) {
        const parent = parentMap.get(parentFact.id);
        const requestedChildren = before.nodes
          .filter((node) => node.parentId === parentFact.id)
          .sort((left, right) => left.index - right.index);
        for (const fact of requestedChildren) {
          const child = await figma.getNodeByIdAsync(fact.id);
          if (!child || child.id !== fact.id) {
            throw new Error('Section Create rollback child identity is unavailable.');
          }
          parent.insertChild(fact.index, child);
        }
      }
      for (const fact of before.nodes) {
        const node = await figma.getNodeByIdAsync(fact.id);
        if (!node || node.id !== fact.id) throw new Error('Section Create rollback node identity is unavailable.');
        node.x = fact.x;
        node.y = fact.y;
      }
      if (sectionId) {
        const rollbackSection = await figma.getNodeByIdAsync(sectionId);
        if (rollbackSection && rollbackSection.id === sectionId
          && typeof rollbackSection.remove === 'function') rollbackSection.remove();
      }
    } catch (error) { failure ||= error; }
    try {
      const restored = await originalSnapshot(pageId, parentIds, request.nodeIds, true);
      const pageAdditions = restored.value.parents[0].childIds.filter(
        (id) => !before.parents[0].childIds.includes(id));
      const createdPresent = sectionId
        ? Boolean(await figma.getNodeByIdAsync(sectionId)) || pageAdditions.includes(sectionId)
        : pageAdditions.length > 0;
      const residue = [];
      if (createdPresent) residue.push('created-section');
      if (!sameOriginal(before, restored.value)) residue.push('original-state');
      if (residue.length === 0) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, [], failure);
      }
      return failed('partial-residue', 0, residue, failure);
    } catch (error) {
      return failed('verification-unavailable', 0, [], failure || error);
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
function finite(value, dimension = false) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE
    && (!dimension || value > 0);
}
function id(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}
function validTransform(value) {
  return Array.isArray(value) && value.length === 2
    && value.every((row) => Array.isArray(row) && row.length === 3
      && row.every((entry) => finite(entry)))
    && Math.abs(value[0][0] * value[1][1] - value[1][0] * value[0][1]) > 1e-9;
}
function validParent(value) {
  return exact(value, ['id', 'childIds']) && id(value.id)
    && Array.isArray(value.childIds) && value.childIds.length <= MAX_SECTION_CREATE_PARENT_CHILDREN
    && value.childIds.every(id) && new Set(value.childIds).size === value.childIds.length;
}
function validNode(value) {
  return exact(value, [
    'id', 'name', 'type', 'parentId', 'index', 'x', 'y', 'width', 'height', 'absolute',
  ]) && id(value.id) && text(value.name, MAX_SECTION_CREATE_NAME_CODE_UNITS)
    && text(value.type, MAX_TYPE_CODE_UNITS, false) && id(value.parentId)
    && Number.isSafeInteger(value.index) && value.index >= 0
    && finite(value.x) && finite(value.y)
    && finite(value.width, true) && finite(value.height, true)
    && exact(value.absolute, ['x', 'y'])
    && finite(value.absolute.x) && finite(value.absolute.y);
}
function validBefore(value, input) {
  const allChildIds = Array.isArray(value?.parents)
    ? value.parents.flatMap((parent) => Array.isArray(parent?.childIds) ? parent.childIds : [])
    : [];
  if (!exact(value, ['pageId', 'parents', 'nodes']) || !id(value.pageId)
    || !Array.isArray(value.parents) || value.parents.length < 1
    || value.parents.length > input.nodeIds.length + 1 || !value.parents.every(validParent)
    || value.parents[0].id !== value.pageId
    || new Set(value.parents.map((parent) => parent.id)).size !== value.parents.length
    || allChildIds.length > MAX_SECTION_CREATE_TOTAL_MEMBERSHIPS
    || new Set(allChildIds).size !== allChildIds.length
    || !Array.isArray(value.nodes) || value.nodes.length !== input.nodeIds.length
    || !value.nodes.every(validNode)
    || value.nodes.some((node, index) => node.id !== input.nodeIds[index])
    || JSON.stringify(value).length > MAX_SECTION_CREATE_SNAPSHOT_CODE_UNITS) return false;
  const memberships = new Map(value.parents.map((parent) => [parent.id, parent.childIds]));
  return value.nodes.every((node) => memberships.get(node.parentId)?.[node.index] === node.id);
}
function validSection(value, input, pageId) {
  return exact(value, [
    'id', 'name', 'type', 'parentId', 'index', 'x', 'y', 'width', 'height',
    'transform', 'childIds',
  ]) && id(value.id) && value.name === input.name && value.type === 'SECTION'
    && value.parentId === pageId && Number.isSafeInteger(value.index) && value.index >= 0
    && finite(value.x) && finite(value.y)
    && finite(value.width, true) && finite(value.height, true)
    && validTransform(value.transform)
    && Array.isArray(value.childIds) && value.childIds.length === input.nodeIds.length
    && value.childIds.every((nodeId, index) => nodeId === input.nodeIds[index]);
}
function validActual(value, input, before) {
  const allParentIds = Array.isArray(value?.parents)
    ? value.parents.flatMap((parent) => Array.isArray(parent?.childIds) ? parent.childIds : [])
    : [];
  return exact(value, ['pageId', 'parents', 'nodes', 'section'])
    && value.pageId === before.pageId && id(value.pageId)
    && Array.isArray(value.parents) && value.parents.length === before.parents.length
    && value.parents.every(validParent)
    && value.parents.every((parent, index) => parent.id === before.parents[index].id)
    && allParentIds.length <= MAX_SECTION_CREATE_TOTAL_MEMBERSHIPS
    && new Set([...allParentIds, ...(value.section?.childIds || [])]).size
      === allParentIds.length + (value.section?.childIds?.length || 0)
    && Array.isArray(value.nodes) && value.nodes.length === input.nodeIds.length
    && value.nodes.every(validNode)
    && value.nodes.every((node, index) => node.id === input.nodeIds[index])
    && validSection(value.section, input, before.pageId)
    && JSON.stringify(value).length <= MAX_SECTION_CREATE_SNAPSHOT_CODE_UNITS;
}
function close(left, right) { return Math.abs(left - right) <= SECTION_CREATE_VERIFY_EPSILON; }
function validRequest(value, input) {
  return exact(value, ['name', 'nodeIds', 'warning']) && value.name === input.name
    && Array.isArray(value.nodeIds) && value.nodeIds.length === input.nodeIds.length
    && value.nodeIds.every((nodeId, index) => nodeId === input.nodeIds[index])
    && value.warning === input.warning;
}
function matchesExpected(before, actual, input) {
  const parents = expectedParents(before, actual.section.id);
  if (!parents || actual.parents.some((parent, index) => parent.id !== parents[index].id
    || parent.childIds.length !== parents[index].childIds.length
    || parent.childIds.some((nodeId, childIndex) => nodeId !== parents[index].childIds[childIndex]))) {
    return false;
  }
  if (actual.section.index !== actual.parents[0].childIds.indexOf(actual.section.id)
    || actual.section.childIds.some((nodeId, index) => nodeId !== input.nodeIds[index])) return false;
  const transform = actual.section.transform;
  if (!close(transform[0][0], 1) || !close(transform[0][1], 0)
    || !close(transform[1][0], 0) || !close(transform[1][1], 1)
    || !close(transform[0][2], actual.section.x)
    || !close(transform[1][2], actual.section.y)) return false;
  const fitted = fittedGeometry(before.nodes);
  if (fitted && !['x', 'y', 'width', 'height'].every(
    (field) => close(actual.section[field], fitted[field]))) return false;
  return actual.nodes.every((node, index) => {
    const prior = before.nodes[index];
    return node.id === prior.id && node.name === prior.name && node.type === prior.type
      && node.parentId === actual.section.id && node.index === index
      && close(node.width, prior.width) && close(node.height, prior.height)
      && close(node.absolute.x, prior.absolute.x) && close(node.absolute.y, prior.absolute.y)
      && (!fitted || (close(node.x, prior.absolute.x - fitted.x)
        && close(node.y, prior.absolute.y - fitted.y)));
  });
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}
function validSuccess(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
    'request', 'before', 'actual', 'warnings',
  ]) && value.schemaVersion === 1 && value.status === 'created'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && value.attempted === 1 && value.restored === 0 && value.residueCount === 0
    && validRequest(value.request, input) && validBefore(value.before, input)
    && validActual(value.actual, input, value.before)
    && matchesExpected(value.before, value.actual, input)
    && Array.isArray(value.warnings)
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
}
function validFailure(value) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure',
  ]) && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 2
    && value.residue.every((entry) => ['created-section', 'original-state'].includes(entry))
    && new Set(value.residue).size === value.residue.length
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false)
    && (value.outcome !== 'rolled-back' || value.restored === 1 && value.residue.length === 0)
    && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0)
    && (value.outcome !== 'verification-unavailable'
      || value.restored === 0 && value.residue.length === 0);
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

export function formatSectionCreateResult(result) {
  return `✓ Created section ${JSON.stringify(safeText(result.actual.section.name))} `
    + `(${result.actual.section.id}) with ${result.actual.section.childIds.length} child(ren)`;
}

export async function executeSectionCreate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Section Create requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(sectionCreateCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SECTION_CREATE_RESULT_CODE_UNITS) {
    throw pluginResultError('Section Create returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Section Create returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Section Create returned an invalid bounded result.');
    throw mutationError(`Section Create made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw pluginResultError('Section Create returned an invalid bounded result.');
    throw mutationError(`Section Create failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Section Create returned an invalid bounded result.');
  }
  return {
    stdout: formatSectionCreateResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function sectionCreatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Section Create routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-section-create';
}
export function executeSectionCreatePlan(plan, adapters = {}) {
  if (sectionCreatePlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Section Create.');
  }
  return executeSectionCreate(parseSectionCreateRequest(plan.argv), adapters);
}
