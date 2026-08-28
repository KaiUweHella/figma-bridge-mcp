// Plan-bound, rollback-owned Component Create Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_CREATE_NAME_CODE_UNITS,
  MAX_COMPONENT_CREATE_NODE_ID_CODE_UNITS,
  componentCreateArgvFromRequest,
  componentCreatePlanningArgvFromRequest,
  parseComponentCreateRequest,
} from './component-create-request.js';

export {
  componentCreateArgvFromRequest,
  componentCreatePlanningArgvFromRequest,
} from './component-create-request.js';

const APPLICATION_ID = 'component.create';
export const MAX_COMPONENT_CREATE_CHILDREN = 50_000;
export const MAX_COMPONENT_CREATE_RESULT_CODE_UNITS = 32_768;

function normalizedRequest(request) {
  return parseComponentCreateRequest(componentCreateArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentCreateCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const requestedName = ${jsValue(input.name)};
    const requestedWidth = ${input.width};
    const requestedHeight = ${input.height};
    const requestedX = ${input.x};
    const requestedY = ${input.y};
    const requestedParentId = ${jsValue(input.parentId)};
    const requestedIndex = ${jsValue(input.index)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_CREATE_RESULT_CODE_UNITS}) {
        throw new Error('Component Create result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const childrenOf = (node) => {
      if (!node || !Array.isArray(node.children)) {
        throw new Error('Target parent returned invalid child membership.');
      }
      if (node.children.length > ${MAX_COMPONENT_CREATE_CHILDREN}) {
        throw new Error('Target parent exceeds the bounded child count.');
      }
      const ids = node.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
        throw new Error('Target parent returned invalid child membership.');
      }
      return ids;
    };
    const sameIds = (left, right) => left.length === right.length
      && left.every((id, index) => id === right[index]);
    const refusal = (error) => bounded({
      schemaVersion: 1,
      status: 'refused',
      outcome: 'no-mutation',
      attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let parent;
    let beforeIds;
    let expectedIndex;
    try {
      if (typeof figma.createComponent !== 'function') {
        throw new Error('Component creation is unavailable in this editor.');
      }
      parent = requestedParentId === null
        ? figma.currentPage
        : await figma.getNodeByIdAsync(requestedParentId);
      if (!parent || parent.type === 'DOCUMENT'
        || typeof parent.appendChild !== 'function'
        || typeof parent.insertChild !== 'function'
        || parent.remote === true) {
        throw new Error('Target parent cannot contain a new Component.');
      }
      beforeIds = childrenOf(parent);
      if (requestedIndex !== null && requestedIndex > beforeIds.length) {
        throw new Error('Index out of range: ' + requestedIndex + '.');
      }
      expectedIndex = requestedIndex === null ? beforeIds.length : requestedIndex;
    } catch (error) {
      return refusal(error);
    }

    let component = null;
    try {
      component = figma.createComponent();
      if (!component || component.type !== 'COMPONENT' || typeof component.id !== 'string'
        || typeof component.remove !== 'function' || typeof component.resize !== 'function') {
        throw new Error('Figma did not return a removable Component.');
      }
      if (requestedIndex === null) parent.appendChild(component);
      else parent.insertChild(requestedIndex, component);
      component.name = requestedName;
      component.resize(requestedWidth, requestedHeight);
      component.x = requestedX;
      component.y = requestedY;

      const verified = await figma.getNodeByIdAsync(component.id);
      const freshParent = await figma.getNodeByIdAsync(parent.id);
      const afterIds = childrenOf(freshParent);
      const expectedIds = [...beforeIds];
      expectedIds.splice(expectedIndex, 0, component.id);
      if (!verified || verified.type !== 'COMPONENT' || verified.remote !== false
        || !verified.parent || verified.parent.id !== parent.id
        || !sameIds(afterIds, expectedIds)
        || afterIds[expectedIndex] !== verified.id
        || verified.name !== requestedName
        || verified.width !== requestedWidth || verified.height !== requestedHeight
        || verified.x !== requestedX || verified.y !== requestedY) {
        throw new Error('Component Create could not freshly verify the complete requested state.');
      }
      delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1,
        status: 'created',
        component: {
          id: verified.id,
          name: String(verified.name || '').slice(0, ${MAX_COMPONENT_CREATE_NAME_CODE_UNITS}),
          type: verified.type,
          remote: verified.remote === true,
          parentId: verified.parent.id,
          index: expectedIndex,
          x: verified.x,
          y: verified.y,
          width: verified.width,
          height: verified.height,
        },
        attempted: 1,
        residue: [],
      });
    } catch (error) {
      const failure = clean(error && error.message ? error.message : String(error), 1024);
      if (!component || typeof component.id !== 'string') {
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: 'verification-unavailable',
          attempted: 1,
          restored: 0,
          residue: { componentId: null, componentPresent: false, parentChanged: false },
          failure,
        });
      }
      try { component.remove(); } catch {}
      try {
        const freshComponent = await figma.getNodeByIdAsync(component.id);
        const freshParent = await figma.getNodeByIdAsync(parent.id);
        const restoredIds = childrenOf(freshParent);
        const componentPresent = Boolean(freshComponent) || restoredIds.includes(component.id);
        const parentChanged = !sameIds(restoredIds, beforeIds);
        const restored = !componentPresent && !parentChanged;
        if (restored) delete globalThis.__invCache;
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: restored ? 'rolled-back' : 'partial-residue',
          attempted: 1,
          restored: restored ? 1 : 0,
          residue: {
            componentId: component.id,
            componentPresent,
            parentChanged,
          },
          failure,
        });
      } catch {
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: 'verification-unavailable',
          attempted: 1,
          restored: 0,
          residue: {
            componentId: component.id,
            componentPresent: false,
            parentChanged: false,
          },
          failure,
        });
      }
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validString(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function validId(value) {
  return validString(value, MAX_COMPONENT_CREATE_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value);
}

function validSuccess(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'component', 'attempted', 'residue'])
    && value.schemaVersion === 1 && value.status === 'created'
    && exactKeys(value.component, [
      'id', 'name', 'type', 'remote', 'parentId', 'index', 'x', 'y', 'width', 'height',
    ])
    && validId(value.component.id)
    && value.component.name === input.name
    && validString(value.component.name, MAX_COMPONENT_CREATE_NAME_CODE_UNITS)
    && value.component.type === 'COMPONENT' && value.component.remote === false
    && validId(value.component.parentId)
    && (input.parentId === null || value.component.parentId === input.parentId)
    && Number.isSafeInteger(value.component.index) && value.component.index >= 0
    && (input.index === null || value.component.index === input.index)
    && value.component.x === input.x && value.component.y === input.y
    && value.component.width === input.width && value.component.height === input.height
    && value.attempted === 1
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure',
  ])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && exactKeys(value.residue, ['componentId', 'componentPresent', 'parentChanged'])
    && (value.residue.componentId === null || validId(value.residue.componentId))
    && typeof value.residue.componentPresent === 'boolean'
    && typeof value.residue.parentChanged === 'boolean'
    && validString(value.failure, 1_024, false)
    && (value.outcome !== 'rolled-back'
      || (value.restored === 1 && value.residue.componentId !== null
        && !value.residue.componentPresent && !value.residue.parentChanged))
    && (value.outcome !== 'partial-residue'
      || (value.restored === 0
        && (value.residue.componentPresent || value.residue.parentChanged)))
    && (value.outcome !== 'verification-unavailable' || value.restored === 0);
}

