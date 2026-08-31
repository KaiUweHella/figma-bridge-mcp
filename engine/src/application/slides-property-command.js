// Plan-bound, readback-verified and rollback-owned Slide property mutations.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  SLIDE_LABEL_KEY,
  TRANSITION_CURVES,
  TRANSITION_STYLES,
  TRANSITION_TIMINGS,
} from '../lib/slides-snippets.js';
import {
  MAX_SLIDES_TRANSITION_SECONDS,
  parseSlidesPropertyRequest,
  slidesPropertyArgvFromRequest,
} from './slides-property-request.js';
import { MAX_NODE_REFERENCE_CODE_UNITS, NODE_REFERENCE_PATTERN } from './node-reference.js';

export {
  parseSlidesPropertyRequest,
  slidesPropertyArgvFromRequest,
  slidesPropertyPlanningArgvFromRequest,
} from './slides-property-request.js';

const APPLICATION_IDS = new Set(['slides.transition', 'slides.skip']);
export const MAX_SLIDES_PROPERTY_ROWS = 4_096;
export const MAX_SLIDES_PROPERTY_ROW_ENTRIES = 4_096;
export const MAX_SLIDES_PROPERTY_GRID_ENTRIES = 4_096;
export const MAX_SLIDES_PROPERTY_SELECTION = 256;
export const MAX_SLIDES_PROPERTY_CHILDREN = 50_000;
export const MAX_SLIDES_PROPERTY_RESULT_CODE_UNITS = 6_000_000;
const MAX_TEXT_CODE_UNITS = 4_096;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseSlidesPropertyRequest(slidesPropertyArgvFromRequest(request));

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function slidesPropertyCode(request) {
  const input = normalized(request);
  const embedded = input.action === 'transition'
    ? { action: input.action, reference: { kind: input.reference.kind, value: input.reference.value },
      transition: input.transition }
    : { action: input.action, reference: { kind: input.reference.kind, value: input.reference.value },
      skipped: input.skipped };
  return `(async () => {
    const schemaVersion = 1;
    const request = ${jsValue(embedded)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const transitionStyles = new Set(${jsValue(TRANSITION_STYLES)});
    const transitionCurves = new Set(${jsValue(TRANSITION_CURVES)});
    const transitionTimings = new Set(${jsValue(TRANSITION_TIMINGS)});
    const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
    const clean = (value, maximum) => String(value).slice(0, maximum)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const text = (value, maximum, empty = true) => typeof value === 'string'
      && value.length <= maximum && (empty || value.length > 0);
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const sameRows = (left, right) => left.length === right.length
      && left.every((row, index) => same(row, right[index]));
    const sameTransition = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const rounded = (value) => Math.round(value * 10000) / 10000;
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SLIDES_PROPERTY_RESULT_CODE_UNITS}) {
        throw new Error('Slides Property result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (failure) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(failure, ${MAX_FAILURE_CODE_UNITS}),
    });
    if (figma.editorType !== 'slides') {
      return refused('Slides Property mutation requires a Figma Slides deck.');
    }
    if (!figma.currentPage || typeof figma.getCanvasGrid !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function') {
      return refused('Slides Property mutation requires the native Slides API.');
    }
    const transitionOf = (slide) => {
      if (typeof slide.getSlideTransition !== 'function') {
        throw new Error('Slides Property mutation requires native transition facts.');
      }
      const value = slide.getSlideTransition();
      if (!exact(value, ['style', 'duration', 'curve', 'timing'])
        || !transitionStyles.has(value.style) || !transitionCurves.has(value.curve)
        || typeof value.duration !== 'number' || !Number.isFinite(value.duration)
        || value.duration < 0 || value.duration > ${MAX_SLIDES_TRANSITION_SECONDS}
        || !value.timing || !transitionTimings.has(value.timing.type)) {
        throw new Error('Slides Property mutation found invalid transition facts.');
      }
      const timingKeys = value.timing.type === 'AFTER_DELAY' ? ['type', 'delay'] : ['type'];
      if (!exact(value.timing, timingKeys)
        || (value.timing.type === 'AFTER_DELAY'
          && (typeof value.timing.delay !== 'number' || !Number.isFinite(value.timing.delay)
            || value.timing.delay < 0 || value.timing.delay > ${MAX_SLIDES_TRANSITION_SECONDS}))) {
        throw new Error('Slides Property mutation found invalid transition timing.');
      }
      return {
        style: value.style, duration: rounded(value.duration), curve: value.curve,
        timing: value.timing.type === 'AFTER_DELAY'
          ? { type: value.timing.type, delay: rounded(value.timing.delay) }
          : { type: value.timing.type },
      };
    };
    const labelOf = (slide) => {
      if (typeof slide.getPluginData !== 'function') {
        throw new Error('Slides Property mutation requires durable label facts.');
      }
      const label = slide.getPluginData(${jsValue(SLIDE_LABEL_KEY)}) || '';
      if (!text(label, ${MAX_TEXT_CODE_UNITS})) {
        throw new Error('Slides Property mutation found an invalid durable label.');
      }
      return label;
    };
    const snapshot = () => {
      const page = figma.currentPage;
      if (!page || !validId(page.id) || !Array.isArray(page.selection)
        || page.selection.length > ${MAX_SLIDES_PROPERTY_SELECTION}) {
        throw new Error('Slides Property mutation requires a bounded current Page and selection.');
      }
      const grid = figma.getCanvasGrid();
      if (!Array.isArray(grid) || grid.length > ${MAX_SLIDES_PROPERTY_ROWS}) {
        throw new Error('Slides Property mutation requires a bounded native grid.');
      }
      let entries = 0; const ids = new Set(); const nodes = new Map();
      const rows = grid.map((row) => {
        if (!Array.isArray(row) || row.length > ${MAX_SLIDES_PROPERTY_ROW_ENTRIES}) {
          throw new Error('Slides Property mutation requires bounded native grid rows.');
        }
        entries += row.length;
        if (entries > ${MAX_SLIDES_PROPERTY_GRID_ENTRIES}) {
          throw new Error('Slides Property mutation native grid entry limit exceeded.');
        }
        return row.map((node) => {
          if (!node || node.type !== 'SLIDE' || !validId(node.id) || ids.has(node.id)
            || !text(node.name, ${MAX_TEXT_CODE_UNITS})) {
            throw new Error('Slides Property mutation requires unique native Slide identities.');
          }
          ids.add(node.id); nodes.set(node.id, node); return node.id;
        });
      });
      const focus = page.focusedSlide || null;
      if (focus && (focus.type !== 'SLIDE' || !validId(focus.id) || !ids.has(focus.id))) {
        throw new Error('Slides Property mutation found an invalid focused Slide.');
      }
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) {
          throw new Error('Slides Property mutation found an invalid selection.');
        }
        return node.id;
      });
      if (new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Slides Property mutation found duplicate selection identities.');
      }
      return {
        nodes, value: { pageId: page.id, rows, focusedId: focus ? focus.id : null, selectionIds },
      };
    };
    const position = (rows, nodeId) => {
      for (let row = 0; row < rows.length; row++) {
        const col = rows[row].indexOf(nodeId);
        if (col !== -1) return { row, col };
      }
      return null;
    };
    const facts = (slide, rows) => {
      if (!slide || slide.type !== 'SLIDE' || !validId(slide.id)
        || !text(slide.name, ${MAX_TEXT_CODE_UNITS}) || !Array.isArray(slide.children)
        || slide.children.length > ${MAX_SLIDES_PROPERTY_CHILDREN}
        || typeof slide.isSkippedSlide !== 'boolean') {
        throw new Error('Slides Property mutation found invalid Slide facts.');
      }
      const coordinate = position(rows, slide.id);
      if (!coordinate) throw new Error('Slides Property mutation found a Slide outside the grid.');
      return {
        id: slide.id, name: slide.name, label: labelOf(slide) || null,
        row: coordinate.row, col: coordinate.col, skipped: slide.isSkippedSlide,
        transition: transitionOf(slide), childCount: slide.children.length,
      };
    };
    const resolve = async (state) => {
      let target = null;
      if (request.reference.kind === 'node' || request.reference.kind === 'query') {
        const byId = await figma.getNodeByIdAsync(request.reference.value);
        if (byId && byId.type === 'SLIDE' && state.nodes.has(byId.id)) {
          target = state.nodes.get(byId.id);
        } else if (request.reference.kind === 'node') {
          throw new Error('Slide reference did not resolve to a Slide in the current grid.');
        }
      }
      const slides = [...state.nodes.values()];
      if (!target) {
        let matches = request.reference.kind === 'name'
          ? slides.filter((slide) => slide.name === request.reference.value)
          : request.reference.kind === 'label'
            ? slides.filter((slide) => labelOf(slide) === request.reference.value)
            : slides.filter((slide) => slide.name === request.reference.value
              || labelOf(slide) === request.reference.value);
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) throw new Error('Slide reference is ambiguous.');
        if (!target && request.reference.kind === 'query') {
          const lower = request.reference.value.toLowerCase();
          matches = slides.filter((slide) => slide.name.toLowerCase().includes(lower)
            || labelOf(slide).toLowerCase().includes(lower));
          if (matches.length === 1) target = matches[0];
          else if (matches.length > 1) throw new Error('Slide reference is ambiguous.');
        }
      }
      if (!target) throw new Error('Slide reference was not found.');
      return target;
    };
    const unchangedFacts = (before, actual) => before.id === actual.id
      && before.name === actual.name && before.label === actual.label
      && before.row === actual.row && before.col === actual.col
      && before.childCount === actual.childCount;
    const desired = (before, actual) => unchangedFacts(before, actual)
      && (request.action === 'transition'
        ? actual.skipped === before.skipped && sameTransition(actual.transition, request.transition)
        : actual.skipped === request.skipped && sameTransition(actual.transition, before.transition));
    const exactSuccess = (before, actual, beforeSlide, slide) =>
      actual.pageId === before.pageId && sameRows(actual.rows, before.rows)
      && actual.focusedId === before.focusedId && same(actual.selectionIds, before.selectionIds)
      && desired(beforeSlide, slide);

    let beforeRefs; let target; let beforeSlide;
    try {
      beforeRefs = snapshot(); target = await resolve(beforeRefs);
      beforeSlide = facts(target, beforeRefs.value.rows);
      if (request.action === 'transition' && typeof target.setSlideTransition !== 'function') {
        return refused('Slides Transition requires the native transition setter.');
      }
    } catch (error) {
      return refused(failureText(error, 'Slides Property mutation preflight failed.'));
    }
    let failure = '';
    try {
      if (request.action === 'transition') target.setSlideTransition(request.transition);
      else target.isSkippedSlide = request.skipped;
    } catch (error) {
      failure = failureText(error, 'Slides Property mutation failed.');
    }
    try {
      const actualRefs = snapshot();
      const actualTarget = actualRefs.nodes.get(target.id) || null;
      const slide = actualTarget ? facts(actualTarget, actualRefs.value.rows) : null;
      if (slide && exactSuccess(beforeRefs.value, actualRefs.value, beforeSlide, slide)) {
        return result({
          schemaVersion, status: 'updated', outcome: failure ? 'verified-after-error' : 'verified',
          attempted: 1, restored: 0, residue: [], request,
          before: { ...beforeRefs.value, slide: beforeSlide },
          actual: { ...actualRefs.value, slide },
          warnings: failure ? [
            'Figma reported an error, but fresh Slides readback verified the requested property.',
          ] : [],
        });
      }
      if (!failure) failure = 'Slides Property mutation postcondition was not satisfied.';
    } catch (error) {
      if (!failure) failure = failureText(error, 'Slides Property mutation verification failed.');
    }
    try {
      try {
        if (request.action === 'transition') target.setSlideTransition(beforeSlide.transition);
        else target.isSkippedSlide = beforeSlide.skipped;
      } catch {}
      const restoredRefs = snapshot();
      const restoredTarget = restoredRefs.nodes.get(target.id) || null;
      const restoredSlide = restoredTarget ? facts(restoredTarget, restoredRefs.value.rows) : null;
      const residue = [];
      if (!sameRows(restoredRefs.value.rows, beforeRefs.value.rows)) residue.push('grid-membership');
      if (!restoredSlide || !unchangedFacts(beforeSlide, restoredSlide)
        || restoredSlide.skipped !== beforeSlide.skipped
        || !sameTransition(restoredSlide.transition, beforeSlide.transition)) residue.push('slide-property');
      if (restoredRefs.value.pageId !== beforeRefs.value.pageId) residue.push('page');
      if (restoredRefs.value.focusedId !== beforeRefs.value.focusedId) residue.push('focus');
      if (!same(restoredRefs.value.selectionIds, beforeRefs.value.selectionIds)) residue.push('selection');
      const rolledBack = residue.length === 0;
      return result({
        schemaVersion, status: 'failed', outcome: rolledBack ? 'rolled-back' : 'partial-residue',
        attempted: 1, restored: rolledBack ? 1 : 0, residue,
        failure: clean(failure || 'Slides Property mutation failed.', ${MAX_FAILURE_CODE_UNITS}),
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable',
        attempted: 1, restored: 0, residue: [],
        failure: failureText(error,
          failure || 'Slides Property mutation verification became unavailable.'),
      });
    }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}
function id(value) { return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value); }
function count(value, maximum) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function rows(value) {
  if (!Array.isArray(value) || value.length > MAX_SLIDES_PROPERTY_ROWS) return false;
  let total = 0; const ids = new Set();
  for (const row of value) {
    if (!Array.isArray(row) || row.length > MAX_SLIDES_PROPERTY_ROW_ENTRIES) return false;
    total += row.length;
    if (total > MAX_SLIDES_PROPERTY_GRID_ENTRIES) return false;
    for (const nodeId of row) { if (!id(nodeId) || ids.has(nodeId)) return false; ids.add(nodeId); }
  }
  return true;
}
function snapshot(value) {
  if (!exact(value, ['pageId', 'rows', 'focusedId', 'selectionIds'])
    || !id(value.pageId) || !rows(value.rows)
    || (value.focusedId !== null && !id(value.focusedId))
    || !Array.isArray(value.selectionIds) || value.selectionIds.length > MAX_SLIDES_PROPERTY_SELECTION
    || value.selectionIds.some((nodeId) => !id(nodeId))
    || new Set(value.selectionIds).size !== value.selectionIds.length) return false;
  const gridIds = new Set(value.rows.flat());
  return value.focusedId === null || gridIds.has(value.focusedId);
}
function transition(value) {
  if (!exact(value, ['style', 'duration', 'curve', 'timing'])
    || !TRANSITION_STYLES.includes(value.style) || !TRANSITION_CURVES.includes(value.curve)
    || typeof value.duration !== 'number' || !Number.isFinite(value.duration)
    || value.duration < 0 || value.duration > MAX_SLIDES_TRANSITION_SECONDS
    || !record(value.timing) || !TRANSITION_TIMINGS.includes(value.timing.type)) return false;
  const keys = value.timing.type === 'AFTER_DELAY' ? ['type', 'delay'] : ['type'];
  return exact(value.timing, keys) && (value.timing.type !== 'AFTER_DELAY'
    || (typeof value.timing.delay === 'number' && Number.isFinite(value.timing.delay)
      && value.timing.delay >= 0 && value.timing.delay <= MAX_SLIDES_TRANSITION_SECONDS));
}
function slideFact(value) {
  return exact(value, ['id', 'name', 'label', 'row', 'col', 'skipped', 'transition', 'childCount'])
    && id(value.id) && text(value.name, MAX_TEXT_CODE_UNITS)
    && (value.label === null || text(value.label, MAX_TEXT_CODE_UNITS))
    && count(value.row, MAX_SLIDES_PROPERTY_ROWS - 1)
    && count(value.col, MAX_SLIDES_PROPERTY_ROW_ENTRIES - 1)
    && typeof value.skipped === 'boolean' && transition(value.transition)
    && count(value.childCount, MAX_SLIDES_PROPERTY_CHILDREN);
}
function same(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameRows(left, right) { return left.length === right.length && left.every((row, index) => same(row, right[index])); }
function position(rowsValue, nodeId) {
  for (let row = 0; row < rowsValue.length; row++) {
    const col = rowsValue[row].indexOf(nodeId); if (col !== -1) return { row, col };
  }
  return null;
}
function sameTransition(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function validRequest(value, input) {
  const base = record(value) && exact(value.reference, ['kind', 'value'])
    && value.reference.kind === input.reference.kind && value.reference.value === input.reference.value;
  if (input.action === 'transition') {
    return base && exact(value, ['action', 'reference', 'transition'])
      && value.action === input.action && transition(value.transition)
      && sameTransition(value.transition, input.transition);
  }
  return base && exact(value, ['action', 'reference', 'skipped'])
    && value.action === input.action && value.skipped === input.skipped;
}
function unchanged(before, actual) {
  return before.id === actual.id && before.name === actual.name && before.label === actual.label
    && before.row === actual.row && before.col === actual.col && before.childCount === actual.childCount;
}
function matchesSuccess(before, actual, input) {
  const beforeCoordinate = position(before.rows, before.slide.id);
  const actualCoordinate = position(actual.rows, actual.slide.id);
  if (!beforeCoordinate || !actualCoordinate
    || beforeCoordinate.row !== before.slide.row || beforeCoordinate.col !== before.slide.col
    || actualCoordinate.row !== actual.slide.row || actualCoordinate.col !== actual.slide.col
    || before.pageId !== actual.pageId || !sameRows(before.rows, actual.rows)
    || before.focusedId !== actual.focusedId || !same(before.selectionIds, actual.selectionIds)
    || !unchanged(before.slide, actual.slide)) return false;
  return input.action === 'transition'
    ? before.slide.skipped === actual.slide.skipped
      && sameTransition(actual.slide.transition, input.transition)
    : actual.slide.skipped === input.skipped
      && sameTransition(before.slide.transition, actual.slide.transition);
}
function validSuccess(value, input) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue',
    'request', 'before', 'actual', 'warnings'])
    && value.schemaVersion === 1 && value.status === 'updated'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && value.attempted === 1 && value.restored === 0
    && Array.isArray(value.residue) && value.residue.length === 0
    && validRequest(value.request, input)
    && exact(value.before, ['pageId', 'rows', 'focusedId', 'selectionIds', 'slide'])
    && snapshot({ pageId: value.before.pageId, rows: value.before.rows,
      focusedId: value.before.focusedId, selectionIds: value.before.selectionIds })
    && slideFact(value.before.slide)
    && exact(value.actual, ['pageId', 'rows', 'focusedId', 'selectionIds', 'slide'])
    && snapshot({ pageId: value.actual.pageId, rows: value.actual.rows,
      focusedId: value.actual.focusedId, selectionIds: value.actual.selectionIds })
    && slideFact(value.actual.slide) && matchesSuccess(value.before, value.actual, input)
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}
function validFailure(value) {
  const allowed = new Set(['grid-membership', 'slide-property', 'page', 'focus', 'selection']);
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= allowed.size
    && value.residue.every((entry) => allowed.has(entry)) && new Set(value.residue).size === value.residue.length
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false)
    && (value.outcome !== 'rolled-back' || value.restored === 1 && value.residue.length === 0)
    && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0)
    && (value.outcome !== 'verification-unavailable' || value.restored === 0 && value.residue.length === 0);
}
function pluginResultError(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
  return error;
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report });
  return error;
}
function safeText(value) { return String(value).replace(UNSAFE_TEXT_CONTROLS, ' '); }
export function formatSlidesPropertyResult(result) {
  const slide = result.actual.slide;
  return result.request.action === 'transition'
    ? `✓ Slide ${safeText(slide.id)} transition: ${safeText(slide.transition.style)}`
    : `✓ Slide ${safeText(slide.id)} is ${slide.skipped ? 'skipped' : 'included'}`;
}
export async function executeSlidesProperty(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Property mutation requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(slidesPropertyCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SLIDES_PROPERTY_RESULT_CODE_UNITS) {
    throw pluginResultError('Slides Property mutation returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Slides Property mutation returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Slides Property mutation returned an invalid bounded result.');
    throw mutationError(`Slides Property mutation made no mutation: ${payload.failure}`, 'no-mutation',
      { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw pluginResultError('Slides Property mutation returned an invalid bounded result.');
    throw mutationError(`Slides Property mutation failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residue.length });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Slides Property mutation returned an invalid bounded result.');
  }
  return { stdout: formatSlidesPropertyResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'), code: 0, result: payload };
}
export function slidesPropertyPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Slides Property routing requires a Command Plan.');
  return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-slides-property';
}
export function executeSlidesPropertyPlan(plan, adapters = {}) {
  if (slidesPropertyPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Property mutation.');
  }
  return executeSlidesProperty(parseSlidesPropertyRequest(plan.argv), adapters);
}
