// Plan-bound, bounded and irreversible Component Property Delete Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS,
  MAX_COMPONENT_PROPERTY_DELETE_NODE_ID_CODE_UNITS,
  componentPropertyDeleteArgvFromRequest,
  componentPropertyDeletePlanningArgvFromRequest,
  parseComponentPropertyDeleteRequest,
} from './component-property-delete-request.js';

export {
  componentPropertyDeleteArgvFromRequest,
  componentPropertyDeletePlanningArgvFromRequest,
} from './component-property-delete-request.js';

const APPLICATION_ID = 'component.prop.delete';
export const MAX_COMPONENT_PROPERTY_DELETE_COUNT = 50_000;
export const MAX_COMPONENT_PROPERTY_DELETE_RESIDUE_NAMES = 8;
export const MAX_COMPONENT_PROPERTY_DELETE_RESULT_CODE_UNITS = 700_000;
const MAX_COMPONENT_PROPERTY_DELETE_VALUE_CODE_UNITS = 200_000;

function normalizedRequest(request) {
  return parseComponentPropertyDeleteRequest(componentPropertyDeleteArgvFromRequest(request));
}

function jsString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentPropertyDeleteCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const componentId = ${jsString(input.componentId)};
    const propertyName = ${jsString(input.propName)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_PROPERTY_DELETE_RESULT_CODE_UNITS}) {
        throw new Error('Component Property Delete result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const own = (record, key) => record && Object.prototype.hasOwnProperty.call(record, key);
    const definitionsOf = (node) => {
      const definitions = node && node.componentPropertyDefinitions;
      if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
        throw new Error('Component returned invalid property definitions.');
      }
      return definitions;
    };
    const scalar = (value) => typeof value === 'boolean'
      || (typeof value === 'string' && value.length <= ${MAX_COMPONENT_PROPERTY_DELETE_VALUE_CODE_UNITS});

    try {
      const component = await figma.getNodeByIdAsync(componentId);
      if (!component) throw new Error('Node not found: ' + componentId);
      if (!['COMPONENT', 'COMPONENT_SET'].includes(component.type)
        || component.remote !== false
        || typeof component.deleteComponentProperty !== 'function') {
        throw new Error('Component Property Delete requires one local Component or Component Set.');
      }
      const definitions = definitionsOf(component);
      const beforeNames = Object.keys(definitions);
      if (beforeNames.length > ${MAX_COMPONENT_PROPERTY_DELETE_COUNT}) {
        throw new Error('Component exceeds the bounded property-definition count.');
      }
      if (!own(definitions, propertyName)) {
        throw new Error('Unknown component property; use the exact full name including its #suffix.');
      }
      const target = definitions[propertyName];
      if (!target || typeof target.type !== 'string' || !target.type
        || target.type.length > 64 || !scalar(target.defaultValue)) {
        throw new Error('Component Property Delete encountered incompatible definition metadata.');
      }
      const property = { name: propertyName, type: target.type, defaultValue: target.defaultValue };
      const otherNames = beforeNames.filter((name) => name !== propertyName);
      const componentFacts = {
        id: component.id,
        name: clean(String(component.name || ''), ${MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS}),
        type: component.type,
      };
      let deletionError = null;
      try { component.deleteComponentProperty(propertyName); }
      catch (error) { deletionError = error; }

      try {
        const verified = await figma.getNodeByIdAsync(componentId);
        const after = definitionsOf(verified);
        const targetPresent = own(after, propertyName);
        const missingOriginalNames = otherNames.filter((name) => !own(after, name));
        if (!targetPresent && missingOriginalNames.length === 0) {
          const recovered = deletionError !== null;
          return bounded({
            schemaVersion: 1, status: 'deleted',
            outcome: recovered ? 'verified-after-error' : 'verified',
            component: componentFacts, property, attempted: 1, residue: [],
            warnings: recovered
              ? ['The native delete call reported an error, but fresh readback proved the exact requested deletion.'] : [],
          });
        }
        const outcome = targetPresent && missingOriginalNames.length === 0
          ? 'unchanged' : 'partial-residue';
        return bounded({
          schemaVersion: 1, status: 'failed', outcome,
          component: componentFacts, property, attempted: 1,
          residue: {
            targetPresent,
            missingOriginalCount: missingOriginalNames.length,
            missingOriginalNames: missingOriginalNames.slice(0, ${MAX_COMPONENT_PROPERTY_DELETE_RESIDUE_NAMES})
              .map((name) => clean(name, ${MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS})),
          },
          failure: clean(deletionError?.message || 'fresh deletion postcondition failed', 1_024),
        });
      } catch (error) {
        return bounded({
          schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
          component: componentFacts, property, attempted: 1,
          residue: { targetPresent: null, missingOriginalCount: 0, missingOriginalNames: [] },
          failure: clean(error?.message || deletionError?.message || 'deletion verification unavailable', 1_024),
        });
      }
    } catch (error) {
      return bounded({
        schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
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
    || validString(value, MAX_COMPONENT_PROPERTY_DELETE_VALUE_CODE_UNITS);
}

function validComponent(value, input) {
  return exactKeys(value, ['id', 'name', 'type'])
    && value.id === input.componentId
    && validString(value.id, MAX_COMPONENT_PROPERTY_DELETE_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && validString(value.name, MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS)
    && ['COMPONENT', 'COMPONENT_SET'].includes(value.type);
}

function validProperty(value, input) {
  return exactKeys(value, ['name', 'type', 'defaultValue'])
    && value.name === input.propName
    && validString(value.name, MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS, false)
    && validString(value.type, 64, false)
    && validScalar(value.defaultValue);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'component', 'property', 'attempted', 'residue', 'warnings',
  ]) && value.schemaVersion === 1 && value.status === 'deleted'
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validComponent(value.component, input) && validProperty(value.property, input)
    && value.attempted === 1 && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => validString(warning, 1_024, false));
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'component', 'property', 'attempted', 'residue', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !validComponent(value.component, input) || !validProperty(value.property, input)
    || value.attempted !== 1
    || !exactKeys(value.residue, ['targetPresent', 'missingOriginalCount', 'missingOriginalNames'])
    || ![true, false, null].includes(value.residue.targetPresent)
    || !Number.isSafeInteger(value.residue.missingOriginalCount)
    || value.residue.missingOriginalCount < 0
    || !Array.isArray(value.residue.missingOriginalNames)
    || value.residue.missingOriginalNames.length > MAX_COMPONENT_PROPERTY_DELETE_RESIDUE_NAMES
    || value.residue.missingOriginalNames.length > value.residue.missingOriginalCount
    || value.residue.missingOriginalNames.some((name) =>
      !validString(name, MAX_COMPONENT_PROPERTY_DELETE_NAME_CODE_UNITS, false))
    || !validString(value.failure, 1_024, false)) return false;
  if (value.outcome === 'unchanged') {
    return value.residue.targetPresent === true && value.residue.missingOriginalCount === 0;
  }
  if (value.outcome === 'partial-residue') return value.residue.missingOriginalCount > 0;
  return value.residue.targetPresent === null
    && value.residue.missingOriginalCount === 0
    && value.residue.missingOriginalNames.length === 0;
}

