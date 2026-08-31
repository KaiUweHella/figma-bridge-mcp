// Plan-bound bounded Component Property List Read Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import { COMPONENT_PROPERTY_LIST_TYPED_READ } from '../lib/typed-read-operations.js';
import {
  MAX_COMPONENT_PROPERTY_LIST_NODE_ID_CODE_UNITS,
  componentPropertyListArgvFromRequest,
  componentPropertyListPlanningArgvFromRequest,
  parseComponentPropertyListRequest,
} from './component-property-list-request.js';

export {
  componentPropertyListArgvFromRequest,
  componentPropertyListPlanningArgvFromRequest,
} from './component-property-list-request.js';

const APPLICATION_ID = 'component.prop.list';
export const MAX_COMPONENT_PROPERTY_LIST_COUNT = 50_000;
export const MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS = 1_024;
export const MAX_COMPONENT_PROPERTY_LIST_VALUE_CODE_UNITS = 200_000;
export const MAX_COMPONENT_PROPERTY_LIST_VARIANT_OPTIONS = 10_000;
export const MAX_COMPONENT_PROPERTY_LIST_PREFERRED_VALUES = 10_000;
export const MAX_COMPONENT_PROPERTY_LIST_NODE_VISITS = 50_000;
export const MAX_COMPONENT_PROPERTY_LIST_RESULT_CODE_UNITS = 700_000;

