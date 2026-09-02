// Plan-bound, freshly verified and rollback-owned `slides create` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { SLIDE_LABEL_KEY } from '../lib/slides-snippets.js';
import {
  MAX_SLIDES_CREATE_INDEX,
  MAX_SLIDES_CREATE_LABEL_CODE_UNITS,
  parseSlidesCreateRequest,
  slidesCreateArgvFromRequest,
} from './slides-create-request.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';

export {
  slidesCreateArgvFromRequest,
  slidesCreatePlanningArgvFromRequest,
} from './slides-create-request.js';

const APPLICATION_ID = 'slides.create';
export const MAX_SLIDES_CREATE_ROWS = 4_096;
export const MAX_SLIDES_CREATE_ROW_ENTRIES = 4_096;
export const MAX_SLIDES_CREATE_GRID_ENTRIES = 4_096;
export const MAX_SLIDES_CREATE_SELECTION = 256;
export const MAX_SLIDES_CREATE_RESULT_CODE_UNITS = 6_000_000;
const MAX_FAILURE_CODE_UNITS = 1_024;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseSlidesCreateRequest(slidesCreateArgvFromRequest(request));

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function slidesCreateCode(request) {
  const input = normalized(request);
  return `(async () => {
    const schemaVersion = 1;
    const request = ${jsValue(input)};
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
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_SLIDES_CREATE_RESULT_CODE_UNITS}) {
        throw new Error('Slides Create result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (failure) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(failure, ${MAX_FAILURE_CODE_UNITS}),
    });
    if (figma.editorType !== 'slides') return refused('Slides Create requires a Figma Slides deck.');
    if (!figma.currentPage || typeof figma.getCanvasGrid !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function' || typeof figma.createSlide !== 'function') {
      return refused('Slides Create requires the native Slides API.');
    }
    const snapshot = () => {
      const page = figma.currentPage;
      if (!page || !validId(page.id) || !Array.isArray(page.selection)
        || page.selection.length > ${MAX_SLIDES_CREATE_SELECTION}) {
        throw new Error('Slides Create requires a bounded current Page and selection.');
      }
      const grid = figma.getCanvasGrid();
      if (!Array.isArray(grid) || grid.length > ${MAX_SLIDES_CREATE_ROWS}) {
        throw new Error('Slides Create requires a bounded native grid.');
      }
      let entries = 0;
      const ids = new Set();
      const rows = grid.map((row) => {
        if (!Array.isArray(row) || row.length > ${MAX_SLIDES_CREATE_ROW_ENTRIES}) {
          throw new Error('Slides Create requires bounded native grid rows.');
        }
        entries += row.length;
        if (entries > ${MAX_SLIDES_CREATE_GRID_ENTRIES}) {
          throw new Error('Slides Create native grid entry limit exceeded.');
        }
        return row.map((node) => {
          if (!node || node.type !== 'SLIDE' || !validId(node.id) || ids.has(node.id)) {
            throw new Error('Slides Create requires unique native Slide identities.');
          }
          ids.add(node.id);
          return node.id;
        });
      });
      const focus = page.focusedSlide || null;
      if (focus && (focus.type !== 'SLIDE' || !validId(focus.id) || !ids.has(focus.id))) {
        throw new Error('Slides Create found an invalid focused Slide.');
      }
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Slides Create found an invalid selection.');
        return node.id;
      });
      if (new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Slides Create found duplicate selection identities.');
      }
      return {
        page,
        selection: [...page.selection],
        focus,
        value: { pageId: page.id, rows, focusedId: focus ? focus.id : null, selectionIds },
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
    const exactSuccess = (before, actual, slide) => actual.pageId === before.pageId
      && actual.focusedId === slide.id && same(actual.selectionIds, [slide.id])
      && attributable(before.rows, actual.rows, slide.id)
      && requestedPosition(actual.rows, slide.id)
      && slide.row === position(actual.rows, slide.id).row
      && slide.col === position(actual.rows, slide.id).col
      && slide.label === (request.label || null);
    const settle = (delay = 0) => new Promise((resolve) => setTimeout(resolve, delay));
    const settledSnapshot = async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { return snapshot(); }
        catch (error) { lastError = error; }
        await settle(50);
      }
      throw lastError || new Error('Slides Create native grid did not settle.');
    };

    let beforeRefs;
    try { beforeRefs = snapshot(); }
    catch (error) { return refused(failureText(error, 'Slides Create preflight failed.')); }
    let createdId = null;
    let failure = '';
    try {
      const created = request.row === null
        ? figma.createSlide()
        : request.col === null
          ? figma.createSlide(request.row)
          : figma.createSlide(request.row, request.col);
      if (!created || created.type !== 'SLIDE' || !validId(created.id)) {
        throw new Error('Slides Create factory returned an invalid Slide identity.');
      }
      createdId = created.id;
      beforeRefs.page.focusedSlide = created;
      beforeRefs.page.selection = [created];
      await settle();
      if (typeof created.setPluginData !== 'function') {
        throw new Error('Slides Create cannot assign a durable label.');
      }
      created.setPluginData(${jsValue(SLIDE_LABEL_KEY)}, request.label || '');
    } catch (error) {
      failure = failureText(error, 'Slides Create mutation failed.');
    }

    let actualRefs = null;
    let created = null;
    let slide = null;
    try {
      actualRefs = await settledSnapshot();
      const beforeIds = new Set(beforeRefs.value.rows.flat());
      const newIds = actualRefs.value.rows.flat().filter((id) => !beforeIds.has(id));
      if (!createdId && newIds.length === 1
        && attributable(beforeRefs.value.rows, actualRefs.value.rows, newIds[0])) {
        createdId = newIds[0];
      }
      created = createdId ? await figma.getNodeByIdAsync(createdId) : null;
      const coordinate = createdId ? position(actualRefs.value.rows, createdId) : null;
      if (created && created.type === 'SLIDE' && coordinate
        && validId(created.id) && text(created.name, ${MAX_SLIDES_CREATE_LABEL_CODE_UNITS})
        && typeof created.getPluginData === 'function') {
        const label = created.getPluginData(${jsValue(SLIDE_LABEL_KEY)}) || '';
        if (text(label, ${MAX_SLIDES_CREATE_LABEL_CODE_UNITS})) {
          slide = {
            id: created.id, name: created.name, label: label || null,
            row: coordinate.row, col: coordinate.col,
          };
        }
      }
      if (slide && exactSuccess(beforeRefs.value, actualRefs.value, slide)) {
        return result({
          schemaVersion, status: 'created',
          outcome: failure ? 'verified-after-error' : 'verified',
          attempted: 1, restored: 0, residue: [],
          request, before: beforeRefs.value, actual: { ...actualRefs.value, slide },
          warnings: failure
            ? ['Figma reported an error, but fresh Slides readback verified the requested creation.']
            : [],
        });
      }
      if (!failure) failure = 'Slides Create postcondition was not satisfied.';
    } catch (error) {
      if (!failure) failure = failureText(error, 'Slides Create verification failed.');
    }

    try {
      const probe = actualRefs || await settledSnapshot();
      const beforeIds = new Set(beforeRefs.value.rows.flat());
      const newIds = probe.value.rows.flat().filter((id) => !beforeIds.has(id));
      let candidateId = createdId;
      if (!candidateId && newIds.length === 1
        && attributable(beforeRefs.value.rows, probe.value.rows, newIds[0])) {
        candidateId = newIds[0];
      }
      if (candidateId && attributable(beforeRefs.value.rows, probe.value.rows, candidateId)) {
        let candidate = created && created.id === candidateId ? created : null;
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
      const restored = (await settledSnapshot()).value;
      const residue = [];
      if (candidateId && occurrences(restored.rows, candidateId) > 0) residue.push('created-slide');
      if (!sameRows(restored.rows, beforeRefs.value.rows)) residue.push('grid-membership');
      if (restored.pageId !== beforeRefs.value.pageId) residue.push('page');
      if (restored.focusedId !== beforeRefs.value.focusedId) residue.push('focus');
      if (!same(restored.selectionIds, beforeRefs.value.selectionIds)) residue.push('selection');
      const rolledBack = residue.length === 0;
      return result({
        schemaVersion, status: 'failed',
        outcome: rolledBack ? 'rolled-back' : 'partial-residue',
        attempted: 1, restored: rolledBack ? 1 : 0, residue,
        failure: clean(failure || 'Slides Create failed.', ${MAX_FAILURE_CODE_UNITS}),
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable',
        attempted: 1, restored: 0, residue: [],
        failure: failureText(error, failure || 'Slides Create verification became unavailable.'),
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
  if (!Array.isArray(value) || value.length > MAX_SLIDES_CREATE_ROWS) return false;
  let total = 0;
  const ids = new Set();
  for (const row of value) {
    if (!Array.isArray(row) || row.length > MAX_SLIDES_CREATE_ROW_ENTRIES) return false;
    total += row.length;
    if (total > MAX_SLIDES_CREATE_GRID_ENTRIES) return false;
    for (const nodeId of row) {
      if (!id(nodeId) || ids.has(nodeId)) return false;
      ids.add(nodeId);
    }
  }
  return true;
}

function snapshot(value) {
  if (!exact(value, ['pageId', 'rows', 'focusedId', 'selectionIds'])
    || !id(value.pageId) || !rows(value.rows)
    || (value.focusedId !== null && !id(value.focusedId))
    || !Array.isArray(value.selectionIds)
    || value.selectionIds.length > MAX_SLIDES_CREATE_SELECTION
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

function validRequest(value, input) {
  return exact(value, ['label', 'row', 'col'])
    && value.label === input.label && value.row === input.row && value.col === input.col;
}

function slideFact(value) {
  return exact(value, ['id', 'name', 'label', 'row', 'col'])
    && id(value.id) && text(value.name, MAX_SLIDES_CREATE_LABEL_CODE_UNITS)
    && (value.label === null || text(value.label, MAX_SLIDES_CREATE_LABEL_CODE_UNITS))
    && count(value.row, MAX_SLIDES_CREATE_INDEX)
    && count(value.col, MAX_SLIDES_CREATE_INDEX);
}

function matchesSuccess(before, actual, slide, input) {
  if (before.pageId !== actual.pageId || actual.focusedId !== slide.id
    || !same(actual.selectionIds, [slide.id])) return false;
  const coordinate = position(actual.rows, slide.id);
  if (!coordinate || coordinate.row !== slide.row || coordinate.col !== slide.col
    || !sameRows(without(actual.rows, slide.id), before.rows)) return false;
  if (input.row === null) {
    if (slide.row !== actual.rows.length - 1
      || slide.col !== actual.rows[slide.row].length - 1) return false;
  } else if (slide.row !== input.row
    || (input.col === null
      ? slide.col !== actual.rows[slide.row].length - 1 : slide.col !== input.col)) return false;
  return slide.label === (input.label || null);
}

function validSuccess(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue',
    'request', 'before', 'actual', 'warnings',
  ]) && value.schemaVersion === 1 && value.status === 'created'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && value.attempted === 1 && value.restored === 0
    && Array.isArray(value.residue) && value.residue.length === 0
    && validRequest(value.request, input) && snapshot(value.before)
    && exact(value.actual, ['pageId', 'rows', 'focusedId', 'selectionIds', 'slide'])
    && snapshot({
      pageId: value.actual.pageId, rows: value.actual.rows,
      focusedId: value.actual.focusedId, selectionIds: value.actual.selectionIds,
    }) && slideFact(value.actual.slide)
    && matchesSuccess(value.before, value.actual, value.actual.slide, input)
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
  const allowed = new Set(['created-slide', 'grid-membership', 'page', 'focus', 'selection']);
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

export function formatSlidesCreateResult(result) {
  const slide = result.actual.slide;
  const labelled = slide.label ? ` [${safeText(slide.label)}]` : '';
  return `✓ Slide ${slide.id}${labelled} at ${slide.row},${slide.col} `
    + `(Figma name: ${JSON.stringify(safeText(slide.name))})`;
}

export async function executeSlidesCreate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slides Create requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(slidesCreateCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_SLIDES_CREATE_RESULT_CODE_UNITS) {
    throw pluginResultError('Slides Create returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Slides Create returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Slides Create returned an invalid bounded result.');
    throw mutationError(`Slides Create made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw pluginResultError('Slides Create returned an invalid bounded result.');
    throw mutationError(`Slides Create failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Slides Create returned an invalid bounded result.');
  }
  return {
    stdout: formatSlidesCreateResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    code: 0,
    result: payload,
  };
}

export function slidesCreatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slides Create routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-slides-create';
}

export function executeSlidesCreatePlan(plan, adapters = {}) {
  if (slidesCreatePlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slides Create.');
  }
  return executeSlidesCreate(parseSlidesCreateRequest(plan.argv), adapters);
}
