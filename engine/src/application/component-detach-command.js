// Plan-bound, irreversible and freshly verified Component Detach Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_DETACH_NAME_CODE_UNITS,
  MAX_COMPONENT_DETACH_NODE_ID_CODE_UNITS,
  componentDetachArgvFromRequest,
  componentDetachPlanningArgvFromRequest,
  parseComponentDetachRequest,
} from './component-detach-request.js';

export {
  componentDetachArgvFromRequest,
  componentDetachPlanningArgvFromRequest,
} from './component-detach-request.js';

const APPLICATION_ID = 'component.detach';
export const MAX_COMPONENT_DETACH_CHILDREN = 50_000;
export const MAX_COMPONENT_DETACH_RESULT_CODE_UNITS = 32_768;

function normalizedRequest(request) {
  return parseComponentDetachRequest(componentDetachArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentDetachCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const instanceId = ${jsValue(input.instanceId)};
    const requestedName = ${jsValue(input.name)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_DETACH_RESULT_CODE_UNITS}) {
        throw new Error('Component Detach result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const childrenOf = (node) => {
      if (!node || !Array.isArray(node.children)) throw new Error('Parent returned invalid child membership.');
      if (node.children.length > ${MAX_COMPONENT_DETACH_CHILDREN}) {
        throw new Error('Parent exceeds the bounded child count.');
      }
      const ids = node.children.map((child) => child && child.id);
      if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
        throw new Error('Parent returned invalid child membership.');
      }
      return ids;
    };
    const sameIds = (left, right) => left.length === right.length
      && left.every((id, index) => id === right[index]);
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let instance;
    let parent;
    let beforeIds;
    let index;
    let previous;
    try {
      instance = await figma.getNodeByIdAsync(instanceId);
      if (!instance || instance.type !== 'INSTANCE'
        || typeof instance.detachInstance !== 'function'
        || typeof instance.getMainComponentAsync !== 'function') {
        throw new Error('Component Detach requires an exact Instance node.');
      }
      parent = instance.parent;
      if (!parent || typeof parent.id !== 'string') throw new Error('Instance parent is unavailable.');
      beforeIds = childrenOf(parent);
      index = beforeIds.indexOf(instance.id);
      if (index < 0) throw new Error('Instance is absent from its parent membership.');
      previous = await instance.getMainComponentAsync();
      if (!previous || previous.type !== 'COMPONENT' || typeof previous.id !== 'string') {
        throw new Error('Instance main Component could not be resolved before mutation.');
      }
      if (!Array.isArray(instance.overrides)
        || instance.overrides.length > ${MAX_COMPONENT_DETACH_CHILDREN}) {
        throw new Error('Instance overrides exceed their bounded count.');
      }
    } catch (error) {
      return refusal(error);
    }

    const previousFacts = {
      id: instance.id,
      name: clean(String(instance.name || ''), ${MAX_COMPONENT_DETACH_NAME_CODE_UNITS}),
      mainComponentId: previous.id,
      parentId: parent.id,
      index,
      overrideCount: instance.overrides.length,
    };
    let frame = null;
    let mutationError = null;
    try {
      frame = instance.detachInstance();
      if (!frame || frame.type !== 'FRAME' || typeof frame.id !== 'string') {
        throw new Error('Figma did not return a detached Frame.');
      }
      if (requestedName !== null) frame.name = requestedName;
    } catch (error) {
      mutationError = error;
    }
    delete globalThis.__invCache;

    try {
      const freshParent = await figma.getNodeByIdAsync(parent.id);
      const afterIds = childrenOf(freshParent);
      let actual = frame && typeof frame.id === 'string'
        ? await figma.getNodeByIdAsync(frame.id) : null;
      if (!actual) {
        const original = await figma.getNodeByIdAsync(instanceId);
        if (original && original.type === 'FRAME') actual = original;
      }
      if (!actual) {
        const addedIds = afterIds.filter((id) => !beforeIds.includes(id));
        if (addedIds.length === 1) {
          const candidate = await figma.getNodeByIdAsync(addedIds[0]);
          if (candidate && candidate.type === 'FRAME') actual = candidate;
        }
      }
      if (actual && actual.type === 'FRAME' && actual.parent && actual.parent.id === parent.id) {
        const expectedIds = [...beforeIds];
        expectedIds.splice(index, 1, actual.id);
        if (sameIds(afterIds, expectedIds) && afterIds[index] === actual.id
          && (requestedName === null || actual.name === requestedName)
          && Array.isArray(actual.children)
          && actual.children.length <= ${MAX_COMPONENT_DETACH_CHILDREN}) {
          const recovered = mutationError !== null;
          return bounded({
            schemaVersion: 1, status: 'detached',
            outcome: recovered ? 'verified-after-error' : 'verified',
            previous: previousFacts,
            frame: {
              id: actual.id,
              name: requestedName !== null
                ? requestedName
                : clean(String(actual.name || ''), ${MAX_COMPONENT_DETACH_NAME_CODE_UNITS}),
              type: actual.type,
              parentId: actual.parent.id,
              index,
              childCount: actual.children.length,
            },
            attempted: 1, residue: [],
            warnings: recovered
              ? ['The native detach sequence reported an error, but fresh readback proved the requested Frame.'] : [],
          });
        }
      }

      const original = await figma.getNodeByIdAsync(instanceId);
      const originalInstancePresent = Boolean(original && original.type === 'INSTANCE');
      const detachedFramePresent = Boolean(actual && actual.type === 'FRAME');
      const parentChanged = !sameIds(afterIds, beforeIds);
      const nameMatches = requestedName === null || !detachedFramePresent
        ? null : actual.name === requestedName;
      const unchanged = originalInstancePresent && !detachedFramePresent && !parentChanged;
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: unchanged ? 'unchanged' : 'partial-residue',
        previous: previousFacts,
        actual: actual ? {
          id: actual.id,
          name: clean(String(actual.name || ''), ${MAX_COMPONENT_DETACH_NAME_CODE_UNITS}),
          type: actual.type,
          parentId: actual.parent && typeof actual.parent.id === 'string' ? actual.parent.id : null,
        } : null,
        requestedName,
        attempted: 1,
        residue: { originalInstancePresent, detachedFramePresent, parentChanged, nameMatches },
        failure: clean(mutationError?.message || 'fresh Component Detach postcondition failed', 1024),
      });
    } catch (error) {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        previous: previousFacts, actual: null, requestedName, attempted: 1,
        residue: {
          originalInstancePresent: null,
          detachedFramePresent: null,
          parentChanged: null,
          nameMatches: null,
        },
        failure: clean(error?.message || mutationError?.message || 'detach verification unavailable', 1024),
      });
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
  return validString(value, MAX_COMPONENT_DETACH_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value);
}

