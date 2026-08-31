// Plan-bound, journaled Auto Layout Grid configuration mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  gridSetArgvFromRequest,
  gridSetPlanningArgvFromRequest,
  MAX_GRID_SET_TRACKS,
  parseGridSetRequest,
} from './grid-set-request.js';

export { gridSetArgvFromRequest, gridSetPlanningArgvFromRequest } from './grid-set-request.js';

const APPLICATION_ID = 'layout.grid.set';
export const MAX_GRID_SET_CHILDREN = 4_096;
export const MAX_GRID_SET_RESULT_CODE_UNITS = 768_000;
const TRACK_TYPES = Object.freeze(['FLEX', 'FIXED', 'HUG']);
const LAYOUT_MODES = Object.freeze(['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID']);
const AUTO_TRACKS = Object.freeze(['NONE', 'ROWS']);
const POSITIONING = Object.freeze(['MANUAL', 'ROW_AUTO_FLOW']);
const ALIGNMENTS = Object.freeze(['AUTO', 'MIN', 'CENTER', 'MAX']);
const CHILD_POSITIONING = Object.freeze(['AUTO', 'ABSOLUTE']);
const normalized = (request) => parseGridSetRequest(gridSetArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function gridSetCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)}; const trackTypes = ${js(TRACK_TYPES)}; const layoutModes = ${js(LAYOUT_MODES)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_GRID_SET_RESULT_CODE_UNITS}) throw new Error('Grid Set result exceeded its bounded response limit.'); return serialized; };
    const track = (value) => { if (!value || !trackTypes.includes(value.type)) throw new Error('Grid track facts are invalid.'); const result = { type: value.type }; if (value.value !== undefined) { if (!Number.isFinite(value.value) || value.value < 0) throw new Error('Grid track value is invalid.'); result.value = value.value; } return result; };
    const tracksEqual = (left, right) => left.length === right.length && left.every((value, index) => value.type === right[index].type && value.value === right[index].value);
    const gridFacts = (node) => {
      const mode = node && node.layoutMode; const rows = node && node.gridRowCount; const columns = node && node.gridColumnCount;
      if (!node || !layoutModes.includes(mode) || !Number.isSafeInteger(rows) || rows < (mode === 'GRID' ? 1 : 0) || rows > ${MAX_GRID_SET_TRACKS}
        || !Number.isSafeInteger(columns) || columns < (mode === 'GRID' ? 1 : 0) || columns > ${MAX_GRID_SET_TRACKS}
        || !Number.isFinite(node.gridRowGap) || node.gridRowGap < 0 || !Number.isFinite(node.gridColumnGap) || node.gridColumnGap < 0
        || !Array.isArray(node.gridRowSizes) || node.gridRowSizes.length !== rows || !Array.isArray(node.gridColumnSizes) || node.gridColumnSizes.length !== columns
        || !${js(AUTO_TRACKS)}.includes(node.gridAutoTracks) || !${js(POSITIONING)}.includes(node.gridItemsPositioning)) throw new Error('Grid Set requires one bounded Grid-capable container.');
      return { layoutMode: mode, rows, columns, rowGap: node.gridRowGap, columnGap: node.gridColumnGap, rowSizes: Array.from(node.gridRowSizes, track), columnSizes: Array.from(node.gridColumnSizes, track), autoTracks: node.gridAutoTracks, itemsPositioning: node.gridItemsPositioning };
    };
    const childFacts = (node, grid) => {
      if (!Array.isArray(node.children) || node.children.length > ${MAX_GRID_SET_CHILDREN}) throw new Error('Grid Set child facts exceed their bound.');
      const children = node.children.map((child) => {
        const row = child.gridRowAnchorIndex, column = child.gridColumnAnchorIndex, rowSpan = child.gridRowSpan, columnSpan = child.gridColumnSpan;
        if (!child || typeof child.id !== 'string' || !Number.isFinite(child.x) || !Number.isFinite(child.y)
          || !${js(CHILD_POSITIONING)}.includes(child.layoutPositioning) || !Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0
          || !Number.isSafeInteger(rowSpan) || rowSpan < 1 || !Number.isSafeInteger(columnSpan) || columnSpan < 1
          || !${js(ALIGNMENTS)}.includes(child.gridChildHorizontalAlign) || !${js(ALIGNMENTS)}.includes(child.gridChildVerticalAlign)
          || (grid.layoutMode === 'GRID' && (row + rowSpan > grid.rows || column + columnSpan > grid.columns))) throw new Error('Grid Set child facts are invalid.');
        return { id: child.id, x: child.x, y: child.y, layoutPositioning: child.layoutPositioning, row, column, rowSpan, columnSpan, horizontalAlign: child.gridChildHorizontalAlign, verticalAlign: child.gridChildVerticalAlign };
      });
      if (new Set(children.map(({ id }) => id)).size !== children.length) throw new Error('Grid Set child identities are invalid.');
      return children;
    };
    const nodeFacts = (node) => ({ id: clean(node.id, 512), name: clean(String(node.name || ''), 1024), type: clean(String(node.type || ''), 64) });
    const sameGrid = (left, right) => left.layoutMode === right.layoutMode && left.rows === right.rows && left.columns === right.columns
      && left.rowGap === right.rowGap && left.columnGap === right.columnGap && tracksEqual(left.rowSizes, right.rowSizes)
      && tracksEqual(left.columnSizes, right.columnSizes) && left.autoTracks === right.autoTracks && left.itemsPositioning === right.itemsPositioning;
    const sameChildGrid = (left, right) => left.id === right.id && left.layoutPositioning === right.layoutPositioning && left.row === right.row && left.column === right.column && left.rowSpan === right.rowSpan && left.columnSpan === right.columnSpan && left.horizontalAlign === right.horizontalAlign && left.verticalAlign === right.verticalAlign;
    const sameChildFree = (left, right) => left.id === right.id && left.x === right.x && left.y === right.y && left.layoutPositioning === right.layoutPositioning;
    const sameChildren = (left, right, compare) => left.length === right.length && left.every((value, index) => right[index] && compare(value, right[index]));
    const requestedTracksMatch = (actual, desired) => !desired || desired.length === actual.length && desired.every((value, index) => actual[index].type === value.type && (value.value === undefined || actual[index].value === value.value));
    const requestSatisfied = (actual) => actual.layoutMode === 'GRID'
      && (request.rows === undefined || actual.rows === request.rows) && (request.columns === undefined || actual.columns === request.columns)
      && (request.rowSizes === undefined || actual.rows === request.rowSizes.length) && (request.columnSizes === undefined || actual.columns === request.columnSizes.length)
      && (request.rowGap === undefined || actual.rowGap === request.rowGap) && (request.columnGap === undefined || actual.columnGap === request.columnGap)
      && requestedTracksMatch(actual.rowSizes, request.rowSizes) && requestedTracksMatch(actual.columnSizes, request.columnSizes);
    const prefixPreserved = (before, after) => before.slice(0, Math.min(before.length, after.length)).every((value, index) => value.type === after[index].type && value.value === after[index].value);
    const preserved = (before, after, beforeChildren, afterChildren) => {
      if (before.layoutMode !== 'GRID') return sameChildren(beforeChildren, afterChildren, (left, right) => left.id === right.id);
      if (before.autoTracks !== after.autoTracks || before.itemsPositioning !== after.itemsPositioning) return false;
      if (request.rows === undefined && request.rowSizes === undefined && before.rows !== after.rows) return false;
      if (request.columns === undefined && request.columnSizes === undefined && before.columns !== after.columns) return false;
      if (request.rowGap === undefined && before.rowGap !== after.rowGap) return false;
      if (request.columnGap === undefined && before.columnGap !== after.columnGap) return false;
      if (!request.rowSizes && !prefixPreserved(before.rowSizes, after.rowSizes)) return false;
      if (!request.columnSizes && !prefixPreserved(before.columnSizes, after.columnSizes)) return false;
      if (request.rowSizes && !requestedTracksMatch(after.rowSizes, request.rowSizes)) return false;
      if (request.columnSizes && !requestedTracksMatch(after.columnSizes, request.columnSizes)) return false;
      return before.itemsPositioning !== 'MANUAL' || sameChildren(beforeChildren, afterChildren, sameChildGrid);
    };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: 'set', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Grid Set preflight failed.' });
    const failed = (outcome, residueCount, error) => bounded({ schemaVersion: 1, status: 'failed', action: 'set', outcome, attempted: 1, restored: outcome === 'rolled-back' ? 1 : 0, residueCount, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Grid Set verification failed.' });
    let node, beforeNode, before, beforeChildren;
    try {
      if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Figma node lookup is unavailable.');
      node = await figma.getNodeByIdAsync(request.nodeId); beforeNode = nodeFacts(node); before = gridFacts(node); beforeChildren = childFacts(node, before);
      const targetRows = request.rows === undefined ? request.rowSizes ? request.rowSizes.length : before.rows : request.rows;
      const targetColumns = request.columns === undefined ? request.columnSizes ? request.columnSizes.length : before.columns : request.columns;
      if (before.layoutMode === 'GRID' && before.itemsPositioning === 'MANUAL') {
        if (beforeChildren.some((child) => child.row + child.rowSpan > targetRows || child.column + child.columnSpan > targetColumns)) throw new Error('Grid Set cannot shrink manual tracks beneath an occupied child span.');
      }
    } catch (error) { return refusal(error); }
    if (requestSatisfied(before)) return bounded({ schemaVersion: 1, status: 'unchanged', action: 'set', outcome: 'no-mutation', attempted: 0, node: beforeNode, before, after: before, residueCount: 0, warnings: [] });
    let mutationError = null;
    try {
      if (node.layoutMode !== 'GRID') node.layoutMode = 'GRID';
      const desiredRows = request.rows === undefined ? request.rowSizes && request.rowSizes.length : request.rows;
      const desiredColumns = request.columns === undefined ? request.columnSizes && request.columnSizes.length : request.columns;
      if (desiredRows && node.gridRowCount !== desiredRows) node.gridRowCount = desiredRows;
      if (desiredColumns && node.gridColumnCount !== desiredColumns) node.gridColumnCount = desiredColumns;
      if (request.rowGap !== undefined && node.gridRowGap !== request.rowGap) node.gridRowGap = request.rowGap;
      if (request.columnGap !== undefined && node.gridColumnGap !== request.columnGap) node.gridColumnGap = request.columnGap;
      if (request.rowSizes) for (let index = 0; index < request.rowSizes.length; index++) { const desired = request.rowSizes[index], current = node.gridRowSizes[index]; if (current.type !== desired.type) current.type = desired.type; if (desired.value !== undefined && current.value !== desired.value) current.value = desired.value; }
      if (request.columnSizes) for (let index = 0; index < request.columnSizes.length; index++) { const desired = request.columnSizes[index], current = node.gridColumnSizes[index]; if (current.type !== desired.type) current.type = desired.type; if (desired.value !== undefined && current.value !== desired.value) current.value = desired.value; }
    } catch (error) { mutationError = error; }
    try {
      const freshNode = await figma.getNodeByIdAsync(request.nodeId); const freshIdentity = nodeFacts(freshNode); const after = gridFacts(freshNode); const afterChildren = childFacts(freshNode, after);
      if (freshIdentity.id === beforeNode.id && freshIdentity.name === beforeNode.name && freshIdentity.type === beforeNode.type
        && requestSatisfied(after) && preserved(before, after, beforeChildren, afterChildren)) {
        return bounded({ schemaVersion: 1, status: 'applied', action: 'set', outcome: mutationError ? 'verified-after-error' : 'verified', attempted: 1, node: freshIdentity, before, after, residueCount: 0, warnings: mutationError ? ['A native Grid setter reported an error, but fresh readback proved the complete requested configuration.'] : [] });
      }
      mutationError ||= new Error('Fresh Grid Set postcondition failed.');
    } catch (error) { mutationError ||= error; }
    const restoreTrack = (target, prior) => { target.type = prior.type; if (prior.value !== undefined) target.value = prior.value; };
    try {
      if (before.layoutMode === 'GRID') {
        if (node.layoutMode !== 'GRID') node.layoutMode = 'GRID';
        if (node.gridRowCount < before.rows) node.gridRowCount = before.rows;
        if (node.gridColumnCount < before.columns) node.gridColumnCount = before.columns;
        for (let index = 0; index < before.rowSizes.length; index++) restoreTrack(node.gridRowSizes[index], before.rowSizes[index]);
        for (let index = 0; index < before.columnSizes.length; index++) restoreTrack(node.gridColumnSizes[index], before.columnSizes[index]);
        node.gridRowGap = before.rowGap; node.gridColumnGap = before.columnGap; node.gridAutoTracks = before.autoTracks; node.gridItemsPositioning = before.itemsPositioning;
        const currentById = new Map(node.children.map((child) => [child.id, child]));
        for (const prior of beforeChildren) { const child = currentById.get(prior.id); if (!child) continue; if (typeof child.setGridChildPosition === 'function') child.setGridChildPosition(prior.row, prior.column); child.gridRowSpan = prior.rowSpan; child.gridColumnSpan = prior.columnSpan; child.gridChildHorizontalAlign = prior.horizontalAlign; child.gridChildVerticalAlign = prior.verticalAlign; child.layoutPositioning = prior.layoutPositioning; }
        if (node.gridRowCount !== before.rows) node.gridRowCount = before.rows;
        if (node.gridColumnCount !== before.columns) node.gridColumnCount = before.columns;
        for (let index = 0; index < before.rowSizes.length; index++) restoreTrack(node.gridRowSizes[index], before.rowSizes[index]);
        for (let index = 0; index < before.columnSizes.length; index++) restoreTrack(node.gridColumnSizes[index], before.columnSizes[index]);
      } else {
        node.layoutMode = before.layoutMode;
        const currentById = new Map(node.children.map((child) => [child.id, child]));
        for (const prior of beforeChildren) { const child = currentById.get(prior.id); if (!child) continue; child.layoutPositioning = prior.layoutPositioning; child.x = prior.x; child.y = prior.y; }
      }
    } catch {}
    try {
      const restoredNode = await figma.getNodeByIdAsync(request.nodeId); const restored = gridFacts(restoredNode); const restoredChildren = childFacts(restoredNode, restored);
      let residue = 0;
      if (before.layoutMode === 'GRID') { if (!sameGrid(before, restored)) residue++; for (let index = 0; index < Math.max(beforeChildren.length, restoredChildren.length); index++) if (!beforeChildren[index] || !restoredChildren[index] || !sameChildGrid(beforeChildren[index], restoredChildren[index])) residue++; }
      else { if (restored.layoutMode !== before.layoutMode) residue++; for (let index = 0; index < Math.max(beforeChildren.length, restoredChildren.length); index++) if (!beforeChildren[index] || !restoredChildren[index] || !sameChildFree(beforeChildren[index], restoredChildren[index])) residue++; }
      return failed(residue ? 'partial-residue' : 'rolled-back', Math.min(100000, residue), mutationError);
    } catch (error) { return failed('verification-unavailable', Math.min(100000, 1 + beforeChildren.length), mutationError || error); }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, maximum, empty = true) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
const safeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validTrack(value) { return exact(value, value?.value === undefined ? ['type'] : ['type','value']) && TRACK_TYPES.includes(value.type) && (value.value === undefined || finite(value.value)); }
function validGrid(value) { return exact(value,['layoutMode','rows','columns','rowGap','columnGap','rowSizes','columnSizes','autoTracks','itemsPositioning']) && LAYOUT_MODES.includes(value.layoutMode) && safeInteger(value.rows,value.layoutMode === 'GRID' ? 1 : 0) && value.rows <= MAX_GRID_SET_TRACKS && safeInteger(value.columns,value.layoutMode === 'GRID' ? 1 : 0) && value.columns <= MAX_GRID_SET_TRACKS && finite(value.rowGap) && finite(value.columnGap) && Array.isArray(value.rowSizes) && value.rowSizes.length === value.rows && value.rowSizes.every(validTrack) && Array.isArray(value.columnSizes) && value.columnSizes.length === value.columns && value.columnSizes.every(validTrack) && AUTO_TRACKS.includes(value.autoTracks) && POSITIONING.includes(value.itemsPositioning); }
function validNode(value,input) { return exact(value,['id','name','type']) && value.id === input.nodeId && text(value.id,512,false) && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name,1024) && text(value.type,64,false); }
function requestedTracksMatch(actual,desired) { return desired === undefined || desired.length === actual.length && desired.every((track,index) => actual[index].type === track.type && (track.value === undefined || actual[index].value === track.value)); }
function requestSatisfied(actual,input) { return actual.layoutMode === 'GRID' && (input.rows === undefined || actual.rows === input.rows) && (input.columns === undefined || actual.columns === input.columns) && (input.rowSizes === undefined || actual.rows === input.rowSizes.length) && (input.columnSizes === undefined || actual.columns === input.columnSizes.length) && (input.rowGap === undefined || actual.rowGap === input.rowGap) && (input.columnGap === undefined || actual.columnGap === input.columnGap) && requestedTracksMatch(actual.rowSizes,input.rowSizes) && requestedTracksMatch(actual.columnSizes,input.columnSizes); }
function preservedGrid(before,after,input) { if (before.layoutMode !== 'GRID') return true; const prefix = (left,right) => left.slice(0,Math.min(left.length,right.length)).every((track,index) => track.type === right[index].type && track.value === right[index].value); return before.autoTracks === after.autoTracks && before.itemsPositioning === after.itemsPositioning && (input.rows !== undefined || input.rowSizes !== undefined || before.rows === after.rows) && (input.columns !== undefined || input.columnSizes !== undefined || before.columns === after.columns) && (input.rowGap !== undefined || before.rowGap === after.rowGap) && (input.columnGap !== undefined || before.columnGap === after.columnGap) && (input.rowSizes !== undefined || prefix(before.rowSizes,after.rowSizes)) && (input.columnSizes !== undefined || prefix(before.columnSizes,after.columnSizes)); }
function validRefusal(value) { return exact(value,['schemaVersion','status','action','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.action === 'set' && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure,1024,false); }
function validSuccess(value,input) { const unchanged = value?.status === 'unchanged'; return exact(value,['schemaVersion','status','action','outcome','attempted','node','before','after','residueCount','warnings']) && value.schemaVersion === 1 && ['unchanged','applied'].includes(value.status) && value.action === 'set' && validNode(value.node,input) && validGrid(value.before) && validGrid(value.after) && requestSatisfied(value.after,input) && preservedGrid(value.before,value.after,input) && value.residueCount === 0 && Array.isArray(value.warnings) && value.warnings.length <= 1 && value.warnings.every((warning) => text(warning,1024,false)) && (unchanged ? value.outcome === 'no-mutation' && value.attempted === 0 && !value.warnings.length && JSON.stringify(value.before) === JSON.stringify(value.after) : ['verified','verified-after-error'].includes(value.outcome) && value.attempted === 1 && (value.outcome === 'verified-after-error' ? value.warnings.length === 1 : !value.warnings.length)); }
function validFailure(value) { return exact(value,['schemaVersion','status','action','outcome','attempted','restored','residueCount','failure']) && value.schemaVersion === 1 && value.status === 'failed' && value.action === 'set' && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && value.restored === (value.outcome === 'rolled-back' ? 1 : 0) && safeInteger(value.residueCount) && value.residueCount <= 100000 && (value.outcome === 'rolled-back' ? value.residueCount === 0 : value.residueCount > 0) && text(value.failure,1024,false); }
function mutationError(message,outcome,report) { const error = new Error(message); Object.assign(error,{kind:'execution',phase:'plugin-execution',outcome:'unknown-after-dispatch',dispatchState:'failed',mutationOutcome:outcome,mutationReport:report}); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error,{kind:'plugin-result',phase:'plugin-response',outcome:'unknown-after-dispatch',dispatchState:'failed'}); return error; }
function safe(value) { return JSON.stringify(value,null,2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,(character)=>`\\u${character.charCodeAt(0).toString(16).padStart(4,'0')}`); }

export async function executeGridSet(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Grid Set requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(gridSetCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_GRID_SET_RESULT_CODE_UNITS) throw invalid('Grid Set returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Grid Set returned invalid JSON.'); }
  if (payload?.status === 'refused') { if (!validRefusal(payload)) throw invalid('Grid Set returned an invalid bounded result.'); throw mutationError(`Grid Set made no mutation: ${payload.failure}`,'no-mutation',{version:1,outcome:'no-mutation',attempted:0,restored:0,residueCount:0}); }
  if (payload?.status === 'failed') { if (!validFailure(payload)) throw invalid('Grid Set returned an invalid bounded result.'); throw mutationError(`Grid Set failed with ${payload.outcome}: ${payload.failure}`,payload.outcome,{version:1,outcome:payload.outcome,attempted:1,restored:payload.restored,residueCount:payload.residueCount}); }
  if (!validSuccess(payload,input)) throw invalid('Grid Set returned an invalid bounded result.');
  return { stdout:safe({before:payload.before,after:payload.after}),stderr:'',result:payload };
}
export function gridSetPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Grid Set routing requires a Command Plan.'); return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-grid-set'; }
export function executeGridSetPlan(plan,adapters={}) { if (gridSetPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Grid Set.'); return executeGridSet(parseGridSetRequest(plan.argv),adapters); }
