// Plan-bound, rollback-owned Component Property Add Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS,
  MAX_COMPONENT_PROPERTY_ADD_NODE_ID_CODE_UNITS,
  MAX_COMPONENT_PROPERTY_ADD_VALUE_CODE_UNITS,
  componentPropertyAddArgvFromRequest,
  componentPropertyAddPlanningArgvFromRequest,
  parseComponentPropertyAddRequest,
} from './component-property-add-request.js';

export {
  componentPropertyAddArgvFromRequest,
  componentPropertyAddPlanningArgvFromRequest,
} from './component-property-add-request.js';

const APPLICATION_ID = 'component.prop.add';
export const MAX_COMPONENT_PROPERTY_ADD_COUNT = 50_000;
export const MAX_COMPONENT_PROPERTY_ADD_RESIDUE_NAMES = 8;
export const MAX_COMPONENT_PROPERTY_ADD_RESULT_CODE_UNITS = 700_000;

function normalizedRequest(request) {
  return parseComponentPropertyAddRequest(componentPropertyAddArgvFromRequest(request));
}

function jsString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function parsedDefault(input) {
  return input.type === 'BOOLEAN'
    ? input.defaultValue === 'true' || input.defaultValue === '1'
    : input.defaultValue;
}

export function componentPropertyAddCode(request) {
  const input = normalizedRequest(request);
  const defaultValue = parsedDefault(input);
  return `(async () => {
    const componentId = ${jsString(input.componentId)};
    const requestedName = ${jsString(input.name)};
    const propertyType = ${jsString(input.type)};
    let expectedDefault = JSON.parse(${jsString(JSON.stringify(defaultValue))});
    const hasIgnoredOptions = ${input.options === null ? 'false' : 'true'};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_PROPERTY_ADD_RESULT_CODE_UNITS}) {
        throw new Error('Component Property Add result exceeded the bounded response limit.');
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
    const definitionMatches = (definition) => definition && definition.type === propertyType
      && Object.is(definition.defaultValue, expectedDefault);
    const nameMatches = (candidate) => candidate === requestedName
      || candidate.startsWith(requestedName + '#');

    try {
      const component = await figma.getNodeByIdAsync(componentId);
      if (!component) throw new Error('Node not found: ' + componentId);
      if (!['COMPONENT', 'COMPONENT_SET'].includes(component.type)
        || component.remote !== false
        || typeof component.addComponentProperty !== 'function'
        || typeof component.deleteComponentProperty !== 'function') {
        throw new Error('Component Property Add requires one local Component or Component Set.');
      }
      const beforeDefinitions = definitionsOf(component);
      const beforeNames = Object.keys(beforeDefinitions);
      if (beforeNames.length > ${MAX_COMPONENT_PROPERTY_ADD_COUNT}) {
        throw new Error('Component exceeds the bounded property-definition count.');
      }
      const before = new Set(beforeNames);

      if (propertyType === 'INSTANCE_SWAP' && /^\\d+:\\d+$/.test(String(expectedDefault))) {
        let swap = await figma.getNodeByIdAsync(String(expectedDefault));
        if (!swap || !['COMPONENT', 'COMPONENT_SET'].includes(swap.type)) {
          throw new Error('INSTANCE_SWAP default is not a Component or Component Set.');
        }
        if (swap.type === 'COMPONENT_SET') swap = swap.defaultVariant || swap.children[0];
        if (!swap || swap.type !== 'COMPONENT') {
          throw new Error('INSTANCE_SWAP Component Set has no default Variant.');
        }
        expectedDefault = swap.id;
      }

      let attempted = false;
      let createdName = null;
      try {
        attempted = true;
        createdName = component.addComponentProperty(requestedName, propertyType, expectedDefault);
        if (typeof createdName !== 'string' || !createdName || createdName.length > ${MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS}) {
          throw new Error('Component Property Add returned an invalid property name.');
        }
        const verified = await figma.getNodeByIdAsync(componentId);
        const definitions = definitionsOf(verified);
        if (!verified || verified.type !== component.type || verified.remote !== false
          || !beforeNames.every((name) => own(definitions, name))
          || !own(definitions, createdName)
          || !nameMatches(createdName)
          || !definitionMatches(definitions[createdName])) {
          throw new Error('Component Property Add fresh postcondition failed.');
        }
        return bounded({
          schemaVersion: 1, status: 'created',
          component: {
            id: verified.id,
            name: clean(String(verified.name || ''), ${MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS}),
            type: verified.type,
          },
          property: {
            name: createdName,
            type: definitions[createdName].type,
            defaultValue: definitions[createdName].defaultValue,
          },
          attempted: 1, residue: [],
          warnings: hasIgnoredOptions
            ? ['--options remains accepted for compatibility but applies only to native Variant workflows.'] : [],
        });
      } catch (error) {
        let verifiable = true;
        let candidates = [];
        try {
          const current = await figma.getNodeByIdAsync(componentId);
          const definitions = definitionsOf(current);
          const addedNames = Object.keys(definitions).filter((name) => !before.has(name));
          candidates = createdName && addedNames.includes(createdName)
            ? [createdName]
            : addedNames.filter((name) => nameMatches(name) && definitionMatches(definitions[name]));
          if (candidates.length === 1) {
            try { current.deleteComponentProperty(candidates[0]); } catch {}
          }
        } catch {
          verifiable = false;
        }

        let createdResidue = [];
        let missingOriginalCount = 0;
        try {
          const restored = await figma.getNodeByIdAsync(componentId);
          const definitions = definitionsOf(restored);
          createdResidue = candidates.filter((name) => own(definitions, name));
          missingOriginalCount = beforeNames.filter((name) => !own(definitions, name)).length;
        } catch {
          verifiable = false;
        }
        const createdCount = createdResidue.length;
        const restored = verifiable && createdCount === 0 && missingOriginalCount === 0;
        return bounded({
          schemaVersion: 1, status: 'failed',
          outcome: !verifiable ? 'verification-unavailable' : restored ? 'rolled-back' : 'partial-residue',
          component: {
            id: component.id,
            name: clean(String(component.name || ''), ${MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS}),
            type: component.type,
          },
          attempted: attempted ? 1 : 0, restored: restored ? 1 : 0,
          residue: {
            createdCount,
            createdNames: createdResidue.slice(0, ${MAX_COMPONENT_PROPERTY_ADD_RESIDUE_NAMES})
              .map((name) => clean(name, ${MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS})),
            missingOriginalCount,
          },
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
    || validString(value, MAX_COMPONENT_PROPERTY_ADD_VALUE_CODE_UNITS);
}

function validComponent(value, input) {
  return exactKeys(value, ['id', 'name', 'type'])
    && value.id === input.componentId
    && validString(value.id, MAX_COMPONENT_PROPERTY_ADD_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && validString(value.name, MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS)
    && ['COMPONENT', 'COMPONENT_SET'].includes(value.type);
}

function validSuccess(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'component', 'property', 'attempted', 'residue', 'warnings',
  ]) || value.schemaVersion !== 1 || value.status !== 'created'
    || !validComponent(value.component, input)
    || !exactKeys(value.property, ['name', 'type', 'defaultValue'])
    || !validString(value.property.name, MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS, false)
    || !(value.property.name === input.name || value.property.name.startsWith(`${input.name}#`))
    || value.property.type !== input.type || !validScalar(value.property.defaultValue)
    || (input.type === 'BOOLEAN' && typeof value.property.defaultValue !== 'boolean')
    || (input.type !== 'BOOLEAN' && typeof value.property.defaultValue !== 'string')
    || (input.type === 'TEXT' && value.property.defaultValue !== input.defaultValue)
    || value.attempted !== 1 || !Array.isArray(value.residue) || value.residue.length !== 0
    || !Array.isArray(value.warnings) || value.warnings.length !== (input.options === null ? 0 : 1)
    || value.warnings.some((warning) => !validString(warning, 1_024, false))) return false;
  const expectedBoolean = input.defaultValue === 'true' || input.defaultValue === '1';
  return input.type !== 'BOOLEAN' || value.property.defaultValue === expectedBoolean;
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'component', 'attempted', 'restored', 'residue', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !validComponent(value.component, input)
    || value.attempted !== 1 || ![0, 1].includes(value.restored)
    || !exactKeys(value.residue, ['createdCount', 'createdNames', 'missingOriginalCount'])
    || !Number.isSafeInteger(value.residue.createdCount) || value.residue.createdCount < 0
    || !Array.isArray(value.residue.createdNames)
    || value.residue.createdNames.length > MAX_COMPONENT_PROPERTY_ADD_RESIDUE_NAMES
    || value.residue.createdNames.length > value.residue.createdCount
    || value.residue.createdNames.some((name) => !validString(
      name, MAX_COMPONENT_PROPERTY_ADD_NAME_CODE_UNITS, false,
    ))
    || !Number.isSafeInteger(value.residue.missingOriginalCount)
    || value.residue.missingOriginalCount < 0
    || !validString(value.failure, 1_024, false)) return false;
  const residueCount = value.residue.createdCount + value.residue.missingOriginalCount;
  if (value.outcome === 'rolled-back') return value.restored === 1 && residueCount === 0;
  if (value.outcome === 'partial-residue') return value.restored === 0 && residueCount > 0;
  return value.restored === 0;
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

