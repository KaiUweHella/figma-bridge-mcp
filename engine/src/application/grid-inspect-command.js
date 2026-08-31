// Bounded native Auto Layout Grid inspection behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import { MAX_GRID_SET_TRACKS } from './grid-set-request.js';
import {
  gridInspectArgvFromRequest,
  gridInspectPlanningArgvFromRequest,
  parseGridInspectRequest,
} from './grid-inspect-request.js';

export { gridInspectArgvFromRequest, gridInspectPlanningArgvFromRequest } from './grid-inspect-request.js';
export const MAX_GRID_INSPECT_RESULT_CODE_UNITS = 768_000;
const APPLICATION_ID = 'layout.grid.inspect';
const TRACK_TYPES = Object.freeze(['FLEX', 'FIXED', 'HUG']);
const AUTO_TRACKS = Object.freeze(['NONE', 'ROWS']);
const POSITIONING = Object.freeze(['MANUAL', 'ROW_AUTO_FLOW']);
const normalized = (request) => parseGridInspectRequest(gridInspectArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function gridInspectCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)}; const trackTypes = ${js(TRACK_TYPES)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_GRID_INSPECT_RESULT_CODE_UNITS}) throw new Error('Grid Inspect result exceeded its bounded response limit.'); return serialized; };
    const track = (value) => { if (!value || !trackTypes.includes(value.type)) throw new Error('Grid track facts are invalid.'); const result = { type: value.type }; if (value.value !== undefined) { if (!Number.isFinite(value.value) || value.value < 0) throw new Error('Grid track value is invalid.'); result.value = value.value; } return result; };
    if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Figma node lookup is unavailable.');
    const node = await figma.getNodeByIdAsync(request.nodeId);
    const rows = node && node.gridRowCount; const columns = node && node.gridColumnCount;
    if (!node) throw new Error('Node not found: ' + request.nodeId);
    if (node.layoutMode !== 'GRID') throw new Error('Node is not an Auto Layout Grid container');
    if (typeof node.id !== 'string' || !node.id.length || node.id.length > 512 || typeof node.name !== 'string' || node.name.length > 1024 || typeof node.type !== 'string' || !node.type.length || node.type.length > 64
      || !Number.isSafeInteger(rows) || rows < 1 || rows > ${MAX_GRID_SET_TRACKS}
      || !Number.isSafeInteger(columns) || columns < 1 || columns > ${MAX_GRID_SET_TRACKS}
      || !Number.isFinite(node.gridRowGap) || node.gridRowGap < 0 || !Number.isFinite(node.gridColumnGap) || node.gridColumnGap < 0
      || !Array.isArray(node.gridRowSizes) || node.gridRowSizes.length !== rows || !Array.isArray(node.gridColumnSizes) || node.gridColumnSizes.length !== columns
      || !${js(AUTO_TRACKS)}.includes(node.gridAutoTracks) || !${js(POSITIONING)}.includes(node.gridItemsPositioning)) throw new Error('Grid Inspect returned invalid bounded Grid facts.');
    return bounded({ id: clean(node.id, 512), name: clean(node.name, 1024), type: clean(node.type, 64), layoutMode: 'GRID', rows, columns, rowGap: node.gridRowGap, columnGap: node.gridColumnGap, rowSizes: Array.from(node.gridRowSizes, track), columnSizes: Array.from(node.gridColumnSizes, track), autoTracks: node.gridAutoTracks, itemsPositioning: node.gridItemsPositioning });
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
const text = (value, maximum, empty = true) => typeof value === 'string'
  && value.length <= maximum && (empty || value.length > 0);
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function validTrack(value) {
  return exact(value, value?.value === undefined ? ['type'] : ['type', 'value'])
    && TRACK_TYPES.includes(value.type) && (value.value === undefined || finite(value.value));
}
function validResult(value, input) {
  return exact(value, [
    'id', 'name', 'type', 'layoutMode', 'rows', 'columns', 'rowGap', 'columnGap',
    'rowSizes', 'columnSizes', 'autoTracks', 'itemsPositioning',
  ])
    && value.id === input.nodeId && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id)
    && text(value.name, 1024) && text(value.type, 64, false) && value.layoutMode === 'GRID'
    && Number.isSafeInteger(value.rows) && value.rows >= 1 && value.rows <= MAX_GRID_SET_TRACKS
    && Number.isSafeInteger(value.columns) && value.columns >= 1 && value.columns <= MAX_GRID_SET_TRACKS
    && finite(value.rowGap) && finite(value.columnGap)
    && Array.isArray(value.rowSizes) && value.rowSizes.length === value.rows && value.rowSizes.every(validTrack)
    && Array.isArray(value.columnSizes) && value.columnSizes.length === value.columns && value.columnSizes.every(validTrack)
    && AUTO_TRACKS.includes(value.autoTracks) && POSITIONING.includes(value.itemsPositioning);
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed',
  });
  return error;
}
function safe(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function executeGridInspect(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Grid Inspect requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(gridInspectCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_GRID_INSPECT_RESULT_CODE_UNITS) {
    throw invalid('Grid Inspect returned an invalid bounded result.');
  }
  let result;
  try { result = JSON.parse(serialized); } catch { throw invalid('Grid Inspect returned invalid JSON.'); }
  if (!validResult(result, input)) throw invalid('Grid Inspect returned an invalid bounded result.');
  return { stdout: safe(result), stderr: input.warning ? `⚠ ${input.warning}` : '', result };
}

export function gridInspectPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Grid Inspect routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-grid-inspect';
}

export function executeGridInspectPlan(plan, adapters = {}) {
  if (gridInspectPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Grid Inspect.');
  }
  return executeGridInspect(parseGridInspectRequest(plan.argv), adapters);
}
