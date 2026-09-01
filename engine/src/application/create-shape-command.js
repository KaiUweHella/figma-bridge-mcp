import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  CREATE_SHAPE_KINDS,
  MAX_CREATE_SHAPE_NAME_CODE_UNITS,
  createShapeArgvFromRequest,
  createShapePlanningArgvFromRequest,
  parseCreateShapeRequest,
} from './create-shape-request.js';

export { createShapeArgvFromRequest, createShapePlanningArgvFromRequest } from './create-shape-request.js';

const APPLICATION_IDS = new Set(CREATE_SHAPE_KINDS.map((kind) => `create.${kind}`));
const TYPES = Object.freeze({ rect: 'RECTANGLE', ellipse: 'ELLIPSE', polygon: 'POLYGON', star: 'STAR' });
export const MAX_CREATE_SHAPE_CHILDREN = 50_000;
export const MAX_CREATE_SHAPE_VARIABLES = 100_000;
export const MAX_CREATE_SHAPE_RESULT_CODE_UNITS = 32_768;
const MAX_ID = 1_024;
const EPSILON = 0.01;
const normalized = (request) => parseCreateShapeRequest(createShapeArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function createShapeCode(request) {
  const input = normalized(request);
  const rgb = (value) => value === null || value.startsWith('var:') ? null
    : [0, 2, 4].map((start) => parseInt(value.slice(1).slice(start, start + 2), 16) / 255);
  return `(async () => {
    const request = ${js(input)};
    const expectedType = ${js(TYPES[input.kind])};
    const fillRgb = ${js(rgb(input.fill))}; const strokeRgb = ${js(rgb(input.stroke))};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const value = JSON.stringify(payload); if (value.length > ${MAX_CREATE_SHAPE_RESULT_CODE_UNITS}) throw new Error('Create Shape result exceeded the bounded response limit.'); return value; };
    const childIds = (parent, label) => {
      if (!parent || !Array.isArray(parent.children)) throw new Error(label + ' returned invalid child membership.');
      if (parent.children.length > ${MAX_CREATE_SHAPE_CHILDREN}) throw new Error(label + ' exceeds the bounded child count.');
      const values = parent.children.map((node) => node && node.id);
      if (values.some((id) => typeof id !== 'string') || new Set(values).size !== values.length) throw new Error(label + ' returned invalid child membership.');
      return values;
    };
    const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    const close = (left, right) => typeof left === 'number' && Number.isFinite(left) && Math.abs(left - right) <= ${EPSILON};
    const aliasId = (paint) => { const alias = paint && paint.boundVariables && paint.boundVariables.color; return alias === undefined || alias === null ? null : alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string' ? alias.id : false; };
    const paintMatches = (paint, kind, variable, expectedRgb) => paint && paint.type === 'SOLID'
      && (paint.opacity === undefined || close(paint.opacity, 1))
      && (paint.visible === undefined || paint.visible === true)
      && (paint.blendMode === undefined || paint.blendMode === 'NORMAL')
      && (kind === 'variable' ? aliasId(paint) === variable.id
        : aliasId(paint) === null && paint.color && close(paint.color.r, expectedRgb[0])
          && close(paint.color.g, expectedRgb[1]) && close(paint.color.b, expectedRgb[2]));
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    let page, parent, beforePageIds, beforeParentIds, beforeSelection, beforeSelectionIds;
    let expectedIndex, expectedX, fillVariable = null, strokeVariable = null;
    try {
      page = figma.currentPage;
      if (!page || page.type !== 'PAGE' || typeof page.id !== 'string' || typeof page.appendChild !== 'function' || typeof page.insertChild !== 'function') throw new Error('Create Shape requires one current Figma Page.');
      beforePageIds = childIds(page, 'Current Page');
      beforeSelection = Array.isArray(page.selection) ? [...page.selection] : null;
      if (!beforeSelection || beforeSelection.length > ${MAX_CREATE_SHAPE_CHILDREN} || beforeSelection.some((node) => !node || typeof node.id !== 'string')) throw new Error('Create Shape requires a bounded current selection.');
      beforeSelectionIds = beforeSelection.map((node) => node.id);
      parent = request.parentId === null ? page : await figma.getNodeByIdAsync(request.parentId);
      if (!parent || parent.type === 'DOCUMENT' || parent.remote === true || typeof parent.id !== 'string' || typeof parent.appendChild !== 'function' || typeof parent.insertChild !== 'function') throw new Error('Create Shape parent cannot contain children.');
      beforeParentIds = parent.id === page.id ? [...beforePageIds] : childIds(parent, 'Target parent');
      if (request.index !== null && request.parentId !== null && request.index > beforeParentIds.length) throw new Error('Index out of range: ' + request.index + '.');
      expectedIndex = request.parentId === null || request.index === null ? beforeParentIds.length : request.index;
      if (request.parentId !== null) expectedX = request.x === null ? 0 : request.x;
      else if (request.x === null) {
        expectedX = 0;
        if (beforePageIds.length > 0) {
          for (const child of page.children) {
            if (!Number.isFinite(child.x) || !Number.isFinite(child.width)) throw new Error('Current Page contains a child without finite horizontal geometry.');
            expectedX = Math.max(expectedX, child.x + child.width);
          }
          expectedX += 200;
        }
      } else expectedX = request.x;
      if (!Number.isFinite(expectedX) || Math.abs(expectedX) > ${MAX_ABSOLUTE_NODE_COORDINATE}) throw new Error('Requested shape position is outside the supported range.');
      if (request.fillKind === 'variable' || request.strokeKind === 'variable') {
        const variables = await figma.variables.getLocalVariablesAsync();
        if (!Array.isArray(variables) || variables.length > ${MAX_CREATE_SHAPE_VARIABLES}) throw new Error('Create Shape Variable candidate limit exceeded.');
        const resolve = (name, label) => {
          const matches = variables.filter((candidate) => candidate && candidate.remote === false && candidate.name === name);
          if (matches.length !== 1) throw new Error(label + (matches.length ? ' Variable reference is ambiguous.' : ' Variable not found.'));
          const variable = matches[0];
          if (typeof variable.id !== 'string' || variable.id.length > ${MAX_ID} || variable.resolvedType !== 'COLOR') throw new Error(label + ' Variable metadata is incompatible.');
          return variable;
        };
        if (request.fillKind === 'variable') fillVariable = resolve(request.fillVariable, 'Fill');
        if (request.strokeKind === 'variable') strokeVariable = resolve(request.strokeVariable, 'Stroke');
      }
    } catch (error) { return refusal(error); }
    let shape = null; let failure = 'Create Shape fresh postcondition did not match the requested state.';
    try {
      try {
        if (request.kind === 'rect') shape = figma.createRectangle();
        else if (request.kind === 'ellipse') shape = figma.createEllipse();
        else if (request.kind === 'polygon') shape = figma.createPolygon();
        else shape = figma.createStar();
        if (!shape || typeof shape.id !== 'string' || typeof shape.remove !== 'function') throw new Error('Figma did not return a removable Shape.');
        shape.name = request.name; shape.x = expectedX; shape.y = request.y; shape.resize(request.width, request.height);
        if (request.points !== null) shape.pointCount = request.points;
        if (request.innerRadius !== null) shape.innerRadius = request.innerRadius;
        shape.fills = [request.fillKind === 'variable'
          ? figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', fillVariable)
          : { type: 'SOLID', color: { r: fillRgb[0], g: fillRgb[1], b: fillRgb[2] } }];
        if (request.strokeKind !== null) {
          shape.strokes = [request.strokeKind === 'variable'
            ? figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', strokeVariable)
            : { type: 'SOLID', color: { r: strokeRgb[0], g: strokeRgb[1], b: strokeRgb[2] } }];
          shape.strokeWeight = 1;
        }
        if (request.radius !== null) shape.cornerRadius = request.radius;
        if (request.opacity !== null) shape.opacity = request.opacity;
        if (request.parentId !== null) { if (request.index === null) parent.appendChild(shape); else parent.insertChild(request.index, shape); }
        page.selection = [shape];
      } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      if (shape && typeof shape.id === 'string') {
        const fresh = await figma.getNodeByIdAsync(shape.id); const freshPage = await figma.getNodeByIdAsync(page.id);
        const freshParent = parent.id === page.id ? freshPage : await figma.getNodeByIdAsync(parent.id);
        const afterPageIds = childIds(freshPage, 'Fresh Current Page'); const afterParentIds = parent.id === page.id ? afterPageIds : childIds(freshParent, 'Fresh target parent');
        const expectedParentIds = [...beforeParentIds]; expectedParentIds.splice(expectedIndex, 0, shape.id);
        const expectedPageIds = parent.id === page.id ? expectedParentIds : beforePageIds;
        const selectedIds = Array.isArray(freshPage.selection) ? freshPage.selection.map((node) => node && node.id) : [];
        const fillMatches = fresh && Array.isArray(fresh.fills) && fresh.fills.length === 1 && paintMatches(fresh.fills[0], request.fillKind, fillVariable, fillRgb);
        const strokeMatches = request.strokeKind === null || (Array.isArray(fresh.strokes) && fresh.strokes.length === 1 && paintMatches(fresh.strokes[0], request.strokeKind, strokeVariable, strokeRgb) && close(fresh.strokeWeight, 1));
        if (fresh && fresh.type === expectedType && fresh.name === request.name && fresh.parent && fresh.parent.id === parent.id
          && same(afterParentIds, expectedParentIds) && same(afterPageIds, expectedPageIds) && afterParentIds[expectedIndex] === fresh.id
          && same(selectedIds, [fresh.id]) && close(fresh.x, expectedX) && close(fresh.y, request.y)
          && close(fresh.width, request.width) && close(fresh.height, request.height) && fillMatches && strokeMatches
          && (request.radius === null || close(fresh.cornerRadius, request.radius))
          && (request.opacity === null || close(fresh.opacity, request.opacity))
          && (request.points === null || fresh.pointCount === request.points)
          && (request.innerRadius === null || close(fresh.innerRadius, request.innerRadius))) {
          delete globalThis.__invCache;
          const resource = (kind, value, variable) => kind === null ? null : { kind, value, variableId: variable ? clean(variable.id, ${MAX_ID}) : null };
          return bounded({ schemaVersion: 1, status: 'created', node: { id: clean(fresh.id, ${MAX_ID}), name: clean(fresh.name, ${MAX_CREATE_SHAPE_NAME_CODE_UNITS}), type: expectedType, parentId: clean(parent.id, ${MAX_ID}), index: expectedIndex, x: fresh.x, y: fresh.y, width: fresh.width, height: fresh.height },
            fill: resource(request.fillKind, request.fill, fillVariable), stroke: resource(request.strokeKind, request.stroke, strokeVariable), radius: request.radius, opacity: request.opacity, points: request.points, innerRadius: request.innerRadius, attempted: 1, residue: [] });
        }
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
    if (!shape || typeof shape.id !== 'string') return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, residue: [], failure });
    try {
      try { shape.remove(); } catch {} try { page.selection = beforeSelection; } catch {}
      const freshShape = await figma.getNodeByIdAsync(shape.id); const freshPage = await figma.getNodeByIdAsync(page.id); const freshParent = parent.id === page.id ? freshPage : await figma.getNodeByIdAsync(parent.id);
      const restoredPageIds = childIds(freshPage, 'Restored Current Page'); const restoredParentIds = parent.id === page.id ? restoredPageIds : childIds(freshParent, 'Restored target parent'); const restoredSelectionIds = Array.isArray(freshPage.selection) ? freshPage.selection.map((node) => node && node.id) : [];
      const residue = []; const createdPresent = Boolean(freshShape) || restoredPageIds.includes(shape.id) || restoredParentIds.includes(shape.id);
      if (createdPresent) residue.push('created-node');
      if (!createdPresent && (!same(restoredPageIds, beforePageIds) || !same(restoredParentIds, beforeParentIds))) residue.push('parent-membership');
      if (!same(restoredSelectionIds, beforeSelectionIds)) residue.push('selection');
      const restored = residue.length === 0; if (restored) delete globalThis.__invCache;
      return bounded({ schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1, restored: restored ? 1 : 0, residue, failure });
    } catch { return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable', attempted: 1, restored: 0, residue: [], failure }); }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, max, empty = true) => typeof value === 'string' && value.length <= max && (empty || value.length > 0);
const id = (value) => text(value, MAX_ID, false) && NODE_REFERENCE_PATTERN.test(value);
const position = (value) => Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE;
function validResource(value, kind, source) { return kind === null ? value === null : exact(value, ['kind', 'value', 'variableId']) && value.kind === kind && value.value === source && (kind === 'literal' ? value.variableId === null : text(value.variableId, MAX_ID, false)); }
function validSuccess(value, input) { return exact(value, ['schemaVersion','status','node','fill','stroke','radius','opacity','points','innerRadius','attempted','residue']) && value.schemaVersion === 1 && value.status === 'created' && exact(value.node, ['id','name','type','parentId','index','x','y','width','height']) && id(value.node.id) && value.node.name === input.name && value.node.type === TYPES[input.kind] && id(value.node.parentId) && Number.isSafeInteger(value.node.index) && value.node.index >= 0 && [value.node.x,value.node.y,value.node.width,value.node.height].every(position) && value.node.width > 0 && value.node.height > 0 && validResource(value.fill, input.fillKind, input.fill) && validResource(value.stroke, input.strokeKind, input.stroke) && value.radius === input.radius && value.opacity === input.opacity && value.points === input.points && value.innerRadius === input.innerRadius && value.attempted === 1 && Array.isArray(value.residue) && !value.residue.length; }
function validRefusal(value) { return exact(value, ['schemaVersion','status','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1024, false); }
function validFailure(value) { return exact(value, ['schemaVersion','status','outcome','attempted','restored','residue','failure']) && value.schemaVersion === 1 && value.status === 'failed' && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && [0,1].includes(value.restored) && Array.isArray(value.residue) && value.residue.length <= 3 && value.residue.every((item) => ['created-node','parent-membership','selection'].includes(item)) && new Set(value.residue).size === value.residue.length && text(value.failure, 1024, false) && (value.outcome !== 'rolled-back' || value.restored === 1 && !value.residue.length) && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0) && (value.outcome !== 'verification-unavailable' || value.restored === 0); }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
export function formatCreateShapeResult(result) { return `${JSON.stringify(result.node.name)} created (${result.node.id}) in ${result.node.parentId} at (${result.node.x}, ${result.node.y})`; }
export async function executeCreateShape(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Create Shape requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(createShapeCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_CREATE_SHAPE_RESULT_CODE_UNITS) throw invalid('Create Shape returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Create Shape returned invalid JSON.'); }
  if (payload?.status === 'refused') { if (!validRefusal(payload)) throw invalid('Create Shape returned an invalid bounded result.'); throw mutationError(`Create Shape made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 }); }
  if (payload?.status === 'failed') { if (!validFailure(payload)) throw invalid('Create Shape returned an invalid bounded result.'); throw mutationError(`Create Shape failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.residue.length }); }
  if (!validSuccess(payload, input)) throw invalid('Create Shape returned an invalid bounded result.');
  return { stdout: formatCreateShapeResult(payload), stderr: '', result: payload };
}
export function createShapePlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Create Shape routing requires a Command Plan created by the Capability Catalog.'); return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-create-shape'; }
export async function executeCreateShapePlan(plan, adapters = {}) { if (createShapePlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Create Shape.`); return executeCreateShape(parseCreateShapeRequest(plan.argv), adapters); }
