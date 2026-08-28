// Plan-bound, rollback-owned Component Instantiate Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_INSTANTIATE_NAME_CODE_UNITS,
  MAX_COMPONENT_INSTANTIATE_NODE_ID_CODE_UNITS,
  componentInstantiateArgvFromRequest,
  componentInstantiatePlanningArgvFromRequest,
  parseComponentInstantiateRequest,
} from './component-instantiate-request.js';

export {
  componentInstantiateArgvFromRequest,
  componentInstantiatePlanningArgvFromRequest,
} from './component-instantiate-request.js';

const APPLICATION_ID = 'component.instantiate';
export const MAX_COMPONENT_INSTANTIATE_CHILDREN = 50_000;
export const MAX_COMPONENT_INSTANTIATE_ANCESTOR_DEPTH = 512;
export const MAX_COMPONENT_INSTANTIATE_RESULT_CODE_UNITS = 32_768;

function normalizedRequest(request) {
  return parseComponentInstantiateRequest(componentInstantiateArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentInstantiateCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const componentId = ${jsValue(input.componentId)};
    const requestedParentId = ${jsValue(input.parentId)};
    const requestedX = ${input.x};
    const requestedY = ${input.y};
    const requestedIndex = ${jsValue(input.index)};
    const requestedName = ${jsValue(input.name)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_INSTANTIATE_RESULT_CODE_UNITS}) {
        throw new Error('Component Instantiate result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const childrenOf = (node) => {
      if (!node || !Array.isArray(node.children)) {
        throw new Error('Target parent returned invalid child membership.');
      }
      if (node.children.length > ${MAX_COMPONENT_INSTANTIATE_CHILDREN}) {
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

    let component;
    let parent;
    let beforeIds;
    let expectedIndex;
    try {
      component = await figma.getNodeByIdAsync(componentId);
      if (!component || component.type !== 'COMPONENT'
        || typeof component.createInstance !== 'function') {
        throw new Error('Component Instantiate requires an exact Component node.');
      }
      parent = requestedParentId === null
        ? figma.currentPage
        : await figma.getNodeByIdAsync(requestedParentId);
      if (!parent || parent.type === 'DOCUMENT'
        || typeof parent.appendChild !== 'function'
        || typeof parent.insertChild !== 'function'
        || parent.remote === true) {
        throw new Error('Target parent cannot contain a new Instance.');
      }
      const seen = new Set();
      let ancestor = parent;
      for (let depth = 0; ancestor && depth <= ${MAX_COMPONENT_INSTANTIATE_ANCESTOR_DEPTH}; depth++) {
        if (seen.has(ancestor)) throw new Error('Target parent ancestry contains a cycle.');
        seen.add(ancestor);
        if (ancestor.id === component.id) {
          throw new Error('A Component cannot be instantiated inside its own hierarchy.');
        }
        ancestor = ancestor.parent || null;
        if (depth === ${MAX_COMPONENT_INSTANTIATE_ANCESTOR_DEPTH} && ancestor) {
          throw new Error('Target parent ancestry exceeds its bounded depth.');
        }
      }
      beforeIds = childrenOf(parent);
      if (requestedIndex !== null && requestedIndex > beforeIds.length) {
        throw new Error('Index out of range: ' + requestedIndex + '.');
      }
      expectedIndex = requestedIndex === null ? beforeIds.length : requestedIndex;
    } catch (error) {
      return refusal(error);
    }

    let instance = null;
    try {
      instance = component.createInstance();
      if (!instance || instance.type !== 'INSTANCE' || typeof instance.id !== 'string'
        || typeof instance.remove !== 'function') {
        throw new Error('Component did not return a removable Instance.');
      }
      if (requestedIndex === null) parent.appendChild(instance);
      else parent.insertChild(requestedIndex, instance);
      instance.x = requestedX;
      instance.y = requestedY;
      if (requestedName !== null) instance.name = requestedName;

      const verified = await figma.getNodeByIdAsync(instance.id);
      const freshParent = await figma.getNodeByIdAsync(parent.id);
      const afterIds = childrenOf(freshParent);
      const expectedIds = [...beforeIds];
      expectedIds.splice(expectedIndex, 0, instance.id);
      const main = verified && typeof verified.getMainComponentAsync === 'function'
        ? await verified.getMainComponentAsync()
        : null;
      if (!verified || verified.type !== 'INSTANCE'
        || !verified.parent || verified.parent.id !== parent.id
        || !sameIds(afterIds, expectedIds)
        || afterIds[expectedIndex] !== verified.id
        || verified.x !== requestedX || verified.y !== requestedY
        || (requestedName !== null && verified.name !== requestedName)
        || !main || main.id !== component.id) {
        throw new Error('Component Instantiate could not freshly verify the complete requested state.');
      }
      delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1,
        status: 'created',
        component: {
          id: component.id,
          name: String(component.name || '').slice(0, ${MAX_COMPONENT_INSTANTIATE_NAME_CODE_UNITS}),
          remote: component.remote === true,
        },
        instance: {
          id: verified.id,
          name: String(verified.name || '').slice(0, ${MAX_COMPONENT_INSTANTIATE_NAME_CODE_UNITS}),
          type: verified.type,
          parentId: verified.parent.id,
          index: expectedIndex,
          x: verified.x,
          y: verified.y,
          mainComponentId: main.id,
        },
        attempted: 1,
        residue: [],
      });
    } catch (error) {
      const failure = clean(error && error.message ? error.message : String(error), 1024);
      if (!instance || typeof instance.id !== 'string') {
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: 'verification-unavailable',
          attempted: 1,
          restored: 0,
          residue: { instanceId: null, instancePresent: false, parentChanged: false },
          failure,
        });
      }
      try { instance.remove(); } catch {}
      let freshInstance;
      let freshParent;
      try {
        freshInstance = await figma.getNodeByIdAsync(instance.id);
        freshParent = await figma.getNodeByIdAsync(parent.id);
        const restoredIds = childrenOf(freshParent);
        const instancePresent = Boolean(freshInstance) || restoredIds.includes(instance.id);
        const parentChanged = !sameIds(restoredIds, beforeIds);
        const restored = !instancePresent && !parentChanged;
        if (restored) delete globalThis.__invCache;
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          outcome: restored ? 'rolled-back' : 'partial-residue',
          attempted: 1,
          restored: restored ? 1 : 0,
          residue: {
            instanceId: instance.id,
            instancePresent,
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
            instanceId: instance.id,
            instancePresent: false,
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
  return validString(value, MAX_COMPONENT_INSTANTIATE_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value);
}

function validSuccess(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'component', 'instance', 'attempted', 'residue'])
    && value.schemaVersion === 1 && value.status === 'created'
    && exactKeys(value.component, ['id', 'name', 'remote'])
    && value.component.id === input.componentId
    && validId(value.component.id)
    && validString(value.component.name, MAX_COMPONENT_INSTANTIATE_NAME_CODE_UNITS)
    && typeof value.component.remote === 'boolean'
    && exactKeys(value.instance, [
      'id', 'name', 'type', 'parentId', 'index', 'x', 'y', 'mainComponentId',
    ])
    && validId(value.instance.id)
    && validString(value.instance.name, MAX_COMPONENT_INSTANTIATE_NAME_CODE_UNITS)
    && value.instance.type === 'INSTANCE'
    && validId(value.instance.parentId)
    && (input.parentId === null || value.instance.parentId === input.parentId)
    && Number.isSafeInteger(value.instance.index) && value.instance.index >= 0
    && (input.index === null || value.instance.index === input.index)
    && value.instance.x === input.x && value.instance.y === input.y
    && value.instance.mainComponentId === input.componentId
    && value.attempted === 1
    && Array.isArray(value.residue) && value.residue.length === 0
    && (input.name === null || value.instance.name === input.name);
}