function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation'
    && value.attempted === 0 && validString(value.failure, 1_024, false);
}

function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatComponentPropertyDeleteResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  return [
    `Deleted property ${safeJson(result.property.name)} on `
      + `${safeJson(result.component.name)} (${result.component.id})`,
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

export async function executeComponentPropertyDelete(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Property Delete requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentPropertyDeleteCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COMPONENT_PROPERTY_DELETE_RESULT_CODE_UNITS) {
    const error = new Error('Component Property Delete returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Property Delete returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Property Delete returned an invalid bounded result.');
    throw mutationError(`Component Property Delete made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Component Property Delete returned an invalid bounded result.');
    }
    const residueCount = payload.outcome === 'verification-unavailable'
      ? 1
      : payload.residue.missingOriginalCount + (payload.residue.targetPresent ? 1 : 0);
    const messages = {
      unchanged: 'Component Property Delete failed before the requested property was removed.',
      'partial-residue': 'Component Property Delete has irreversible partial residue.',
      'verification-unavailable': 'Component Property Delete was dispatched, but fresh verification is unavailable.',
    };
    throw mutationError(`${messages[payload.outcome]} ${payload.failure}`, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: 1, restored: 0, residueCount,
    });
  }
  if (!validSuccess(payload, input)) {
    const error = new Error('Component Property Delete returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentPropertyDeleteResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentPropertyDeletePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Property Delete routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-property-delete';
}

export async function executeComponentPropertyDeletePlan(plan, adapters = {}) {
  if (componentPropertyDeletePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Property Delete.`);
  }
  return executeComponentPropertyDelete(parseComponentPropertyDeleteRequest(plan.argv), adapters);
}
