import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_CREATE_FRAME_COLOR_CODE_UNITS,
  MAX_CREATE_FRAME_NAME_CODE_UNITS,
  createFrameArgvFromRequest,
  createFramePlanningArgvFromRequest,
  parseCreateFrameRequest,
} from './create-frame-request.js';

export { createFrameArgvFromRequest, createFramePlanningArgvFromRequest } from './create-frame-request.js';

const APPLICATION_ID = 'create.frame';
export const MAX_CREATE_FRAME_CHILDREN = 50_000;
export const MAX_CREATE_FRAME_VARIABLES = 100_000;
export const MAX_CREATE_FRAME_RESULT_CODE_UNITS = 32_768;
const MAX_ID_CODE_UNITS = 1_024;
const VERIFY_EPSILON = 0.01;

const normalizedRequest = (request) => parseCreateFrameRequest(createFrameArgvFromRequest(request));
const js = (value) => JSON.stringify(value)
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function createFrameCode(request) {
  const input = normalizedRequest(request);
  const hex = input.fillKind === 'literal' ? input.fill.slice(1) : null;
  const rgb = hex === null ? null
    : [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  return `(async () => {
    const request = ${js(input)};
    const expectedRgb = ${js(rgb)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_CREATE_FRAME_RESULT_CODE_UNITS}) {
        throw new Error('Create Frame result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const ids = (parent, label) => {
      if (!parent || !Array.isArray(parent.children)) throw new Error(label + ' returned invalid child membership.');
      if (parent.children.length > ${MAX_CREATE_FRAME_CHILDREN}) throw new Error(label + ' exceeds the bounded child count.');
      const values = parent.children.map((child) => child && child.id);
      if (values.some((id) => typeof id !== 'string') || new Set(values).size !== values.length) {
        throw new Error(label + ' returned invalid child membership.');
      }
      return values;
    };
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const close = (left, right) => typeof left === 'number' && Number.isFinite(left)
      && Math.abs(left - right) <= ${VERIFY_EPSILON};
    const aliasId = (paint) => {
      const alias = paint && paint.boundVariables && paint.boundVariables.color;
      return alias === undefined || alias === null ? null
        : alias.type === 'VARIABLE_ALIAS' && typeof alias.id === 'string' ? alias.id : false;
    };
    const solidMatches = (paint, variable) => paint && paint.type === 'SOLID'
      && (paint.opacity === undefined || close(paint.opacity, 1))
      && (paint.visible === undefined || paint.visible === true)
      && (paint.blendMode === undefined || paint.blendMode === 'NORMAL')
      && (request.fillKind === 'variable'
        ? aliasId(paint) === variable.id
        : aliasId(paint) === null && paint.color
          && close(paint.color.r, expectedRgb[0])
          && close(paint.color.g, expectedRgb[1])
          && close(paint.color.b, expectedRgb[2]));
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let page;
    let parent;
    let beforePageIds;
    let beforeParentIds;
    let beforeSelection;
    let beforeSelectionIds;
    let expectedIndex;
    let expectedX;
    let variable = null;
    try {
      page = figma.currentPage;
      if (!page || page.type !== 'PAGE' || typeof page.id !== 'string'
        || typeof page.appendChild !== 'function' || typeof page.insertChild !== 'function') {
        throw new Error('Create Frame requires one current Figma Page.');
      }
      beforePageIds = ids(page, 'Current Page');
      beforeSelection = Array.isArray(page.selection) ? [...page.selection] : null;
      if (!beforeSelection || beforeSelection.length > ${MAX_CREATE_FRAME_CHILDREN}
        || beforeSelection.some((node) => !node || typeof node.id !== 'string')) {
        throw new Error('Create Frame requires a bounded current selection.');
      }
      beforeSelectionIds = beforeSelection.map((node) => node.id);
      parent = request.parentId === null ? page : await figma.getNodeByIdAsync(request.parentId);
      if (!parent || parent.type === 'DOCUMENT' || parent.remote === true
        || typeof parent.id !== 'string' || typeof parent.appendChild !== 'function'
        || typeof parent.insertChild !== 'function') {
        throw new Error('Create Frame parent cannot contain children.');
      }
      beforeParentIds = parent.id === page.id ? [...beforePageIds] : ids(parent, 'Target parent');
      if (request.index !== null && request.parentId !== null
        && request.index > beforeParentIds.length) throw new Error('Index out of range: ' + request.index + '.');
      expectedIndex = request.parentId === null || request.index === null
        ? beforeParentIds.length : request.index;
      if (request.parentId !== null) expectedX = request.x === null ? 0 : request.x;
      else if (request.smart || request.x === null) {
        expectedX = 0;
        if (beforePageIds.length > 0) {
          for (const child of page.children) {
            if (!Number.isFinite(child.x) || !Number.isFinite(child.width)) {
              throw new Error('Current Page contains a child without finite horizontal geometry.');
            }
            expectedX = Math.max(expectedX, child.x + child.width);
          }
          expectedX += request.gap * 2;
        }
      } else expectedX = request.x;
      if (!Number.isFinite(expectedX) || Math.abs(expectedX) > ${MAX_ABSOLUTE_NODE_COORDINATE}) {
        throw new Error('Requested frame position is outside the supported range.');
      }
      if (request.fillKind === 'variable') {
        const variables = await figma.variables.getLocalVariablesAsync();
        if (!Array.isArray(variables) || variables.length > ${MAX_CREATE_FRAME_VARIABLES}) {
          throw new Error('Create Frame Variable candidate limit exceeded.');
        }
        const matches = variables.filter((candidate) => candidate && candidate.remote === false
          && candidate.name === request.variable);
        if (matches.length !== 1) {
          throw new Error(matches.length
            ? 'Color Variable reference is ambiguous.' : 'Color Variable not found.');
        }
        variable = matches[0];
        if (typeof variable.id !== 'string' || variable.id.length > ${MAX_ID_CODE_UNITS}
          || variable.resolvedType !== 'COLOR') throw new Error('Color Variable metadata is incompatible.');
      }
    } catch (error) { return refusal(error); }

    let frame = null;
    let failure = 'Create Frame fresh postcondition did not match the requested state.';
    try {
      try {
        frame = figma.createFrame();
        if (!frame || typeof frame.id !== 'string' || typeof frame.remove !== 'function') {
          throw new Error('Figma did not return a removable Frame.');
        }
        frame.name = request.name;
        frame.x = expectedX;
        frame.y = request.y;
        frame.resize(request.width, request.height);
        if (request.fillKind === 'literal') {
          frame.fills = [{ type: 'SOLID', color: { r: expectedRgb[0], g: expectedRgb[1], b: expectedRgb[2] } }];
        } else if (request.fillKind === 'variable') {
          frame.fills = [figma.variables.setBoundVariableForPaint(
            { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }, 'color', variable,
          )];
        }
        if (request.radius !== null) frame.cornerRadius = request.radius;
        if (request.parentId !== null) {
          if (request.index === null) parent.appendChild(frame);
          else parent.insertChild(request.index, frame);
        }
        page.selection = [frame];
      } catch (error) {
        failure = clean(error && error.message ? error.message : String(error), 1024);
      }

      if (frame && typeof frame.id === 'string') {
        const fresh = await figma.getNodeByIdAsync(frame.id);
        const freshPage = await figma.getNodeByIdAsync(page.id);
        const freshParent = parent.id === page.id ? freshPage : await figma.getNodeByIdAsync(parent.id);
        const afterPageIds = ids(freshPage, 'Fresh Current Page');
        const afterParentIds = parent.id === page.id ? afterPageIds : ids(freshParent, 'Fresh target parent');
        const expectedParentIds = [...beforeParentIds];
        expectedParentIds.splice(expectedIndex, 0, frame.id);
        const expectedPageIds = parent.id === page.id ? expectedParentIds : beforePageIds;
        const selectedIds = Array.isArray(freshPage.selection)
          ? freshPage.selection.map((node) => node && node.id) : [];
        const fillMatches = request.fillKind === null
          || (Array.isArray(fresh.fills) && fresh.fills.length === 1
            && solidMatches(fresh.fills[0], variable));
        const radiusMatches = request.radius === null || close(fresh.cornerRadius, request.radius);
        if (fresh && fresh.type === 'FRAME' && fresh.name === request.name
          && fresh.parent && fresh.parent.id === parent.id
          && afterParentIds[expectedIndex] === fresh.id
          && same(afterParentIds, expectedParentIds) && same(afterPageIds, expectedPageIds)
          && same(selectedIds, [fresh.id])
          && close(fresh.x, expectedX) && close(fresh.y, request.y)
          && close(fresh.width, request.width) && close(fresh.height, request.height)
          && fillMatches && radiusMatches) {
          delete globalThis.__invCache;
          return bounded({
            schemaVersion: 1, status: 'created',
            node: {
              id: clean(fresh.id, ${MAX_ID_CODE_UNITS}),
              name: clean(fresh.name, ${MAX_CREATE_FRAME_NAME_CODE_UNITS}), type: 'FRAME',
              parentId: clean(parent.id, ${MAX_ID_CODE_UNITS}), index: expectedIndex,
              x: fresh.x, y: fresh.y, width: fresh.width, height: fresh.height,
            },
            fill: request.fillKind === null ? null : {
              kind: request.fillKind, value: request.fill,
              variableId: variable ? clean(variable.id, ${MAX_ID_CODE_UNITS}) : null,
            },
            radius: request.radius, attempted: 1, residue: [],
          });
        }
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }

    if (!frame || typeof frame.id !== 'string') {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        attempted: 1, restored: 0, residue: [], failure,
      });
    }
    try {
      try { frame.remove(); } catch {}
      try { page.selection = beforeSelection; } catch {}
      const freshFrame = await figma.getNodeByIdAsync(frame.id);
      const freshPage = await figma.getNodeByIdAsync(page.id);
      const freshParent = parent.id === page.id ? freshPage : await figma.getNodeByIdAsync(parent.id);
      const restoredPageIds = ids(freshPage, 'Restored Current Page');
      const restoredParentIds = parent.id === page.id
        ? restoredPageIds : ids(freshParent, 'Restored target parent');
      const restoredSelectionIds = Array.isArray(freshPage.selection)
        ? freshPage.selection.map((node) => node && node.id) : [];
      const residue = [];
      const createdPresent = Boolean(freshFrame)
        || restoredPageIds.includes(frame.id) || restoredParentIds.includes(frame.id);
      if (createdPresent) residue.push('created-node');
      if (!createdPresent && (!same(restoredPageIds, beforePageIds)
        || !same(restoredParentIds, beforeParentIds))) residue.push('parent-membership');
      if (!same(restoredSelectionIds, beforeSelectionIds)) residue.push('selection');
      const restored = residue.length === 0;
      if (restored) delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1, status: 'failed',
        outcome: restored ? 'rolled-back' : 'partial-residue', attempted: 1,
        restored: restored ? 1 : 0, residue, failure,
      });
    } catch {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        attempted: 1, restored: 0, residue: [], failure,
      });
    }
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}
function id(value) {
  return text(value, MAX_ID_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}
function position(value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE;
}
function validNode(value, input) {
  return exact(value, ['id', 'name', 'type', 'parentId', 'index', 'x', 'y', 'width', 'height'])
    && id(value.id) && value.name === input.name && value.type === 'FRAME'
    && id(value.parentId) && Number.isSafeInteger(value.index) && value.index >= 0
    && position(value.x) && position(value.y)
    && position(value.width) && value.width > 0 && position(value.height) && value.height > 0;
}
function validFill(value, input) {
  if (input.fillKind === null) return value === null;
  return exact(value, ['kind', 'value', 'variableId'])
    && value.kind === input.fillKind && value.value === input.fill
    && (input.fillKind === 'literal'
      ? value.variableId === null
      : text(value.variableId, MAX_ID_CODE_UNITS, false));
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, 1024, false);
}
function validSuccess(value, input) {
  return exact(value, ['schemaVersion', 'status', 'node', 'fill', 'radius', 'attempted', 'residue'])
    && value.schemaVersion === 1 && value.status === 'created'
    && validNode(value.node, input) && validFill(value.fill, input)
    && value.radius === input.radius && value.attempted === 1
    && Array.isArray(value.residue) && value.residue.length === 0;
}
function validFailure(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 3
    && value.residue.every((entry) => ['created-node', 'parent-membership', 'selection'].includes(entry))
    && new Set(value.residue).size === value.residue.length
    && text(value.failure, 1024, false)
    && (value.outcome !== 'rolled-back' || value.restored === 1 && value.residue.length === 0)
    && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0)
    && (value.outcome !== 'verification-unavailable' || value.restored === 0);
}

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
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

export function formatCreateFrameResult(result) {
  return `${JSON.stringify(result.node.name)} created (${result.node.id}) in `
    + `${result.node.parentId} at (${result.node.x}, ${result.node.y})`;
}

export async function executeCreateFrame(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Create Frame requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(createFrameCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_CREATE_FRAME_RESULT_CODE_UNITS) {
    throw invalid('Create Frame returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw invalid('Create Frame returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Create Frame returned an invalid bounded result.');
    throw mutationError(`Create Frame made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw invalid('Create Frame returned an invalid bounded result.');
    throw mutationError(`Create Frame failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residue.length,
      });
  }
  if (!validSuccess(payload, input)) {
    throw invalid('Create Frame returned an invalid bounded result.');
  }
  return { stdout: formatCreateFrameResult(payload), stderr: '', result: payload };
}

export function createFramePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Create Frame routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-create-frame';
}

export async function executeCreateFramePlan(plan, adapters = {}) {
  if (createFramePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Create Frame.`);
  }
  return executeCreateFrame(parseCreateFrameRequest(plan.argv), adapters);
}