function normalizedRequest(request) {
  return parseComponentPropertyListRequest(componentPropertyListArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function componentPropertyListCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const componentId = ${jsValue(input.componentId)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_PROPERTY_LIST_RESULT_CODE_UNITS}) {
        throw new Error('Component Property List result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const node = componentId === null
      ? figma.currentPage.selection[0]
      : await figma.getNodeByIdAsync(componentId);
    if (!node) throw new Error(componentId === null
      ? 'Select one local Component or Component Set.'
      : 'Node not found: ' + componentId);
    if (!['COMPONENT', 'COMPONENT_SET'].includes(node.type) || node.remote !== false) {
      throw new Error('Component Property List requires one local Component or Component Set.');
    }
    const definitions = node.componentPropertyDefinitions;
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
      throw new Error('Component returned invalid property definitions.');
    }
    const entries = Object.entries(definitions);
    if (entries.length > ${MAX_COMPONENT_PROPERTY_LIST_COUNT}) {
      throw new Error('Component exceeds the bounded property-definition count.');
    }
    const bindings = new Map(entries.map(([name]) => [name, []]));
    const slotDefinitionNames = entries
      .filter(([, definition]) => definition?.type === 'SLOT')
      .map(([name]) => name);
    const nestedInstances = [];
    const slots = [];
    const stack = Array.isArray(node.children) ? [...node.children].reverse() : [];
    let visits = 0;
    while (stack.length) {
      if (++visits > ${MAX_COMPONENT_PROPERTY_LIST_NODE_VISITS}) {
        throw new Error('Component exceeds the bounded sublayer visit count.');
      }
      const child = stack.pop();
      if (!child || typeof child !== 'object') throw new Error('Component contains an invalid sublayer.');
      // A nested Instance or Slot owns an independent property scope. Its own
      // node can be wired by this Component, but its descendants cannot.
      if (!['INSTANCE', 'SLOT'].includes(child.type) && Array.isArray(child.children)) {
        for (let index = child.children.length - 1; index >= 0; index--) stack.push(child.children[index]);
      }
      const references = child.componentPropertyReferences;
      if (references !== null && references !== undefined) {
        if (!references || typeof references !== 'object' || Array.isArray(references)) {
          throw new Error('Component contains invalid property references.');
        }
        for (const field of ['visible', 'characters', 'mainComponent']) {
          if (!Object.prototype.hasOwnProperty.call(references, field)) continue;
          const property = references[field];
          if (typeof property !== 'string' || property.length > ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}) {
            throw new Error('Component contains an invalid property reference.');
          }
          if (!bindings.has(property)) throw new Error('Component sublayer references an unknown property definition.');
          bindings.get(property).push({
            nodeId: child.id,
            nodeName: clean(String(child.name || ''), ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}),
            nodeType: clean(String(child.type || ''), 64),
            field,
          });
        }
      }
      if (child.type === 'INSTANCE') {
        if (typeof child.isExposedInstance !== 'boolean') {
          throw new Error('Nested Instance returned invalid exposure metadata.');
        }
        nestedInstances.push({
          id: child.id,
          name: clean(String(child.name || ''), ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}),
          exposed: child.isExposedInstance,
        });
      }
      if (child.type === 'SLOT') {
        const violations = Array.isArray(child.limitViolations) ? child.limitViolations : [];
        if (violations.some((value) => !['BELOW_MIN', 'ABOVE_MAX', 'HAS_NON_PREFERRED'].includes(value))) {
          throw new Error('Slot returned invalid limit violations.');
        }
        slots.push({
          id: child.id,
          name: clean(String(child.name || ''), ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}),
          childCount: Array.isArray(child.children) ? child.children.length : 0,
          limitViolations: violations,
          property: null,
        });
      }
    }
    const baseName = (value) => String(value).split('#')[0].trim().toLowerCase();
    const assignedSlotProperties = new Set();
    for (const slot of slots) {
      const matches = slotDefinitionNames.filter((name) => !assignedSlotProperties.has(name)
        && (name === slot.name || baseName(name) === baseName(slot.name)));
      if (matches.length === 1) {
        slot.property = matches[0];
        assignedSlotProperties.add(matches[0]);
      }
    }
    const unmatchedSlots = slots.filter((slot) => slot.property === null);
    const unmatchedSlotProperties = slotDefinitionNames.filter((name) => !assignedSlotProperties.has(name));
    if (unmatchedSlots.length === 1 && unmatchedSlotProperties.length === 1) {
      unmatchedSlots[0].property = unmatchedSlotProperties[0];
    }
    const properties = entries.map(([name, definition]) => {
      const defaultValue = definition?.type === 'SLOT' && definition.defaultValue === undefined
        ? null : definition?.defaultValue;
      if (typeof name !== 'string' || !name || name.length > ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}
        || !definition || typeof definition !== 'object' || Array.isArray(definition)
        || typeof definition.type !== 'string' || !definition.type || definition.type.length > 64
        || !((definition.type === 'SLOT' && defaultValue === null)
          || typeof defaultValue === 'boolean'
          || (typeof defaultValue === 'string'
            && defaultValue.length <= ${MAX_COMPONENT_PROPERTY_LIST_VALUE_CODE_UNITS}))) {
        throw new Error('Component Property List encountered incompatible definition metadata.');
      }
      const variantOptions = definition.variantOptions === undefined ? null : definition.variantOptions;
      if (variantOptions !== null && (!Array.isArray(variantOptions)
        || variantOptions.length > ${MAX_COMPONENT_PROPERTY_LIST_VARIANT_OPTIONS}
        || variantOptions.some((option) => typeof option !== 'string'
          || option.length > ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}))) {
        throw new Error('Component Property List encountered invalid Variant options.');
      }
      const preferredValues = definition.preferredValues === undefined ? null : definition.preferredValues;
      if (preferredValues !== null && (!Array.isArray(preferredValues)
        || preferredValues.length > ${MAX_COMPONENT_PROPERTY_LIST_PREFERRED_VALUES}
        || preferredValues.some((value) => !value || typeof value !== 'object' || Array.isArray(value)
          || !['COMPONENT', 'COMPONENT_SET'].includes(value.type)
          || typeof value.key !== 'string' || !value.key
          || value.key.length > ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}))) {
        throw new Error('Component Property List encountered invalid preferred values.');
      }
      const description = definition.description === undefined ? null : definition.description;
      if (description !== null && (typeof description !== 'string'
        || description.length > ${MAX_COMPONENT_PROPERTY_LIST_VALUE_CODE_UNITS})) {
        throw new Error('Component Property List encountered an invalid description.');
      }
      const slotSettings = definition.slotSettings === undefined ? null : definition.slotSettings;
      if (slotSettings !== null && (!slotSettings || typeof slotSettings !== 'object'
        || Array.isArray(slotSettings))) {
        throw new Error('Component Property List encountered invalid Slot settings.');
      }
      if (slotSettings !== null) {
        const allowed = new Set(['stretchChildOnInsert', 'displayEmptyByDefault', 'minChildren', 'maxChildren', 'allowPreferredValuesOnly']);
        if (Object.keys(slotSettings).some((key) => !allowed.has(key))) {
          throw new Error('Component Property List encountered unknown Slot settings.');
        }
        for (const key of ['stretchChildOnInsert', 'displayEmptyByDefault', 'allowPreferredValuesOnly']) {
          if (slotSettings[key] !== undefined && typeof slotSettings[key] !== 'boolean') {
            throw new Error('Component Property List encountered an invalid Slot Boolean setting.');
          }
        }
        for (const key of ['minChildren', 'maxChildren']) {
          if (slotSettings[key] !== undefined && slotSettings[key] !== null
            && (!Number.isSafeInteger(slotSettings[key]) || slotSettings[key] < 0)) {
            throw new Error('Component Property List encountered an invalid Slot child limit.');
          }
        }
      }
      const nativeBindings = definition.boundVariables === undefined ? null : definition.boundVariables;
      if (nativeBindings !== null && (!nativeBindings || typeof nativeBindings !== 'object'
        || Array.isArray(nativeBindings)
        || Object.keys(nativeBindings).some((key) => key !== 'defaultValue')
        || (nativeBindings.defaultValue !== undefined
          && (!nativeBindings.defaultValue || typeof nativeBindings.defaultValue !== 'object'
            || Array.isArray(nativeBindings.defaultValue)
            || nativeBindings.defaultValue.type !== 'VARIABLE_ALIAS'
            || typeof nativeBindings.defaultValue.id !== 'string'
            || !nativeBindings.defaultValue.id
            || nativeBindings.defaultValue.id.length > ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS})))) {
        throw new Error('Component Property List encountered invalid default Variable binding metadata.');
      }
      const defaultValueVariable = nativeBindings?.defaultValue
        ? { type: nativeBindings.defaultValue.type, id: nativeBindings.defaultValue.id }
        : null;
      const propertyBindings = bindings.get(name) || [];
      const bindingStatus = definition.type === 'VARIANT' ? 'native-axis'
        : definition.type === 'SLOT' ? (slots.some((slot) => slot.property === name) ? 'native-slot' : 'unbound')
          : propertyBindings.length ? 'wired' : 'unbound';
      return {
        name,
        type: definition.type,
        defaultValue,
        variantOptions,
        preferredValues,
        description,
        slotSettings,
        defaultValueVariable,
        bindings: propertyBindings,
        bindingStatus,
      };
    });
    return bounded({
      schemaVersion: 2,
      status: 'listed',
      source: componentId === null ? 'selection' : 'id',
      component: {
        id: node.id,
        name: clean(String(node.name || ''), ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}),
        type: node.type,
      },
      properties,
      nestedInstances,
      slots,
    });
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

