// Plan-bound, freshly verified native Auto Layout Grid track reordering.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  gridTrackReorderArgvFromRequest,
  gridTrackReorderPlanningArgvFromRequest,
  parseGridTrackReorderRequest,
} from './grid-track-reorder-request.js';

export { gridTrackReorderArgvFromRequest, gridTrackReorderPlanningArgvFromRequest } from './grid-track-reorder-request.js';

const APPLICATION_IDS = Object.freeze(['layout.grid.reorder-rows', 'layout.grid.reorder-columns']);
export const MAX_GRID_TRACK_REORDER_TRACKS = 4_096;
export const MAX_GRID_TRACK_REORDER_CHILDREN = 4_096;
export const MAX_GRID_TRACK_REORDER_RESULT_CODE_UNITS = 128_000;
const TRACK_TYPES = Object.freeze(['FLEX', 'FIXED', 'HUG']);
const ALIGNMENTS = Object.freeze(['AUTO', 'MIN', 'CENTER', 'MAX']);
const normalized = (request) => parseGridTrackReorderRequest(gridTrackReorderArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function gridTrackReorderCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)}; const trackTypes = ${js(TRACK_TYPES)}; const alignments = ${js(ALIGNMENTS)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_GRID_TRACK_REORDER_RESULT_CODE_UNITS}) throw new Error('Grid Track Reorder result exceeded its bounded response limit.'); return serialized; };
    const track = (value) => { if (!value || !trackTypes.includes(value.type)) throw new Error('Grid track facts are invalid.'); const result = { type: value.type }; if (value.value !== undefined) { if (!Number.isFinite(value.value) || value.value < 0) throw new Error('Grid track value is invalid.'); result.value = value.value; } return result; };
    const tracksEqual = (left, right) => left.length === right.length && left.every((value, index) => value.type === right[index].type && value.value === right[index].value);
    const gridFacts = (grid) => {
      if (!grid || grid.layoutMode !== 'GRID' || !Number.isSafeInteger(grid.gridRowCount) || grid.gridRowCount < 1 || grid.gridRowCount > ${MAX_GRID_TRACK_REORDER_TRACKS}
        || !Number.isSafeInteger(grid.gridColumnCount) || grid.gridColumnCount < 1 || grid.gridColumnCount > ${MAX_GRID_TRACK_REORDER_TRACKS}
        || !Number.isFinite(grid.gridRowGap) || grid.gridRowGap < 0 || !Number.isFinite(grid.gridColumnGap) || grid.gridColumnGap < 0
        || !Array.isArray(grid.gridRowSizes) || grid.gridRowSizes.length !== grid.gridRowCount
        || !Array.isArray(grid.gridColumnSizes) || grid.gridColumnSizes.length !== grid.gridColumnCount
        || !['NONE','ROWS'].includes(grid.gridAutoTracks) || !['MANUAL','ROW_AUTO_FLOW'].includes(grid.gridItemsPositioning)) throw new Error('Grid Track Reorder requires one bounded native Auto Layout Grid container.');
      return { id: clean(grid.id, 512), name: clean(String(grid.name || ''), 1024), type: clean(String(grid.type || ''), 64), layoutMode: 'GRID', rows: grid.gridRowCount, columns: grid.gridColumnCount, rowGap: grid.gridRowGap, columnGap: grid.gridColumnGap, rowSizes: Array.from(grid.gridRowSizes, track), columnSizes: Array.from(grid.gridColumnSizes, track), autoTracks: grid.gridAutoTracks, itemsPositioning: grid.gridItemsPositioning };
    };
    const childFacts = (grid) => {
      if (!Array.isArray(grid.children) || grid.children.length > ${MAX_GRID_TRACK_REORDER_CHILDREN}) throw new Error('Grid child facts exceed their bound.');
      const result = grid.children.map((child) => {
        const row = child.gridRowAnchorIndex, column = child.gridColumnAnchorIndex, rowSpan = child.gridRowSpan, columnSpan = child.gridColumnSpan;
        const horizontalAlign = child.gridChildHorizontalAlign, verticalAlign = child.gridChildVerticalAlign;
        if (!child || typeof child.id !== 'string' || !Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0
          || !Number.isSafeInteger(rowSpan) || rowSpan < 1 || !Number.isSafeInteger(columnSpan) || columnSpan < 1
          || row + rowSpan > grid.gridRowCount || column + columnSpan > grid.gridColumnCount
          || !alignments.includes(horizontalAlign) || !alignments.includes(verticalAlign)) throw new Error('Grid child placement facts are invalid.');
        return { id: child.id, row, column, rowSpan, columnSpan, horizontalAlign, verticalAlign };
      });
      if (new Set(result.map(({ id }) => id)).size !== result.length) throw new Error('Grid child identities are invalid.');
      return result;
    };
    const sameGrid = (left, right) => left.id === right.id && left.name === right.name && left.type === right.type && left.layoutMode === right.layoutMode
      && left.rows === right.rows && left.columns === right.columns && left.rowGap === right.rowGap && left.columnGap === right.columnGap
      && tracksEqual(left.rowSizes, right.rowSizes) && tracksEqual(left.columnSizes, right.columnSizes)
      && left.autoTracks === right.autoTracks && left.itemsPositioning === right.itemsPositioning;
    const sameChildren = (left, right) => left.length === right.length && left.every((value, index) => Object.keys(value).every((key) => value[key] === right[index][key]));
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: 'reorder-' + request.axis, outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Grid Track Reorder preflight failed.' });
    const failed = (outcome, attempted, residueCount, error) => bounded({ schemaVersion: 1, status: 'failed', action: 'reorder-' + request.axis, outcome, attempted, restored: 0, residueCount, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Grid Track Reorder verification failed.' });
    let grid, beforeGrid, beforeChildren, count, method;
    try {
      if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Figma node lookup is unavailable.');
      grid = await figma.getNodeByIdAsync(request.nodeId); beforeGrid = gridFacts(grid); beforeChildren = childFacts(grid);
      count = request.axis === 'rows' ? beforeGrid.rows : beforeGrid.columns;
      if (request.fromIndices.some((index) => index >= count)) throw new Error('One or more source track indices are out of range.');
      if (request.insertionIndex > count) throw new Error('The insertion track index is out of range.');
      method = request.axis === 'rows' ? 'reorderRows' : 'reorderColumns';
      if (typeof grid[method] !== 'function') throw new Error('Native Grid track reordering is unavailable.');
    } catch (error) { return refusal(error); }
    let moves = null; let nativeError = null;
    try { moves = grid[method]({ fromIndices: request.fromIndices, insertionIndex: request.insertionIndex }); }
    catch (error) { nativeError = error; }
    let freshGrid, freshChildren;
    try { const fresh = await figma.getNodeByIdAsync(request.nodeId); freshGrid = gridFacts(fresh); freshChildren = childFacts(fresh); }
    catch (error) { return failed('verification-unavailable', 1, Math.min(100000, count + beforeChildren.length), nativeError || error); }
    if (nativeError) {
      if (sameGrid(beforeGrid, freshGrid) && sameChildren(beforeChildren, freshChildren)) return failed('no-mutation', 0, 0, nativeError);
      let residue = sameGrid(beforeGrid, freshGrid) ? 0 : 1;
      for (let index = 0; index < Math.max(beforeChildren.length, freshChildren.length); index++) if (!beforeChildren[index] || !freshChildren[index] || Object.keys(beforeChildren[index]).some((key) => beforeChildren[index][key] !== freshChildren[index][key])) residue++;
      return failed('partial-residue', 1, Math.max(1, Math.min(100000, residue)), nativeError);
    }
    try {
      if (!Array.isArray(moves) || moves.length > count) throw new Error('Native Grid track permutation is invalid.');
      const mapping = Array.from({ length: count }, (_, index) => index); const from = new Set(); const to = new Set();
      for (const move of moves) {
        if (!move || Object.keys(move).sort().join(',') !== 'from,to' || !Number.isSafeInteger(move.from) || move.from < 0 || move.from >= count || !Number.isSafeInteger(move.to) || move.to < 0 || move.to >= count || from.has(move.from) || to.has(move.to)) throw new Error('Native Grid track permutation is invalid.');
        from.add(move.from); to.add(move.to); mapping[move.from] = move.to;
      }
      if (new Set(mapping).size !== count) throw new Error('Native Grid track permutation is incomplete.');
      const selected = new Set(request.fromIndices); let expanded = true;
      while (expanded) {
        expanded = false;
        for (const child of beforeChildren) {
          const anchor = request.axis === 'rows' ? child.row : child.column; const span = request.axis === 'rows' ? child.rowSpan : child.columnSpan;
          const intersects = Array.from({ length: span }, (_, offset) => anchor + offset).some((index) => selected.has(index));
          if (intersects) for (let offset = 0; offset < span; offset++) if (!selected.has(anchor + offset)) { selected.add(anchor + offset); expanded = true; }
        }
      }
      const selectedIndices = [...selected].sort((left, right) => left - right);
      const remaining = Array.from({ length: count }, (_, index) => index).filter((index) => !selected.has(index));
      const adjustedInsertion = request.insertionIndex - selectedIndices.filter((index) => index < request.insertionIndex).length;
      const expectedOrder = [...remaining]; expectedOrder.splice(adjustedInsertion, 0, ...selectedIndices);
      const expectedMapping = Array(count); for (let index = 0; index < count; index++) expectedMapping[expectedOrder[index]] = index;
      if (mapping.some((value, index) => value !== expectedMapping[index])) throw new Error('Native Grid track permutation did not match the requested move.');
      const beforeAxis = request.axis === 'rows' ? beforeGrid.rowSizes : beforeGrid.columnSizes;
      const expectedAxis = Array(count); for (let index = 0; index < count; index++) expectedAxis[mapping[index]] = beforeAxis[index];
      const freshAxis = request.axis === 'rows' ? freshGrid.rowSizes : freshGrid.columnSizes;
      let residue = tracksEqual(expectedAxis, freshAxis) ? 0 : 1;
      const stableGrid = { ...beforeGrid, [request.axis === 'rows' ? 'rowSizes' : 'columnSizes']: freshAxis };
      if (!sameGrid(stableGrid, freshGrid)) residue++;
      if (beforeChildren.length !== freshChildren.length) residue += Math.abs(beforeChildren.length - freshChildren.length) || 1;
      for (let index = 0; index < Math.min(beforeChildren.length, freshChildren.length); index++) {
        const prior = beforeChildren[index], actual = freshChildren[index];
        const anchor = request.axis === 'rows' ? prior.row : prior.column; const span = request.axis === 'rows' ? prior.rowSpan : prior.columnSpan;
        const mapped = Array.from({ length: span }, (_, offset) => mapping[anchor + offset]).sort((a, b) => a - b);
        const contiguous = mapped.every((value, offset) => value === mapped[0] + offset);
        const expected = { ...prior, [request.axis === 'rows' ? 'row' : 'column']: mapped[0] };
        if (!contiguous || Object.keys(expected).some((key) => expected[key] !== actual[key])) residue++;
      }
      if (residue) return failed('partial-residue', 1, Math.min(100000, residue), new Error('Fresh Grid track postcondition did not match the native permutation.'));
      const reportedMoves = [...moves].sort((left, right) => left.from - right.from);
      delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: reportedMoves.length ? 'reordered' : 'unchanged', action: 'reorder-' + request.axis, outcome: reportedMoves.length ? 'verified' : 'no-mutation', attempted: 1, grid: freshGrid, moves: reportedMoves, residueCount: 0 });
    } catch (error) {
      if (sameGrid(beforeGrid, freshGrid) && sameChildren(beforeChildren, freshChildren)) return failed('no-mutation', 0, 0, error);
      return failed('partial-residue', 1, 1, error);
    }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, maximum, empty = true) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
const safeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validTrack(value) { return exact(value, value?.value === undefined ? ['type'] : ['type','value']) && TRACK_TYPES.includes(value.type) && (value.value === undefined || finite(value.value)); }
function validGrid(value, input) { return exact(value, ['id','name','type','layoutMode','rows','columns','rowGap','columnGap','rowSizes','columnSizes','autoTracks','itemsPositioning']) && value.id === input.nodeId && text(value.id,512,false) && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name,1024) && text(value.type,64,false) && value.layoutMode === 'GRID' && safeInteger(value.rows,1) && value.rows <= MAX_GRID_TRACK_REORDER_TRACKS && safeInteger(value.columns,1) && value.columns <= MAX_GRID_TRACK_REORDER_TRACKS && finite(value.rowGap) && finite(value.columnGap) && Array.isArray(value.rowSizes) && value.rowSizes.length === value.rows && value.rowSizes.every(validTrack) && Array.isArray(value.columnSizes) && value.columnSizes.length === value.columns && value.columnSizes.every(validTrack) && ['NONE','ROWS'].includes(value.autoTracks) && ['MANUAL','ROW_AUTO_FLOW'].includes(value.itemsPositioning); }
function validMoves(value, grid, axis) {
  const count = axis === 'rows' ? grid.rows : grid.columns;
  if (!Array.isArray(value) || value.length > count) return false;
  const from = new Set(); const to = new Set(); const mapping = Array.from({ length: count }, (_, index) => index);
  let previousFrom = -1;
  for (const move of value) {
    if (!exact(move,['from','to']) || !safeInteger(move.from) || move.from >= count
      || !safeInteger(move.to) || move.to >= count || move.from <= previousFrom || move.from === move.to
      || from.has(move.from) || to.has(move.to)) return false;
    from.add(move.from); to.add(move.to); mapping[move.from] = move.to; previousFrom = move.from;
  }
  return new Set(mapping).size === count;
}
function validRefusal(value, input) { return exact(value,['schemaVersion','status','action','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.action === `reorder-${input.axis}` && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure,1024,false); }
function validFailure(value, input) { return exact(value,['schemaVersion','status','action','outcome','attempted','restored','residueCount','failure']) && value.schemaVersion === 1 && value.status === 'failed' && value.action === `reorder-${input.axis}` && ['no-mutation','partial-residue','verification-unavailable'].includes(value.outcome) && value.restored === 0 && safeInteger(value.residueCount) && value.residueCount <= 100000 && text(value.failure,1024,false) && (value.outcome === 'no-mutation' ? value.attempted === 0 && value.residueCount === 0 : value.attempted === 1) && (value.outcome !== 'partial-residue' || value.residueCount > 0); }
function validSuccess(value, input) { return exact(value,['schemaVersion','status','action','outcome','attempted','grid','moves','residueCount']) && value.schemaVersion === 1 && value.action === `reorder-${input.axis}` && value.attempted === 1 && value.residueCount === 0 && validGrid(value.grid,input) && validMoves(value.moves,value.grid,input.axis) && (value.status === 'reordered' ? value.outcome === 'verified' && value.moves.length > 0 : value.status === 'unchanged' && value.outcome === 'no-mutation' && value.moves.length === 0); }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error,{ kind:'execution', phase:'plugin-execution', outcome:'unknown-after-dispatch', dispatchState:'failed', mutationOutcome:outcome, mutationReport:report }); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error,{ kind:'plugin-result', phase:'plugin-response', outcome:'unknown-after-dispatch', dispatchState:'failed' }); return error; }
function safe(value) { return JSON.stringify(value,null,2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,(character)=>`\\u${character.charCodeAt(0).toString(16).padStart(4,'0')}`); }