function validFailure(value) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residue', 'failure',
  ])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && exactKeys(value.residue, ['instanceId', 'instancePresent', 'parentChanged'])
    && (value.residue.instanceId === null || validId(value.residue.instanceId))
    && typeof value.residue.instancePresent === 'boolean'
    && typeof value.residue.parentChanged === 'boolean'
    && validString(value.failure, 1_024, false)
    && (value.outcome !== 'rolled-back'
      || (value.restored === 1 && value.residue.instanceId !== null
        && !value.residue.instancePresent && !value.residue.parentChanged))
    && (value.outcome !== 'partial-residue'
      || (value.restored === 0
        && (value.residue.instancePresent || value.residue.parentChanged)))
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

export function formatComponentInstantiateResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  return `Created instance ${safeJson(result.instance.name)} (${result.instance.id}) from `
    + `${safeJson(result.component.name)} (${result.component.id}) in ${result.instance.parentId} `
    + `at index ${result.instance.index}, x=${result.instance.x}, y=${result.instance.y}`;
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

export async function executeComponentInstantiate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Instantiate requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentInstantiateCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COMPONENT_INSTANTIATE_RESULT_CODE_UNITS) {
    const error = new Error('Component Instantiate returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Instantiate returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Instantiate returned an invalid bounded result.');
    throw mutationError(`Component Instantiate made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw new Error('Component Instantiate returned an invalid bounded result.');
    const residueCount = Number(payload.residue.instancePresent) + Number(payload.residue.parentChanged);
    const message = payload.outcome === 'rolled-back'
      ? `Component Instantiate failed and removed the new Instance: ${payload.failure}`
      : `Component Instantiate failed; the new Instance outcome could not be fully restored: ${payload.failure}`;
    throw mutationError(message, payload.outcome, {
      version: 1,
      outcome: payload.outcome,
      attempted: 1,
      restored: payload.restored,
      residueCount,
    });
  }
  if (!validSuccess(payload, input)) {
    const error = new Error('Component Instantiate returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentInstantiateResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentInstantiatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Instantiate routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-instantiate';
}

export async function executeComponentInstantiatePlan(plan, adapters = {}) {
  if (componentInstantiatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Instantiate.`);
  }
  return executeComponentInstantiate(parseComponentInstantiateRequest(plan.argv), adapters);
}
