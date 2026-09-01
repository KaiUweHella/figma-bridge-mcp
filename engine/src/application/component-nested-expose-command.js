// Plan-bound, rollback-owned nested Component property exposure Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_NESTED_EXPOSE_NODE_ID_CODE_UNITS,
  componentNestedExposeArgvFromRequest,
  componentNestedExposePlanningArgvFromRequest,
  parseComponentNestedExposeRequest,
} from './component-nested-expose-request.js';

export {
  componentNestedExposeArgvFromRequest,
  componentNestedExposePlanningArgvFromRequest,
} from './component-nested-expose-request.js';

const APPLICATION_ID = 'component.nested.expose';
export const MAX_COMPONENT_NESTED_EXPOSE_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_NESTED_EXPOSE_RESULT_CODE_UNITS = 700_000;

function normalizedRequest(request) {
  return parseComponentNestedExposeRequest(componentNestedExposeArgvFromRequest(request));
}

function jsString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentNestedExposeCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const instanceId = ${jsString(input.instanceId)};
    const desired = ${input.exposed ? 'true' : 'false'};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_NESTED_EXPOSE_RESULT_CODE_UNITS}) {
        throw new Error('Component Nested Expose result exceeded the bounded response limit.');
      }
      return serialized;
    };
    try {
      const instance = await figma.getNodeByIdAsync(instanceId);
      if (!instance) throw new Error('Node not found: ' + instanceId);
      if (instance.type !== 'INSTANCE' || typeof instance.isExposedInstance !== 'boolean') {
        throw new Error('Component Nested Expose requires one nested INSTANCE.');
      }
      let ancestor = instance.parent || null;
      let owner = null;
      let visits = 0;
      while (ancestor && visits++ < 256) {
        if (ancestor.type === 'INSTANCE') {
          throw new Error('Inherited instances inside another INSTANCE cannot change isExposedInstance; target the primary nested instance in its main Component.');
        }
        if (ancestor.type === 'COMPONENT' || ancestor.type === 'COMPONENT_SET') {
          owner = ancestor; break;
        }
        ancestor = ancestor.parent || null;
      }
      if (!owner) throw new Error('Nested instance must be contained by a local Component or Component Set.');
      if (owner.remote === true) throw new Error('Remote Components cannot expose nested instances.');
      const before = instance.isExposedInstance;
      const compact = (node) => ({
        id: node.id,
        name: clean(String(node.name || ''), ${MAX_COMPONENT_NESTED_EXPOSE_NAME_CODE_UNITS}),
        type: node.type,
      });
      if (before === desired) {
        return bounded({
          schemaVersion: 1, status: 'unchanged', owner: compact(owner), instance: compact(instance),
          before, value: before, attempted: 0, residue: [],
        });
      }
      let attempted = false;
      try {
        attempted = true;
        instance.isExposedInstance = desired;
        const verified = await figma.getNodeByIdAsync(instanceId);
        if (!verified || verified.type !== 'INSTANCE' || verified.isExposedInstance !== desired) {
          throw new Error('Component Nested Expose fresh postcondition failed.');
        }
        return bounded({
          schemaVersion: 1, status: desired ? 'exposed' : 'hidden', owner: compact(owner), instance: compact(verified),
          before, value: verified.isExposedInstance, attempted: 1, residue: [],
        });
      } catch (error) {
        if (attempted) {
          try { instance.isExposedInstance = before; } catch {}
        }
        let restored = false;
        let verifiable = true;
        let actual = null;
        try {
          const restoredInstance = await figma.getNodeByIdAsync(instanceId);
          actual = restoredInstance?.type === 'INSTANCE' ? restoredInstance.isExposedInstance : null;
          restored = restoredInstance?.type === 'INSTANCE' && actual === before;
        } catch { verifiable = false; }
        return bounded({
          schemaVersion: 1, status: 'failed',
          outcome: !verifiable ? 'verification-unavailable' : restored ? 'rolled-back' : 'partial-residue',
          owner: compact(owner), instance: compact(instance), attempted: attempted ? 1 : 0,
          restored: restored ? 1 : 0,
          residue: restored ? [] : [{ field: 'isExposedInstance', expected: before, actual }],
          failure: clean(error?.message || 'mutation failed', 1_024),
        });
      }
    } catch (error) {
      return bounded({
        schemaVersion: 1, status: 'refused', outcome: 'no-mutation',
        failure: clean(error?.message || 'preflight refused', 1_024),
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

function validNode(value, expectedId = null) {
  return exactKeys(value, ['id', 'name', 'type'])
    && validString(value.id, MAX_COMPONENT_NESTED_EXPOSE_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id) && (!expectedId || value.id === expectedId)
    && validString(value.name, MAX_COMPONENT_NESTED_EXPOSE_NAME_CODE_UNITS)
    && ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(value.type);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'owner', 'instance', 'before', 'value', 'attempted', 'residue',
  ]) && value.schemaVersion === 1 && ['exposed', 'hidden', 'unchanged'].includes(value.status)
    && validNode(value.owner) && ['COMPONENT', 'COMPONENT_SET'].includes(value.owner.type)
    && validNode(value.instance, input.instanceId) && value.instance.type === 'INSTANCE'
    && typeof value.before === 'boolean' && typeof value.value === 'boolean'
    && [0, 1].includes(value.attempted) && Array.isArray(value.residue) && value.residue.length === 0
    && (value.status === 'unchanged'
      ? value.attempted === 0 && value.before === value.value
      : value.attempted === 1 && value.value === input.exposed);
}

function validFailure(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'owner', 'instance', 'attempted', 'restored', 'residue', 'failure',
  ]) && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && validNode(value.owner) && ['COMPONENT', 'COMPONENT_SET'].includes(value.owner.type)
    && validNode(value.instance, input.instanceId) && value.instance.type === 'INSTANCE'
    && [0, 1].includes(value.attempted) && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 1
    && validString(value.failure, 1_024, false)
    && (value.outcome !== 'rolled-back' || (value.restored === 1 && value.residue.length === 0))
    && (value.outcome !== 'partial-residue' || (value.restored === 0 && value.residue.length === 1));
}

