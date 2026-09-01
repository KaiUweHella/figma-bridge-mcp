// Plan-bound, freshly verified and rollback-owned `jam sticky` creation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  MAX_JAM_STICKY_TEXT_CODE_UNITS,
  jamStickyArgvFromRequest,
  parseJamStickyRequest,
} from './jam-sticky-request.js';

export { jamStickyArgvFromRequest } from './jam-sticky-request.js';

const APPLICATION_ID = 'jam.sticky';
export const JAM_STICKY_VERIFY_EPSILON = 0.01;
export const MAX_JAM_STICKY_PAGE_CHILDREN = 20_000;
export const MAX_JAM_STICKY_SELECTION = 4_096;
export const MAX_JAM_STICKY_SNAPSHOT_CODE_UNITS = 300_000;
export const MAX_JAM_STICKY_RESULT_CODE_UNITS = 1_000_000;
const MAX_FAILURE_CODE_UNITS = 1_024;
const MAX_TYPE_CODE_UNITS = 64;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseJamStickyRequest(jamStickyArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function jamStickyCode(request) {
  const input = normalized(request);
  const rgb = input.color === null ? null
    : [0, 2, 4].map((start) => parseInt(input.color.slice(1).slice(start, start + 2), 16) / 255);
  return `(async () => {
    const schemaVersion = 1;
    const request = ${js(input)};
    const requestedRgb = ${js(rgb)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => String(value).slice(0, maximum)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const finite = (value, dimension = false) => typeof value === 'number'
      && Number.isFinite(value) && Math.abs(value) <= ${MAX_ABSOLUTE_NODE_COORDINATE}
      && (!dimension || value >= 0);
    const close = (left, right) => typeof left === 'number' && Number.isFinite(left)
      && Math.abs(left - right) <= ${JAM_STICKY_VERIFY_EPSILON};
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_JAM_STICKY_RESULT_CODE_UNITS}) {
        throw new Error('Jam Sticky result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (error) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Jam Sticky preflight failed.'),
    });
    if (figma.editorType !== 'figjam') return refused('Jam Sticky requires a FigJam board.');
    if (!figma.currentPage || typeof figma.createSticky !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function' || typeof figma.loadFontAsync !== 'function') {
      return refused('Jam Sticky requires the native FigJam API.');
    }
    const context = (page, placement = false) => {
      if (!page || !validId(page.id) || !Array.isArray(page.children)
        || page.children.length > ${MAX_JAM_STICKY_PAGE_CHILDREN}
        || !Array.isArray(page.selection) || page.selection.length > ${MAX_JAM_STICKY_SELECTION}) {
        throw new Error('Jam Sticky requires one bounded current page and selection.');
      }
      const childIds = page.children.map((node) => {
        if (!node || !validId(node.id)
          || (placement && (!finite(node.x) || !finite(node.y) || !finite(node.width, true)))) {
          throw new Error('Jam Sticky found invalid bounded page geometry.');
        }
        return node.id;
      });
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Jam Sticky found an invalid selection.');
        return node.id;
      });
      if (new Set(childIds).size !== childIds.length
        || new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Jam Sticky requires unique page and selection identities.');
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
        throw new Error('Jam Sticky placement exceeded the bounded coordinate limit.');
      }
      if (JSON.stringify({ request, before, origin }).length
        > ${MAX_JAM_STICKY_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Jam Sticky preflight snapshot exceeded its bounded limit.');
      }
    } catch (error) {
      return refused(error);
    }
    const paintMatches = (node) => {
      if (requestedRgb === null) return true;
      return Array.isArray(node.fills) && node.fills.length === 1
        && node.fills[0] && node.fills[0].type === 'SOLID'
        && node.fills[0].color
        && close(node.fills[0].color.r, requestedRgb[0])
        && close(node.fills[0].color.g, requestedRgb[1])
        && close(node.fills[0].color.b, requestedRgb[2]);
    };
    const nodeFact = (node, pageId, index) => {
      if (!node || node.type !== 'STICKY' || !validId(node.id)
        || !node.parent || node.parent.id !== pageId
        || !node.text || typeof node.text.characters !== 'string'
        || node.text.characters.length > ${MAX_JAM_STICKY_TEXT_CODE_UNITS}
        || typeof node.type !== 'string' || node.type.length > ${MAX_TYPE_CODE_UNITS}
        || !finite(node.x) || !finite(node.y)
        || !finite(node.width, true) || !finite(node.height, true)
        || !Number.isSafeInteger(index) || index < 0) {
        throw new Error('Jam Sticky found invalid bounded Sticky facts.');
      }
      return {
        id: node.id, type: 'STICKY', parentId: pageId, index,
        x: node.x, y: node.y, width: node.width, height: node.height,
        text: node.text.characters, color: request.color,
      };
    };
    const exactSuccess = (actual, node, nativeNode) => {
      const expectedChildren = [...before.childIds, node.id];
      return figma.currentPage && figma.currentPage.id === before.pageId
        && same(actual.childIds, expectedChildren)
        && same(actual.selectionIds, [node.id])
        && node.index === before.childIds.length
        && node.text === request.text && node.color === request.color
        && close(node.x, origin.x) && close(node.y, origin.y)
        && paintMatches(nativeNode);
    };

    let sticky = null;
    let failure = '';
    try {
      sticky = figma.createSticky();
      try { await figma.loadFontAsync({ family: 'Inter', style: 'Medium' }); } catch {}
      try {
        const font = sticky.text && sticky.text.fontName;
        if (font && font !== figma.mixed) await figma.loadFontAsync(font);
      } catch {}
      sticky.text.characters = request.text;
      if (requestedRgb !== null) {
        sticky.fills = [{
          type: 'SOLID',
          color: { r: requestedRgb[0], g: requestedRgb[1], b: requestedRgb[2] },
        }];
      }
      sticky.x = origin.x;
      sticky.y = origin.y;
      page.selection = [sticky];
    } catch (error) {
      failure = failureText(error, 'Jam Sticky mutation failed.');
    }
    if (sticky && validId(sticky.id)) {
      try {
        const page = await figma.getNodeByIdAsync(before.pageId);
        const fresh = await figma.getNodeByIdAsync(sticky.id);
        const actual = context(page);
        const index = actual.childIds.indexOf(sticky.id);
        const node = nodeFact(fresh, before.pageId, index);
        if (exactSuccess(actual, node, fresh)) {
          delete globalThis.__invCache;
          return result({
            schemaVersion, status: 'created', outcome: failure ? 'verified-after-error' : 'verified',
            attempted: 1, restored: 0, residueCount: 0, request, origin, before,
            actual: { context: actual, node },
            warnings: failure
              ? ['Figma reported an error, but fresh FigJam readback verified the requested Sticky.']
              : [],
          });
        }
        if (!failure) failure = 'Jam Sticky postcondition was not satisfied.';
      } catch (error) {
        if (!failure) failure = failureText(error, 'Jam Sticky verification failed.');
      }
    } else if (!failure) {
      failure = 'Jam Sticky factory returned no bounded identity.';
    }

    if (!sticky || !validId(sticky.id)) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, residue: [], failure,
      });
    }
    try {
      try { sticky.remove(); } catch {}
      const restoredPage = await figma.getNodeByIdAsync(before.pageId);
      try {
        const selection = [];
        for (const id of before.selectionIds) {
          const node = await figma.getNodeByIdAsync(id);
          if (node) selection.push(node);
        }
        restoredPage.selection = selection;
      } catch {}
      const fresh = await figma.getNodeByIdAsync(sticky.id);
      const restoredContext = context(restoredPage);
      const residue = [];
      if (fresh || restoredContext.childIds.includes(sticky.id)) residue.push('created-node');
      if (!same(restoredContext.childIds, before.childIds)) residue.push('page-membership');
      if (!same(restoredContext.selectionIds, before.selectionIds)) residue.push('selection');
      const restored = residue.length === 0;
      if (restored) delete globalThis.__invCache;
      return result({
        schemaVersion, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue',
        attempted: 1, restored: restored ? 1 : 0, residue, failure,
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, residue: [],
        failure: failureText(error, failure || 'Jam Sticky rollback verification failed.'),
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
function ids(value, maximum) {
  return Array.isArray(value) && value.length <= maximum && value.every(id)
    && new Set(value).size === value.length;
}
function validContext(value) {
  return exact(value, ['pageId', 'childIds', 'selectionIds']) && id(value.pageId)
    && ids(value.childIds, MAX_JAM_STICKY_PAGE_CHILDREN)
    && ids(value.selectionIds, MAX_JAM_STICKY_SELECTION);
}
function validRequest(value, input) {
  return exact(value, ['text', 'color', 'x', 'y'])
    && value.text === input.text && value.color === input.color
    && value.x === input.x && value.y === input.y;
}
function validNode(value, input, before) {
  return exact(value, [
    'id', 'type', 'parentId', 'index', 'x', 'y', 'width', 'height', 'text', 'color',
  ]) && id(value.id) && value.type === 'STICKY' && value.parentId === before.pageId
    && Number.isSafeInteger(value.index) && value.index === before.childIds.length
    && coordinate(value.x) && coordinate(value.y)
    && coordinate(value.width, true) && coordinate(value.height, true)
    && value.text === input.text && value.color === input.color;
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
      > MAX_JAM_STICKY_SNAPSHOT_CODE_UNITS
    || !exact(value.actual, ['context', 'node']) || !validContext(value.actual.context)
    || !validNode(value.actual.node, input, value.before)
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || value.warnings.some((warning) => typeof warning !== 'string'
      || warning.length === 0 || warning.length > MAX_FAILURE_CODE_UNITS)) return false;
  const expectedChildren = [...value.before.childIds, value.actual.node.id];
  return value.actual.context.pageId === value.before.pageId
    && value.actual.context.childIds.length === expectedChildren.length
    && value.actual.context.childIds.every((nodeId, index) => nodeId === expectedChildren[index])
    && value.actual.context.selectionIds.length === 1
    && value.actual.context.selectionIds[0] === value.actual.node.id
    && Math.abs(value.actual.node.x - value.origin.x) <= JAM_STICKY_VERIFY_EPSILON
    && Math.abs(value.actual.node.y - value.origin.y) <= JAM_STICKY_VERIFY_EPSILON
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
function validFailure(value) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || value.attempted !== 1 || ![0, 1].includes(value.restored)
    || !Array.isArray(value.residue) || value.residue.length > 3
    || value.residue.some((item) => !['created-node', 'page-membership', 'selection'].includes(item))
    || new Set(value.residue).size !== value.residue.length
    || typeof value.failure !== 'string' || value.failure.length === 0
    || value.failure.length > MAX_FAILURE_CODE_UNITS) return false;
  if (value.outcome === 'rolled-back') return value.restored === 1 && value.residue.length === 0;
  if (value.outcome === 'partial-residue') return value.restored === 0 && value.residue.length > 0;
  return value.restored === 0;
}
function invalid(message) {
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

export function formatJamStickyResult(result) {
  return `✓ Sticky ${safeText(result.actual.node.id)} at ${Math.round(result.actual.node.x)},${Math.round(result.actual.node.y)}`;
}

export async function executeJamSticky(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Jam Sticky requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(jamStickyCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_JAM_STICKY_RESULT_CODE_UNITS) {
    throw invalid('Jam Sticky returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw invalid('Jam Sticky returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Jam Sticky returned an invalid bounded result.');
    throw mutationError(`Jam Sticky made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw invalid('Jam Sticky returned an invalid bounded result.');
    throw mutationError(`Jam Sticky failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) throw invalid('Jam Sticky returned an invalid bounded result.');
  return {
    stdout: formatJamStickyResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function jamStickyPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Jam Sticky routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-jam-sticky';
}

export function executeJamStickyPlan(plan, adapters = {}) {
  if (jamStickyPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Jam Sticky.');
  }
  return executeJamSticky(parseJamStickyRequest(plan.argv), adapters);
}