export async function executeGridTrackReorder(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Grid Track Reorder requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(gridTrackReorderCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_GRID_TRACK_REORDER_RESULT_CODE_UNITS) throw invalid('Grid Track Reorder returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Grid Track Reorder returned invalid JSON.'); }
  if (payload?.status === 'refused') { if (!validRefusal(payload,input)) throw invalid('Grid Track Reorder returned an invalid bounded result.'); throw mutationError(`Grid Track Reorder made no mutation: ${payload.failure}`,'no-mutation',{version:1,outcome:'no-mutation',attempted:0,restored:0,residueCount:0}); }
  if (payload?.status === 'failed') { if (!validFailure(payload,input)) throw invalid('Grid Track Reorder returned an invalid bounded result.'); throw mutationError(`Grid Track Reorder failed with ${payload.outcome}: ${payload.failure}`,payload.outcome,{version:1,outcome:payload.outcome,attempted:payload.attempted,restored:0,residueCount:payload.residueCount}); }
  if (!validSuccess(payload,input)) throw invalid('Grid Track Reorder returned an invalid bounded result.');
  return { stdout:safe({grid:payload.grid,moves:payload.moves}),stderr:'',result:payload };
}
export function gridTrackReorderPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Grid Track Reorder routing requires a Command Plan.'); return plan.allowed && APPLICATION_IDS.includes(plan.id) ? 'command-application' : 'not-grid-track-reorder'; }
export function executeGridTrackReorderPlan(plan, adapters = {}) { if (gridTrackReorderPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Grid Track Reorder.'); return executeGridTrackReorder(parseGridTrackReorderRequest(plan.argv),adapters); }
