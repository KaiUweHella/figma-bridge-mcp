import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  CREATE_CANVAS_NODE_KINDS,
  MAX_CREATE_CANVAS_NODE_NAME_CODE_UNITS,
  MAX_CREATE_CANVAS_NODE_NETWORK_CODE_UNITS,
  createCanvasNodeArgvFromRequest,
  createCanvasNodePlanningArgvFromRequest,
  parseCreateCanvasNodeRequest,
} from './create-canvas-node-request.js';

export { createCanvasNodeArgvFromRequest, createCanvasNodePlanningArgvFromRequest } from './create-canvas-node-request.js';
const APPLICATION_IDS = new Set(CREATE_CANVAS_NODE_KINDS.map((kind) => `create.${kind}`));
const TYPES = Object.freeze({ vector: 'VECTOR', slice: 'SLICE' });
export const MAX_CREATE_CANVAS_NODE_CHILDREN = 50_000;
export const MAX_CREATE_CANVAS_NODE_RESULT_CODE_UNITS = 32_768;
const MAX_ID = 1_024; const EPSILON = 0.01;
const normalized = (request) => parseCreateCanvasNodeRequest(createCanvasNodeArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function createCanvasNodeCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)}; const expectedType = ${js(TYPES[input.kind])};
    const expectedNetworkJson = request.network === null ? null : JSON.stringify(request.network);
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (value.length > ${MAX_CREATE_CANVAS_NODE_RESULT_CODE_UNITS}) throw new Error('Create Canvas Node result exceeded the bounded response limit.'); return value; };
    const childIds = (parent, label) => { if (!parent || !Array.isArray(parent.children)) throw new Error(label + ' returned invalid child membership.'); if (parent.children.length > ${MAX_CREATE_CANVAS_NODE_CHILDREN}) throw new Error(label + ' exceeds the bounded child count.'); const values = parent.children.map((node) => node && node.id); if (values.some((id) => typeof id !== 'string') || new Set(values).size !== values.length) throw new Error(label + ' returned invalid child membership.'); return values; };
    const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    const close = (left, right) => typeof left === 'number' && Number.isFinite(left) && Math.abs(left - right) <= ${EPSILON};
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    let page, parent, beforePageIds, beforeParentIds, beforeSelection, beforeSelectionIds, expectedIndex, expectedX;
    try {
      page = figma.currentPage;
      if (!page || page.type !== 'PAGE' || typeof page.id !== 'string' || typeof page.appendChild !== 'function' || typeof page.insertChild !== 'function') throw new Error('Create Canvas Node requires one current Figma Page.');
      beforePageIds = childIds(page, 'Current Page'); beforeSelection = Array.isArray(page.selection) ? [...page.selection] : null;
      if (!beforeSelection || beforeSelection.length > ${MAX_CREATE_CANVAS_NODE_CHILDREN} || beforeSelection.some((node) => !node || typeof node.id !== 'string')) throw new Error('Create Canvas Node requires a bounded current selection.');
      beforeSelectionIds = beforeSelection.map((node) => node.id);
      parent = request.parentId === null ? page : await figma.getNodeByIdAsync(request.parentId);
      if (!parent || parent.type === 'DOCUMENT' || parent.remote === true || typeof parent.id !== 'string' || typeof parent.appendChild !== 'function' || typeof parent.insertChild !== 'function') throw new Error('Create Canvas Node parent cannot contain children.');
      beforeParentIds = parent.id === page.id ? [...beforePageIds] : childIds(parent, 'Target parent');
      if (request.index !== null && request.parentId !== null && request.index > beforeParentIds.length) throw new Error('Index out of range: ' + request.index + '.');
      expectedIndex = request.parentId === null || request.index === null ? beforeParentIds.length : request.index;
      if (request.parentId !== null) expectedX = request.x === null ? 0 : request.x;
      else if (request.x === null) { expectedX = 0; if (beforePageIds.length > 0) { for (const child of page.children) { if (!Number.isFinite(child.x) || !Number.isFinite(child.width)) throw new Error('Current Page contains a child without finite horizontal geometry.'); expectedX = Math.max(expectedX, child.x + child.width); } expectedX += 100; } }
      else expectedX = request.x;
      if (!Number.isFinite(expectedX) || Math.abs(expectedX) > ${MAX_ABSOLUTE_NODE_COORDINATE}) throw new Error('Requested canvas node position is outside the supported range.');
    } catch (error) { return refusal(error); }
    let node = null; let failure = 'Create Canvas Node fresh postcondition did not match the requested state.';
    try {
      try {
        node = request.kind === 'vector' ? figma.createVector() : figma.createSlice();
        if (!node || typeof node.id !== 'string' || typeof node.remove !== 'function') throw new Error('Figma did not return a removable Canvas Node.');
        node.name = request.name;
        if (request.network !== null) { if (typeof node.setVectorNetworkAsync !== 'function') throw new Error('Vector does not support setVectorNetworkAsync().'); await node.setVectorNetworkAsync(request.network); }
        node.x = expectedX; node.y = request.y; if (request.kind === 'slice') node.resize(request.width, request.height);
        if (request.parentId !== null) { if (request.index === null) parent.appendChild(node); else parent.insertChild(request.index, node); }
        page.selection = [node];
      } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      if (node && typeof node.id === 'string') {
        const fresh = await figma.getNodeByIdAsync(node.id); const freshPage = await figma.getNodeByIdAsync(page.id); const freshParent = parent.id === page.id ? freshPage : await figma.getNodeByIdAsync(parent.id);
        const afterPageIds = childIds(freshPage, 'Fresh Current Page'); const afterParentIds = parent.id === page.id ? afterPageIds : childIds(freshParent, 'Fresh target parent'); const expectedParentIds = [...beforeParentIds]; expectedParentIds.splice(expectedIndex, 0, node.id); const expectedPageIds = parent.id === page.id ? expectedParentIds : beforePageIds;
        const selectedIds = Array.isArray(freshPage.selection) ? freshPage.selection.map((item) => item && item.id) : [];
        let networkMatches = request.network === null;
        if (request.network !== null) { let freshNetworkJson = null; try { freshNetworkJson = JSON.stringify(fresh.vectorNetwork); } catch {} networkMatches = typeof freshNetworkJson === 'string' && freshNetworkJson.length <= ${MAX_CREATE_CANVAS_NODE_NETWORK_CODE_UNITS} && freshNetworkJson === expectedNetworkJson; }
        const sizeMatches = request.kind === 'vector' || close(fresh.width, request.width) && close(fresh.height, request.height);
        if (fresh && fresh.type === expectedType && fresh.name === request.name && fresh.parent && fresh.parent.id === parent.id && same(afterParentIds, expectedParentIds) && same(afterPageIds, expectedPageIds) && afterParentIds[expectedIndex] === fresh.id && same(selectedIds, [fresh.id]) && close(fresh.x, expectedX) && close(fresh.y, request.y) && sizeMatches && networkMatches) {
          delete globalThis.__invCache;
          return bounded({ schemaVersion: 1, status: 'created', node: { id: clean(fresh.id, ${MAX_ID}), name: clean(fresh.name, ${MAX_CREATE_CANVAS_NODE_NAME_CODE_UNITS}), type: expectedType, parentId: clean(parent.id, ${MAX_ID}), index: expectedIndex, x: fresh.x, y: fresh.y, width: request.kind === 'slice' ? fresh.width : null, height: request.kind === 'slice' ? fresh.height : null }, networkApplied: request.network !== null, attempted: 1, residue: [] });
        }
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
    if (!node || typeof node.id !== 'string') return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, residue: [], failure });
    try {
      try { node.remove(); } catch {} try { page.selection = beforeSelection; } catch {}
      const freshNode = await figma.getNodeByIdAsync(node.id); const freshPage = await figma.getNodeByIdAsync(page.id); const freshParent = parent.id === page.id ? freshPage : await figma.getNodeByIdAsync(parent.id);
      const restoredPageIds = childIds(freshPage, 'Restored Current Page'); const restoredParentIds = parent.id === page.id ? restoredPageIds : childIds(freshParent, 'Restored target parent'); const restoredSelectionIds = Array.isArray(freshPage.selection) ? freshPage.selection.map((item) => item && item.id) : [];
      const residue = []; const createdPresent = Boolean(freshNode) || restoredPageIds.includes(node.id) || restoredParentIds.includes(node.id); if (createdPresent) residue.push('created-node'); if (!createdPresent && (!same(restoredPageIds, beforePageIds) || !same(restoredParentIds, beforeParentIds))) residue.push('parent-membership'); if (!same(restoredSelectionIds, beforeSelectionIds)) residue.push('selection'); const restored = residue.length === 0; if (restored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1, restored: restored ? 1 : 0, residue, failure });
    } catch { return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, residue: [], failure }); }
  })()`;
}
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, max, empty = true) => typeof value === 'string' && value.length <= max && (empty || value.length > 0);
const id = (value) => text(value, MAX_ID, false) && NODE_REFERENCE_PATTERN.test(value);
const position = (value) => Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE;
function validSuccess(value, input) { return exact(value, ['schemaVersion','status','node','networkApplied','attempted','residue']) && value.schemaVersion === 1 && value.status === 'created' && exact(value.node, ['id','name','type','parentId','index','x','y','width','height']) && id(value.node.id) && value.node.name === input.name && value.node.type === TYPES[input.kind] && id(value.node.parentId) && Number.isSafeInteger(value.node.index) && value.node.index >= 0 && position(value.node.x) && position(value.node.y) && (input.kind === 'vector' ? value.node.width === null && value.node.height === null : position(value.node.width) && value.node.width > 0 && position(value.node.height) && value.node.height > 0) && value.networkApplied === (input.network !== null) && value.attempted === 1 && Array.isArray(value.residue) && !value.residue.length; }
function validRefusal(value) { return exact(value, ['schemaVersion','status','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validFailure(value) { return exact(value, ['schemaVersion','status','outcome','attempted','restored','residue','failure']) && value.schemaVersion === 1 && value.status === 'failed' && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && Array.isArray(value.residue) && value.residue.length <= 3 && value.residue.every((item) => ['created-node','parent-membership','selection'].includes(item)) && new Set(value.residue).size === value.residue.length && text(value.failure, 1024, false) && (value.outcome !== 'rolled-back' || value.restored === 1 && !value.residue.length) && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0) && (value.outcome !== 'verification-unavailable' || value.restored === 0); }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
export function formatCreateCanvasNodeResult(result) { return `${JSON.stringify(result.node.name)} created (${result.node.id}) in ${result.node.parentId} at (${result.node.x}, ${result.node.y})`; }
export async function executeCreateCanvasNode(request, adapters = {}) { if (typeof adapters.evaluate !== 'function') throw new TypeError('Create Canvas Node requires a Figma evaluate adapter.'); const input = normalized(request); const serialized = await adapters.evaluate(createCanvasNodeCode(input)); if (typeof serialized !== 'string' || serialized.length > MAX_CREATE_CANVAS_NODE_RESULT_CODE_UNITS) throw invalid('Create Canvas Node returned an invalid bounded result.'); let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Create Canvas Node returned invalid JSON.'); } if (payload?.status === 'refused') { if (!validRefusal(payload)) throw invalid('Create Canvas Node returned an invalid bounded result.'); throw mutationError(`Create Canvas Node made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); } if (payload?.status === 'failed') { if (!validFailure(payload)) throw invalid('Create Canvas Node returned an invalid bounded result.'); throw mutationError(`Create Canvas Node failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.residue.length }); } if (!validSuccess(payload, input)) throw invalid('Create Canvas Node returned an invalid bounded result.'); return { stdout: formatCreateCanvasNodeResult(payload), stderr: '', result: payload }; }
export function createCanvasNodePlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Create Canvas Node routing requires a Command Plan created by the Capability Catalog.'); return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-create-canvas-node'; }
export async function executeCreateCanvasNodePlan(plan, adapters = {}) { if (createCanvasNodePlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Create Canvas Node.`); return executeCreateCanvasNode(parseCreateCanvasNodeRequest(plan.argv), adapters); }
