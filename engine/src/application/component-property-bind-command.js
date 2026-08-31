// Plan-bound, rollback-owned Component Property Bind Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS,
  MAX_COMPONENT_PROPERTY_BIND_NODE_ID_CODE_UNITS,
  componentPropertyBindArgvFromRequest,
  componentPropertyBindPlanningArgvFromRequest,
  parseComponentPropertyBindRequest,
} from './component-property-bind-request.js';

export {
  componentPropertyBindArgvFromRequest,
  componentPropertyBindPlanningArgvFromRequest,
} from './component-property-bind-request.js';

const APPLICATION_ID = 'component.prop.bind';
export const MAX_COMPONENT_PROPERTY_BIND_COUNT = 50_000;
export const MAX_COMPONENT_PROPERTY_BIND_RESULT_CODE_UNITS = 700_000;

function normalizedRequest(request) {
  return parseComponentPropertyBindRequest(componentPropertyBindArgvFromRequest(request));
}

function jsString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentPropertyBindCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const componentId = ${jsString(input.componentId)};
    const requested = ${jsString(input.propertyName)};
    const nodeId = ${jsString(input.nodeId)};
    const remove = ${input.remove ? 'true' : 'false'};
    const replace = ${input.replace ? 'true' : 'false'};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_PROPERTY_BIND_RESULT_CODE_UNITS}) {
        throw new Error('Component Property Bind result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const own = (record, key) => record && Object.prototype.hasOwnProperty.call(record, key);
    const referencesOf = (node) => {
      const references = node.componentPropertyReferences;
      if (references === null) return null;
      if (!references || typeof references !== 'object' || Array.isArray(references)) {
        throw new Error('Target node returned invalid component-property references.');
      }
      const copy = {};
      for (const field of ['visible', 'characters', 'mainComponent']) {
        if (!own(references, field)) continue;
        if (typeof references[field] !== 'string'
          || references[field].length > ${MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS}) {
          throw new Error('Target node returned an invalid component-property reference.');
        }
        copy[field] = references[field];
      }
      return copy;
    };
    const sameReferences = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const applyReferences = (node, references) => {
      node.componentPropertyReferences = references;
    };

    try {
      const component = await figma.getNodeByIdAsync(componentId);
      if (!component) throw new Error('Component not found: ' + componentId);
      if (!['COMPONENT', 'COMPONENT_SET'].includes(component.type)
        || component.remote !== false) {
        throw new Error('Component Property Bind requires one local Component or Component Set.');
      }
      const definitions = component.componentPropertyDefinitions;
      if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
        throw new Error('Component returned invalid property definitions.');
      }
      const names = Object.keys(definitions);
      if (names.length > ${MAX_COMPONENT_PROPERTY_BIND_COUNT}) {
        throw new Error('Component exceeds the bounded property-definition count.');
      }
      const base = (candidate) => String(candidate).split('#')[0].trim().toLowerCase();
      let resolved = names.includes(requested) ? requested : null;
      if (!resolved) {
        const matches = names.filter((candidate) => base(candidate) === base(requested));
        if (matches.length > 1) throw new Error('Property name is ambiguous: ' + clean(requested, 1_024));
        resolved = matches[0] || null;
      }
      if (!resolved) throw new Error('Unknown component property: ' + clean(requested, 1_024));
      const definition = definitions[resolved];
      const fieldForType = { BOOLEAN: 'visible', TEXT: 'characters', INSTANCE_SWAP: 'mainComponent' };
      const field = fieldForType[definition?.type] || null;
      if (!field) {
        const guidance = definition?.type === 'VARIANT'
          ? 'VARIANT properties are native component-set axes and are not bound to one sublayer.'
          : definition?.type === 'SLOT'
            ? 'SLOT properties are created and configured with the slot commands.'
            : 'Unsupported component property type.';
        throw new Error(guidance);
      }

      const target = await figma.getNodeByIdAsync(nodeId);
      if (!target) throw new Error('Target node not found: ' + nodeId);
      let ancestor = target.parent || null;
      let contained = false;
      let visits = 0;
      while (ancestor && visits++ < 256) {
        if (ancestor.id === component.id) { contained = true; break; }
        ancestor = ancestor.parent || null;
      }
      if (!contained) throw new Error('Target node must be a sublayer of the Component or Component Set.');
      if (!('componentPropertyReferences' in target)) {
        throw new Error('Target node cannot receive component-property references.');
      }
      if (field === 'characters' && target.type !== 'TEXT') {
        throw new Error('TEXT properties must bind to a TEXT sublayer.');
      }
      if (field === 'mainComponent' && target.type !== 'INSTANCE') {
        throw new Error('INSTANCE_SWAP properties must bind to a nested INSTANCE sublayer.');
      }

      const beforeReferences = referencesOf(target);
      const current = beforeReferences && own(beforeReferences, field) ? beforeReferences[field] : null;
      if (remove && current !== null && current !== resolved) {
        throw new Error('Target field is bound to a different property; refusing to remove it.');
      }
      if (!remove && current !== null && current !== resolved && !replace) {
        throw new Error('Target field is already bound to another property; pass --replace to replace it explicitly.');
      }
      const nextReferences = { ...(beforeReferences || {}) };
      if (remove) delete nextReferences[field];
      else nextReferences[field] = resolved;
      const next = Object.keys(nextReferences).length ? nextReferences : null;
      if (sameReferences(beforeReferences, next)) {
        return bounded({
          schemaVersion: 1, status: 'unchanged',
          component: { id: component.id, name: clean(String(component.name || ''), 1_024), type: component.type },
          target: { id: target.id, name: clean(String(target.name || ''), 1_024), type: target.type },
          property: resolved, propertyType: definition.type, field, before: current,
          value: current, attempted: 0, residue: [],
        });
      }

      let attempted = false;
      try {
        attempted = true;
        applyReferences(target, next);
        const verifiedComponent = await figma.getNodeByIdAsync(componentId);
        const verified = await figma.getNodeByIdAsync(nodeId);
        const verifiedDefinitions = verifiedComponent?.componentPropertyDefinitions;
        const references = verified ? referencesOf(verified) : null;
        const actual = references && own(references, field) ? references[field] : null;
        const expected = remove ? null : resolved;
        if (!verifiedComponent || !verified || !verifiedDefinitions
          || !own(verifiedDefinitions, resolved)
          || !Object.is(actual, expected)
          || !sameReferences(references, next)) {
          throw new Error('Component Property Bind fresh postcondition failed.');
        }
        return bounded({
          schemaVersion: 1, status: remove ? 'unbound' : 'bound',
          component: { id: verifiedComponent.id, name: clean(String(verifiedComponent.name || ''), 1_024), type: verifiedComponent.type },
          target: { id: verified.id, name: clean(String(verified.name || ''), 1_024), type: verified.type },
          property: resolved, propertyType: definition.type, field, before: current,
          value: actual, attempted: 1, residue: [],
        });
      } catch (error) {
        if (attempted) {
          try { applyReferences(target, beforeReferences); } catch {}
        }
        let restored = false;
        let verifiable = true;
        let actual = null;
        try {
          const restoredTarget = await figma.getNodeByIdAsync(nodeId);
          const restoredReferences = restoredTarget ? referencesOf(restoredTarget) : null;
          actual = restoredReferences && own(restoredReferences, field) ? restoredReferences[field] : null;
          restored = Boolean(restoredTarget) && sameReferences(restoredReferences, beforeReferences);
        } catch { verifiable = false; }
        const residue = restored ? [] : [{ field, expected: current, actual }];
        return bounded({
          schemaVersion: 1, status: 'failed',
          outcome: !verifiable ? 'verification-unavailable' : restored ? 'rolled-back' : 'partial-residue',
          component: { id: component.id, name: clean(String(component.name || ''), 1_024), type: component.type },
          target: { id: target.id, name: clean(String(target.name || ''), 1_024), type: target.type },
          property: resolved, propertyType: definition.type, field,
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

function validNode(value, id, allowedTypes = null) {
  return exactKeys(value, ['id', 'name', 'type'])
    && value.id === id && NODE_REFERENCE_PATTERN.test(value.id)
    && validString(value.id, MAX_COMPONENT_PROPERTY_BIND_NODE_ID_CODE_UNITS, false)
    && validString(value.name, MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS)
    && validString(value.type, 64, false)
    && (!allowedTypes || allowedTypes.includes(value.type));
}

function validNullableName(value) {
  return value === null || validString(value, MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS, false);
}

function validSuccess(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'component', 'target', 'property', 'propertyType',
    'field', 'before', 'value', 'attempted', 'residue',
  ]) || value.schemaVersion !== 1
    || !['bound', 'unbound', 'unchanged'].includes(value.status)
    || !validNode(value.component, input.componentId, ['COMPONENT', 'COMPONENT_SET'])
    || !validNode(value.target, input.nodeId)
    || !validString(value.property, MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS, false)
    || !['BOOLEAN', 'TEXT', 'INSTANCE_SWAP'].includes(value.propertyType)
    || !['visible', 'characters', 'mainComponent'].includes(value.field)
    || !validNullableName(value.before) || !validNullableName(value.value)
    || ![0, 1].includes(value.attempted)
    || !Array.isArray(value.residue) || value.residue.length !== 0) return false;
  if (value.status === 'unchanged') return value.attempted === 0 && Object.is(value.before, value.value);
  if (value.status === 'unbound') return input.remove && value.attempted === 1 && value.value === null;
  return !input.remove && value.attempted === 1 && value.value === value.property;
}

function validFailure(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'component', 'target', 'property', 'propertyType',
    'field', 'attempted', 'restored', 'residue', 'failure',
  ]) && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && validNode(value.component, input.componentId, ['COMPONENT', 'COMPONENT_SET'])
    && validNode(value.target, input.nodeId)
    && validString(value.property, MAX_COMPONENT_PROPERTY_BIND_NAME_CODE_UNITS, false)
    && ['BOOLEAN', 'TEXT', 'INSTANCE_SWAP'].includes(value.propertyType)
    && ['visible', 'characters', 'mainComponent'].includes(value.field)
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

export function formatComponentPropertyBindResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  const verb = result.status === 'unbound' ? 'Unbound' : result.status === 'unchanged' ? 'Kept' : 'Bound';
  return `${verb} ${safeJson(result.property)} → ${result.target.id}.${result.field}`;
}

