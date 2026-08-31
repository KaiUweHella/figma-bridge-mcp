// Plan-bound, freshly verified and rollback-owned `jam arrange` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  jamArrangeArgvFromRequest,
  parseJamArrangeRequest,
} from './jam-arrange-request.js';

export { jamArrangeArgvFromRequest } from './jam-arrange-request.js';

const APPLICATION_ID = 'jam.arrange';
export const JAM_ARRANGE_VERIFY_EPSILON = 0.01;
export const MAX_JAM_ARRANGE_CANDIDATES = 4_096;
export const MAX_JAM_ARRANGE_PAGE_CHILDREN = 20_000;
export const MAX_JAM_ARRANGE_SELECTION = 4_096;
export const MAX_JAM_ARRANGE_RESULT_CODE_UNITS = 4_000_000;
const MAX_TYPE_CODE_UNITS = 64;
const MAX_FAILURE_CODE_UNITS = 1_024;
const MAX_ANCESTORS = 128;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseJamArrangeRequest(jamArrangeArgvFromRequest(request));

function arrangedState(before, input) {
  if (before.nodes.length === 0) return before;
  const startX = Math.min(...before.nodes.map((node) => node.x));
  const startY = Math.min(...before.nodes.map((node) => node.y));
  const columnWidth = Math.max(...before.nodes.map((node) => node.width)) + input.gap;
  const rowHeight = Math.max(...before.nodes.map((node) => node.height)) + input.gap;
  return {
    context: before.context,
    nodes: before.nodes.map((node, index) => ({
      ...node,
      x: startX + (index % input.columns) * columnWidth,
      y: startY + Math.floor(index / input.columns) * rowHeight,
    })),
  };
}

