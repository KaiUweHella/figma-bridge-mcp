// Plan-bound, freshly verified and rollback-owned `jam shape` creation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import { MAX_NODE_REFERENCE_CODE_UNITS, NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_JAM_SHAPE_TEXT_CODE_UNITS,
  jamShapeArgvFromRequest,
  parseJamShapeRequest,
} from './jam-shape-request.js';

export { jamShapeArgvFromRequest } from './jam-shape-request.js';

const APPLICATION_ID = 'jam.shape';
export const JAM_SHAPE_VERIFY_EPSILON = 0.01;
export const MAX_JAM_SHAPE_PAGE_CHILDREN = 20_000;
export const MAX_JAM_SHAPE_SELECTION = 4_096;
export const MAX_JAM_SHAPE_SNAPSHOT_CODE_UNITS = 300_000;
export const MAX_JAM_SHAPE_RESULT_CODE_UNITS = 1_000_000;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseJamShapeRequest(jamShapeArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function jamShapeCode(request) {
  const input = normalized(request);
  return `(async () => {
    const schemaVersion = 1;
    const request = ${js(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => String(value).slice(0, maximum)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const finite = (value, dimension = false) => typeof value === 'number'
      && Number.isFinite(value) && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE}
      && (!dimension || value >= 0.01);
    const close = (left, right) => typeof left === 'number' && Number.isFinite(left)
      && Math.abs(left - right) <= ${JAM_SHAPE_VERIFY_EPSILON};
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_JAM_SHAPE_RESULT_CODE_UNITS}) {
        throw new Error('Jam Shape result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (error) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Jam Shape preflight failed.'),
    });
    if (figma.editorType !== 'figjam') return refused('Jam Shape requires a FigJam board.');
    if (!figma.currentPage || typeof figma.createShapeWithText !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function' || typeof figma.loadFontAsync !== 'function') {
      return refused('Jam Shape requires the native FigJam API.');
    }
    const context = (page, placement = false) => {
      if (!page || !validId(page.id) || !Array.isArray(page.children)
        || page.children.length > ${MAX_JAM_SHAPE_PAGE_CHILDREN}
        || !Array.isArray(page.selection) || page.selection.length > ${MAX_JAM_SHAPE_SELECTION}) {
        throw new Error('Jam Shape requires one bounded current page and selection.');
      }
      const childIds = page.children.map((node) => {
        if (!node || !validId(node.id)
          || (placement && (!finite(node.x) || !finite(node.y)
            || typeof node.width !== 'number' || !Number.isFinite(node.width) || node.width < 0))) {
          throw new Error('Jam Shape found invalid bounded page geometry.');
        }
        return node.id;
      });
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Jam Shape found an invalid selection.');
        return node.id;
      });
      if (new Set(childIds).size !== childIds.length
        || new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Jam Shape requires unique page and selection identities.');
      }
      return { pageId: page.id, childIds, selectionIds };
    };
    const explicit = request.x !== null;
    let page;
    let before;
    let origin;
    try {
      page = figma.currentPage;
      before = context(page, !explicit);
      origin = explicit ? { x: request.x, y: request.y } : page.children.length
        ? {
          x: Math.max(...page.children.map((node) => node.x + node.width)) + 80,
          y: Math.min(...page.children.map((node) => node.y)),
        }
        : { x: 0, y: 0 };
      if (!finite(origin.x) || !finite(origin.y)) {
        throw new Error('Jam Shape placement exceeded the bounded coordinate limit.');
      }
      if (JSON.stringify({ request, before, origin }).length > ${MAX_JAM_SHAPE_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Jam Shape preflight snapshot exceeded its bounded limit.');
      }
    } catch (error) { return refused(error); }
    const nodeFact = (node, pageId, index) => {
      if (!node || node.type !== 'SHAPE_WITH_TEXT' || !validId(node.id)
        || !node.parent || node.parent.id !== pageId
        || typeof node.shapeType !== 'string' || node.shapeType.length > 64
        || !node.text || typeof node.text.characters !== 'string'
        || node.text.characters.length > ${MAX_JAM_SHAPE_TEXT_CODE_UNITS}
        || !finite(node.x) || !finite(node.y)
        || !finite(node.width, true) || !finite(node.height, true)
        || !Number.isSafeInteger(index) || index < 0) {
        throw new Error('Jam Shape found invalid bounded Shape facts.');
      }
      return {
        id: node.id, type: 'SHAPE_WITH_TEXT', parentId: pageId, index,
        shapeType: node.shapeType, text: node.text.characters,
        x: node.x, y: node.y, width: node.width, height: node.height,
      };
    };
    const exactSuccess = (actual, node) => {
      const expectedChildren = [...before.childIds, node.id];
      return figma.currentPage && figma.currentPage.id === before.pageId
        && same(actual.childIds, expectedChildren) && same(actual.selectionIds, [node.id])
        && node.index === before.childIds.length && node.shapeType === request.type
        && node.text === request.text && close(node.x, origin.x) && close(node.y, origin.y)
        && close(node.width, request.width) && close(node.height, request.height);
    };

    let shape = null;
    let failure = '';
    try {
      shape = figma.createShapeWithText();
      shape.shapeType = request.type;
      try { await figma.loadFontAsync({ family: 'Inter', style: 'Medium' }); } catch {}
      try {
        const font = shape.text && shape.text.fontName;
        if (font && font !== figma.mixed) await figma.loadFontAsync(font);
      } catch {}
      if (!figma.currentPage || figma.currentPage.id !== before.pageId) {
        throw new Error('Jam Shape current page changed during creation.');
      }
      shape.text.characters = request.text;
      shape.resize(request.width, request.height);
      shape.x = origin.x;
      shape.y = origin.y;
      page.selection = [shape];
    } catch (error) {
      failure = failureText(error, 'Jam Shape mutation failed.');
    }
    if (shape && validId(shape.id)) {
      try {
        const freshPage = await figma.getNodeByIdAsync(before.pageId);
        const fresh = await figma.getNodeByIdAsync(shape.id);
        const actual = context(freshPage);
        const node = nodeFact(fresh, before.pageId, actual.childIds.indexOf(shape.id));
        if (exactSuccess(actual, node)) {
          delete globalThis.__invCache;
          return result({
            schemaVersion, status: 'created', outcome: failure ? 'verified-after-error' : 'verified',
            attempted: 1, restored: 0, residueCount: 0, request, origin, before,
            actual: { context: actual, node },
            warnings: failure
              ? ['Figma reported an error, but fresh FigJam readback verified the requested Shape.']
              : [],
          });
        }
        if (!failure) failure = 'Jam Shape postcondition was not satisfied.';
      } catch (error) {
        if (!failure) failure = failureText(error, 'Jam Shape verification failed.');
      }
    } else if (!failure) failure = 'Jam Shape factory returned no bounded identity.';

    if (!shape || !validId(shape.id)) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, residueCount: 0, failure,
      });
    }
    try {
      try { shape.remove(); } catch {}
      const restoredPage = await figma.getNodeByIdAsync(before.pageId);
      try {
        const selection = [];
        for (const id of before.selectionIds) {
          const node = await figma.getNodeByIdAsync(id);
          if (node) selection.push(node);
        }
        restoredPage.selection = selection;
      } catch {}
      const fresh = await figma.getNodeByIdAsync(shape.id);
      const restoredContext = context(restoredPage);
      let residueCount = fresh || restoredContext.childIds.includes(shape.id) ? 1 : 0;
      if (!same(restoredContext.childIds, before.childIds)) residueCount += 1;
      if (!same(restoredContext.selectionIds, before.selectionIds)) residueCount += 1;
      if (residueCount === 0) delete globalThis.__invCache;
      return result({
        schemaVersion, status: 'failed',
        outcome: residueCount === 0 ? 'rolled-back' : 'partial-residue', attempted: 1,
        restored: residueCount === 0 ? 1 : 0, residueCount, failure,
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, residueCount: 0,
        failure: failureText(error, failure || 'Jam Shape rollback verification failed.'),
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
    && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE && (!dimension || value >= 0.01);
}
function ids(value, maximum) {
  return Array.isArray(value) && value.length <= maximum && value.every(id)
    && new Set(value).size === value.length;
}
function validContext(value) {
  return exact(value, ['pageId', 'childIds', 'selectionIds']) && id(value.pageId)
    && ids(value.childIds, MAX_JAM_SHAPE_PAGE_CHILDREN)
    && ids(value.selectionIds, MAX_JAM_SHAPE_SELECTION);
}
function validRequest(value, input) {
  return exact(value, ['text', 'type', 'width', 'height', 'x', 'y'])
    && JSON.stringify(value) === JSON.stringify(input);
}
function validNode(value, input, before) {
  return exact(value, [
    'id', 'type', 'parentId', 'index', 'shapeType', 'text', 'x', 'y', 'width', 'height',
  ]) && id(value.id) && value.type === 'SHAPE_WITH_TEXT' && value.parentId === before.pageId
    && value.index === before.childIds.length && value.shapeType === input.type
    && value.text === input.text && coordinate(value.x) && coordinate(value.y)
    && coordinate(value.width, true) && coordinate(value.height, true);
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && typeof value.failure === 'string' && value.failure.length > 0
    && value.failure.length <= MAX_FAILURE_CODE_UNITS;
}
function validSuccess(value, input) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
    'request', 'origin', 'before', 'actual', 'warnings',
  ]) || value.schemaVersion !== 1 || value.status !== 'created'
    || !['verified', 'verified-after-error'].includes(value.outcome)
    || value.attempted !== 1 || value.restored !== 0 || value.residueCount !== 0
    || !validRequest(value.request, input)
    || !exact(value.origin, ['x', 'y']) || !coordinate(value.origin.x) || !coordinate(value.origin.y)
    || (input.x !== null && (value.origin.x !== input.x || value.origin.y !== input.y))
    || !validContext(value.before)
    || JSON.stringify({ request: value.request, before: value.before, origin: value.origin }).length
      > MAX_JAM_SHAPE_SNAPSHOT_CODE_UNITS
    || !exact(value.actual, ['context', 'node']) || !validContext(value.actual.context)
    || !validNode(value.actual.node, input, value.before)
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || value.warnings.some((warning) => typeof warning !== 'string'
      || warning.length === 0 || warning.length > MAX_FAILURE_CODE_UNITS)) return false;
  const expectedChildren = [...value.before.childIds, value.actual.node.id];
  return value.actual.context.pageId === value.before.pageId
    && sameIds(value.actual.context.childIds, expectedChildren)
    && sameIds(value.actual.context.selectionIds, [value.actual.node.id])
    && Math.abs(value.actual.node.x - value.origin.x) <= JAM_SHAPE_VERIFY_EPSILON
    && Math.abs(value.actual.node.y - value.origin.y) <= JAM_SHAPE_VERIFY_EPSILON
    && Math.abs(value.actual.node.width - input.width) <= JAM_SHAPE_VERIFY_EPSILON
    && Math.abs(value.actual.node.height - input.height) <= JAM_SHAPE_VERIFY_EPSILON
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function validFailure(value) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || value.attempted !== 1 || ![0, 1].includes(value.restored)
    || !Number.isSafeInteger(value.residueCount) || value.residueCount < 0 || value.residueCount > 3
    || typeof value.failure !== 'string' || value.failure.length === 0
    || value.failure.length > MAX_FAILURE_CODE_UNITS) return false;
  if (value.outcome === 'rolled-back') return value.restored === 1 && value.residueCount === 0;
  if (value.outcome === 'partial-residue') return value.restored === 0 && value.residueCount > 0;
  return value.restored === 0;
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
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

export function formatJamShapeResult(result) {
  return `✓ Shape ${safeText(result.actual.node.id)}`;
}

export async function executeJamShape(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Jam Shape requires a Figma evaluate adapter.');
  const input = normalized(request);
  const serialized = await adapters.evaluate(jamShapeCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_JAM_SHAPE_RESULT_CODE_UNITS) {
    throw invalid('Jam Shape returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw invalid('Jam Shape returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Jam Shape returned an invalid bounded result.');
    throw mutationError(`Jam Shape made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw invalid('Jam Shape returned an invalid bounded result.');
    throw mutationError(`Jam Shape failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) throw invalid('Jam Shape returned an invalid bounded result.');
  return {
    stdout: formatJamShapeResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function jamShapePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Jam Shape routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-jam-shape';
}

export function executeJamShapePlan(plan, adapters = {}) {
  if (jamShapePlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Jam Shape.');
  }
  return executeJamShape(parseJamShapeRequest(plan.argv), adapters);
}