function mutationError(message, outcome, report) {
  const error = new Error(message);
  error.kind = 'execution'; error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch'; error.dispatchState = 'failed';
  error.mutationOutcome = outcome; error.mutationReport = report;
  return error;
}

export async function executeComponentPropertyBind(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Property Bind requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentPropertyBindCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_PROPERTY_BIND_RESULT_CODE_UNITS) {
    throw new Error('Component Property Bind returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Property Bind returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Property Bind returned an invalid bounded result.');
    throw mutationError(`Component Property Bind made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Component Property Bind returned an invalid bounded result.');
    const residueCount = payload.residue.length;
    throw mutationError(
      payload.outcome === 'rolled-back'
        ? `Component Property Bind failed and restored the prior reference: ${payload.failure}`
        : `Component Property Bind failed; ${residueCount} reference mutation(s) may remain: ${payload.failure}`,
      payload.outcome,
      { version: 1, outcome: payload.outcome, attempted: payload.attempted, restored: payload.restored, residueCount },
    );
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Component Property Bind returned an invalid bounded result.');
  }
  return {
    stdout: formatComponentPropertyBindResult(payload, { json: input.json }),
    stderr: '', result: payload,
  };
}

export function componentPropertyBindPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Property Bind routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-property-bind';
}

export async function executeComponentPropertyBindPlan(plan, adapters = {}) {
  if (componentPropertyBindPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Property Bind.`);
  }
  return executeComponentPropertyBind(parseComponentPropertyBindRequest(plan.argv), adapters);
}