export function jamArrangeCode(request = {}) {
  const input = normalized(request);
  return `(async () => {
    const schemaVersion = 1;
    const request = ${JSON.stringify(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const close = (left, right) => Math.abs(left - right) <= ${JAM_ARRANGE_VERIFY_EPSILON};
    const clean = (value, maximum) => String(value).slice(0, maximum)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const finite = (value, dimension = false) => typeof value === 'number'
      && Number.isFinite(value) && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE}
      && (!dimension || value >= 0);
    const sameIds = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_JAM_ARRANGE_RESULT_CODE_UNITS}) {
        throw new Error('Jam Arrange result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (error) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Jam Arrange preflight failed.'),
    });
    if (figma.editorType !== 'figjam') return refused('Jam Arrange requires a FigJam board.');
    if (!figma.currentPage || typeof figma.getNodeByIdAsync !== 'function') {
      return refused('Jam Arrange requires the native FigJam API.');
    }
    const context = () => {
      const page = figma.currentPage;
      if (!page || !validId(page.id) || !Array.isArray(page.children)
        || page.children.length > ${MAX_JAM_ARRANGE_PAGE_CHILDREN}
        || !Array.isArray(page.selection) || page.selection.length > ${MAX_JAM_ARRANGE_SELECTION}) {
        throw new Error('Jam Arrange requires one bounded current page and selection.');
      }
      const pageChildIds = page.children.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Jam Arrange found an invalid page child.');
        return node.id;
      });
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Jam Arrange found an invalid selection.');
        return node.id;
      });
      if (new Set(pageChildIds).size !== pageChildIds.length
        || new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Jam Arrange requires unique page and selection identities.');
      }
      return { pageId: page.id, pageChildIds, selectionIds };
    };
    const belongsToPage = (node, pageId) => {
      let current = node;
      const visited = new Set();
      for (let depth = 0; current && depth <= ${MAX_ANCESTORS}; depth++) {
        if (current.id === pageId) return true;
        if (!validId(current.id) || visited.has(current.id)) return false;
        visited.add(current.id); current = current.parent || null;
      }
      return false;
    };
    const fact = (node, pageId) => {
      const parentId = node && node.parent && node.parent.id;
      if (!node || !validId(node.id) || typeof node.type !== 'string'
        || node.type.length === 0 || node.type.length > ${MAX_TYPE_CODE_UNITS}
        || !validId(parentId) || !belongsToPage(node, pageId)
        || !finite(node.x) || !finite(node.y)
        || !finite(node.width, true) || !finite(node.height, true)) {
        throw new Error('Jam Arrange found invalid bounded node geometry.');
      }
      return {
        id: node.id, type: node.type, parentId,
        x: node.x, y: node.y, width: node.width, height: node.height,
      };
    };
    const sameFact = (left, right) => left.id === right.id && left.type === right.type
      && left.parentId === right.parentId && close(left.x, right.x) && close(left.y, right.y)
      && close(left.width, right.width) && close(left.height, right.height);
    const sameContext = (left, right) => left.pageId === right.pageId
      && sameIds(left.pageChildIds, right.pageChildIds)
      && sameIds(left.selectionIds, right.selectionIds);
    const sameState = (left, right) => sameContext(left.context, right.context)
      && left.nodes.length === right.nodes.length
      && left.nodes.every((node, index) => sameFact(node, right.nodes[index]));
    const expectedState = (before) => {
      if (before.nodes.length === 0) return before;
      const startX = Math.min(...before.nodes.map((node) => node.x));
      const startY = Math.min(...before.nodes.map((node) => node.y));
      const columnWidth = Math.max(...before.nodes.map((node) => node.width)) + request.gap;
      const rowHeight = Math.max(...before.nodes.map((node) => node.height)) + request.gap;
      const nodes = before.nodes.map((node, index) => ({
        ...node,
        x: startX + (index % request.columns) * columnWidth,
        y: startY + Math.floor(index / request.columns) * rowHeight,
      }));
      if (nodes.some((node) => !finite(node.x) || !finite(node.y))) {
        throw new Error('Jam Arrange expected geometry exceeded the bounded coordinate limit.');
      }
      return { context: before.context, nodes };
    };
    const differenceCount = (left, right) => {
      let count = sameContext(left.context, right.context) ? 0 : 1;
      if (left.nodes.length !== right.nodes.length) count += 1;
      for (let index = 0; index < Math.min(left.nodes.length, right.nodes.length); index++) {
        if (!sameFact(left.nodes[index], right.nodes[index])) count += 1;
      }
      return Math.max(1, count);
    };
    const readState = async (ids) => {
      const current = context();
      const nodes = [];
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (!node || node.id !== id) throw new Error('Jam Arrange target disappeared.');
        nodes.push(fact(node, current.pageId));
      }
      return { context: current, nodes };
    };

    let before;
    let expected;
    let ignored = 0;
    let refs = [];
    try {
      const initialContext = context();
      let candidates;
      if (request.ids !== null) {
        candidates = [];
        for (const id of request.ids) {
          const node = await figma.getNodeByIdAsync(id);
          if (!node || node.id !== id) throw new Error('Jam Arrange target was not found: ' + id);
          candidates.push(node);
        }
      } else if (request.all) candidates = [...figma.currentPage.children];
      else candidates = [...figma.currentPage.selection];
      if (candidates.length > ${MAX_JAM_ARRANGE_CANDIDATES}) {
        throw new Error('Jam Arrange candidate limit exceeded.');
      }
      if (new Set(candidates.map((node) => node && node.id)).size !== candidates.length) {
        throw new Error('Jam Arrange candidate identities must be unique.');
      }
      const candidateFacts = candidates.map((node) => ({
        node, value: fact(node, initialContext.pageId),
      }));
      const movable = candidateFacts.filter(({ value }) => value.type !== 'CONNECTOR'
        && value.type !== 'SECTION');
      ignored = candidates.length - movable.length;
      const nodes = movable.map(({ value }) => value);
      refs = movable.map(({ node }) => node);
      before = { context: initialContext, nodes };
      expected = expectedState(before);
    } catch (error) {
      return refused(error);
    }
    const success = (status, outcome, attempted, actual, warnings) => result({
      schemaVersion, status, outcome, attempted, restored: 0, residueCount: 0,
      scope: request.scope, moved: before.nodes.length, ignored, request,
      before, actual, warnings,
    });
    if (before.nodes.length === 0 || sameState(before, expected)) {
      return success('unchanged', 'no-mutation', 0, before, []);
    }
    try {
      const fresh = await readState(before.nodes.map((node) => node.id));
      if (!sameState(fresh, before)) throw new Error('Jam Arrange precondition changed before mutation.');
      refs = [];
      for (const node of fresh.nodes) refs.push(await figma.getNodeByIdAsync(node.id));
    } catch (error) {
      return refused(error);
    }

    let attempted = 0;
    let mutationFailure = '';
    try {
      for (let index = 0; index < refs.length; index++) {
        attempted += 1;
        refs[index].x = expected.nodes[index].x;
        refs[index].y = expected.nodes[index].y;
      }
    } catch (error) {
      mutationFailure = failureText(error, 'Jam Arrange mutation failed.');
    }
    let actual = null;
    try {
      actual = await readState(before.nodes.map((node) => node.id));
      if (sameState(actual, expected)) {
        delete globalThis.__invCache;
        return success('arranged', mutationFailure ? 'verified-after-error' : 'verified',
          attempted, actual, mutationFailure
            ? ['Figma reported an error, but fresh FigJam readback verified the requested arrangement.']
            : []);
      }
      if (!mutationFailure) mutationFailure = 'Jam Arrange postcondition was not satisfied.';
    } catch (error) {
      if (!mutationFailure) mutationFailure = failureText(error, 'Jam Arrange verification failed.');
    }

    try {
      for (let index = attempted - 1; index >= 0; index--) {
        const node = await figma.getNodeByIdAsync(before.nodes[index].id);
        if (!node || node.id !== before.nodes[index].id) continue;
        try { node.x = before.nodes[index].x; } catch {}
        try { node.y = before.nodes[index].y; } catch {}
      }
      const restored = await readState(before.nodes.map((node) => node.id));
      const rolledBack = sameState(restored, before);
      const unchanged = attempted > 0 && actual && sameState(actual, before);
      const outcome = rolledBack ? (unchanged ? 'unchanged' : 'rolled-back') : 'partial-residue';
      const residueCount = rolledBack ? 0 : differenceCount(before, restored);
      if (rolledBack) delete globalThis.__invCache;
      return result({
        schemaVersion, status: 'failed', outcome, attempted,
        restored: outcome === 'rolled-back' ? attempted : 0, residueCount,
        scope: request.scope, moved: before.nodes.length, ignored, request,
        before, actual: restored, failure: clean(mutationFailure, ${MAX_FAILURE_CODE_UNITS}),
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted,
        restored: 0, residueCount: Math.max(1, attempted), scope: request.scope,
        moved: before.nodes.length, ignored, request, before, actual: null,
        failure: failureText(error, mutationFailure || 'Jam Arrange rollback verification failed.'),
      });
    }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function id(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_NODE_REFERENCE_CODE_UNITS && NODE_REFERENCE_PATTERN.test(value);
}
function coordinate(value, dimension = false) {
  return typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE && (!dimension || value >= 0);
}
function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function validContext(value) {
  return exact(value, ['pageId', 'pageChildIds', 'selectionIds']) && id(value.pageId)
    && Array.isArray(value.pageChildIds) && value.pageChildIds.length <= MAX_JAM_ARRANGE_PAGE_CHILDREN
    && value.pageChildIds.every(id) && new Set(value.pageChildIds).size === value.pageChildIds.length
    && Array.isArray(value.selectionIds) && value.selectionIds.length <= MAX_JAM_ARRANGE_SELECTION
    && value.selectionIds.every(id) && new Set(value.selectionIds).size === value.selectionIds.length;
}
function validNode(value) {
  return exact(value, ['id', 'type', 'parentId', 'x', 'y', 'width', 'height'])
    && id(value.id) && typeof value.type === 'string' && value.type.length > 0
    && value.type.length <= MAX_TYPE_CODE_UNITS && id(value.parentId)
    && coordinate(value.x) && coordinate(value.y)
    && coordinate(value.width, true) && coordinate(value.height, true);
}
function validState(value) {
  return exact(value, ['context', 'nodes']) && validContext(value.context)
    && Array.isArray(value.nodes) && value.nodes.length <= MAX_JAM_ARRANGE_CANDIDATES
    && value.nodes.every(validNode)
    && new Set(value.nodes.map((node) => node.id)).size === value.nodes.length;
}
function sameFact(left, right) {
  return left.id === right.id && left.type === right.type && left.parentId === right.parentId
    && ['x', 'y', 'width', 'height'].every(
      (field) => Math.abs(left[field] - right[field]) <= JAM_ARRANGE_VERIFY_EPSILON);
}
function sameState(left, right) {
  return left.context.pageId === right.context.pageId
    && sameIds(left.context.pageChildIds, right.context.pageChildIds)
    && sameIds(left.context.selectionIds, right.context.selectionIds)
    && left.nodes.length === right.nodes.length
    && left.nodes.every((node, index) => sameFact(node, right.nodes[index]));
}
function validRequest(value, input) {
  return exact(value, ['columns', 'gap', 'ids', 'all', 'scope'])
    && value.columns === input.columns && value.gap === input.gap
    && value.all === input.all && value.scope === input.scope
    && ((value.ids === null && input.ids === null)
      || (Array.isArray(value.ids) && Array.isArray(input.ids) && sameIds(value.ids, input.ids)));
}
function boundedCount(value, maximum = MAX_JAM_ARRANGE_CANDIDATES) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && typeof value.failure === 'string' && value.failure.length > 0
    && value.failure.length <= MAX_FAILURE_CODE_UNITS;
}
const SUCCESS_KEYS = [
  'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
  'scope', 'moved', 'ignored', 'request', 'before', 'actual', 'warnings',
];
function validSuccess(value, input) {
  if (!exact(value, SUCCESS_KEYS) || value.schemaVersion !== 1
    || !['unchanged', 'arranged'].includes(value.status)
    || !['no-mutation', 'verified', 'verified-after-error'].includes(value.outcome)
    || value.scope !== input.scope || !validRequest(value.request, input)
    || !boundedCount(value.moved) || !boundedCount(value.ignored)
    || !validState(value.before) || !validState(value.actual)
    || value.moved !== value.before.nodes.length || value.restored !== 0 || value.residueCount !== 0
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || value.warnings.some((warning) => typeof warning !== 'string'
      || warning.length === 0 || warning.length > MAX_FAILURE_CODE_UNITS)) return false;
  const expected = arrangedState(value.before, input);
  if (!validState(expected) || !sameState(value.actual, expected)) return false;
  if (value.outcome === 'no-mutation') {
    return value.status === 'unchanged' && value.attempted === 0
      && value.warnings.length === 0 && sameState(value.before, value.actual);
  }
  return value.status === 'arranged' && boundedCount(value.attempted)
    && value.attempted > 0 && value.attempted <= value.moved
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
const FAILURE_KEYS = [
  'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
  'scope', 'moved', 'ignored', 'request', 'before', 'actual', 'failure',
];
function validFailure(value, input) {
  if (!exact(value, FAILURE_KEYS) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'rolled-back', 'partial-residue', 'verification-unavailable']
      .includes(value.outcome)
    || value.scope !== input.scope || !validRequest(value.request, input)
    || !boundedCount(value.attempted) || !boundedCount(value.restored)
    || !boundedCount(value.residueCount, MAX_JAM_ARRANGE_CANDIDATES + 1)
    || !boundedCount(value.moved) || !boundedCount(value.ignored)
    || !validState(value.before) || value.moved !== value.before.nodes.length
    || typeof value.failure !== 'string' || value.failure.length === 0
    || value.failure.length > MAX_FAILURE_CODE_UNITS) return false;
  if (value.outcome === 'verification-unavailable') {
    return value.actual === null && value.restored === 0 && value.residueCount > 0;
  }
  if (!validState(value.actual)) return false;
  const restored = sameState(value.before, value.actual);
  if (value.outcome === 'unchanged') return restored && value.restored === 0 && value.residueCount === 0;
  if (value.outcome === 'rolled-back') {
    return restored && value.restored === value.attempted && value.residueCount === 0;
  }
  return !restored && value.restored === 0 && value.residueCount > 0;
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

export function formatJamArrangeResult(result) {
  return result.moved
    ? `✓ ${result.moved} node(s) arranged (${safeText(result.scope)})`
    : `✓ Nothing to arrange (${safeText(result.scope)})`;
}

export async function executeJamArrange(request = {}, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Jam Arrange requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(jamArrangeCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_JAM_ARRANGE_RESULT_CODE_UNITS) {
    throw pluginResultError('Jam Arrange returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Jam Arrange returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Jam Arrange returned an invalid bounded result.');
    throw mutationError(`Jam Arrange made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw pluginResultError('Jam Arrange returned an invalid bounded result.');
    }
    throw mutationError(`Jam Arrange failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: payload.attempted,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Jam Arrange returned an invalid bounded result.');
  }
  return {
    stdout: formatJamArrangeResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function jamArrangePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Jam Arrange routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-jam-arrange';
}

export function executeJamArrangePlan(plan, adapters = {}) {
  if (jamArrangePlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Jam Arrange.');
  }
  return executeJamArrange(parseJamArrangeRequest(plan.argv), adapters);
}
