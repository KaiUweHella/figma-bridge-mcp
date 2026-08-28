// Plan-bound, one-shot and freshly verified Component Override removal Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_OVERRIDES_NODE_ID_CODE_UNITS,
  componentOverridesArgvFromRequest,
  componentOverridesPlanningArgvFromRequest,
  parseComponentOverridesRequest,
} from './component-overrides-request.js';

export {
  componentOverridesArgvFromRequest,
  componentOverridesPlanningArgvFromRequest,
} from './component-overrides-request.js';

const APPLICATION_ID = 'component.overrides';
export const MAX_COMPONENT_DIRECT_OVERRIDES = 50_000;
export const MAX_COMPONENT_OVERRIDE_FIELDS = 100_000;
export const MAX_COMPONENT_OVERRIDES_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_OVERRIDES_RESULT_CODE_UNITS = 32_768;

function normalizedRequest(request) {
  return parseComponentOverridesRequest(componentOverridesArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentOverridesCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const instanceId = ${jsValue(input.instanceId)};
    const requestedAction = ${jsValue(input.action)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_OVERRIDES_RESULT_CODE_UNITS}) {
        throw new Error('Component Overrides result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const snapshot = (node) => {
      if (!node || !Array.isArray(node.overrides)
        || node.overrides.length > ${MAX_COMPONENT_DIRECT_OVERRIDES}) {
        throw new Error('Instance overrides exceed their bounded count.');
      }
      let fieldCount = 0;
      const entries = node.overrides.map((entry) => {
        if (!entry || typeof entry.id !== 'string' || entry.id.length > ${MAX_COMPONENT_OVERRIDES_NODE_ID_CODE_UNITS}
          || !Array.isArray(entry.overriddenFields)) {
          throw new Error('Instance returned an invalid direct-override entry.');
        }
        fieldCount += entry.overriddenFields.length;
        if (fieldCount > ${MAX_COMPONENT_OVERRIDE_FIELDS}
          || entry.overriddenFields.some((field) => typeof field !== 'string' || field.length > 256)) {
          throw new Error('Instance override fields exceed their bounded count.');
        }
        return [entry.id, [...entry.overriddenFields].sort()];
      }).sort((left, right) => left[0].localeCompare(right[0]));
      return { entries, count: entries.length, fieldCount };
    };
    const sameSnapshot = (left, right) => JSON.stringify(left.entries) === JSON.stringify(right.entries);
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let instance;
    let main;
    let before;
    let parentId;
    try {
      instance = await figma.getNodeByIdAsync(instanceId);
      if (!instance || instance.type !== 'INSTANCE'
        || typeof instance.removeOverrides !== 'function'
        || typeof instance.getMainComponentAsync !== 'function') {
        throw new Error('Component Overrides requires an exact Instance node.');
      }
      main = await instance.getMainComponentAsync();
      if (!main || main.type !== 'COMPONENT' || typeof main.id !== 'string') {
        throw new Error('Instance main Component could not be resolved before mutation.');
      }
      if (!instance.parent || typeof instance.parent.id !== 'string') {
        throw new Error('Instance parent is unavailable.');
      }
      parentId = instance.parent.id;
      before = snapshot(instance);
    } catch (error) {
      return refusal(error);
    }

    const previous = {
      id: instance.id,
      name: clean(String(instance.name || ''), ${MAX_COMPONENT_OVERRIDES_NAME_CODE_UNITS}),
      mainComponentId: main.id,
      parentId,
      overrideCount: before.count,
      overriddenFieldCount: before.fieldCount,
    };
    if (before.count === 0) {
      return bounded({
        schemaVersion: 1, status: 'cleared', outcome: 'verified', action: requestedAction,
        previous, current: previous, attempted: 0, residue: [], warnings: [],
      });
    }

    let mutationError = null;
    try {
      instance.removeOverrides();
    } catch (error) {
      mutationError = error;
    }
    delete globalThis.__invCache;

    try {
      const actual = await figma.getNodeByIdAsync(instanceId);
      if (!actual || actual.type !== 'INSTANCE' || typeof actual.getMainComponentAsync !== 'function') {
        return bounded({
          schemaVersion: 1, status: 'failed', outcome: 'partial-residue', action: requestedAction,
          previous, current: null, attempted: 1,
          residue: { instancePresent: Boolean(actual), sameMainComponent: false, sameParent: false, overrideCount: null },
          failure: clean(mutationError?.message || 'Instance identity changed after removing overrides.', 1024),
        });
      }
      const actualMain = await actual.getMainComponentAsync();
      const after = snapshot(actual);
      const actualParentId = actual.parent && typeof actual.parent.id === 'string' ? actual.parent.id : null;
      const current = {
        id: actual.id,
        name: clean(String(actual.name || ''), ${MAX_COMPONENT_OVERRIDES_NAME_CODE_UNITS}),
        mainComponentId: actualMain && actualMain.type === 'COMPONENT' ? actualMain.id : null,
        parentId: actualParentId,
        overrideCount: after.count,
        overriddenFieldCount: after.fieldCount,
      };
      const identityMatches = actual.id === previous.id
        && current.mainComponentId === previous.mainComponentId
        && current.parentId === previous.parentId;
      if (identityMatches && after.count === 0) {
        const recovered = mutationError !== null;
        return bounded({
          schemaVersion: 1, status: 'cleared',
          outcome: recovered ? 'verified-after-error' : 'verified', action: requestedAction,
          previous, current, attempted: 1, residue: [],
          warnings: recovered
            ? ['The native override removal reported an error, but fresh readback proved zero direct overrides.'] : [],
        });
      }
      const unchanged = identityMatches && sameSnapshot(before, after);
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: unchanged ? 'unchanged' : 'partial-residue',
        action: requestedAction, previous, current, attempted: 1,
        residue: {
          instancePresent: true,
          sameMainComponent: current.mainComponentId === previous.mainComponentId,
          sameParent: current.parentId === previous.parentId,
          overrideCount: after.count,
        },
        failure: clean(mutationError?.message || 'fresh Component Overrides postcondition failed', 1024),
      });
    } catch (error) {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        action: requestedAction, previous, current: null, attempted: 1,
        residue: { instancePresent: null, sameMainComponent: null, sameParent: null, overrideCount: null },
        failure: clean(error?.message || mutationError?.message || 'override verification unavailable', 1024),
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
  return validString(value, MAX_COMPONENT_OVERRIDES_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value);
}