function validPrevious(value, input) {
  return exactKeys(value, ['id', 'name', 'mainComponentId', 'parentId', 'index', 'overrideCount'])
    && value.id === input.instanceId && validId(value.id)
    && validString(value.name, MAX_COMPONENT_DETACH_NAME_CODE_UNITS)
    && validId(value.mainComponentId) && validId(value.parentId)
    && Number.isSafeInteger(value.index) && value.index >= 0
    && Number.isSafeInteger(value.overrideCount) && value.overrideCount >= 0
    && value.overrideCount <= MAX_COMPONENT_DETACH_CHILDREN;
}

function validActual(value) {
  return exactKeys(value, ['id', 'name', 'type', 'parentId'])
    && validId(value.id) && validString(value.name, MAX_COMPONENT_DETACH_NAME_CODE_UNITS)
    && validString(value.type, 64, false)
    && (value.parentId === null || validId(value.parentId));
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'previous', 'frame',
    'attempted', 'residue', 'warnings',
  ]) && value.schemaVersion === 1 && value.status === 'detached'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validPrevious(value.previous, input)
    && exactKeys(value.frame, ['id', 'name', 'type', 'parentId', 'index', 'childCount'])
    && validId(value.frame.id)
    && validString(value.frame.name, MAX_COMPONENT_DETACH_NAME_CODE_UNITS)
    && value.frame.type === 'FRAME' && value.frame.parentId === value.previous.parentId
    && value.frame.index === value.previous.index
    && Number.isSafeInteger(value.frame.childCount) && value.frame.childCount >= 0
    && value.frame.childCount <= MAX_COMPONENT_DETACH_CHILDREN
    && (input.name === null || value.frame.name === input.name)
    && value.attempted === 1 && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => validString(warning, 1_024, false));
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'previous', 'actual', 'requestedName',
    'attempted', 'residue', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !validPrevious(value.previous, input)
    || value.requestedName !== input.name
    || value.attempted !== 1
    || !exactKeys(value.residue, [
      'originalInstancePresent', 'detachedFramePresent', 'parentChanged', 'nameMatches',
    ])
    || !validString(value.failure, 1_024, false)) return false;
  const fields = Object.values(value.residue);
  if (value.outcome === 'verification-unavailable') {
    return value.actual === null && fields.every((field) => field === null);
  }
  if (fields.some((field) => ![true, false, null].includes(field))) return false;
  if (value.actual !== null && !validActual(value.actual)) return false;
  if (value.outcome === 'unchanged') {
    return value.residue.originalInstancePresent === true
      && value.residue.detachedFramePresent === false
      && value.residue.parentChanged === false;
  }
  return value.residue.detachedFramePresent === true
    || value.residue.parentChanged === true
    || value.residue.originalInstancePresent === false;
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

export function formatComponentDetachResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  return [
    `Detached as ${safeJson(result.frame.name)} (${result.frame.id}) in `
      + `${result.frame.parentId} at index ${result.frame.index}`,
    ...result.warnings.map((warning) => `  ⚠ ${warning}`),
  ].join('\n');
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

export async function executeComponentDetach(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Detach requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentDetachCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_DETACH_RESULT_CODE_UNITS) {
    const error = new Error('Component Detach returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Detach returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Detach returned an invalid bounded result.');
    throw mutationError(`Component Detach made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Component Detach returned an invalid bounded result.');
    const messages = {
      unchanged: 'Component Detach did not replace the Instance.',
      'partial-residue': 'Component Detach has irreversible partial residue.',
      'verification-unavailable': 'Component Detach was dispatched, but fresh verification is unavailable.',
    };
    throw mutationError(`${messages[payload.outcome]} ${payload.failure}`, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: 1, restored: 0,
      residueCount: 1,
    });
  }
  if (!validSuccess(payload, input)) {
    const error = new Error('Component Detach returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentDetachResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentDetachPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Detach routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-detach';
}

export async function executeComponentDetachPlan(plan, adapters = {}) {
  if (componentDetachPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Detach.`);
  }
  return executeComponentDetach(parseComponentDetachRequest(plan.argv), adapters);
}
