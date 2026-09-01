// Plan-bound, bounded and rollback-verified `section arrange` geometry mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  parseSectionArrangeRequest,
  sectionArrangeArgvFromRequest,
  sectionArrangePlanningArgvFromRequest,
} from './section-arrange-request.js';

export {
  sectionArrangeArgvFromRequest,
  sectionArrangePlanningArgvFromRequest,
} from './section-arrange-request.js';

const APPLICATION_ID = 'section.arrange';
export const SECTION_ARRANGE_HEADER = 40;
export const SECTION_ARRANGE_VERIFY_EPSILON = 0.01;
export const MAX_SECTION_ARRANGE_CHILDREN = 4_096;
export const MAX_SECTION_ARRANGE_RESULT_CODE_UNITS = 2_000_000;
export const MAX_SECTION_ARRANGE_SNAPSHOT_CODE_UNITS = 900_000;
const MAX_NAME_CODE_UNITS = 1_024;
const MAX_TYPE_CODE_UNITS = 64;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseSectionArrangeRequest(sectionArrangeArgvFromRequest(request));

function rank(type) {
  return ({ COMPONENT_SET: 0, COMPONENT: 1, INSTANCE: 2, FRAME: 3 })[type] ?? 4;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function arrangedGeometry(before, input) {
  if (before.children.length === 0) return before;
  const ordered = before.children.map((child, index) => ({ ...child, index }));
  ordered.sort(input.groupRows
    ? (left, right) => rank(left.type) - rank(right.type)
      || compareText(left.type, right.type)
      || compareText(left.name, right.name)
      || left.index - right.index
    : (left, right) => left.y - right.y || left.x - right.x || left.index - right.index);
  const positions = new Map();
  let x = input.pad;
  let y = input.pad + SECTION_ARRANGE_HEADER;
  let rowHeight = 0;
  let column = 0;
  let maxRight = 0;
  let previousType = null;
  for (const child of ordered) {
    const typeBreak = input.groupRows && previousType !== null && child.type !== previousType;
    if (column === input.cols || typeBreak) {
      column = 0;
      x = input.pad;
      y += rowHeight + input.gap;
      rowHeight = 0;
    }
    positions.set(child.id, { x, y });
    maxRight = Math.max(maxRight, x + child.width);
    rowHeight = Math.max(rowHeight, child.height);
    x += child.width + input.gap;
    column += 1;
    previousType = child.type;
  }
  return {
    section: {
      ...before.section,
      width: maxRight + input.pad,
      height: y + rowHeight + input.pad,
    },
    children: before.children.map((child) => ({ ...child, ...positions.get(child.id) })),
  };
}

export function sectionArrangeCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${JSON.stringify(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SECTION_ARRANGE_RESULT_CODE_UNITS}) {
        throw new Error('Section Arrange result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const finite = (value, dimension = false) => Number.isFinite(value)
      && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE}
      && (!dimension || value >= 0);
    const identity = (node) => ({
      id: clean(node.id, ${MAX_NODE_REFERENCE_CODE_UNITS}),
      name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
      type: 'SECTION',
    });
    const geometry = (node) => {
      if (!node || node.type !== 'SECTION' || typeof node.id !== 'string'
        || !nodeIdPattern.test(node.id) || node.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
        || typeof node.name !== 'string' || node.name.length > ${MAX_NAME_CODE_UNITS}
        || typeof node.resizeWithoutConstraints !== 'function'
        || !Array.isArray(node.children)
        || node.children.length > ${MAX_SECTION_ARRANGE_CHILDREN}
        || !finite(node.x) || !finite(node.y)
        || !finite(node.width, true) || !finite(node.height, true)) {
        throw new Error('Section Arrange requires one exact bounded Section node.');
      }
      const children = node.children.map((child) => {
        if (!child || typeof child.id !== 'string' || !nodeIdPattern.test(child.id)
          || child.id.length > ${MAX_NODE_REFERENCE_CODE_UNITS}
          || typeof child.name !== 'string' || child.name.length > ${MAX_NAME_CODE_UNITS}
          || typeof child.type !== 'string' || child.type.length === 0
          || child.type.length > ${MAX_TYPE_CODE_UNITS}
          || !finite(child.x) || !finite(child.y)
          || !finite(child.width, true) || !finite(child.height, true)) {
          throw new Error('Section Arrange found invalid bounded child geometry.');
        }
        return {
          id: child.id, name: child.name, type: child.type,
          x: child.x, y: child.y, width: child.width, height: child.height,
        };
      });
      if (new Set(children.map((child) => child.id)).size !== children.length) {
        throw new Error('Section Arrange child identities must be unique.');
      }
      const value = {
        section: { x: node.x, y: node.y, width: node.width, height: node.height },
        children,
      };
      if (JSON.stringify(value).length > ${MAX_SECTION_ARRANGE_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Section Arrange snapshot exceeded its bounded limit.');
      }
      return value;
    };
    const rank = (type) => ({ COMPONENT_SET: 0, COMPONENT: 1, INSTANCE: 2, FRAME: 3 })[type] ?? 4;
    const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const expectedGeometry = (before) => {
      if (before.children.length === 0) return before;
      const ordered = before.children.map((child, index) => ({ ...child, index }));
      ordered.sort(request.groupRows
        ? (left, right) => rank(left.type) - rank(right.type)
          || compareText(left.type, right.type)
          || compareText(left.name, right.name)
          || left.index - right.index
        : (left, right) => left.y - right.y || left.x - right.x || left.index - right.index);
      const positions = new Map();
      let x = request.pad;
      let y = request.pad + ${SECTION_ARRANGE_HEADER};
      let rowHeight = 0;
      let column = 0;
      let maxRight = 0;
      let previousType = null;
      for (const child of ordered) {
        const typeBreak = request.groupRows && previousType !== null && child.type !== previousType;
        if (column === request.cols || typeBreak) {
          column = 0;
          x = request.pad;
          y += rowHeight + request.gap;
          rowHeight = 0;
        }
        positions.set(child.id, { x, y });
        maxRight = Math.max(maxRight, x + child.width);
        rowHeight = Math.max(rowHeight, child.height);
        x += child.width + request.gap;
        column += 1;
        previousType = child.type;
      }
      const expected = {
        section: {
          ...before.section,
          width: maxRight + request.pad,
          height: y + rowHeight + request.pad,
        },
        children: before.children.map((child) => ({ ...child, ...positions.get(child.id) })),
      };
      if (![expected.section, ...expected.children].every((item) => (
        finite(item.x) && finite(item.y)
        && finite(item.width, true) && finite(item.height, true)
      ))) throw new Error('Section Arrange expected geometry exceeded the bounded coordinate limit.');
      return expected;
    };
    const close = (left, right) => Math.abs(left - right) <= ${SECTION_ARRANGE_VERIFY_EPSILON};
    const same = (left, right) => left.children.length === right.children.length
      && ['x', 'y', 'width', 'height'].every(
        (field) => close(left.section[field], right.section[field]))
      && left.children.every((child, index) => {
        const other = right.children[index];
        return child.id === other.id && child.name === other.name && child.type === other.type
          && ['x', 'y', 'width', 'height'].every((field) => close(child[field], other[field]));
      });
    const differences = (left, right) => {
      let count = ['x', 'y', 'width', 'height'].filter(
        (field) => !close(left.section[field], right.section[field])).length;
      if (left.children.length !== right.children.length) count += 1;
      const length = Math.min(left.children.length, right.children.length);
      for (let index = 0; index < length; index++) {
        const a = left.children[index];
        const b = right.children[index];
        if (a.id !== b.id || a.name !== b.name || a.type !== b.type) { count += 1; continue; }
        count += ['x', 'y', 'width', 'height'].filter(
          (field) => !close(a[field], b[field])).length;
      }
      return Math.max(1, count);
    };
    const apply = (node, target) => {
      if (!node || node.id !== request.sectionId || node.type !== 'SECTION'
        || typeof node.resizeWithoutConstraints !== 'function'
        || !Array.isArray(node.children)
        || node.children.length !== target.children.length
        || node.children.some((child, index) => child.id !== target.children[index].id)) {
        throw new Error('Section Arrange target membership changed before geometry assignment.');
      }
      for (let index = 0; index < node.children.length; index++) {
        node.children[index].x = target.children[index].x;
        node.children[index].y = target.children[index].y;
      }
      node.resizeWithoutConstraints(target.section.width, target.section.height);
    };
    const success = (status, outcome, attempted, node, before, actual, warnings) => bounded({
      schemaVersion: 1, status, outcome, attempted, restored: 0, residueCount: 0,
      node: identity(node), request, empty: before.children.length === 0,
      before, actual, warnings,
    });
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Section Arrange preflight failed'),
    });
    const failed = (outcome, restored, residueCount, node, before, actual, failure) => bounded({
      schemaVersion: 1, status: 'failed', outcome, attempted: 1, restored,
      residueCount, node: identity(node), request, before, actual,
      failure: failureText(failure, 'fresh geometry postcondition failed'),
    });

    let section;
    let before;
    let expected;
    try {
      section = await figma.getNodeByIdAsync(request.sectionId);
      if (!section || section.id !== request.sectionId) {
        throw new Error('Section Arrange target was not found in the targeted Figma document.');
      }
      before = geometry(section);
      expected = expectedGeometry(before);
    } catch (error) {
      return refusal(error);
    }
    if (before.children.length === 0 || same(before, expected)) {
      return success('unchanged', 'no-mutation', 0, section, before, before, []);
    }

    const fresh = async () => {
      const node = await figma.getNodeByIdAsync(request.sectionId);
      if (!node || node.id !== request.sectionId) {
        throw new Error('Fresh Section Arrange target identity changed.');
      }
      return { node, value: geometry(node) };
    };
    try {
      const current = await fresh();
      if (!same(current.value, before)) {
        return refusal(new Error('Section Arrange precondition changed before mutation.'));
      }
      section = current.node;
    } catch (error) {
      return refusal(error);
    }

    let mutationError = null;
    try { apply(section, expected); }
    catch (error) { mutationError = error; }
    let failure = mutationError;
    try {
      const after = await fresh();
      if (same(after.value, expected)) {
        delete globalThis.__invCache;
        return success('arranged', mutationError ? 'verified-after-error' : 'verified',
          1, after.node, before, after.value,
          mutationError ? [failureText(mutationError, 'native acknowledgement failed')] : []);
      }
      if (same(after.value, before)) {
        return failed('unchanged', 0, 1, after.node, before, after.value,
          mutationError || new Error('Fresh Section Arrange postcondition was unchanged.'));
      }
      failure ||= new Error('Fresh Section Arrange postcondition failed.');
    } catch (error) { failure ||= error; }

    let rollbackNode = section;
    try {
      rollbackNode = await figma.getNodeByIdAsync(request.sectionId);
      apply(rollbackNode, before);
    } catch (error) { failure ||= error; }
    try {
      const restored = await fresh();
      if (same(restored.value, before)) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, 0, restored.node, before, restored.value, failure);
      }
      return failed('partial-residue', 0, differences(before, restored.value),
        restored.node, before, restored.value, failure);
    } catch (error) {
      return failed('verification-unavailable', 0, 1,
        rollbackNode || section, before, null, failure || error);
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
    && (!dimension || value >= 0);
}
function validNode(value, input) {
  return exact(value, ['id', 'name', 'type']) && value.id === input.sectionId
    && text(value.id, MAX_NODE_REFERENCE_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && text(value.name, MAX_NAME_CODE_UNITS) && value.type === 'SECTION';
}
function validGeometryItem(value, child = false) {
  return exact(value, child
    ? ['id', 'name', 'type', 'x', 'y', 'width', 'height']
    : ['x', 'y', 'width', 'height'])
    && (!child || text(value.id, MAX_NODE_REFERENCE_CODE_UNITS, false)
      && NODE_REFERENCE_PATTERN.test(value.id)
      && text(value.name, MAX_NAME_CODE_UNITS)
      && text(value.type, MAX_TYPE_CODE_UNITS, false))
    && finite(value.x) && finite(value.y)
    && finite(value.width, true) && finite(value.height, true);
}
function validState(value) {
  return exact(value, ['section', 'children']) && validGeometryItem(value.section)
    && Array.isArray(value.children) && value.children.length <= MAX_SECTION_ARRANGE_CHILDREN
    && value.children.every((child) => validGeometryItem(child, true))
    && new Set(value.children.map((child) => child.id)).size === value.children.length
    && JSON.stringify(value).length <= MAX_SECTION_ARRANGE_SNAPSHOT_CODE_UNITS;
}
function close(left, right) {
  return Math.abs(left - right) <= SECTION_ARRANGE_VERIFY_EPSILON;
}
function sameState(left, right) {
  return left.children.length === right.children.length
    && ['x', 'y', 'width', 'height'].every(
      (field) => close(left.section[field], right.section[field]))
    && left.children.every((child, index) => {
      const other = right.children[index];
      return child.id === other.id && child.name === other.name && child.type === other.type
        && ['x', 'y', 'width', 'height'].every((field) => close(child[field], other[field]));
    });
}
function differenceCount(left, right) {
  let count = ['x', 'y', 'width', 'height'].filter(
    (field) => !close(left.section[field], right.section[field])).length;
  if (left.children.length !== right.children.length) count += 1;
  const length = Math.min(left.children.length, right.children.length);
  for (let index = 0; index < length; index++) {
    const a = left.children[index];
    const b = right.children[index];
    if (a.id !== b.id || a.name !== b.name || a.type !== b.type) { count += 1; continue; }
    count += ['x', 'y', 'width', 'height'].filter(
      (field) => !close(a[field], b[field])).length;
  }
  return Math.max(1, count);
}
function validRequest(value, input) {
  return exact(value, ['sectionId', 'cols', 'gap', 'pad', 'groupRows'])
    && value.sectionId === input.sectionId && value.cols === input.cols
    && value.gap === input.gap && value.pad === input.pad
    && value.groupRows === input.groupRows;
}

const SUCCESS_KEYS = [
  'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
  'node', 'request', 'empty', 'before', 'actual', 'warnings',
];
function validSuccess(value, input) {
  if (!exact(value, SUCCESS_KEYS) || value.schemaVersion !== 1
    || !['unchanged', 'arranged'].includes(value.status)
    || !['no-mutation', 'verified', 'verified-after-error'].includes(value.outcome)
    || !validNode(value.node, input) || !validRequest(value.request, input)
    || typeof value.empty !== 'boolean' || value.empty !== (value.before?.children?.length === 0)
    || !validState(value.before) || !validState(value.actual)
    || value.restored !== 0 || value.residueCount !== 0
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || !value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false))) return false;
  const expected = arrangedGeometry(value.before, input);
  if (!validState(expected) || !sameState(value.actual, expected)) return false;
  if (value.outcome === 'no-mutation') {
    return value.status === 'unchanged' && value.attempted === 0
      && value.warnings.length === 0 && sameState(value.before, value.actual);
  }
  return value.status === 'arranged' && value.attempted === 1
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}
const FAILURE_KEYS = [
  'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
  'node', 'request', 'before', 'actual', 'failure',
];
function validFailure(value, input) {
  if (!exact(value, FAILURE_KEYS) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'rolled-back', 'partial-residue', 'verification-unavailable']
      .includes(value.outcome)
    || value.attempted !== 1 || ![0, 1].includes(value.restored)
    || !Number.isInteger(value.residueCount) || value.residueCount < 0
    || value.residueCount > 1 + (MAX_SECTION_ARRANGE_CHILDREN + 1) * 4
    || !validNode(value.node, input) || !validRequest(value.request, input)
    || !validState(value.before) || !text(value.failure, MAX_FAILURE_CODE_UNITS, false)) return false;
  if (value.outcome === 'verification-unavailable') {
    return value.restored === 0 && value.residueCount === 1 && value.actual === null;
  }
  if (!validState(value.actual)) return false;
  const restored = sameState(value.before, value.actual);
  const desired = sameState(arrangedGeometry(value.before, input), value.actual);
  if (value.outcome === 'unchanged') {
    return value.restored === 0 && value.residueCount === 1 && restored && !desired;
  }
  if (value.outcome === 'rolled-back') {
    return value.restored === 1 && value.residueCount === 0 && restored;
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

export function formatSectionArrangeResult(result) {
  const name = JSON.stringify(safeText(result.node.name));
  if (result.empty) return `⚠ Section ${name} is empty — nothing to arrange`;
  return `✓ Arranged ${result.actual.children.length} children in ${name} (${Math.round(result.actual.section.width)}×${Math.round(result.actual.section.height)})`;
}

export async function executeSectionArrange(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Section Arrange requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(sectionArrangeCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SECTION_ARRANGE_RESULT_CODE_UNITS) {
    throw pluginResultError('Section Arrange returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Section Arrange returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) {
      throw pluginResultError('Section Arrange returned an invalid bounded result.');
    }
    throw mutationError(`Section Arrange made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw pluginResultError('Section Arrange returned an invalid bounded result.');
    }
    throw mutationError(`Section Arrange failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Section Arrange returned an invalid bounded result.');
  }
  return {
    stdout: formatSectionArrangeResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function sectionArrangePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Section Arrange routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-section-arrange';
}
export function executeSectionArrangePlan(plan, adapters = {}) {
  if (sectionArrangePlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Section Arrange.');
  }
  return executeSectionArrange(parseSectionArrangeRequest(plan.argv), adapters);
}
