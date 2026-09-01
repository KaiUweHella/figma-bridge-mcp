// Plan-bound, freshly verified and rollback-owned `jam stickies` batch creation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  MAX_JAM_STICKIES_ITEMS,
  MAX_JAM_STICKIES_TEXT_CODE_UNITS,
  jamStickiesArgvFromRequest,
  parseJamStickiesRequest,
} from './jam-stickies-request.js';

export { jamStickiesArgvFromRequest } from './jam-stickies-request.js';

const APPLICATION_ID = 'jam.stickies';
export const JAM_STICKIES_GAP = 24;
export const JAM_STICKIES_VERIFY_EPSILON = 0.01;
export const MAX_JAM_STICKIES_PAGE_CHILDREN = 20_000;
export const MAX_JAM_STICKIES_SELECTION = 4_096;
export const MAX_JAM_STICKIES_SNAPSHOT_CODE_UNITS = 700_000;
export const MAX_JAM_STICKIES_RESULT_CODE_UNITS = 2_000_000;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseJamStickiesRequest(jamStickiesArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function jamStickiesCode(request) {
  const input = normalized(request);
  const requestedRgb = input.items.map((item) => item.color === null ? null
    : [0, 2, 4].map((start) => parseInt(item.color.slice(1).slice(start, start + 2), 16) / 255));
  return `(async () => {
    const schemaVersion = 1;
    const request = ${js(input)};
    const requestedRgb = ${js(requestedRgb)};
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
      && Math.abs(left - right) <= ${JAM_STICKIES_VERIFY_EPSILON};
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_JAM_STICKIES_RESULT_CODE_UNITS}) {
        throw new Error('Jam Stickies result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (error) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Jam Stickies preflight failed.'),
    });
    if (figma.editorType !== 'figjam') return refused('Jam Stickies requires a FigJam board.');
    if (!figma.currentPage || typeof figma.createSticky !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function' || typeof figma.loadFontAsync !== 'function') {
      return refused('Jam Stickies requires the native FigJam API.');
    }
    const context = (page, placement = false) => {
      if (!page || !validId(page.id) || !Array.isArray(page.children)
        || page.children.length > ${MAX_JAM_STICKIES_PAGE_CHILDREN}
        || !Array.isArray(page.selection) || page.selection.length > ${MAX_JAM_STICKIES_SELECTION}) {
        throw new Error('Jam Stickies requires one bounded current page and selection.');
      }
      const childIds = page.children.map((node) => {
        if (!node || !validId(node.id)
          || (placement && (!finite(node.x) || !finite(node.y) || !finite(node.width, true)))) {
          throw new Error('Jam Stickies found invalid bounded page geometry.');
        }
        return node.id;
      });
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Jam Stickies found an invalid selection.');
        return node.id;
      });
      if (new Set(childIds).size !== childIds.length
        || new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Jam Stickies requires unique page and selection identities.');
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
        throw new Error('Jam Stickies placement exceeded the bounded coordinate limit.');
      }
      if (JSON.stringify({ request, before, origin }).length
        > ${MAX_JAM_STICKIES_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Jam Stickies preflight snapshot exceeded its bounded limit.');
      }
    } catch (error) {
      return refused(error);
    }
    const paintMatches = (node, index) => {
      const rgb = requestedRgb[index];
      if (rgb === null) return true;
      return Array.isArray(node.fills) && node.fills.length === 1
        && node.fills[0] && node.fills[0].type === 'SOLID' && node.fills[0].color
        && close(node.fills[0].color.r, rgb[0])
        && close(node.fills[0].color.g, rgb[1])
        && close(node.fills[0].color.b, rgb[2]);
    };
    const nodeFact = (node, pageId, index, itemIndex) => {
      if (!node || node.type !== 'STICKY' || !validId(node.id)
        || !node.parent || node.parent.id !== pageId
        || !node.text || typeof node.text.characters !== 'string'
        || node.text.characters.length > ${MAX_JAM_STICKIES_TEXT_CODE_UNITS}
        || !finite(node.x) || !finite(node.y)
        || !finite(node.width, true) || !finite(node.height, true)
        || !Number.isSafeInteger(index) || index < 0) {
        throw new Error('Jam Stickies found invalid bounded Sticky facts.');
      }
      return {
        id: node.id, type: 'STICKY', parentId: pageId, index,
        x: node.x, y: node.y, width: node.width, height: node.height,
        text: node.text.characters, color: request.items[itemIndex].color,
      };
    };
    const exactSuccess = (actual, nodes, nativeNodes) => {
      const ids = nodes.map((node) => node.id);
      const expectedChildren = [...before.childIds, ...ids];
      return figma.currentPage && figma.currentPage.id === before.pageId
        && same(actual.childIds, expectedChildren) && same(actual.selectionIds, ids)
        && nodes.every((node, index) => {
          const item = request.items[index];
          const expectedX = origin.x + (index % request.columns) * (node.width + ${JAM_STICKIES_GAP});
          const expectedY = origin.y + Math.floor(index / request.columns)
            * (node.height + ${JAM_STICKIES_GAP});
          return node.index === before.childIds.length + index
            && node.text === item.text && node.color === item.color
            && close(node.x, expectedX) && close(node.y, expectedY)
            && paintMatches(nativeNodes[index], index);
        });
    };

    const made = [];
    let attempted = 0;
    let unattributed = false;
    let failure = '';
    try {
      for (let index = 0; index < request.items.length; index++) {
        attempted += 1;
        let sticky;
        try { sticky = figma.createSticky(); }
        catch (error) { unattributed = true; throw error; }
        made.push(sticky);
        if (!sticky || !validId(sticky.id)) {
          unattributed = true;
          throw new Error('Jam Stickies factory returned no bounded identity.');
        }
        if (index === 0) {
          try { await figma.loadFontAsync({ family: 'Inter', style: 'Medium' }); } catch {}
          try {
            const font = sticky.text && sticky.text.fontName;
            if (font && font !== figma.mixed) await figma.loadFontAsync(font);
          } catch {}
        }
        if (!figma.currentPage || figma.currentPage.id !== before.pageId) {
          throw new Error('Jam Stickies current page changed during creation.');
        }
        sticky.text.characters = request.items[index].text;
        const rgb = requestedRgb[index];
        if (rgb !== null) {
          sticky.fills = [{ type: 'SOLID', color: { r: rgb[0], g: rgb[1], b: rgb[2] } }];
        }
        if (!finite(sticky.width, true) || !finite(sticky.height, true)) {
          throw new Error('Jam Stickies factory returned invalid bounded dimensions.');
        }
        sticky.x = origin.x + (index % request.columns) * (sticky.width + ${JAM_STICKIES_GAP});
        sticky.y = origin.y + Math.floor(index / request.columns)
          * (sticky.height + ${JAM_STICKIES_GAP});
        if (!finite(sticky.x) || !finite(sticky.y)) {
          throw new Error('Jam Stickies grid exceeded the bounded coordinate limit.');
        }
      }
      page.selection = made;
    } catch (error) {
      failure = failureText(error, 'Jam Stickies mutation failed.');
    }
    if (!unattributed && made.length === request.items.length
      && new Set(made.map((node) => node.id)).size === made.length) {
      try {
        const freshPage = await figma.getNodeByIdAsync(before.pageId);
        const actual = context(freshPage);
        const nativeNodes = [];
        const nodes = [];
        for (let index = 0; index < made.length; index++) {
          const fresh = await figma.getNodeByIdAsync(made[index].id);
          nativeNodes.push(fresh);
          nodes.push(nodeFact(fresh, before.pageId,
            actual.childIds.indexOf(made[index].id), index));
        }
        if (exactSuccess(actual, nodes, nativeNodes)) {
          delete globalThis.__invCache;
          return result({
            schemaVersion, status: 'created', outcome: failure ? 'verified-after-error' : 'verified',
            attempted, restored: 0, residueCount: 0, request, origin, before,
            actual: { context: actual, nodes },
            warnings: failure
              ? ['Figma reported an error, but fresh FigJam readback verified every requested Sticky.']
              : [],
          });
        }
        if (!failure) failure = 'Jam Stickies postcondition was not satisfied.';
      } catch (error) {
        if (!failure) failure = failureText(error, 'Jam Stickies verification failed.');
      }
    } else if (!failure) {
      failure = 'Jam Stickies could not attribute every factory result.';
    }

    try {
      for (let index = made.length - 1; index >= 0; index--) {
        try { if (made[index] && typeof made[index].remove === 'function') made[index].remove(); } catch {}
      }
      const restoredPage = await figma.getNodeByIdAsync(before.pageId);
      try {
        const selection = [];
        for (const id of before.selectionIds) {
          const node = await figma.getNodeByIdAsync(id);
          if (node) selection.push(node);
        }
        restoredPage.selection = selection;
      } catch {}
      const restoredContext = context(restoredPage);
      let lingering = 0;
      for (const node of made) {
        if (!node || !validId(node.id)) continue;
        const fresh = await figma.getNodeByIdAsync(node.id);
        if (fresh || restoredContext.childIds.includes(node.id)) lingering += 1;
      }
      let residueCount = lingering;
      if (!same(restoredContext.childIds, before.childIds)) residueCount += 1;
      if (!same(restoredContext.selectionIds, before.selectionIds)) residueCount += 1;
      const restored = Math.max(0, made.filter((node) => node && validId(node.id)).length - lingering);
      if (residueCount === 0 && !unattributed) delete globalThis.__invCache;
      const outcome = unattributed ? 'verification-unavailable'
        : residueCount === 0 ? 'rolled-back' : 'partial-residue';
      return result({
        schemaVersion, status: 'failed', outcome, attempted,
        restored: outcome === 'verification-unavailable' ? 0 : restored,
        residueCount, failure,
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted,
        restored: 0, residueCount: 0,
        failure: failureText(error, failure || 'Jam Stickies rollback verification failed.'),
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
    && ids(value.childIds, MAX_JAM_STICKIES_PAGE_CHILDREN)
    && ids(value.selectionIds, MAX_JAM_STICKIES_SELECTION);
}
function validRequest(value, input) {
  return exact(value, ['items', 'columns', 'x', 'y'])
    && JSON.stringify(value) === JSON.stringify(input);
}
function validNode(value, item, before, index) {
  return exact(value, [
    'id', 'type', 'parentId', 'index', 'x', 'y', 'width', 'height', 'text', 'color',
  ]) && id(value.id) && value.type === 'STICKY' && value.parentId === before.pageId
    && value.index === before.childIds.length + index
    && coordinate(value.x) && coordinate(value.y)
    && coordinate(value.width, true) && coordinate(value.height, true)
    && value.text === item.text && value.color === item.color;
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
    || value.attempted !== input.items.length || value.restored !== 0 || value.residueCount !== 0
    || !validRequest(value.request, input)
    || !exact(value.origin, ['x', 'y']) || !coordinate(value.origin.x) || !coordinate(value.origin.y)
    || (input.x !== null && (value.origin.x !== input.x || value.origin.y !== input.y))
    || !validContext(value.before)
    || JSON.stringify({ request: value.request, before: value.before, origin: value.origin }).length
      > MAX_JAM_STICKIES_SNAPSHOT_CODE_UNITS
    || !exact(value.actual, ['context', 'nodes']) || !validContext(value.actual.context)
    || !Array.isArray(value.actual.nodes) || value.actual.nodes.length !== input.items.length
    || value.actual.nodes.some((node, index) => !validNode(node, input.items[index], value.before, index))
    || new Set(value.actual.nodes.map((node) => node.id)).size !== value.actual.nodes.length
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || value.warnings.some((warning) => typeof warning !== 'string'
      || warning.length === 0 || warning.length > MAX_FAILURE_CODE_UNITS)) return false;
  const nodeIds = value.actual.nodes.map((node) => node.id);
  const expectedChildren = [...value.before.childIds, ...nodeIds];
  return value.actual.context.pageId === value.before.pageId
    && sameIds(value.actual.context.childIds, expectedChildren)
    && sameIds(value.actual.context.selectionIds, nodeIds)
    && value.actual.nodes.every((node, index) => {
      const expectedX = value.origin.x + (index % input.columns) * (node.width + JAM_STICKIES_GAP);
      const expectedY = value.origin.y + Math.floor(index / input.columns)
        * (node.height + JAM_STICKIES_GAP);
      return Math.abs(node.x - expectedX) <= JAM_STICKIES_VERIFY_EPSILON
        && Math.abs(node.y - expectedY) <= JAM_STICKIES_VERIFY_EPSILON;
    })
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function boundedCount(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function validFailure(value, input) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !boundedCount(value.attempted, input.items.length)
    || !boundedCount(value.restored, input.items.length)
    || !boundedCount(value.residueCount, input.items.length + 2)
    || value.restored > value.attempted
    || typeof value.failure !== 'string' || value.failure.length === 0
    || value.failure.length > MAX_FAILURE_CODE_UNITS) return false;
  if (value.outcome === 'rolled-back') {
    return value.attempted > 0 && value.restored === value.attempted && value.residueCount === 0;
  }
  if (value.outcome === 'partial-residue') return value.residueCount > 0;
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

export function formatJamStickiesResult(result) {
  return `✓ ${safeText(result.actual.nodes.length)} stickies added`;
}

export async function executeJamStickies(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Jam Stickies requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(jamStickiesCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_JAM_STICKIES_RESULT_CODE_UNITS) {
    throw invalid('Jam Stickies returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw invalid('Jam Stickies returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Jam Stickies returned an invalid bounded result.');
    throw mutationError(`Jam Stickies made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw invalid('Jam Stickies returned an invalid bounded result.');
    throw mutationError(`Jam Stickies failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: payload.attempted,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) throw invalid('Jam Stickies returned an invalid bounded result.');
  return {
    stdout: formatJamStickiesResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function jamStickiesPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Jam Stickies routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-jam-stickies';
}

export function executeJamStickiesPlan(plan, adapters = {}) {
  if (jamStickiesPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Jam Stickies.');
  }
  return executeJamStickies(parseJamStickiesRequest(plan.argv), adapters);
}