function validBinding(value) {
  return exactKeys(value, ['nodeId', 'nodeName', 'nodeType', 'field'])
    && validString(value.nodeId, MAX_COMPONENT_PROPERTY_LIST_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.nodeId)
    && validString(value.nodeName, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS)
    && validString(value.nodeType, 64, false)
    && ['visible', 'characters', 'mainComponent'].includes(value.field);
}

function validPreferredValue(value) {
  return exactKeys(value, ['type', 'key'])
    && ['COMPONENT', 'COMPONENT_SET'].includes(value.type)
    && validString(value.key, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS, false);
}

function validSlotSettings(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const allowed = new Set([
    'stretchChildOnInsert', 'displayEmptyByDefault', 'minChildren', 'maxChildren', 'allowPreferredValuesOnly',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  for (const key of ['stretchChildOnInsert', 'displayEmptyByDefault', 'allowPreferredValuesOnly']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  }
  for (const key of ['minChildren', 'maxChildren']) {
    if (value[key] !== undefined && value[key] !== null
      && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return false;
  }
  return !(value.minChildren != null && value.maxChildren != null
    && value.minChildren > value.maxChildren);
}

function validVariableAlias(value) {
  return value === null || (exactKeys(value, ['type', 'id'])
    && value.type === 'VARIABLE_ALIAS'
    && validString(value.id, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS, false));
}

function validProperty(value) {
  return exactKeys(value, [
    'name', 'type', 'defaultValue', 'variantOptions', 'preferredValues',
    'description', 'slotSettings', 'defaultValueVariable', 'bindings', 'bindingStatus',
  ])
    && validString(value.name, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS, false)
    && validString(value.type, 64, false)
    && ((value.type === 'SLOT' && value.defaultValue === null)
      || typeof value.defaultValue === 'boolean'
      || validString(value.defaultValue, MAX_COMPONENT_PROPERTY_LIST_VALUE_CODE_UNITS))
    && (value.variantOptions === null
      || (Array.isArray(value.variantOptions)
        && value.variantOptions.length <= MAX_COMPONENT_PROPERTY_LIST_VARIANT_OPTIONS
        && value.variantOptions.every((option) =>
          validString(option, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS))))
    && (value.preferredValues === null
      || (Array.isArray(value.preferredValues)
        && value.preferredValues.length <= MAX_COMPONENT_PROPERTY_LIST_PREFERRED_VALUES
        && value.preferredValues.every(validPreferredValue)))
    && (value.description === null
      || validString(value.description, MAX_COMPONENT_PROPERTY_LIST_VALUE_CODE_UNITS))
    && validSlotSettings(value.slotSettings)
    && validVariableAlias(value.defaultValueVariable)
    && Array.isArray(value.bindings)
    && value.bindings.length <= MAX_COMPONENT_PROPERTY_LIST_NODE_VISITS
    && value.bindings.every(validBinding)
    && ['wired', 'unbound', 'native-axis', 'native-slot'].includes(value.bindingStatus)
    && (value.type === 'VARIANT' ? value.bindingStatus === 'native-axis'
      : value.type === 'SLOT' ? ['native-slot', 'unbound'].includes(value.bindingStatus)
        : value.bindingStatus === (value.bindings.length ? 'wired' : 'unbound'));
}

function validNestedInstance(value) {
  return exactKeys(value, ['id', 'name', 'exposed'])
    && validString(value.id, MAX_COMPONENT_PROPERTY_LIST_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && validString(value.name, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS)
    && typeof value.exposed === 'boolean';
}

function validSlot(value) {
  return exactKeys(value, ['id', 'name', 'childCount', 'limitViolations', 'property'])
    && validString(value.id, MAX_COMPONENT_PROPERTY_LIST_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && validString(value.name, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS)
    && Number.isSafeInteger(value.childCount) && value.childCount >= 0
    && (value.property === null
      || validString(value.property, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS, false))
    && Array.isArray(value.limitViolations)
    && value.limitViolations.every((item) =>
      ['BELOW_MIN', 'ABOVE_MAX', 'HAS_NON_PREFERRED'].includes(item));
}

function validPayload(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'source', 'component', 'properties', 'nestedInstances', 'slots',
  ])
    && value.schemaVersion === 2 && value.status === 'listed'
    && value.source === (input.componentId === null ? 'selection' : 'id')
    && exactKeys(value.component, ['id', 'name', 'type'])
    && validString(value.component.id, MAX_COMPONENT_PROPERTY_LIST_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.component.id)
    && (input.componentId === null || value.component.id === input.componentId)
    && validString(value.component.name, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS)
    && ['COMPONENT', 'COMPONENT_SET'].includes(value.component.type)
    && Array.isArray(value.properties)
    && value.properties.length <= MAX_COMPONENT_PROPERTY_LIST_COUNT
    && value.properties.every(validProperty)
    && new Set(value.properties.map((property) => property.name)).size === value.properties.length
    && Array.isArray(value.nestedInstances)
    && value.nestedInstances.length <= MAX_COMPONENT_PROPERTY_LIST_NODE_VISITS
    && value.nestedInstances.every(validNestedInstance)
    && Array.isArray(value.slots)
    && value.slots.length <= MAX_COMPONENT_PROPERTY_LIST_NODE_VISITS
    && value.slots.every(validSlot);
}

function safeJson(value, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatComponentPropertyListResult(result, { json = false } = {}) {
  if (json) return safeJson(result, true);
  const lines = [`${safeJson(result.component.name)} (${result.component.id})`];
  if (result.properties.length === 0) lines.push('  (no component properties)');
  for (const property of result.properties) {
    const tail = property.type === 'VARIANT' && property.variantOptions !== null
      ? ` [${property.variantOptions.map((option) => safeJson(option)).join(', ')}]` : '';
    lines.push(`  ${safeJson(property.name)}  ${property.type}  default=${safeJson(property.defaultValue)}${tail}  ${property.bindingStatus || 'unknown'}`);
    for (const binding of property.bindings || []) {
      lines.push(`    ↳ ${binding.nodeId}.${binding.field} (${safeJson(binding.nodeName)})`);
    }
    if (property.preferredValues?.length) {
      lines.push(`    preferred: ${property.preferredValues.map((value) => `${value.type}:${value.key}`).join(', ')}`);
    }
    if (property.description) lines.push(`    description: ${safeJson(property.description)}`);
    if (property.slotSettings) lines.push(`    slot settings: ${safeJson(property.slotSettings)}`);
    if (property.defaultValueVariable) lines.push(`    default variable: ${property.defaultValueVariable.id}`);
  }
  for (const instance of result.nestedInstances || []) {
    lines.push(`  nested ${instance.id} ${safeJson(instance.name)}  ${instance.exposed ? 'exposed' : 'not exposed'}`);
  }
  for (const slot of result.slots || []) {
    lines.push(`  slot ${slot.id} ${safeJson(slot.name)}  property=${safeJson(slot.property)}  children=${slot.childCount}  violations=${slot.limitViolations.join(',') || 'none'}`);
  }
  return lines.join('\n');
}

export async function executeComponentPropertyList(request, adapters = {}) {
  if (typeof adapters.typedRead !== 'function' && typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Property List requires typedRead(operation, request, fallbackCode) or evaluate(code).');
  }
  const input = normalizedRequest(request);
  const fallbackCode = componentPropertyListCode(input);
  const serialized = typeof adapters.typedRead === 'function'
    ? await adapters.typedRead(
      COMPONENT_PROPERTY_LIST_TYPED_READ,
      { componentId: input.componentId },
      fallbackCode,
    )
    : await adapters.evaluate(fallbackCode);
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COMPONENT_PROPERTY_LIST_RESULT_CODE_UNITS) {
    throw new Error('Component Property List returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Component Property List returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Component Property List returned an invalid bounded result.');
  }
  return {
    stdout: formatComponentPropertyListResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentPropertyListPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Property List routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    && plan.execution.pluginDispatch === 'typed-read'
    ? 'command-application' : 'not-component-property-list';
}

export async function executeComponentPropertyListPlan(plan, adapters = {}) {
  if (componentPropertyListPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Property List.`);
  }
  return executeComponentPropertyList(parseComponentPropertyListRequest(plan.argv), adapters);
}
