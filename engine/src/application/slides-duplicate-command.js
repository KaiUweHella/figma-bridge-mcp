// Plan-bound, freshly verified and rollback-owned `slides duplicate` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  SLIDE_LABEL_KEY,
  TRANSITION_CURVES,
  TRANSITION_STYLES,
  TRANSITION_TIMINGS,
  slidePageSlidesFragment,
} from '../lib/slides-snippets.js';
import {
  MAX_SLIDES_DUPLICATE_INDEX,
  MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS,
  parseSlidesDuplicateRequest,
  slidesDuplicateArgvFromRequest,
} from './slides-duplicate-request.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';

export {
  slidesDuplicateArgvFromRequest,
  slidesDuplicatePlanningArgvFromRequest,
} from './slides-duplicate-request.js';

const APPLICATION_ID = 'slides.duplicate';
export const MAX_SLIDES_DUPLICATE_ROWS = 4_096;
export const MAX_SLIDES_DUPLICATE_ROW_ENTRIES = 4_096;
export const MAX_SLIDES_DUPLICATE_GRID_ENTRIES = 4_096;
export const MAX_SLIDES_DUPLICATE_SELECTION = 256;
export const MAX_SLIDES_DUPLICATE_CHILDREN = 50_000;
export const MAX_SLIDES_DUPLICATE_RESULT_CODE_UNITS = 6_000_000;
const MAX_TRANSITION_SECONDS = 86_400;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseSlidesDuplicateRequest(
  slidesDuplicateArgvFromRequest(request),
);

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function slidesDuplicateCode(request) {
  const input = normalized(request);
  const embedded = {
    reference: { kind: input.reference.kind, value: input.reference.value },
    label: input.label,
    row: input.row,
    col: input.col,
  };
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
    // A Figma rejection is not always an Error: a string or an object with
    // no message would otherwise vanish behind the fallback sentence.
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message
        : typeof error === 'string' && error ? error
          : error && typeof error === 'object' && Object.keys(error).length
            ? JSON.stringify(error) : fallback, ${MAX_FAILURE_CODE_UNITS});
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const text = (value, maximum, empty = true) => typeof value === 'string'
      && value.length <= maximum && (empty || value.length > 0);
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const sameRows = (left, right) => left.length === right.length
      && left.every((row, index) => same(row, right[index]));
    const sameTransition = (left, right) => left && right
      && (left.style === 'NONE' && right.style === 'NONE'
        || JSON.stringify(left) === JSON.stringify(right));
    const rounded = (value) => Math.round(value * 10000) / 10000;
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SLIDES_DUPLICATE_RESULT_CODE_UNITS}) {
        throw new Error('Slides Duplicate result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (failure) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(failure, ${MAX_FAILURE_CODE_UNITS}),
    });
    if (figma.editorType !== 'slides') {
      return refused('Slides Duplicate requires a Figma Slides deck.');
    }
    if (!figma.currentPage || typeof figma.getCanvasGrid !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function'
      || typeof figma.moveNodesToCoord !== 'function') {
      return refused('Slides Duplicate requires the native Slides API.');
    }
    ${slidePageSlidesFragment()}
    const transitionOf = (slide) => {
      if (typeof slide.getSlideTransition !== 'function') {
        throw new Error('Slides Duplicate requires native transition facts.');
      }
      const value = slide.getSlideTransition();
      if (!exact(value, ['style', 'duration', 'curve', 'timing'])
        || !transitionStyles.has(value.style) || !transitionCurves.has(value.curve)
        || typeof value.duration !== 'number' || !Number.isFinite(value.duration)
        || value.duration < 0 || value.duration > ${MAX_TRANSITION_SECONDS}
        || !value.timing || !transitionTimings.has(value.timing.type)) {
        throw new Error('Slides Duplicate found invalid transition facts.');
      }
      const timingKeys = value.timing.type === 'AFTER_DELAY' ? ['type', 'delay'] : ['type'];
      if (!exact(value.timing, timingKeys)
        || (value.timing.type === 'AFTER_DELAY'
          && (typeof value.timing.delay !== 'number' || !Number.isFinite(value.timing.delay)
            || value.timing.delay < 0 || value.timing.delay > ${MAX_TRANSITION_SECONDS}))) {
        throw new Error('Slides Duplicate found invalid transition timing.');
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
        throw new Error('Slides Duplicate requires durable label facts.');
      }
      const label = slide.getPluginData(${jsValue(SLIDE_LABEL_KEY)}) || '';
      if (!text(label, ${MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS})) {
        throw new Error('Slides Duplicate found an invalid durable label.');
      }
      return label;
    };
    const snapshot = () => {
      const page = figma.currentPage;
      if (!page || !validId(page.id) || !Array.isArray(page.selection)
        || page.selection.length > ${MAX_SLIDES_DUPLICATE_SELECTION}) {
        throw new Error('Slides Duplicate requires a bounded current Page and selection.');
      }
      const grid = figma.getCanvasGrid();
      if (!Array.isArray(grid) || grid.length > ${MAX_SLIDES_DUPLICATE_ROWS}) {
        throw new Error('Slides Duplicate requires a bounded native grid.');
      }
      let entries = 0;
      const ids = new Set();
      const nodes = new Map();
      const rows = grid.map((row) => {
        if (!Array.isArray(row) || row.length > ${MAX_SLIDES_DUPLICATE_ROW_ENTRIES}) {
          throw new Error('Slides Duplicate requires bounded native grid rows.');
        }
        entries += row.length;
        if (entries > ${MAX_SLIDES_DUPLICATE_GRID_ENTRIES}) {
          throw new Error('Slides Duplicate native grid entry limit exceeded.');
        }
        return row.map((node) => {
          if (!node || node.type !== 'SLIDE' || !validId(node.id) || ids.has(node.id)
            || !text(node.name, ${MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS})) {
            throw new Error('Slides Duplicate requires unique native Slide identities.');
          }
          ids.add(node.id);
          nodes.set(node.id, node);
          return node.id;
        });
      });
      // The grid is authoritative for coordinates, the page tree for existence:
      // a slide the grid has not listed yet is still a slide, and still may be
      // the focused one. It joins the snapshot without a coordinate.
      const unlisted = [];
      for (const node of __pageSlides()) {
        if (ids.has(node.id)) continue;
        if (node.type !== 'SLIDE' || !validId(node.id) || !text(node.name, ${MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS})) {
          throw new Error('Slides Duplicate requires unique native Slide identities.');
        }
        ids.add(node.id); nodes.set(node.id, node); unlisted.push(node.id);
      }
      // The focus can rest on a node that was just removed: reading it throws
      // or reports removed. That is no focus, not an invalid snapshot.
      let focus = null;
      try {
        const candidate = page.focusedSlide || null;
        focus = candidate && candidate.removed !== true && candidate.type ? candidate : null;
      } catch { focus = null; }
      if (focus && (focus.type !== 'SLIDE' || !validId(focus.id) || !ids.has(focus.id))) {
        throw new Error('Slides Duplicate found an invalid focused Slide.');
      }
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Slides Duplicate found an invalid selection.');
        return node.id;
      });
      if (new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Slides Duplicate found duplicate selection identities.');
      }
      return {
        page, nodes, selection: [...page.selection], focus,
        value: { pageId: page.id, rows, unlisted, focusedId: focus ? focus.id : null, selectionIds },
      };
    };
    const without = (rows, nodeId) => rows
      .map((row) => row.filter((id) => id !== nodeId)).filter((row) => row.length > 0);
    const occurrences = (rows, nodeId) => rows.reduce(
      (count, row) => count + row.filter((id) => id === nodeId).length, 0);
    const position = (rows, nodeId) => {
      for (let row = 0; row < rows.length; row++) {
        const col = rows[row].indexOf(nodeId);
        if (col !== -1) return { row, col };
      }
      return null;
    };
    const attributable = (beforeRows, afterRows, nodeId) => occurrences(afterRows, nodeId) === 1
      && sameRows(without(afterRows, nodeId), beforeRows);
    const facts = (slide, state) => {
      if (!slide || slide.type !== 'SLIDE' || !validId(slide.id)
        || !text(slide.name, ${MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS})
        || !Array.isArray(slide.children) || slide.children.length > ${MAX_SLIDES_DUPLICATE_CHILDREN}
        || typeof slide.isSkippedSlide !== 'boolean') {
        throw new Error('Slides Duplicate found invalid Slide facts.');
      }
      const coordinate = position(state.rows, slide.id)
        || (state.unlisted.includes(slide.id) ? { row: null, col: null } : null);
      if (!coordinate) throw new Error('Slides Duplicate found a Slide outside the grid.');
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
          throw new Error('Slide reference did not resolve to a Slide in the current deck.');
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
    const requestedPosition = (rows, nodeId) => {
      const actual = position(rows, nodeId);
      if (!actual) return false;
      if (request.row === null) {
        return actual.row === rows.length - 1 && actual.col === rows[actual.row].length - 1;
      }
      if (actual.row !== request.row) return false;
      return request.col === null
        ? actual.col === rows[actual.row].length - 1 : actual.col === request.col;
    };
    const sameSource = (before, actual) => before.id === actual.id
      && before.label === actual.label && before.skipped === actual.skipped
      && before.childCount === actual.childCount
      && sameTransition(before.transition, actual.transition);
    const sameClone = (source, copy) => source.skipped === copy.skipped
      && source.childCount === copy.childCount
      && sameTransition(source.transition, copy.transition);
    const settle = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    let beforeRefs;
    let source;
    let beforeSource;
    try {
      beforeRefs = snapshot();
      source = await resolve(beforeRefs);
      if (typeof source.clone !== 'function') {
        return refused('Slides Duplicate requires native Slide cloning.');
      }
      if (request.row !== null && !beforeRefs.value.rows[request.row]) {
        return refused('Slides Duplicate target row does not exist.');
      }
      if (request.row !== null && request.col !== null
        && request.col > beforeRefs.value.rows[request.row].length) {
        return refused('Slides Duplicate target column is outside its row.');
      }
      beforeSource = facts(source, beforeRefs.value);
      if (request.label === null
        && ((beforeSource.label || beforeSource.name) + ' copy').length
          > ${MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS}) {
        return refused('Slides Duplicate default label exceeds its bounded limit.');
      }
    } catch (error) {
      return refused(failureText(error, 'Slides Duplicate preflight failed.'));
    }

    let copyId = null;
    let trustedCopyId = false;
    let failure = '';
    let copy = null;
    try {
      copy = source.clone();
      if (!copy || copy.type !== 'SLIDE' || !validId(copy.id) || copy.id === source.id) {
        throw new Error('Slides Duplicate clone returned an invalid Slide identity.');
      }
      copyId = copy.id;
      trustedCopyId = true;
      if (request.row === null) figma.moveNodesToCoord([copy.id]);
      else if (request.col === null) figma.moveNodesToCoord([copy.id], request.row);
      else figma.moveNodesToCoord([copy.id], request.row, request.col);
      beforeRefs.page.focusedSlide = copy;
      beforeRefs.page.selection = [copy];
      await settle();
      const defaultLabel = (labelOf(source) || source.name) + ' copy';
      if (typeof copy.setPluginData !== 'function') {
        throw new Error('Slides Duplicate cannot assign a durable label.');
      }
      copy.setPluginData(${jsValue(SLIDE_LABEL_KEY)}, request.label || defaultLabel);
    } catch (error) {
      failure = failureText(error, 'Slides Duplicate mutation failed.');
    }

    let actualRefs = null;
    let actualCopy = null;
    try {
      actualRefs = snapshot();
      const beforeIds = new Set(beforeRefs.value.rows.flat());
      const newIds = actualRefs.value.rows.flat().filter((id) => !beforeIds.has(id));
      if (!copyId && newIds.length === 1
        && attributable(beforeRefs.value.rows, actualRefs.value.rows, newIds[0])) {
        copyId = newIds[0];
      }
      if (!copy && copyId) copy = await figma.getNodeByIdAsync(copyId);
      const currentSource = actualRefs.nodes.get(source.id) || null;
      const sourceFact = currentSource ? facts(currentSource, actualRefs.value) : null;
      const copyFact = copy ? facts(copy, actualRefs.value) : null;
      const expectedLabel = request.label || (sourceFact && (sourceFact.label || sourceFact.name) + ' copy');
      const exactSuccess = sourceFact && copyFact && copyFact.id !== sourceFact.id
        && actualRefs.value.pageId === beforeRefs.value.pageId
        && actualRefs.value.focusedId === copyFact.id
        && same(actualRefs.value.selectionIds, [copyFact.id])
        && attributable(beforeRefs.value.rows, actualRefs.value.rows, copyFact.id)
        && same(actualRefs.value.unlisted, beforeRefs.value.unlisted)
        && requestedPosition(actualRefs.value.rows, copyFact.id)
        && sameSource(beforeSource, sourceFact) && sameClone(beforeSource, copyFact)
        && copyFact.label === expectedLabel;
      if (exactSuccess) {
        return result({
          schemaVersion, status: 'duplicated',
          outcome: failure ? 'verified-after-error' : 'verified',
          attempted: 1, restored: 0, residue: [], request,
          before: { ...beforeRefs.value, source: beforeSource },
          actual: { ...actualRefs.value, source: sourceFact, slide: copyFact },
          warnings: failure
            ? ['Figma reported an error, but fresh Slides readback verified the requested duplicate.']
            : [],
        });
      }
      if (!failure) failure = 'Slides Duplicate postcondition was not satisfied.';
      actualCopy = copy;
    } catch (error) {
      if (!failure) failure = failureText(error, 'Slides Duplicate verification failed.');
      actualCopy = copy;
    }

    try {
      const probe = actualRefs || snapshot();
      const beforeIds = new Set(beforeRefs.value.rows.flat());
      const newIds = probe.value.rows.flat().filter((id) => !beforeIds.has(id));
      let candidateId = copyId;
      if (!candidateId && newIds.length === 1
        && attributable(beforeRefs.value.rows, probe.value.rows, newIds[0])) {
        candidateId = newIds[0];
      }
      if (candidateId && (trustedCopyId
        || attributable(beforeRefs.value.rows, probe.value.rows, candidateId))) {
        let candidate = actualCopy && actualCopy.id === candidateId ? actualCopy : null;
        if (!candidate) {
          try { candidate = await figma.getNodeByIdAsync(candidateId); } catch {}
        }
        try {
          if (candidate && candidate.type === 'SLIDE' && typeof candidate.remove === 'function') {
            candidate.remove();
          }
        } catch {}
      }
      try { beforeRefs.page.focusedSlide = beforeRefs.focus; } catch {}
      try { beforeRefs.page.selection = beforeRefs.selection; } catch {}
      try { await settle(); } catch {}
      const restored = snapshot().value;
      const residue = [];
      if (candidateId && (occurrences(restored.rows, candidateId) > 0
        || restored.unlisted.includes(candidateId))) residue.push('duplicated-slide');
      if (!sameRows(restored.rows, beforeRefs.value.rows)
        || !same(restored.unlisted, beforeRefs.value.unlisted)) residue.push('grid-membership');
      if (restored.pageId !== beforeRefs.value.pageId) residue.push('page');
      if (restored.focusedId !== beforeRefs.value.focusedId) residue.push('focus');
      if (!same(restored.selectionIds, beforeRefs.value.selectionIds)) residue.push('selection');
      const rolledBack = residue.length === 0;
      return result({
        schemaVersion, status: 'failed', outcome: rolledBack ? 'rolled-back' : 'partial-residue',
        attempted: 1, restored: rolledBack ? 1 : 0, residue,
        failure: clean(failure || 'Slides Duplicate failed.', ${MAX_FAILURE_CODE_UNITS}),
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable',
        attempted: 1, restored: 0, residue: [],
        failure: failureText(error, failure || 'Slides Duplicate verification became unavailable.'),
      });
    }
  })()`;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

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

function count(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function rows(value) {
  if (!Array.isArray(value) || value.length > MAX_SLIDES_DUPLICATE_ROWS) return false;
  let total = 0;
  const ids = new Set();
  for (const row of value) {
    if (!Array.isArray(row) || row.length > MAX_SLIDES_DUPLICATE_ROW_ENTRIES) return false;
    total += row.length;
    if (total > MAX_SLIDES_DUPLICATE_GRID_ENTRIES) return false;
    for (const nodeId of row) {
      if (!id(nodeId) || ids.has(nodeId)) return false;
      ids.add(nodeId);
    }
  }
  return true;
}

function unlistedIds(value, rowsValue, maximum) {
  if (!Array.isArray(value) || value.length > maximum) return false;
  const gridIds = new Set(rowsValue.flat());
  const seen = new Set();
  return value.every((nodeId) => {
    if (!id(nodeId) || gridIds.has(nodeId) || seen.has(nodeId)) return false;
    seen.add(nodeId);
    return true;
  });
}

// A slide the grid lists must sit where the fact says; one the grid has not
// listed yet carries no coordinate and must be among the snapshot's unlisted ids.
function placed(state, slide) {
  const coordinate = position(state.rows, slide.id);
  if (coordinate) return coordinate.row === slide.row && coordinate.col === slide.col;
  return slide.row === null && slide.col === null && state.unlisted.includes(slide.id);
}
function coordinateFact(row, col, maxRow, maxCol) {
  return (count(row, maxRow) && count(col, maxCol)) || (row === null && col === null);
}

function snapshot(value) {
  if (!exact(value, ['pageId', 'rows', 'unlisted', 'focusedId', 'selectionIds'])
    || !id(value.pageId) || !rows(value.rows)
    || !unlistedIds(value.unlisted, value.rows, MAX_SLIDES_DUPLICATE_GRID_ENTRIES)
    || (value.focusedId !== null && !id(value.focusedId))
    || !Array.isArray(value.selectionIds)
    || value.selectionIds.length > MAX_SLIDES_DUPLICATE_SELECTION
    || value.selectionIds.some((nodeId) => !id(nodeId))
    || new Set(value.selectionIds).size !== value.selectionIds.length) return false;
  const gridIds = new Set(value.rows.flat());
  return value.focusedId === null || gridIds.has(value.focusedId)
    || value.unlisted.includes(value.focusedId);
}

function transition(value) {
  if (!exact(value, ['style', 'duration', 'curve', 'timing'])
    || !TRANSITION_STYLES.includes(value.style) || !TRANSITION_CURVES.includes(value.curve)
    || typeof value.duration !== 'number' || !Number.isFinite(value.duration)
    || value.duration < 0 || value.duration > MAX_TRANSITION_SECONDS
    || !record(value.timing) || !TRANSITION_TIMINGS.includes(value.timing.type)) return false;
  const keys = value.timing.type === 'AFTER_DELAY' ? ['type', 'delay'] : ['type'];
  return exact(value.timing, keys) && (value.timing.type !== 'AFTER_DELAY'
    || (typeof value.timing.delay === 'number' && Number.isFinite(value.timing.delay)
      && value.timing.delay >= 0 && value.timing.delay <= MAX_TRANSITION_SECONDS));
}

function slideFact(value) {
  return exact(value, [
    'id', 'name', 'label', 'row', 'col', 'skipped', 'transition', 'childCount',
  ]) && id(value.id) && text(value.name, MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS)
    && (value.label === null || text(value.label, MAX_SLIDES_DUPLICATE_LABEL_CODE_UNITS))
    && coordinateFact(value.row, value.col, MAX_SLIDES_DUPLICATE_INDEX, MAX_SLIDES_DUPLICATE_INDEX)
    && typeof value.skipped === 'boolean' && transition(value.transition)
    && count(value.childCount, MAX_SLIDES_DUPLICATE_CHILDREN);
}

function same(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRows(left, right) {
  return left.length === right.length && left.every((row, index) => same(row, right[index]));
}

function without(rowsValue, nodeId) {
  return rowsValue.map((row) => row.filter((idValue) => idValue !== nodeId))
    .filter((row) => row.length > 0);
}

function position(rowsValue, nodeId) {
  for (let row = 0; row < rowsValue.length; row++) {
    const col = rowsValue[row].indexOf(nodeId);
    if (col !== -1) return { row, col };
  }
  return null;
}

function sameTransition(left, right) {
  return left && right && (left.style === 'NONE' && right.style === 'NONE'
    || JSON.stringify(left) === JSON.stringify(right));
}

function validRequest(value, input) {
  return exact(value, ['reference', 'label', 'row', 'col'])
    && exact(value.reference, ['kind', 'value'])
    && value.reference.kind === input.reference.kind
    && value.reference.value === input.reference.value
    && value.label === input.label && value.row === input.row && value.col === input.col;
}

function sameSource(before, actual) {
  return before.id === actual.id && before.label === actual.label
    && before.skipped === actual.skipped && before.childCount === actual.childCount
    && sameTransition(before.transition, actual.transition);
}

function matchesSuccess(before, actual, input) {
  const source = actual.source;
  const slide = actual.slide;
  if (before.pageId !== actual.pageId || source.id !== before.source.id
    || slide.id === source.id || actual.focusedId !== slide.id
    || !same(actual.selectionIds, [slide.id]) || !sameSource(before.source, source)
    || source.skipped !== slide.skipped || source.childCount !== slide.childCount
    || !sameTransition(source.transition, slide.transition)
    || !sameRows(without(actual.rows, slide.id), before.rows)
    || !same(actual.unlisted, before.unlisted)
    || !placed(before, before.source) || !placed(actual, source)) return false;
  const coordinate = position(actual.rows, slide.id);
  if (!coordinate || coordinate.row !== slide.row || coordinate.col !== slide.col) return false;
  if (input.row === null) {
    if (slide.row !== actual.rows.length - 1
      || slide.col !== actual.rows[slide.row].length - 1) return false;
  } else if (slide.row !== input.row
    || (input.col === null
      ? slide.col !== actual.rows[slide.row].length - 1 : slide.col !== input.col)) return false;
  const expectedLabel = input.label || `${source.label || source.name} copy`;
  return slide.label === expectedLabel;
}

function validSuccess(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue',
    'request', 'before', 'actual', 'warnings',
  ]) && value.schemaVersion === 1 && value.status === 'duplicated'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && value.attempted === 1 && value.restored === 0
    && Array.isArray(value.residue) && value.residue.length === 0
    && validRequest(value.request, input)
    && exact(value.before, ['pageId', 'rows', 'unlisted', 'focusedId', 'selectionIds', 'source'])
    && snapshot({ pageId: value.before.pageId, rows: value.before.rows, unlisted: value.before.unlisted,
      focusedId: value.before.focusedId, selectionIds: value.before.selectionIds }) && slideFact(value.before.source)
    && exact(value.actual, ['pageId', 'rows', 'unlisted', 'focusedId', 'selectionIds', 'source', 'slide'])
    && snapshot({ pageId: value.actual.pageId, rows: value.actual.rows, unlisted: value.actual.unlisted,
      focusedId: value.actual.focusedId, selectionIds: value.actual.selectionIds }) && slideFact(value.actual.source) && slideFact(value.actual.slide)
    && matchesSuccess(value.before, value.actual, input)
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
  const allowed = new Set(['duplicated-slide', 'grid-membership', 'page', 'focus', 'selection']);
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure',
  ]) && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= allowed.size
    && value.residue.every((entry) => allowed.has(entry))
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

function safeText(value) {
  return String(value).replace(UNSAFE_TEXT_CONTROLS, ' ');
}

export function formatSlidesDuplicateResult(result) {
  const slide = result.actual.slide;
  const labelled = slide.label ? ` [${safeText(slide.label)}]` : '';
  return `✓ Slide ${safeText(result.actual.source.id)} duplicated as ${safeText(slide.id)}${labelled}`;
}

export async function executeSlidesDuplicate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Duplicate requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(slidesDuplicateCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SLIDES_DUPLICATE_RESULT_CODE_UNITS) {
    throw pluginResultError('Slides Duplicate returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Slides Duplicate returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) {
      throw pluginResultError('Slides Duplicate returned an invalid bounded result.');
    }
    throw mutationError(`Slides Duplicate made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) {
      throw pluginResultError('Slides Duplicate returned an invalid bounded result.');
    }
    throw mutationError(`Slides Duplicate failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Slides Duplicate returned an invalid bounded result.');
  }
  return {
    stdout: formatSlidesDuplicateResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    code: 0,
    result: payload,
  };
}

export function slidesDuplicatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides Duplicate routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-slides-duplicate';
}

export function executeSlidesDuplicatePlan(plan, adapters = {}) {
  if (slidesDuplicatePlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Duplicate.');
  }
  return executeSlidesDuplicate(parseSlidesDuplicateRequest(plan.argv), adapters);
}
