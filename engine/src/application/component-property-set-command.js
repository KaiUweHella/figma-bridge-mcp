// Plan-bound, rollback-owned Component Property Set Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS,
  MAX_COMPONENT_PROPERTY_NODE_ID_CODE_UNITS,
  MAX_COMPONENT_PROPERTY_VALUE_CODE_UNITS,
  componentPropertySetArgvFromRequest,
  componentPropertySetPlanningArgvFromRequest,
  parseComponentPropertySetRequest,
} from './component-property-set-request.js';

export {
  componentPropertySetArgvFromRequest,
  componentPropertySetPlanningArgvFromRequest,
} from './component-property-set-request.js';

const APPLICATION_ID = 'component.prop.set';
export const MAX_COMPONENT_PROPERTY_COUNT = 50_000;
export const MAX_COMPONENT_PROPERTY_RESULT_CODE_UNITS = 700_000;

function normalizedRequest(request) {
  return parseComponentPropertySetRequest(componentPropertySetArgvFromRequest(request));
}

function jsString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentPropertySetCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const instanceId = ${jsString(input.instanceId)};
    const requested = ${jsString(input.name)};
    const rawValue = ${jsString(input.value)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_PROPERTY_RESULT_CODE_UNITS}) {
        throw new Error('Component Property Set result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const own = (record, key) => record && Object.prototype.hasOwnProperty.call(record, key);
    const propertyValue = (record, key) => {
      const entry = own(record, key) ? record[key] : null;
      return entry && (typeof entry.value === 'string' || typeof entry.value === 'boolean')
        ? entry.value : undefined;
    };
    const updateFor = (key, value) => {
      const update = {};
      Object.defineProperty(update, key, { value, enumerable: true, configurable: true, writable: true });
      return update;
    };

    try {
      const instance = await figma.getNodeByIdAsync(instanceId);
      if (!instance) throw new Error('Node not found: ' + instanceId);
      if (instance.type !== 'INSTANCE' || typeof instance.setProperties !== 'function') {
        throw new Error('Expected an INSTANCE; got ' + clean(instance.type, 64));
      }
      const current = instance.componentProperties;
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error('Instance returned invalid component properties.');
      }
      const main = await instance.getMainComponentAsync();
      const owner = main && main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : main;
      const definitions = owner && owner.componentPropertyDefinitions
        && typeof owner.componentPropertyDefinitions === 'object'
        && !Array.isArray(owner.componentPropertyDefinitions)
        ? owner.componentPropertyDefinitions : {};
      const names = [...new Set([...Object.keys(current), ...Object.keys(definitions)])];
      if (names.length > ${MAX_COMPONENT_PROPERTY_COUNT}) {
        throw new Error('Instance exceeds the bounded component-property count.');
      }
      const base = (candidate) => String(candidate).split('#')[0].trim().toLowerCase();
      let resolved = names.includes(requested) ? requested : null;
      if (!resolved) {
        const matches = names.filter((candidate) => base(candidate) === base(requested));
        if (matches.length > 1) {
          throw new Error('Property name is ambiguous: ' + clean(requested, ${MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS}));
        }
        resolved = matches[0] || null;
      }
      if (!resolved) {
        throw new Error('Unknown component property: ' + clean(requested, ${MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS}));
      }
      if (resolved.length > ${MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS}) {
        throw new Error('Resolved property name exceeds the bounded contract.');
      }
      const definition = own(definitions, resolved) ? definitions[resolved]
        : own(current, resolved) ? current[resolved] : {};
      const type = typeof definition?.type === 'string' && definition.type.length <= 64
        ? definition.type
        : own(current, resolved) && typeof current[resolved]?.type === 'string'
          && current[resolved].type.length <= 64 ? current[resolved].type : 'TEXT';
      if (type === 'SLOT') {
        throw new Error('SLOT properties cannot be changed with InstanceNode.setProperties.');
      }
      let parsed = rawValue;
      if (type === 'BOOLEAN') {
        const lowered = String(parsed).toLowerCase();
        if (!['true', 'false', '1', '0'].includes(lowered)) {
          throw new Error('BOOLEAN values must be true or false.');
        }
        parsed = lowered === 'true' || lowered === '1';
      } else if (type === 'INSTANCE_SWAP' && /^\\d+:\\d+$/.test(String(parsed))) {
        let component = await figma.getNodeByIdAsync(String(parsed));
        if (!component || !['COMPONENT', 'COMPONENT_SET'].includes(component.type)) {
          throw new Error('INSTANCE_SWAP target is not a component: ' + clean(String(parsed), 96));
        }
        if (component.type === 'COMPONENT_SET') component = component.defaultVariant || component.children[0];
        if (!component || component.type !== 'COMPONENT') {
          throw new Error('INSTANCE_SWAP target component set has no variant.');
        }
        parsed = component.id;
      }
      const beforeFromInstance = propertyValue(current, resolved);
      const beforeFromDefinition = definition
        && (typeof definition.defaultValue === 'string' || typeof definition.defaultValue === 'boolean')
        ? definition.defaultValue : undefined;
      const before = beforeFromInstance === undefined ? beforeFromDefinition : beforeFromInstance;
      if (before === undefined) {
        throw new Error('Component property has no rollback-safe current value.');
      }
      if (typeof before === 'string' && before.length > ${MAX_COMPONENT_PROPERTY_VALUE_CODE_UNITS}) {
        throw new Error('Existing component property value exceeds the bounded rollback contract.');
      }
      if (Object.is(before, parsed)) {
        return bounded({
          schemaVersion: 1, status: 'unchanged',
          instance: { id: instance.id, name: clean(String(instance.name || ''), ${MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS}) },
          property: resolved, type, before, value: before,
          attempted: 0, residue: [],
        });
      }

      let attempted = false;
      try {
        attempted = true;
        instance.setProperties(updateFor(resolved, parsed));
        const verified = await figma.getNodeByIdAsync(instanceId);
        const verifiedProperties = verified && verified.type === 'INSTANCE'
          ? verified.componentProperties : null;
        const value = propertyValue(verifiedProperties, resolved);
        if (!verified || verified.type !== 'INSTANCE' || value === undefined || !Object.is(value, parsed)) {
          throw new Error('Component Property Set fresh postcondition failed.');
        }
        return bounded({
          schemaVersion: 1, status: 'updated',
          instance: { id: verified.id, name: clean(String(verified.name || ''), ${MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS}) },
          property: resolved, type, before, value,
          attempted: 1, residue: [],
        });
      } catch (error) {
        let restored = false;
        let verifiable = true;
        let actual = null;
        if (attempted) {
          try { instance.setProperties(updateFor(resolved, before)); } catch {}
        }
        try {
          const restoredInstance = await figma.getNodeByIdAsync(instanceId);
          const restoredProperties = restoredInstance && restoredInstance.type === 'INSTANCE'
            ? restoredInstance.componentProperties : null;
          const restoredValue = propertyValue(restoredProperties, resolved);
          restored = restoredInstance?.type === 'INSTANCE' && Object.is(restoredValue, before);
          actual = restoredValue === undefined ? null : restoredValue;
        } catch {
          verifiable = false;
        }
        const residue = restored ? [] : [{ property: resolved, expected: before, actual }];
        return bounded({
          schemaVersion: 1, status: 'failed',
          outcome: !verifiable ? 'verification-unavailable' : restored ? 'rolled-back' : 'partial-residue',
          instance: { id: instance.id, name: clean(String(instance.name || ''), ${MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS}) },
          property: resolved, type,
          attempted: attempted ? 1 : 0, restored: restored ? 1 : 0, residue,
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

function validScalar(value) {
  return typeof value === 'boolean'
    || validString(value, MAX_COMPONENT_PROPERTY_VALUE_CODE_UNITS);
}

function propertyBase(value) {
  return String(value).split('#')[0].trim().toLowerCase();
}

function validScalarForType(type, value) {
  return type === 'BOOLEAN' ? typeof value === 'boolean' : typeof value === 'string';
}

function validInstance(value, expectedId) {
  return exactKeys(value, ['id', 'name'])
    && validString(value.id, MAX_COMPONENT_PROPERTY_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && value.id === expectedId
    && validString(value.name, MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'instance', 'property', 'type', 'before', 'value', 'attempted', 'residue',
  ])
    && value.schemaVersion === 1
    && ['updated', 'unchanged'].includes(value.status)
    && validInstance(value.instance, input.instanceId)
    && validString(value.property, MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS, false)
    && (value.property === input.name || propertyBase(value.property) === propertyBase(input.name))
    && validString(value.type, 64, false)
    && validScalar(value.before) && validScalar(value.value)
    && validScalarForType(value.type, value.before) && validScalarForType(value.type, value.value)
    && value.attempted === (value.status === 'updated' ? 1 : 0)
    && Array.isArray(value.residue) && value.residue.length === 0
    && (value.status === 'unchanged'
      ? Object.is(value.before, value.value) : !Object.is(value.before, value.value));
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'instance', 'property', 'type',
    'attempted', 'restored', 'residue', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !validInstance(value.instance, input.instanceId)
    || !validString(value.property, MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS, false)
    || !validString(value.type, 64, false)
    || ![0, 1].includes(value.attempted) || ![0, 1].includes(value.restored)
    || value.restored > value.attempted
    || !Array.isArray(value.residue) || value.residue.length > 1
    || value.residue.some((entry) => !exactKeys(entry, ['property', 'expected', 'actual'])
      || !validString(entry.property, MAX_COMPONENT_PROPERTY_NAME_CODE_UNITS, false)
      || !validScalar(entry.expected)
      || !(entry.actual === null || validScalar(entry.actual)))
    || !validString(value.failure, 1_024, false)) return false;
  if (value.outcome === 'rolled-back') return value.restored === 1 && value.residue.length === 0;
  if (value.outcome === 'partial-residue') return value.residue.length === 1;
  return true;
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

export function formatComponentPropertySetResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  const verb = result.status === 'unchanged' ? 'Kept' : 'Set';
  return `${verb} ${safeJson(result.property)}=${safeJson(result.value)} on ${safeJson(result.instance.name)} (${result.instance.id})`;
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

export async function executeComponentPropertySet(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Property Set requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentPropertySetCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_PROPERTY_RESULT_CODE_UNITS) {
    const error = new Error('Component Property Set returned an invalid bounded result.');
    error.kind = 'plugin-result';
    error.phase = 'plugin-response';
    error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Property Set returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Property Set returned an invalid bounded result.');
    throw mutationError(`Component Property Set made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Component Property Set returned an invalid bounded result.');
    const residueCount = payload.residue.length;
    const message = payload.outcome === 'rolled-back'
      ? `Component Property Set failed and restored the prior value: ${payload.failure}`
      : `Component Property Set failed; ${residueCount} property mutation(s) may remain: ${payload.failure}`;
    throw mutationError(message, payload.outcome, {
      version: 1, outcome: payload.outcome,
      attempted: payload.attempted, restored: payload.restored, residueCount,
    });
  }
  if (!validSuccess(payload, input)) {
    const error = new Error('Component Property Set returned an invalid bounded result.');
    error.kind = 'plugin-result';
    error.phase = 'plugin-response';
    error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentPropertySetResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentPropertySetPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Property Set routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-property-set';
}

export async function executeComponentPropertySetPlan(plan, adapters = {}) {
  if (componentPropertySetPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Property Set.`);
  }
  return executeComponentPropertySet(parseComponentPropertySetRequest(plan.argv), adapters);
}