function validFacts(value, input, { zero = false, nullableRelations = false } = {}) {
  return exactKeys(value, [
    'id', 'name', 'mainComponentId', 'parentId', 'overrideCount', 'overriddenFieldCount',
  ]) && value.id === input.instanceId && validId(value.id)
    && validString(value.name, MAX_COMPONENT_OVERRIDES_NAME_CODE_UNITS)
    && (nullableRelations
      ? value.mainComponentId === null || validId(value.mainComponentId)
      : validId(value.mainComponentId))
    && (nullableRelations ? value.parentId === null || validId(value.parentId) : validId(value.parentId))
    && Number.isSafeInteger(value.overrideCount) && value.overrideCount >= 0
    && value.overrideCount <= MAX_COMPONENT_DIRECT_OVERRIDES
    && (!zero || value.overrideCount === 0)
    && Number.isSafeInteger(value.overriddenFieldCount) && value.overriddenFieldCount >= 0
    && value.overriddenFieldCount <= MAX_COMPONENT_OVERRIDE_FIELDS
    && (!zero || value.overriddenFieldCount === 0);
}

function validSuccess(value, input) {
  const noOp = value?.attempted === 0;
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'action', 'previous', 'current',
    'attempted', 'residue', 'warnings',
  ]) && value.schemaVersion === 1 && value.status === 'cleared'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && value.action === input.action
    && validFacts(value.previous, input)
    && validFacts(value.current, input, { zero: true })
    && value.current.mainComponentId === value.previous.mainComponentId
    && value.current.parentId === value.previous.parentId
    && [0, 1].includes(value.attempted)
    && (!noOp || value.previous.overrideCount === 0)
    && (noOp ? value.outcome === 'verified' : true)
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => validString(warning, 1_024, false));
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'action', 'previous', 'current',
    'attempted', 'residue', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || value.action !== input.action || !validFacts(value.previous, input)
    || value.attempted !== 1
    || !exactKeys(value.residue, [
      'instancePresent', 'sameMainComponent', 'sameParent', 'overrideCount',
    ])
    || !validString(value.failure, 1_024, false)) return false;
  const { instancePresent, sameMainComponent, sameParent, overrideCount } = value.residue;
  if (value.outcome === 'verification-unavailable') {
    return value.current === null
      && [instancePresent, sameMainComponent, sameParent, overrideCount].every((field) => field === null);
  }
  if (![true, false].includes(instancePresent)
    || ![true, false].includes(sameMainComponent)
    || ![true, false].includes(sameParent)
    || !(overrideCount === null || (Number.isSafeInteger(overrideCount)
      && overrideCount >= 0 && overrideCount <= MAX_COMPONENT_DIRECT_OVERRIDES))) return false;
  if (value.current !== null && !validFacts(value.current, input, { nullableRelations: true })) return false;
  if (value.outcome === 'unchanged') {
    return instancePresent === true && sameMainComponent === true && sameParent === true
      && overrideCount === value.previous.overrideCount;
  }
  return instancePresent === false || sameMainComponent === false || sameParent === false
    || (Number.isSafeInteger(overrideCount) && overrideCount > 0
      && overrideCount !== value.previous.overrideCount);
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

export function formatComponentOverridesResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  const verb = result.action === 'reset' ? 'Reset' : 'Removed';
  return `${verb} direct overrides on ${safeJson(result.current.name)} (${result.current.id}) `
    + `(${result.previous.overrideCount} → ${result.current.overrideCount})`
    + result.warnings.map((warning) => `\n  ⚠ ${warning}`).join('');
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

export async function executeComponentOverrides(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Overrides requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentOverridesCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_OVERRIDES_RESULT_CODE_UNITS) {
    const error = new Error('Component Overrides returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Overrides returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Overrides returned an invalid bounded result.');
    throw mutationError(`Component Overrides made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Component Overrides returned an invalid bounded result.');
    const messages = {
      unchanged: 'Component Overrides did not remove direct overrides.',
      'partial-residue': 'Component Overrides left partial residue.',
      'verification-unavailable': 'Component Overrides was dispatched, but fresh verification is unavailable.',
    };
    throw mutationError(`${messages[payload.outcome]} ${payload.failure}`, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: 1, restored: 0,
      residueCount: payload.outcome === 'unchanged' ? payload.previous.overrideCount : 1,
    });
  }
  if (!validSuccess(payload, input)) {
    const error = new Error('Component Overrides returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentOverridesResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentOverridesPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Overrides routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-overrides';
}

export async function executeComponentOverridesPlan(plan, adapters = {}) {
  if (componentOverridesPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Overrides.`);
  }
  return executeComponentOverrides(parseComponentOverridesRequest(plan.argv), adapters);
}
