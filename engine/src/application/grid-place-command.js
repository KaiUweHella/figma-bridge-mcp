// Plan-bound, hierarchy- and readback-verified Auto Layout Grid placement.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  gridPlaceArgvFromRequest,
  gridPlacePlanningArgvFromRequest,
  parseGridPlaceRequest,
} from './grid-place-request.js';

export { gridPlaceArgvFromRequest, gridPlacePlanningArgvFromRequest } from './grid-place-request.js';

const APPLICATION_ID = 'layout.grid.place';
export const MAX_GRID_PLACE_CHILDREN = 50_000;
export const MAX_GRID_PLACE_TRACKS = 4_096;
export const MAX_GRID_PLACE_ANCESTORS = 512;
export const MAX_GRID_PLACE_RESULT_CODE_UNITS = 96_000;
const ALIGNMENTS = Object.freeze(['AUTO', 'MIN', 'CENTER', 'MAX']);
const TRACK_TYPES = Object.freeze(['FLEX', 'FIXED', 'HUG']);
const normalized = (request) => parseGridPlaceRequest(gridPlaceArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function gridPlaceCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const alignments = ${js(ALIGNMENTS)};
    const trackTypes = ${js(TRACK_TYPES)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_GRID_PLACE_RESULT_CODE_UNITS}) throw new Error('Grid Place result exceeded its bounded response limit.'); return serialized; };
    const childIds = (parent, label) => {
      if (!parent || !Array.isArray(parent.children) || parent.children.length > ${MAX_GRID_PLACE_CHILDREN}) throw new Error(label + ' child membership is unavailable or exceeds its bound.');
      const ids = parent.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error(label + ' child membership is invalid.');
      return ids;
    };
    const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
    const track = (value) => {
      if (!value || !trackTypes.includes(value.type)) throw new Error('Grid track facts are invalid.');
      const projected = { type: value.type };
      if (value.value !== undefined) {
        if (!Number.isFinite(value.value) || value.value < 0) throw new Error('Grid track value is invalid.');
        projected.value = value.value;
      }
      return projected;
    };
    const gridFacts = (grid) => {
      if (!grid || grid.layoutMode !== 'GRID' || typeof grid.appendChildAt !== 'function'
        || !Number.isSafeInteger(grid.gridRowCount) || grid.gridRowCount < 1 || grid.gridRowCount > ${MAX_GRID_PLACE_TRACKS}
        || !Number.isSafeInteger(grid.gridColumnCount) || grid.gridColumnCount < 1 || grid.gridColumnCount > ${MAX_GRID_PLACE_TRACKS}
        || !Number.isFinite(grid.gridRowGap) || grid.gridRowGap < 0
        || !Number.isFinite(grid.gridColumnGap) || grid.gridColumnGap < 0
        || !Array.isArray(grid.gridRowSizes) || grid.gridRowSizes.length !== grid.gridRowCount
        || !Array.isArray(grid.gridColumnSizes) || grid.gridColumnSizes.length !== grid.gridColumnCount
        || !['NONE','ROWS'].includes(grid.gridAutoTracks)
        || !['MANUAL','ROW_AUTO_FLOW'].includes(grid.gridItemsPositioning)) throw new Error('Grid Place requires one bounded native Auto Layout Grid container.');
      return { id: clean(grid.id, 512), name: clean(String(grid.name || ''), 1024), type: clean(String(grid.type || ''), 64), layoutMode: 'GRID', rows: grid.gridRowCount, columns: grid.gridColumnCount, rowGap: grid.gridRowGap, columnGap: grid.gridColumnGap, rowSizes: Array.from(grid.gridRowSizes, track), columnSizes: Array.from(grid.gridColumnSizes, track), autoTracks: grid.gridAutoTracks, itemsPositioning: grid.gridItemsPositioning };
    };
    const placement = (child) => {
      if (!child || !child.parent || typeof child.parent.id !== 'string') throw new Error('Grid child parent identity is unavailable.');
      const ids = childIds(child.parent, 'Grid child parent'); const index = ids.indexOf(child.id);
      if (index < 0 || ids.indexOf(child.id, index + 1) !== -1) throw new Error('Grid child membership is invalid.');
      const row = child.gridRowAnchorIndex, column = child.gridColumnAnchorIndex;
      const rowSpan = child.gridRowSpan, columnSpan = child.gridColumnSpan;
      const horizontalAlign = child.gridChildHorizontalAlign, verticalAlign = child.gridChildVerticalAlign;
      if (![row,column].every((value) => Number.isSafeInteger(value) && value >= 0)
        || ![rowSpan,columnSpan].every((value) => Number.isSafeInteger(value) && value >= 1)
        || !alignments.includes(horizontalAlign) || !alignments.includes(verticalAlign)) throw new Error('Grid child facts are invalid.');
      return { id: clean(child.id, 512), name: clean(String(child.name || ''), 1024), type: clean(String(child.type || ''), 64), parentId: clean(child.parent.id, 512), index, row, column, rowSpan, columnSpan, horizontalAlign, verticalAlign };
    };
    const sourceState = (child, source) => ({
      parentId: source.id, index: childIds(source, 'Source parent').indexOf(child.id),
      x: Number.isFinite(child.x) ? child.x : null, y: Number.isFinite(child.y) ? child.y : null,
      layoutPositioning: typeof child.layoutPositioning === 'string' ? child.layoutPositioning : null,
      grid: source.layoutMode === 'GRID' ? placement(child) : null,
    });
    const matches = (value) => value.parentId === request.gridId && value.row === request.row && value.column === request.column
      && (request.rowSpan === null || value.rowSpan === request.rowSpan)
      && (request.columnSpan === null || value.columnSpan === request.columnSpan)
      && (request.horizontalAlign === null || value.horizontalAlign === request.horizontalAlign)
      && (request.verticalAlign === null || value.verticalAlign === request.verticalAlign);
    const overlaps = (other, rowSpan, columnSpan) => {
      const item = placement(other);
      return request.row < item.row + item.rowSpan && request.row + rowSpan > item.row
        && request.column < item.column + item.columnSpan && request.column + columnSpan > item.column;
    };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: 'place', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Grid Place preflight failed.' });
    const failed = (outcome, failure, restored, residue) => bounded({ schemaVersion: 1, status: 'failed', action: 'place', outcome, attempted: 1, restored, failure: clean(failure, 1024) || 'Grid Place verification failed.', residue });

    let grid, child, source, beforeSourceIds, beforeGridIds, before;
    try {
      if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Figma node lookup is unavailable.');
      grid = await figma.getNodeByIdAsync(request.gridId); const facts = gridFacts(grid);
      child = await figma.getNodeByIdAsync(request.childId);
      if (!child || child.type === 'DOCUMENT' || child.type === 'PAGE' || child.id === grid.id
        || typeof child.id !== 'string' || typeof child.name !== 'string' || typeof child.type !== 'string') throw new Error('Grid Place requires one exact Scene child.');
      if (facts.itemsPositioning !== 'MANUAL') throw new Error('Grid Place requires manual Grid item positioning.');
      source = child.parent;
      if (!source || typeof source.id !== 'string' || typeof source.insertChild !== 'function') throw new Error('Grid Place source cannot restore its child.');
      let cursor = grid;
      for (let depth = 0; cursor && depth <= ${MAX_GRID_PLACE_ANCESTORS}; depth++) {
        if (cursor.id === child.id) throw new Error('Grid Place cannot move an ancestor into its descendant.');
        cursor = cursor.parent || null;
        if (depth === ${MAX_GRID_PLACE_ANCESTORS} && cursor) throw new Error('Grid Place ancestry exceeds its bounded depth.');
      }
      beforeSourceIds = childIds(source, 'Source parent'); beforeGridIds = source.id === grid.id ? [...beforeSourceIds] : childIds(grid, 'Grid');
      before = sourceState(child, source);
      if (before.index < 0 || beforeSourceIds.indexOf(child.id, before.index + 1) !== -1) throw new Error('Source parent does not contain exactly one child identity.');
      const rowSpan = request.rowSpan === null ? (Number.isSafeInteger(child.gridRowSpan) && child.gridRowSpan > 0 ? child.gridRowSpan : 1) : request.rowSpan;
      const columnSpan = request.columnSpan === null ? (Number.isSafeInteger(child.gridColumnSpan) && child.gridColumnSpan > 0 ? child.gridColumnSpan : 1) : request.columnSpan;
      if (request.row + rowSpan > facts.rows || request.column + columnSpan > facts.columns) throw new Error('Requested Grid cell or span is outside the bounded Grid dimensions.');
      for (const other of grid.children) if (other.id !== child.id && overlaps(other, rowSpan, columnSpan)) throw new Error('Requested Grid cells are already occupied.');
    } catch (error) { return refusal(error); }

    if (source.id === grid.id && matches(before.grid)) {
      return bounded({ schemaVersion: 1, status: 'unchanged', action: 'place', outcome: 'no-mutation', attempted: 0, grid: gridFacts(grid), child: before.grid, residue: [], warnings: [] });
    }

    let mutationError = null; let failure = 'Fresh Grid Place postcondition failed.';
    try {
      try {
        try { grid.appendChildAt(child, request.row, request.column); }
        catch (error) { mutationError = error; failure = error && error.message ? error.message : String(error); }
        if (child.parent && child.parent.id === grid.id) {
          for (const [field, value] of [
            ['gridRowSpan', request.rowSpan], ['gridColumnSpan', request.columnSpan],
            ['gridChildHorizontalAlign', request.horizontalAlign], ['gridChildVerticalAlign', request.verticalAlign],
          ]) {
            if (value === null) continue;
            try { child[field] = value; }
            catch (error) { mutationError ||= error; failure = error && error.message ? error.message : String(error); }
          }
        }
      } catch (error) { mutationError ||= error; failure = error && error.message ? error.message : String(error); }
      const freshGrid = await figma.getNodeByIdAsync(request.gridId);
      const freshChild = await figma.getNodeByIdAsync(request.childId);
      const freshSource = source.id === grid.id ? freshGrid : await figma.getNodeByIdAsync(source.id);
      const gridIds = childIds(freshGrid, 'Fresh Grid'); const sourceIds = source.id === grid.id ? gridIds : childIds(freshSource, 'Fresh source parent');
      const expectedSource = source.id === grid.id ? null : beforeSourceIds.filter((id) => id !== child.id);
      const otherGridIds = beforeGridIds.filter((id) => id !== child.id);
      const freshOtherGridIds = gridIds.filter((id) => id !== child.id);
      const actual = placement(freshChild);
      if (matches(actual) && gridIds.filter((id) => id === child.id).length === 1
        && sameIds(otherGridIds, freshOtherGridIds)
        && (expectedSource === null || sameIds(expectedSource, sourceIds))) {
        delete globalThis.__invCache;
        return bounded({ schemaVersion: 1, status: 'placed', action: 'place', outcome: mutationError ? 'verified-after-error' : 'verified', attempted: 1, grid: gridFacts(freshGrid), child: actual, residue: [], warnings: mutationError ? ['A native Grid placement operation reported an error, but fresh readback proved the requested state.'] : [] });
      }
    } catch (error) { failure = error && error.message ? error.message : String(error); }

    try {
      const rollbackChild = await figma.getNodeByIdAsync(request.childId);
      const rollbackSource = await figma.getNodeByIdAsync(source.id);
      const rollbackGrid = source.id === grid.id ? rollbackSource : await figma.getNodeByIdAsync(request.gridId);
      if (!rollbackChild || !rollbackSource || !rollbackGrid) throw new Error('Grid Place rollback identities are unavailable.');
      try { rollbackSource.insertChild(before.index, rollbackChild); } catch {}
      if (before.grid) {
        try { rollbackChild.gridRowSpan = 1; rollbackChild.gridColumnSpan = 1; } catch {}
        try { rollbackChild.setGridChildPosition(before.grid.row, before.grid.column); } catch {}
        try { rollbackChild.gridRowSpan = before.grid.rowSpan; } catch {}
        try { rollbackChild.gridColumnSpan = before.grid.columnSpan; } catch {}
        try { rollbackChild.gridChildHorizontalAlign = before.grid.horizontalAlign; } catch {}
        try { rollbackChild.gridChildVerticalAlign = before.grid.verticalAlign; } catch {}
      } else {
        try { if (before.x !== null) rollbackChild.x = before.x; } catch {}
        try { if (before.y !== null) rollbackChild.y = before.y; } catch {}
        try { if (before.layoutPositioning !== null) rollbackChild.layoutPositioning = before.layoutPositioning; } catch {}
      }
      const restoredChild = await figma.getNodeByIdAsync(request.childId);
      const restoredSource = await figma.getNodeByIdAsync(source.id);
      const restoredGrid = source.id === grid.id ? restoredSource : await figma.getNodeByIdAsync(request.gridId);
      const restoredSourceIds = childIds(restoredSource, 'Restored source parent'); const restoredGridIds = source.id === grid.id ? restoredSourceIds : childIds(restoredGrid, 'Restored Grid');
      const parentChanged = !restoredChild.parent || restoredChild.parent.id !== source.id;
      const sourceOrderChanged = !sameIds(restoredSourceIds, beforeSourceIds);
      const gridOrderChanged = !sameIds(restoredGridIds, beforeGridIds);
      let placementChanged = false; let presentationChanged = false;
      if (before.grid) {
        const restored = placement(restoredChild);
        placementChanged = restored.row !== before.grid.row || restored.column !== before.grid.column || restored.rowSpan !== before.grid.rowSpan || restored.columnSpan !== before.grid.columnSpan;
        presentationChanged = restored.horizontalAlign !== before.grid.horizontalAlign || restored.verticalAlign !== before.grid.verticalAlign;
      } else {
        placementChanged = (before.x !== null && restoredChild.x !== before.x) || (before.y !== null && restoredChild.y !== before.y);
        presentationChanged = before.layoutPositioning !== null && restoredChild.layoutPositioning !== before.layoutPositioning;
      }
      const residue = { parentChanged, sourceOrderChanged, gridOrderChanged, placementChanged, presentationChanged };
      const count = Object.values(residue).filter(Boolean).length;
      if (!count) delete globalThis.__invCache;
      return failed(count ? 'partial-residue' : 'rolled-back', failure, count ? 0 : 1, residue);
    } catch { return failed('verification-unavailable', failure, 0, { parentChanged: false, sourceOrderChanged: false, gridOrderChanged: false, placementChanged: false, presentationChanged: false }); }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, maximum, empty = true) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
const safeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validTrack(value) { return exact(value, value?.value === undefined ? ['type'] : ['type','value']) && TRACK_TYPES.includes(value.type) && (value.value === undefined || finite(value.value)); }
function validGrid(value, input) {
  return exact(value, ['id','name','type','layoutMode','rows','columns','rowGap','columnGap','rowSizes','columnSizes','autoTracks','itemsPositioning'])
    && value.id === input.gridId && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id)
    && text(value.name, 1024) && text(value.type, 64, false) && value.layoutMode === 'GRID'
    && safeInteger(value.rows, 1) && value.rows <= MAX_GRID_PLACE_TRACKS && safeInteger(value.columns, 1) && value.columns <= MAX_GRID_PLACE_TRACKS
    && finite(value.rowGap) && finite(value.columnGap)
    && Array.isArray(value.rowSizes) && value.rowSizes.length === value.rows && value.rowSizes.every(validTrack)
    && Array.isArray(value.columnSizes) && value.columnSizes.length === value.columns && value.columnSizes.every(validTrack)
    && ['NONE','ROWS'].includes(value.autoTracks) && ['MANUAL','ROW_AUTO_FLOW'].includes(value.itemsPositioning);
}
function validChild(value, input) {
  return exact(value, ['id','name','type','parentId','index','row','column','rowSpan','columnSpan','horizontalAlign','verticalAlign'])
    && value.id === input.childId && value.parentId === input.gridId
    && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id) && text(value.parentId, 512, false)
    && text(value.name, 1024) && text(value.type, 64, false) && safeInteger(value.index)
    && value.row === input.row && value.column === input.column && safeInteger(value.row) && safeInteger(value.column)
    && safeInteger(value.rowSpan, 1) && safeInteger(value.columnSpan, 1)
    && (input.rowSpan === null || value.rowSpan === input.rowSpan) && (input.columnSpan === null || value.columnSpan === input.columnSpan)
    && ALIGNMENTS.includes(value.horizontalAlign) && ALIGNMENTS.includes(value.verticalAlign)
    && (input.horizontalAlign === null || value.horizontalAlign === input.horizontalAlign)
    && (input.verticalAlign === null || value.verticalAlign === input.verticalAlign);
}
function validRefusal(value) { return exact(value, ['schemaVersion','status','action','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.action === 'place' && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validResidue(value) { return exact(value, ['parentChanged','sourceOrderChanged','gridOrderChanged','placementChanged','presentationChanged']) && Object.values(value).every((entry) => typeof entry === 'boolean'); }
function validFailure(value) { const count = value?.residue && Object.values(value.residue).filter(Boolean).length; return exact(value, ['schemaVersion','status','action','outcome','attempted','restored','failure','residue']) && value.schemaVersion === 1 && value.status === 'failed' && value.action === 'place' && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && text(value.failure, 1024, false) && validResidue(value.residue) && (value.outcome === 'rolled-back' ? value.restored === 1 && count === 0 : value.restored === 0) && (value.outcome !== 'partial-residue' || count > 0) && (value.outcome !== 'verification-unavailable' || count === 0); }
function validSuccess(value, input) { const warnings = Array.isArray(value?.warnings) && value.warnings.length <= 1 && value.warnings.every((warning) => text(warning, 1024, false)); const status = value?.status === 'unchanged' ? value.outcome === 'no-mutation' && value.attempted === 0 && value.warnings.length === 0 : value?.status === 'placed' && ['verified','verified-after-error'].includes(value.outcome) && value.attempted === 1 && (value.outcome === 'verified-after-error' ? value.warnings.length === 1 : value.warnings.length === 0); return exact(value, ['schemaVersion','status','action','outcome','attempted','grid','child','residue','warnings']) && value.schemaVersion === 1 && value.action === 'place' && status && validGrid(value.grid, input) && validChild(value.child, input) && Array.isArray(value.residue) && value.residue.length === 0 && warnings; }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' }); return error; }
function safe(value) { return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }

export async function executeGridPlace(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Grid Place requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(gridPlaceCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_GRID_PLACE_RESULT_CODE_UNITS) throw invalid('Grid Place returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Grid Place returned invalid JSON.'); }
  if (payload?.status === 'refused') { if (!validRefusal(payload)) throw invalid('Grid Place returned an invalid bounded result.'); throw mutationError(`Grid Place made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); }
  if (payload?.status === 'failed') { if (!validFailure(payload)) throw invalid('Grid Place returned an invalid bounded result.'); const count = payload.outcome === 'verification-unavailable' ? 5 : Object.values(payload.residue).filter(Boolean).length; throw mutationError(`Grid Place failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: count }); }
  if (!validSuccess(payload, input)) throw invalid('Grid Place returned an invalid bounded result.');
  return { stdout: safe({ grid: payload.grid, child: { id: payload.child.id, name: payload.child.name, row: payload.child.row, column: payload.child.column, rowSpan: payload.child.rowSpan, columnSpan: payload.child.columnSpan, horizontalAlign: payload.child.horizontalAlign, verticalAlign: payload.child.verticalAlign } }), stderr: '', result: payload };
}
export function gridPlacePlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Grid Place routing requires a Command Plan.'); return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-grid-place'; }
export function executeGridPlacePlan(plan, adapters = {}) { if (gridPlacePlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Grid Place.'); return executeGridPlace(parseGridPlaceRequest(plan.argv), adapters); }