function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation'
    && validString(value.failure, 1_024, false);
}

function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatComponentNestedExposeResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  const state = result.value ? 'exposed' : 'not exposed';
  return `Nested instance ${safeJson(result.instance.name)} (${result.instance.id}) is ${state}.`;
}

function mutationError(message, outcome, report) {
  const error = new Error(message);
  error.kind = 'execution'; error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch'; error.dispatchState = 'failed';
  error.mutationOutcome = outcome; error.mutationReport = report;
  return error;
}

export async function executeComponentNestedExpose(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Nested Expose requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentNestedExposeCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_NESTED_EXPOSE_RESULT_CODE_UNITS) {
    throw new Error('Component Nested Expose returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Nested Expose returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Nested Expose returned an invalid bounded result.');
    throw mutationError(`Component Nested Expose made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Component Nested Expose returned an invalid bounded result.');
    const residueCount = payload.residue.length;
    throw mutationError(
      payload.outcome === 'rolled-back'
        ? `Component Nested Expose failed and restored the prior state: ${payload.failure}`
        : `Component Nested Expose failed; ${residueCount} mutation(s) may remain: ${payload.failure}`,
      payload.outcome,
      { version: 1, outcome: payload.outcome, attempted: payload.attempted, restored: payload.restored, residueCount },
    );
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Component Nested Expose returned an invalid bounded result.');
  }
  return {
    stdout: formatComponentNestedExposeResult(payload, { json: input.json }),
    stderr: '', result: payload,
  };
}

export function componentNestedExposePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Nested Expose routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-nested-expose';
}

export async function executeComponentNestedExposePlan(plan, adapters = {}) {
  if (componentNestedExposePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Nested Expose.`);
  }
  return executeComponentNestedExpose(parseComponentNestedExposeRequest(plan.argv), adapters);
}
