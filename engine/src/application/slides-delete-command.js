// Plan-bound, bounded and irreversible `slides delete` Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { SLIDE_LABEL_KEY } from '../lib/slides-snippets.js';
import {
  parseSlidesDeleteRequest,
  slidesDeleteArgvFromRequest,
} from './slides-delete-request.js';
import { MAX_NODE_REFERENCE_CODE_UNITS, NODE_REFERENCE_PATTERN } from './node-reference.js';

export {
  slidesDeleteArgvFromRequest,
  slidesDeletePlanningArgvFromRequest,
} from './slides-delete-request.js';

const APPLICATION_ID = 'slides.delete';
export const MAX_SLIDES_DELETE_ROWS = 4_096;
export const MAX_SLIDES_DELETE_ROW_ENTRIES = 4_096;
export const MAX_SLIDES_DELETE_GRID_ENTRIES = 4_096;
export const MAX_SLIDES_DELETE_SELECTION = 256;
export const MAX_SLIDES_DELETE_RESULT_CODE_UNITS = 2_000_000;
const MAX_TEXT_CODE_UNITS = 4_096;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseSlidesDeleteRequest(slidesDeleteArgvFromRequest(request));

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function slidesDeleteCode(request) {
  const input = normalized(request);
  const embedded = { reference: { kind: input.reference.kind, value: input.reference.value } };
  return `(async () => {
    const schemaVersion = 1;
    const request = ${jsValue(embedded)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => String(value).slice(0, maximum)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const text = (value, maximum) => typeof value === 'string' && value.length <= maximum;
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const sameRows = (left, right) => left.length === right.length
      && left.every((row, index) => same(row, right[index]));
    const withoutTarget = (rows, targetId) => rows
      .map((row) => row.filter((nodeId) => nodeId !== targetId))
      .filter((row) => row.length > 0);
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SLIDES_DELETE_RESULT_CODE_UNITS}) {
        throw new Error('Slides Delete result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (failure) => bounded({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(failure, ${MAX_FAILURE_CODE_UNITS}),
    });
    if (figma.editorType !== 'slides') return refused('Slides Delete requires a Figma Slides deck.');
    if (!figma.currentPage || typeof figma.getCanvasGrid !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function') {
      return refused('Slides Delete requires the native Slides API.');
    }
    const labelOf = (slide) => {
      if (typeof slide.getPluginData !== 'function') {
        throw new Error('Slides Delete requires durable label facts.');
      }
      const label = slide.getPluginData(${jsValue(SLIDE_LABEL_KEY)}) || '';
      if (!text(label, ${MAX_TEXT_CODE_UNITS})) {
        throw new Error('Slides Delete found an invalid durable label.');
      }
      return label;
    };
    const snapshot = () => {
      const page = figma.currentPage;
      if (!page || !validId(page.id) || !Array.isArray(page.selection)
        || page.selection.length > ${MAX_SLIDES_DELETE_SELECTION}) {
        throw new Error('Slides Delete requires a bounded current Page and selection.');
      }
      const grid = figma.getCanvasGrid();
      if (!Array.isArray(grid) || grid.length > ${MAX_SLIDES_DELETE_ROWS}) {
        throw new Error('Slides Delete requires a bounded native grid.');
      }
      let entries = 0; const ids = new Set(); const nodes = new Map();
      const rows = grid.map((row) => {
        if (!Array.isArray(row) || row.length === 0
          || row.length > ${MAX_SLIDES_DELETE_ROW_ENTRIES}) {
          throw new Error('Slides Delete requires bounded non-empty native grid rows.');
        }
        entries += row.length;
        if (entries > ${MAX_SLIDES_DELETE_GRID_ENTRIES}) {
          throw new Error('Slides Delete native grid entry limit exceeded.');
        }
        return row.map((node) => {
          if (!node || node.type !== 'SLIDE' || !validId(node.id) || ids.has(node.id)
            || !text(node.name, ${MAX_TEXT_CODE_UNITS})) {
            throw new Error('Slides Delete requires unique native Slide identities.');
          }
          ids.add(node.id); nodes.set(node.id, node); return node.id;
        });
      });
      const focus = page.focusedSlide || null;
      if (focus && (focus.type !== 'SLIDE' || !validId(focus.id) || !ids.has(focus.id))) {
        throw new Error('Slides Delete found an invalid focused Slide.');
      }
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Slides Delete found an invalid selection.');
        return node.id;
      });
      if (new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Slides Delete found duplicate selection identities.');
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
    const targetFacts = (slide, rows) => {
      if (!slide || slide.type !== 'SLIDE' || !validId(slide.id)
        || !text(slide.name, ${MAX_TEXT_CODE_UNITS})) {
        throw new Error('Slides Delete found invalid target facts.');
      }
      const coordinate = position(rows, slide.id);
      if (!coordinate) throw new Error('Slides Delete found a target outside the grid.');
      return { id: slide.id, name: slide.name, label: labelOf(slide) || null, ...coordinate };
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
    const contextStable = (before, actual, targetId) =>
      (before.focusedId === targetId || before.focusedId === actual.focusedId)
      && (before.selectionIds.includes(targetId)
        || same(before.selectionIds, actual.selectionIds));
    const desired = (before, actual, targetId) => before.pageId === actual.pageId
      && sameRows(actual.rows, withoutTarget(before.rows, targetId))
      && !actual.targetPresent && !actual.lookupPresent
      && contextStable(before, actual, targetId);
    const unchanged = (before, actual) => before.pageId === actual.pageId
      && sameRows(before.rows, actual.rows) && before.focusedId === actual.focusedId
      && same(before.selectionIds, actual.selectionIds)
      && actual.targetPresent && actual.lookupPresent;
    const residueFor = (before, actual, targetId) => {
      const residue = [];
      if (actual.targetPresent || actual.lookupPresent) residue.push('target');
      const expectedRows = actual.targetPresent ? before.rows : withoutTarget(before.rows, targetId);
      if (!sameRows(actual.rows, expectedRows)) residue.push('grid-membership');
      if (actual.pageId !== before.pageId) residue.push('page');
      if (before.focusedId !== targetId && before.focusedId !== actual.focusedId) residue.push('focus');
      if ((!before.selectionIds.includes(targetId)
          && !same(before.selectionIds, actual.selectionIds))
        || actual.selectionIds.includes(targetId)) residue.push('selection');
      return residue;
    };

    let beforeRefs; let target; let slide;
    try {
      beforeRefs = snapshot(); target = await resolve(beforeRefs);
      slide = targetFacts(target, beforeRefs.value.rows);
      if (typeof target.remove !== 'function') return refused('Slide cannot be removed.');
    } catch (error) {
      return refused(failureText(error, 'Slides Delete preflight failed.'));
    }
    const before = { ...beforeRefs.value, slide };
    let failure = '';
    try { target.remove(); }
    catch (error) { failure = failureText(error, 'Slides Delete failed.'); }
    try {
      await new Promise((resolveTask) => setTimeout(resolveTask, 0));
      const actualRefs = snapshot();
      const lookup = await figma.getNodeByIdAsync(target.id);
      const actual = {
        ...actualRefs.value,
        targetPresent: actualRefs.nodes.has(target.id),
        lookupPresent: lookup !== null,
      };
      if (desired(beforeRefs.value, actual, target.id)) {
        return bounded({
          schemaVersion, status: 'deleted', outcome: failure ? 'verified-after-error' : 'verified',
          attempted: 1, residue: [], request, before, actual,
          warnings: failure ? [
            'Figma reported an error, but fresh Slides readback verified the exact deletion.',
          ] : [],
        });
      }
      const noEffect = unchanged(beforeRefs.value, actual);
      return bounded({
        schemaVersion, status: 'failed', outcome: noEffect ? 'unchanged' : 'partial-residue',
        attempted: 1, request, before, actual,
        residue: noEffect ? ['target'] : residueFor(beforeRefs.value, actual, target.id),
        failure: clean(failure || 'Slides Delete postcondition was not satisfied.',
          ${MAX_FAILURE_CODE_UNITS}),
      });
    } catch (error) {
      return bounded({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        request, before, actual: null, residue: [],
        failure: failureText(error, failure || 'Slides Delete verification became unavailable.'),
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
function id(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}
function rows(value) {
  if (!Array.isArray(value) || value.length > MAX_SLIDES_DELETE_ROWS) return false;
  let total = 0; const ids = new Set();
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0 || row.length > MAX_SLIDES_DELETE_ROW_ENTRIES) return false;
    total += row.length;
    if (total > MAX_SLIDES_DELETE_GRID_ENTRIES) return false;
    for (const nodeId of row) { if (!id(nodeId) || ids.has(nodeId)) return false; ids.add(nodeId); }
  }
  return true;
}
function snapshot(value) {
  if (!exact(value, ['pageId', 'rows', 'focusedId', 'selectionIds'])
    || !id(value.pageId) || !rows(value.rows)
    || (value.focusedId !== null && !id(value.focusedId))
    || !Array.isArray(value.selectionIds) || value.selectionIds.length > MAX_SLIDES_DELETE_SELECTION
    || value.selectionIds.some((nodeId) => !id(nodeId))
    || new Set(value.selectionIds).size !== value.selectionIds.length) return false;
  const gridIds = new Set(value.rows.flat());
  return value.focusedId === null || gridIds.has(value.focusedId);
}
function same(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameRows(left, right) {
  return left.length === right.length && left.every((row, index) => same(row, right[index]));
}
function withoutTarget(value, targetId) {
  return value.map((row) => row.filter((nodeId) => nodeId !== targetId)).filter((row) => row.length > 0);
}
function position(value, targetId) {
  for (let row = 0; row < value.length; row++) {
    const col = value[row].indexOf(targetId); if (col !== -1) return { row, col };
  }
  return null;
}
function validRequest(value, input) {
  return exact(value, ['reference']) && exact(value.reference, ['kind', 'value'])
    && value.reference.kind === input.reference.kind && value.reference.value === input.reference.value;
}
function validBefore(value, input) {
  if (!exact(value, ['pageId', 'rows', 'focusedId', 'selectionIds', 'slide'])
    || !snapshot({ pageId: value.pageId, rows: value.rows,
      focusedId: value.focusedId, selectionIds: value.selectionIds })
    || !exact(value.slide, ['id', 'name', 'label', 'row', 'col'])
    || !id(value.slide.id) || !text(value.slide.name, MAX_TEXT_CODE_UNITS)
    || (value.slide.label !== null && !text(value.slide.label, MAX_TEXT_CODE_UNITS))) return false;
  const coordinate = position(value.rows, value.slide.id);
  return coordinate && coordinate.row === value.slide.row && coordinate.col === value.slide.col
    && (input.reference.kind !== 'node' || input.reference.value === value.slide.id);
}
function validActual(value) {
  return exact(value, ['pageId', 'rows', 'focusedId', 'selectionIds', 'targetPresent', 'lookupPresent'])
    && snapshot({ pageId: value.pageId, rows: value.rows,
      focusedId: value.focusedId, selectionIds: value.selectionIds })
    && typeof value.targetPresent === 'boolean' && typeof value.lookupPresent === 'boolean';
}
function contextStable(before, actual) {
  return (before.focusedId === before.slide.id || before.focusedId === actual.focusedId)
    && (before.selectionIds.includes(before.slide.id)
      || same(before.selectionIds, actual.selectionIds));
}
function desired(before, actual) {
  return before.pageId === actual.pageId
    && sameRows(actual.rows, withoutTarget(before.rows, before.slide.id))
    && !actual.targetPresent && !actual.lookupPresent && contextStable(before, actual);
}
function unchanged(before, actual) {
  return before.pageId === actual.pageId && sameRows(before.rows, actual.rows)
    && before.focusedId === actual.focusedId && same(before.selectionIds, actual.selectionIds)
    && actual.targetPresent && actual.lookupPresent;
}
function expectedResidue(before, actual) {
  const residue = [];
  if (actual.targetPresent || actual.lookupPresent) residue.push('target');
  const expectedRows = actual.targetPresent ? before.rows : withoutTarget(before.rows, before.slide.id);
  if (!sameRows(actual.rows, expectedRows)) residue.push('grid-membership');
  if (actual.pageId !== before.pageId) residue.push('page');
  if (before.focusedId !== before.slide.id && before.focusedId !== actual.focusedId) residue.push('focus');
  if ((!before.selectionIds.includes(before.slide.id)
      && !same(before.selectionIds, actual.selectionIds))
    || actual.selectionIds.includes(before.slide.id)) residue.push('selection');
  return residue;
}
function validSuccess(value, input) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'residue',
    'request', 'before', 'actual', 'warnings'])
    && value.schemaVersion === 1 && value.status === 'deleted'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && value.attempted === 1 && Array.isArray(value.residue) && value.residue.length === 0
    && validRequest(value.request, input) && validBefore(value.before, input)
    && validActual(value.actual) && desired(value.before, value.actual)
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
}
function validFailure(value, input) {
  const allowed = new Set(['target', 'grid-membership', 'page', 'focus', 'selection']);
  if (!exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'request',
    'before', 'actual', 'residue', 'failure'])
    || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || value.attempted !== 1 || !validRequest(value.request, input)
    || !validBefore(value.before, input) || !Array.isArray(value.residue)
    || value.residue.length > allowed.size || value.residue.some((entry) => !allowed.has(entry))
    || new Set(value.residue).size !== value.residue.length
    || !text(value.failure, MAX_FAILURE_CODE_UNITS, false)) return false;
  if (value.outcome === 'verification-unavailable') {
    return value.actual === null && value.residue.length === 0;
  }
  if (!validActual(value.actual)) return false;
  if (value.outcome === 'unchanged') {
    return unchanged(value.before, value.actual)
      && value.residue.length === 1 && value.residue[0] === 'target';
  }
  const expected = expectedResidue(value.before, value.actual);
  return !desired(value.before, value.actual) && !unchanged(value.before, value.actual)
    && expected.length > 0 && same(value.residue, expected);
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
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
export function formatSlidesDeleteResult(result) {
  const slide = result.before.slide;
  const labelled = slide.label ? ` [${safeText(slide.label)}]` : '';
  return `✓ Deleted slide ${safeText(slide.id)}${labelled} (Figma name: ${JSON.stringify(safeText(slide.name))})`;
}
export async function executeSlidesDelete(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Delete requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(slidesDeleteCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SLIDES_DELETE_RESULT_CODE_UNITS) {
    throw pluginResultError('Slides Delete returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Slides Delete returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Slides Delete returned an invalid bounded result.');
    throw mutationError(`Slides Delete made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw pluginResultError('Slides Delete returned an invalid bounded result.');
    const messages = {
      unchanged: 'Slides Delete failed before the requested Slide was removed.',
      'partial-residue': 'Slides Delete has irreversible partial residue.',
      'verification-unavailable': 'Slides Delete was dispatched, but fresh verification is unavailable.',
    };
    throw mutationError(`${messages[payload.outcome]} ${payload.failure}`, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: 1, restored: 0,
      residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length,
    });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Slides Delete returned an invalid bounded result.');
  }
  return {
    stdout: formatSlidesDeleteResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    code: 0,
    result: payload,
  };
}
export function slidesDeletePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Slides Delete routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-slides-delete';
}
export function executeSlidesDeletePlan(plan, adapters = {}) {
  if (slidesDeletePlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Delete.');
  }
  return executeSlidesDelete(parseSlidesDeleteRequest(plan.argv), adapters);
}