function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && validString(value.failure, 1_024, false);
}

function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatComponentCreateResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  const component = result.component;
  return `Created component ${safeJson(component.name)} (${component.id}) in ${component.parentId} `
    + `at index ${component.index}, x=${component.x}, y=${component.y}, `
    + `${component.width}×${component.height}`;
}

function mutationError(message, outcome, report) {
  const error = new Error(message);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = outcome;
  error.mutationReport = report;
  return error;
}

export async function executeComponentCreate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Create requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentCreateCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_CREATE_RESULT_CODE_UNITS) {
    const error = new Error('Component Create returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Create returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Create returned an invalid bounded result.');
    throw mutationError(`Component Create made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw new Error('Component Create returned an invalid bounded result.');
    const residueCount = Number(payload.residue.componentPresent) + Number(payload.residue.parentChanged);
    const message = payload.outcome === 'rolled-back'
      ? `Component Create failed and removed the new Component: ${payload.failure}`
      : `Component Create failed; the new Component outcome could not be fully restored: ${payload.failure}`;
    throw mutationError(message, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: 1,
      restored: payload.restored, residueCount,
    });
  }
  if (!validSuccess(payload, input)) {
    const error = new Error('Component Create returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentCreateResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentCreatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Create routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-create';
}

export async function executeComponentCreatePlan(plan, adapters = {}) {
  if (componentCreatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Create.`);
  }
  return executeComponentCreate(parseComponentCreateRequest(plan.argv), adapters);
}
