// Plan-bound bounded Component Property List Read Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
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
    const properties = entries.map(([name, definition]) => {
      if (typeof name !== 'string' || !name || name.length > ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}
        || !definition || typeof definition !== 'object' || Array.isArray(definition)
        || typeof definition.type !== 'string' || !definition.type || definition.type.length > 64
        || !(typeof definition.defaultValue === 'boolean'
          || (typeof definition.defaultValue === 'string'
            && definition.defaultValue.length <= ${MAX_COMPONENT_PROPERTY_LIST_VALUE_CODE_UNITS}))) {
        throw new Error('Component Property List encountered incompatible definition metadata.');
      }
      const variantOptions = definition.variantOptions === undefined ? null : definition.variantOptions;
      if (variantOptions !== null && (!Array.isArray(variantOptions)
        || variantOptions.length > ${MAX_COMPONENT_PROPERTY_LIST_VARIANT_OPTIONS}
        || variantOptions.some((option) => typeof option !== 'string'
          || option.length > ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}))) {
        throw new Error('Component Property List encountered invalid Variant options.');
      }
      return {
        name,
        type: definition.type,
        defaultValue: definition.defaultValue,
        variantOptions,
      };
    });
    return bounded({
      schemaVersion: 1,
      status: 'listed',
      source: componentId === null ? 'selection' : 'id',
      component: {
        id: node.id,
        name: clean(String(node.name || ''), ${MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS}),
        type: node.type,
      },
      properties,
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

function validProperty(value) {
  return exactKeys(value, ['name', 'type', 'defaultValue', 'variantOptions'])
    && validString(value.name, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS, false)
    && validString(value.type, 64, false)
    && (typeof value.defaultValue === 'boolean'
      || validString(value.defaultValue, MAX_COMPONENT_PROPERTY_LIST_VALUE_CODE_UNITS))
    && (value.variantOptions === null
      || (Array.isArray(value.variantOptions)
        && value.variantOptions.length <= MAX_COMPONENT_PROPERTY_LIST_VARIANT_OPTIONS
        && value.variantOptions.every((option) =>
          validString(option, MAX_COMPONENT_PROPERTY_LIST_NAME_CODE_UNITS))));
}

function validPayload(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'source', 'component', 'properties'])
    && value.schemaVersion === 1 && value.status === 'listed'
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
    && new Set(value.properties.map((property) => property.name)).size === value.properties.length;
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
  if (result.properties.length === 0) return [...lines, '  (no component properties)'].join('\n');
  for (const property of result.properties) {
    const tail = property.type === 'VARIANT' && property.variantOptions !== null
      ? ` [${property.variantOptions.map((option) => safeJson(option)).join(', ')}]` : '';
    lines.push(`  ${safeJson(property.name)}  ${property.type}  default=${safeJson(property.defaultValue)}${tail}`);
  }
  return lines.join('\n');
}

export async function executeComponentPropertyList(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Property List requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentPropertyListCode(input));
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
    ? 'command-application' : 'not-component-property-list';
}

export async function executeComponentPropertyListPlan(plan, adapters = {}) {
  if (componentPropertyListPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Property List.`);
  }
  return executeComponentPropertyList(parseComponentPropertyListRequest(plan.argv), adapters);
}