export function formatComponentPropertyAddResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  return [
    `Added property ${safeJson(result.property.name)} (${result.property.type}) on `
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

export async function executeComponentPropertyAdd(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Property Add requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentPropertyAddCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_COMPONENT_PROPERTY_ADD_RESULT_CODE_UNITS) {
    const error = new Error('Component Property Add returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Property Add returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw new Error('Component Property Add returned an invalid bounded result.');
    throw mutationError(`Component Property Add made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Component Property Add returned an invalid bounded result.');
    const residueCount = payload.residue.createdCount + payload.residue.missingOriginalCount;
    const message = payload.outcome === 'rolled-back'
      ? `Component Property Add failed and removed the new property: ${payload.failure}`
      : `Component Property Add failed; ${residueCount} definition mutation(s) may remain: ${payload.failure}`;
    throw mutationError(message, payload.outcome, {
      version: 1, outcome: payload.outcome,
      attempted: payload.attempted, restored: payload.restored, residueCount,
    });
  }
  if (!validSuccess(payload, input)) {
    const error = new Error('Component Property Add returned an invalid bounded result.');
    error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentPropertyAddResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentPropertyAddPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Property Add routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-component-property-add';
}

export async function executeComponentPropertyAddPlan(plan, adapters = {}) {
  if (componentPropertyAddPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Property Add.`);
  }
  return executeComponentPropertyAdd(parseComponentPropertyAddRequest(plan.argv), adapters);
}
