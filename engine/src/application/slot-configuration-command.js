// Plan-bound, rollback-owned Slot create/edit Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_SLOT_DESCRIPTION_CODE_UNITS,
  MAX_SLOT_NAME_CODE_UNITS,
  MAX_SLOT_PREFERRED_KEY_CODE_UNITS,
  MAX_SLOT_PREFERRED_VALUES,
  SLOT_CONFIGURATION_ACTIONS,
  parseSlotConfigurationRequest,
  slotConfigurationArgvFromRequest,
  slotConfigurationPlanningArgvFromRequest,
} from './slot-configuration-request.js';

export {
  slotConfigurationArgvFromRequest,
  slotConfigurationPlanningArgvFromRequest,
} from './slot-configuration-request.js';

export const MAX_SLOT_CONFIGURATION_RESULT_CODE_UNITS = 700_000;
export const MAX_SLOT_CONFIGURATION_DEFINITIONS = 50_000;
export const MAX_SLOT_CONFIGURATION_SLOTS = 10_000;
const APPLICATION_IDS = new Set(SLOT_CONFIGURATION_ACTIONS.map((action) => `slot.${action}`));
const SETTING_FIELDS = Object.freeze([
  'stretchChildOnInsert', 'displayEmptyByDefault', 'minChildren', 'maxChildren',
  'allowPreferredValuesOnly',
]);
const VIOLATIONS = Object.freeze(['BELOW_MIN', 'ABOVE_MAX', 'HAS_NON_PREFERRED']);
const RESIDUE_KINDS = Object.freeze([
  'new-slot', 'new-definition', 'missing-original-definition',
  'missing-sibling-definition', 'extra-definition', 'changed-target-definition',
  'missing-target-definition', 'verification-unavailable',
]);
const normalized = (request) => parseSlotConfigurationRequest(
  slotConfigurationArgvFromRequest(request),
);
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function slotConfigurationCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_SLOT_CONFIGURATION_RESULT_CODE_UNITS}) throw new Error('Slot Configuration result exceeded its bounded response limit.'); return serialized; };
    const own = (record, key) => record && Object.prototype.hasOwnProperty.call(record, key);
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const baseName = (name) => { const index = name.lastIndexOf('#'); return index > 0 ? name.slice(0, index) : name; };
    const suffix = (name) => { const index = name.lastIndexOf('#'); return index > 0 ? name.slice(index) : ''; };
    const definitionsOf = (node) => {
      const definitions = node && node.componentPropertyDefinitions;
      if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) throw new Error('Component returned invalid property definitions.');
      const names = Object.keys(definitions); if (names.length > ${MAX_SLOT_CONFIGURATION_DEFINITIONS}) throw new Error('Component exceeds the bounded property-definition count.');
      return definitions;
    };
    const preferred = (value) => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > ${MAX_SLOT_PREFERRED_VALUES}) throw new Error('Slot preferred values are invalid.');
      return value.map((entry) => {
        if (!entry || typeof entry !== 'object' || !['COMPONENT','COMPONENT_SET'].includes(entry.type)
          || typeof entry.key !== 'string' || !entry.key.length || entry.key.length > ${MAX_SLOT_PREFERRED_KEY_CODE_UNITS}) throw new Error('Slot preferred value is invalid.');
        return { type: entry.type, key: clean(entry.key, ${MAX_SLOT_PREFERRED_KEY_CODE_UNITS}) };
      });
    };
    const settings = (value) => {
      if (value === undefined) return {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Slot settings are invalid.');
      const keys = Object.keys(value); if (keys.some((key) => !${js(SETTING_FIELDS)}.includes(key))) throw new Error('Slot settings contain an unsupported field.');
      const result = {};
      for (const key of ${js(SETTING_FIELDS)}) {
        if (!own(value, key)) continue; const setting = value[key];
        if (['stretchChildOnInsert','displayEmptyByDefault','allowPreferredValuesOnly'].includes(key)) {
          if (typeof setting !== 'boolean') throw new Error('Slot boolean setting is invalid.');
        } else if (setting !== null && (!Number.isSafeInteger(setting) || setting < 0)) throw new Error('Slot child limit is invalid.');
        result[key] = setting;
      }
      if (result.minChildren !== undefined && result.minChildren !== null
        && result.maxChildren !== undefined && result.maxChildren !== null
        && result.minChildren > result.maxChildren) throw new Error('Slot child limits are inconsistent.');
      return result;
    };
    const definitionFacts = (definition) => {
      if (!definition || typeof definition !== 'object' || definition.type !== 'SLOT'
        || typeof definition.defaultValue !== 'string' || definition.defaultValue.length > ${MAX_SLOT_NAME_CODE_UNITS}) throw new Error('Slot definition is invalid.');
      const description = definition.description === undefined ? '' : definition.description;
      if (typeof description !== 'string' || description.length > ${MAX_SLOT_DESCRIPTION_CODE_UNITS}) throw new Error('Slot description is invalid.');
      return { type: 'SLOT', defaultValue: clean(definition.defaultValue, ${MAX_SLOT_NAME_CODE_UNITS}), preferredValues: preferred(definition.preferredValues), description: clean(description, ${MAX_SLOT_DESCRIPTION_CODE_UNITS}), slotSettings: settings(definition.slotSettings) };
    };
    const componentFacts = (component) => ({ id: clean(component.id, 512), name: clean(String(component.name || ''), ${MAX_SLOT_NAME_CODE_UNITS}), type: component.type });
    const slotFacts = (slot) => {
      if (!slot || slot.type !== 'SLOT' || typeof slot.id !== 'string' || !slot.id.length
        || !Array.isArray(slot.children) || slot.children.length > ${MAX_SLOT_CONFIGURATION_DEFINITIONS}
        || !Array.isArray(slot.limitViolations) || slot.limitViolations.length > 3
        || slot.limitViolations.some((value) => !${js(VIOLATIONS)}.includes(value))) throw new Error('Slot node facts are invalid.');
      return { id: clean(slot.id, 512), name: clean(String(slot.name || ''), ${MAX_SLOT_NAME_CODE_UNITS}), type: 'SLOT', childCount: slot.children.length, limitViolations: [...slot.limitViolations] };
    };
    const slotsOf = (component) => {
      if (typeof component.findAll !== 'function') throw new Error('Component cannot enumerate Slot descendants.');
      const slots = component.findAll((node) => node.type === 'SLOT');
      if (!Array.isArray(slots) || slots.length > ${MAX_SLOT_CONFIGURATION_SLOTS}) throw new Error('Component exceeds the bounded Slot count.');
      const ids = slots.map((slot) => slot && slot.id); if (ids.some((id) => typeof id !== 'string' || !id.length) || new Set(ids).size !== ids.length) throw new Error('Component returned invalid Slot identities.');
      return slots;
    };
    const residue = (count, kinds) => ({ count, kinds: [...new Set(kinds)].slice(0, 8) });
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', action: request.action, outcome: 'no-mutation', attempted: 0, failure: clean(error && error.message ? error.message : String(error), 1024) });
    const failure = (component, outcome, error, report) => bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome, component: componentFacts(component), attempted: 1, restored: outcome === 'rolled-back' ? 1 : 0, residue: report, failure: clean(error && error.message ? error.message : String(error), 1024) || 'Slot Configuration verification failed.' });
    let component, beforeDefinitions, beforeNames, beforeSlots;
    try {
      component = await figma.getNodeByIdAsync(request.componentId); if (!component) throw new Error('Component was not found.');
      if (!(request.action === 'create' ? component.type === 'COMPONENT' : ['COMPONENT','COMPONENT_SET'].includes(component.type))
        || component.remote !== false || typeof component.editComponentProperty !== 'function') throw new Error('Slot Configuration requires one local compatible Component.');
      if (request.action === 'create' && (typeof component.createSlot !== 'function' || typeof component.deleteComponentProperty !== 'function')) throw new Error('Slot creation or rollback is unavailable.');
      beforeDefinitions = definitionsOf(component); beforeNames = Object.keys(beforeDefinitions);
      beforeSlots = request.action === 'create' ? slotsOf(component) : [];
    } catch (error) { return refusal(error); }
    if (request.action === 'create') {
      const beforeNameSet = new Set(beforeNames); const beforeSlotIds = new Set(beforeSlots.map((slot) => slot.id));
      const configured = request.settings !== null || request.preferredValues !== null || request.description !== null;
      let createdId = null; let returnedPropertyName = null; let mutationError = null;
      try {
        const created = component.createSlot();
        if (created && typeof created.id === 'string') createdId = created.id;
        created.name = request.name;
        const currentDefinitions = definitionsOf(component);
        const added = Object.keys(currentDefinitions).filter((name) => !beforeNameSet.has(name) && currentDefinitions[name]?.type === 'SLOT');
        if (added.length !== 1) throw new Error('Slot creation did not expose one exact new definition.');
        returnedPropertyName = added[0];
        if (configured) {
          const update = { name: request.name, ...(request.settings === null ? {} : { slotSettings: request.settings }), ...(request.preferredValues === null ? {} : { preferredValues: request.preferredValues }), ...(request.description === null ? {} : { description: request.description }) };
          returnedPropertyName = component.editComponentProperty(returnedPropertyName, update);
          if (typeof returnedPropertyName !== 'string' || !returnedPropertyName.length
            || returnedPropertyName.length > ${MAX_SLOT_NAME_CODE_UNITS}) throw new Error('Slot configuration returned an invalid property name.');
        }
      } catch (error) { mutationError = error; }
      try {
        const freshComponent = await figma.getNodeByIdAsync(request.componentId); const freshDefinitions = definitionsOf(freshComponent); const freshSlots = slotsOf(freshComponent);
        const newSlots = freshSlots.filter((slot) => !beforeSlotIds.has(slot.id));
        const newNames = Object.keys(freshDefinitions).filter((name) => !beforeNameSet.has(name));
        if (!freshComponent || freshComponent.type !== 'COMPONENT' || freshComponent.remote !== false
          || newSlots.length !== 1 || newNames.length !== 1
          || !beforeNames.every((name) => own(freshDefinitions, name))) throw new Error('Slot Create fresh topology postcondition failed.');
        const freshSlot = newSlots[0]; const propertyName = newNames[0]; const definition = definitionFacts(freshDefinitions[propertyName]);
        if ((createdId && freshSlot.id !== createdId) || freshSlot.name !== request.name
          || !freshSlot.parent || freshSlot.parent.id !== request.componentId
          || (returnedPropertyName && propertyName !== returnedPropertyName)
          || (configured && baseName(propertyName) !== request.name)
          || (request.settings !== null && Object.entries(request.settings).some(([key, value]) => !Object.is(definition.slotSettings[key], value)))
          || (request.preferredValues !== null && !same(definition.preferredValues, request.preferredValues))
          || (request.description !== null && definition.description !== request.description)) throw new Error('Slot Create fresh semantic postcondition failed.');
        return bounded({ schemaVersion: 1, status: 'created', action: request.action, outcome: mutationError ? 'verified-after-error' : 'verified', component: componentFacts(freshComponent), slot: slotFacts(freshSlot), propertyName: clean(propertyName, ${MAX_SLOT_NAME_CODE_UNITS}), definition, attempted: 1, residue: residue(0, []), warnings: mutationError ? ['The native Slot creation reported an error, but fresh readback proved the requested state.'] : [] });
      } catch (error) { mutationError ||= error; }
      let verifiable = true; const kinds = []; let count = 0;
      try {
        let current = await figma.getNodeByIdAsync(request.componentId); let currentSlots = slotsOf(current);
        const newSlots = currentSlots.filter((slot) => !beforeSlotIds.has(slot.id));
        if (newSlots.length === 1 && typeof newSlots[0].remove === 'function') { try { newSlots[0].remove(); } catch {} }
        current = await figma.getNodeByIdAsync(request.componentId); const currentDefinitions = definitionsOf(current);
        const newNames = Object.keys(currentDefinitions).filter((name) => !beforeNameSet.has(name));
        if (newNames.length === 1 && currentDefinitions[newNames[0]]?.type === 'SLOT') { try { current.deleteComponentProperty(newNames[0]); } catch {} }
        const restored = await figma.getNodeByIdAsync(request.componentId); const restoredDefinitions = definitionsOf(restored); currentSlots = slotsOf(restored);
        const slotCount = currentSlots.filter((slot) => !beforeSlotIds.has(slot.id)).length;
        const definitionCount = Object.keys(restoredDefinitions).filter((name) => !beforeNameSet.has(name)).length;
        const missingCount = beforeNames.filter((name) => !own(restoredDefinitions, name)).length;
        count = slotCount + definitionCount + missingCount;
        if (slotCount) kinds.push('new-slot'); if (definitionCount) kinds.push('new-definition'); if (missingCount) kinds.push('missing-original-definition');
      } catch { verifiable = false; }
      return failure(component, !verifiable ? 'verification-unavailable' : count === 0 ? 'rolled-back' : 'partial-residue', mutationError, residue(verifiable ? count : null, verifiable ? kinds : ['verification-unavailable']));
    }
    let beforeDefinition;
    try {
      if (!own(beforeDefinitions, request.propertyName)) throw new Error('Slot property was not found; use its exact full name including the #suffix.');
      beforeDefinition = definitionFacts(beforeDefinitions[request.propertyName]);
    } catch (error) { return refusal(error); }
    let desired;
    try { desired = { ...beforeDefinition, preferredValues: request.preferredValues === null ? beforeDefinition.preferredValues : request.preferredValues, description: request.description === null ? beforeDefinition.description : request.description, slotSettings: request.settings === null ? beforeDefinition.slotSettings : settings({ ...beforeDefinition.slotSettings, ...request.settings }) }; }
    catch (error) { return refusal(error); }
    const desiredBase = request.name === null ? baseName(request.propertyName) : request.name;
    const desiredMatch = (name, definition) => baseName(name) === desiredBase && same(definitionFacts(definition), desired);
    if (desiredMatch(request.propertyName, beforeDefinitions[request.propertyName])) return bounded({ schemaVersion: 1, status: 'unchanged', action: request.action, outcome: 'verified', component: componentFacts(component), propertyName: clean(request.propertyName, ${MAX_SLOT_NAME_CODE_UNITS}), definition: beforeDefinition, attempted: 0, residue: residue(0, []), warnings: [] });
    let returnedName = null; let mutationError = null;
    try {
      const update = { ...(request.name === null ? {} : { name: request.name }), ...(request.settings === null ? {} : { slotSettings: request.settings }), ...(request.preferredValues === null ? {} : { preferredValues: request.preferredValues }), ...(request.description === null ? {} : { description: request.description }) };
      returnedName = component.editComponentProperty(request.propertyName, update);
      if (typeof returnedName !== 'string' || !returnedName.length
        || returnedName.length > ${MAX_SLOT_NAME_CODE_UNITS}) throw new Error('Slot edit returned an invalid property name.');
    } catch (error) { mutationError = error; }
    const propertySuffix = suffix(request.propertyName);
    const resolveCurrent = (definitions) => {
      const candidates = Object.keys(definitions).filter((name) => definitions[name]?.type === 'SLOT' && (name === returnedName || name === request.propertyName || (propertySuffix && suffix(name) === propertySuffix)));
      return candidates.length === 1 ? candidates[0] : null;
    };
    try {
      const fresh = await figma.getNodeByIdAsync(request.componentId); const definitions = definitionsOf(fresh); const currentName = resolveCurrent(definitions);
      const siblingNames = beforeNames.filter((name) => name !== request.propertyName);
      if (!fresh || fresh.type !== component.type || fresh.remote !== false
        || Object.keys(definitions).length !== beforeNames.length
        || !currentName || !siblingNames.every((name) => own(definitions, name))
        || !desiredMatch(currentName, definitions[currentName])) throw new Error('Slot Edit fresh postcondition failed.');
      return bounded({ schemaVersion: 1, status: 'edited', action: request.action, outcome: mutationError ? 'verified-after-error' : 'verified', component: componentFacts(fresh), propertyName: clean(currentName, ${MAX_SLOT_NAME_CODE_UNITS}), definition: definitionFacts(definitions[currentName]), attempted: 1, residue: residue(0, []), warnings: mutationError ? ['The native Slot edit reported an error, but fresh readback proved the requested state.'] : [] });
    } catch (error) { mutationError ||= error; }
    let verifiable = true; const kinds = []; let count = 0;
    try {
      let current = await figma.getNodeByIdAsync(request.componentId); let definitions = definitionsOf(current); const currentName = resolveCurrent(definitions);
      if (currentName) {
        try { current.editComponentProperty(currentName, { name: baseName(request.propertyName), preferredValues: beforeDefinition.preferredValues, description: beforeDefinition.description, slotSettings: beforeDefinition.slotSettings }); } catch {}
      }
      current = await figma.getNodeByIdAsync(request.componentId); definitions = definitionsOf(current);
      const siblings = beforeNames.filter((name) => name !== request.propertyName); const missingSiblings = siblings.filter((name) => !own(definitions, name)).length;
      const targetPresent = own(definitions, request.propertyName); const targetChanged = !targetPresent || !same(definitionFacts(definitions[request.propertyName]), beforeDefinition);
      const extraDefinitions = Object.keys(definitions).filter((name) => !beforeNames.includes(name)).length;
      count = missingSiblings + extraDefinitions + (targetChanged ? 1 : 0);
      if (missingSiblings) kinds.push('missing-sibling-definition'); if (extraDefinitions) kinds.push('extra-definition'); if (targetChanged) kinds.push(targetPresent ? 'changed-target-definition' : 'missing-target-definition');
    } catch { verifiable = false; }
    return failure(component, !verifiable ? 'verification-unavailable' : count === 0 ? 'rolled-back' : 'partial-residue', mutationError, residue(verifiable ? count : null, verifiable ? kinds : ['verification-unavailable']));
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
const text = (value, maximum, empty = true) => typeof value === 'string'
  && value.length <= maximum && (empty || value.length > 0);
function validSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !SETTING_FIELDS.includes(key))) return false;
  const fieldsValid = Object.entries(value).every(([key, setting]) =>
    ['stretchChildOnInsert', 'displayEmptyByDefault', 'allowPreferredValuesOnly'].includes(key)
      ? typeof setting === 'boolean'
      : setting === null || (Number.isSafeInteger(setting) && setting >= 0));
  return fieldsValid && !(value.minChildren !== undefined && value.minChildren !== null
    && value.maxChildren !== undefined && value.maxChildren !== null
    && value.minChildren > value.maxChildren);
}
function validPreferred(value) {
  return Array.isArray(value) && value.length <= MAX_SLOT_PREFERRED_VALUES
    && value.every((entry) => exact(entry, ['type', 'key'])
      && ['COMPONENT', 'COMPONENT_SET'].includes(entry.type)
      && text(entry.key, MAX_SLOT_PREFERRED_KEY_CODE_UNITS, false));
}
function validDefinition(value) {
  return exact(value, ['type', 'defaultValue', 'preferredValues', 'description', 'slotSettings'])
    && value.type === 'SLOT' && text(value.defaultValue, MAX_SLOT_NAME_CODE_UNITS)
    && validPreferred(value.preferredValues)
    && text(value.description, MAX_SLOT_DESCRIPTION_CODE_UNITS)
    && validSettings(value.slotSettings);
}
function validComponent(value, input) {
  return exact(value, ['id', 'name', 'type']) && value.id === input.componentId
    && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id)
    && text(value.name, MAX_SLOT_NAME_CODE_UNITS)
    && (input.action === 'create' ? value.type === 'COMPONENT'
      : ['COMPONENT', 'COMPONENT_SET'].includes(value.type));
}
function validSlot(value, input) {
  return exact(value, ['id', 'name', 'type', 'childCount', 'limitViolations'])
    && text(value.id, 512, false) && NODE_REFERENCE_PATTERN.test(value.id)
    && value.name === input.name && value.type === 'SLOT'
    && Number.isSafeInteger(value.childCount) && value.childCount >= 0
    && value.childCount <= MAX_SLOT_CONFIGURATION_DEFINITIONS
    && Array.isArray(value.limitViolations) && value.limitViolations.length <= 3
    && value.limitViolations.every((item) => VIOLATIONS.includes(item));
}
function validResidue(value, success) {
  return exact(value, ['count', 'kinds'])
    && (value.count === null || (Number.isSafeInteger(value.count) && value.count >= 0
      && value.count <= 2 * MAX_SLOT_CONFIGURATION_DEFINITIONS + MAX_SLOT_CONFIGURATION_SLOTS))
    && Array.isArray(value.kinds) && value.kinds.length <= 8
    && value.kinds.every((kind) => RESIDUE_KINDS.includes(kind))
    && (!success || value.count === 0 && value.kinds.length === 0);
}
function propertyBase(value) {
  const name = String(value); const index = name.lastIndexOf('#');
  return index > 0 ? name.slice(0, index) : name;
}
function propertySuffix(value) {
  const name = String(value); const index = name.lastIndexOf('#');
  return index > 0 ? name.slice(index) : '';
}
function matchesRequestedDefinition(value, input) {
  if (input.settings !== null
    && Object.entries(input.settings).some(([key, setting]) => !Object.is(value.slotSettings[key], setting))) return false;
  if (input.preferredValues !== null
    && JSON.stringify(value.preferredValues) !== JSON.stringify(input.preferredValues)) return false;
  return input.description === null || value.description === input.description;
}
function validSuccess(value, input) {
  const common = value?.schemaVersion === 1 && value.action === input.action
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validComponent(value.component, input) && validDefinition(value.definition)
    && matchesRequestedDefinition(value.definition, input)
    && text(value.propertyName, MAX_SLOT_NAME_CODE_UNITS, false)
    && validResidue(value.residue, true) && Array.isArray(value.warnings)
    && value.warnings.every((warning) => text(warning, 1_024, false))
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0);
  if (input.action === 'create') {
    const configured = input.settings !== null || input.preferredValues !== null
      || input.description !== null;
    return exact(value, ['schemaVersion','status','action','outcome','component','slot','propertyName','definition','attempted','residue','warnings'])
      && common && value.status === 'created' && value.attempted === 1
      && validSlot(value.slot, input)
      && (!configured || propertyBase(value.propertyName) === input.name);
  }
  const expectedBase = input.name === null ? propertyBase(input.propertyName) : input.name;
  const expectedSuffix = propertySuffix(input.propertyName);
  return exact(value, ['schemaVersion','status','action','outcome','component','propertyName','definition','attempted','residue','warnings'])
    && common && ['edited','unchanged'].includes(value.status)
    && propertyBase(value.propertyName) === expectedBase
    && (!expectedSuffix || propertySuffix(value.propertyName) === expectedSuffix)
    && value.attempted === (value.status === 'edited' ? 1 : 0)
    && value.outcome === (value.status === 'unchanged' ? 'verified' : value.outcome);
}
function validRefusal(value, input) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.action === input.action
    && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure, 1_024, false);
}
function validFailure(value, input) {
  return exact(value, ['schemaVersion','status','action','outcome','component','attempted','restored','residue','failure'])
    && value.schemaVersion === 1 && value.status === 'failed' && value.action === input.action
    && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome)
    && validComponent(value.component, input) && value.attempted === 1
    && value.restored === (value.outcome === 'rolled-back' ? 1 : 0)
    && validResidue(value.residue, false) && text(value.failure, 1_024, false)
    && (value.outcome === 'rolled-back' ? value.residue.count === 0
      : value.outcome === 'partial-residue' ? value.residue.count > 0
        : value.residue.count === null);
}
function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report });
  return error;
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' });
  return error;
}
function safe(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function executeSlotConfiguration(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Slot Configuration requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(slotConfigurationCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_SLOT_CONFIGURATION_RESULT_CODE_UNITS) {
    throw invalid('Slot Configuration returned an invalid bounded result.');
  }
  let payload; try { payload = JSON.parse(serialized); }
  catch { throw invalid('Slot Configuration returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, input)) throw invalid('Slot Configuration returned an invalid bounded result.');
    throw mutationError(`Slot Configuration made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw invalid('Slot Configuration returned an invalid bounded result.');
    const residueCount = payload.residue.count === null ? 1 : payload.residue.count;
    throw mutationError(`Slot Configuration failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount });
  }
  if (!validSuccess(payload, input)) {
    throw invalid('Slot Configuration returned an invalid bounded result.');
  }
  const legacy = input.action === 'create'
    ? { component: payload.component, slot: payload.slot, propertyName: payload.propertyName,
      definition: payload.definition }
    : { component: payload.component, propertyName: payload.propertyName,
      definition: payload.definition };
  return { stdout: safe(legacy), stderr: '', result: payload };
}

export function slotConfigurationPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Slot Configuration routing requires a Command Plan.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-slot-configuration';
}

export function executeSlotConfigurationPlan(plan, adapters = {}) {
  if (slotConfigurationPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Slot Configuration.');
  }
  return executeSlotConfiguration(parseSlotConfigurationRequest(plan.argv), adapters);
}
