// Exact bounded instance-to-component identity Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { componentContextExpr } from '../lib/eval-snippets.js';
import {
  componentMainArgvFromRequest,
  componentMainPlanningArgvFromRequest,
  parseComponentMainRequest,
} from './component-main-request.js';

export {
  componentMainArgvFromRequest,
  componentMainPlanningArgvFromRequest,
} from './component-main-request.js';

const COMPONENT_MAIN_APPLICATION_ID = 'component.main';
export const MAX_COMPONENT_MAIN_SERIALIZED_CODE_UNITS = 500_000;
export const MAX_COMPONENT_MAIN_DEPTH = 24;
export const MAX_COMPONENT_MAIN_CONTAINER_ENTRIES = 1024;
export const MAX_COMPONENT_MAIN_VALUES = 50_000;
export const MAX_COMPONENT_MAIN_STRING_CODE_UNITS = 65_536;
export const MAX_COMPONENT_MAIN_VARIANTS = 1024;
const MAX_COMPONENT_MAIN_KEY_CODE_UNITS = 256;
const MAX_COMPONENT_MAIN_ID_CODE_UNITS = 96;
const MAX_COMPONENT_MAIN_NAME_CODE_UNITS = 512;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const COMPONENT_PROPERTY_TYPES = new Set(['BOOLEAN', 'TEXT', 'INSTANCE_SWAP', 'VARIANT', 'SLOT']);
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

function normalizedRequest(request) {
  return parseComponentMainRequest(componentMainArgvFromRequest(request));
}

export function componentMainCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const n = await figma.getNodeByIdAsync(${JSON.stringify(input.instanceId)});
    if (!n) throw new Error('Instance not found in the targeted Figma document.');
    if (n.type !== 'INSTANCE') throw new Error('Target node is not an INSTANCE (got ' + n.type + ').');
    const ctx = ${componentContextExpr('n')};
    if (!ctx.mainComponent) {
      throw new Error('Instance has no resolvable main component; its library may not be loaded.');
    }
    const payload = { schemaVersion: 1, instance: { id: n.id, name: n.name }, ...ctx };
    if (payload.set && payload.set.variants.length > ${MAX_COMPONENT_MAIN_VARIANTS}) {
      throw new Error('Component Main variant limit exceeded.');
    }
    let values = 0;
    const seen = new Set();
    const verify = (value, depth = 0) => {
      values++;
      if (values > ${MAX_COMPONENT_MAIN_VALUES}) throw new Error('Component Main value limit exceeded.');
      if (depth > ${MAX_COMPONENT_MAIN_DEPTH}) throw new Error('Component Main depth limit exceeded.');
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Component Main contains a non-finite number.');
        return;
      }
      if (typeof value === 'string') {
        if (value.length > ${MAX_COMPONENT_MAIN_STRING_CODE_UNITS}) {
          throw new Error('Component Main string limit exceeded.');
        }
        return;
      }
      if (!value || typeof value !== 'object') throw new Error('Component Main contains a non-JSON value.');
      if (seen.has(value)) throw new Error('Component Main contains a cycle.');
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length > ${MAX_COMPONENT_MAIN_CONTAINER_ENTRIES}) {
          throw new Error('Component Main array limit exceeded.');
        }
        for (const item of value) verify(item, depth + 1);
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error('Component Main contains a non-plain object.');
        }
        const keys = Object.keys(value);
        if (keys.length > ${MAX_COMPONENT_MAIN_CONTAINER_ENTRIES}) {
          throw new Error('Component Main object limit exceeded.');
        }
        for (const key of keys) {
          if (key.length > ${MAX_COMPONENT_MAIN_KEY_CODE_UNITS}) {
            throw new Error('Component Main key limit exceeded.');
          }
          verify(value[key], depth + 1);
        }
      }
      seen.delete(value);
    };
    verify(payload);
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_COMPONENT_MAIN_SERIALIZED_CODE_UNITS}) {
      throw new Error('Component Main serialized-size limit exceeded.');
    }
    return serialized;
  })()`;
}

function boundedString(value, maximum, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function validNode(value, { key = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = key ? 'id,key,name,remote' : 'id,name';
  if (Object.keys(value).sort().join(',') !== expected) return false;
  return boundedString(value.id, MAX_COMPONENT_MAIN_ID_CODE_UNITS, { empty: false })
    && NODE_ID_PATTERN.test(value.id)
    && boundedString(value.name, MAX_COMPONENT_MAIN_NAME_CODE_UNITS)
    && (!key || ((value.key === null || boundedString(value.key, MAX_COMPONENT_MAIN_NAME_CODE_UNITS))
      && typeof value.remote === 'boolean'));
}

function boundedJsonValue(value, depth, state) {
  state.values++;
  if (state.values > MAX_COMPONENT_MAIN_VALUES || depth > MAX_COMPONENT_MAIN_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_COMPONENT_MAIN_STRING_CODE_UNITS;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_COMPONENT_MAIN_CONTAINER_ENTRIES
      && value.every((item) => boundedJsonValue(item, depth + 1, state));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.length <= MAX_COMPONENT_MAIN_CONTAINER_ENTRIES
    && keys.every((key) => key.length <= MAX_COMPONENT_MAIN_KEY_CODE_UNITS
      && boundedJsonValue(value[key], depth + 1, state));
}

function validPropertyRecord(value, { definition = false } = {}) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length > MAX_COMPONENT_MAIN_CONTAINER_ENTRIES) return false;
  return Object.entries(value).every(([name, property]) => (
    name.length <= MAX_COMPONENT_MAIN_KEY_CODE_UNITS
    && property && typeof property === 'object' && !Array.isArray(property)
    && COMPONENT_PROPERTY_TYPES.has(property.type)
    && Object.hasOwn(property, definition ? 'defaultValue' : 'value')
    && ['string', 'boolean'].includes(typeof property[definition ? 'defaultValue' : 'value'])
  ));
}

function validVariantProperties(value) {
  return value === null || (
    value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length <= MAX_COMPONENT_MAIN_CONTAINER_ENTRIES
    && Object.entries(value).every(([name, selected]) => (
      name.length <= MAX_COMPONENT_MAIN_KEY_CODE_UNITS
      && boundedString(selected, MAX_COMPONENT_MAIN_STRING_CODE_UNITS)
    ))
  );
}

function validPayload(value, input) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectedKeys = [
    'componentProperties', 'componentPropertyDefinitions', 'instance', 'mainComponent',
    'role', 'schemaVersion', 'set', 'variantGroupProperties', 'variantProperties',
  ].sort().join(',');
  if (Object.keys(value).sort().join(',') !== expectedKeys
    || value.schemaVersion !== 1 || value.role !== 'INSTANCE'
    || !validNode(value.instance) || value.instance.id !== input.instanceId
    || !validNode(value.mainComponent, { key: true })
    || !validVariantProperties(value.variantProperties)
    || !validPropertyRecord(value.componentProperties)
    || !validPropertyRecord(value.componentPropertyDefinitions, { definition: true })
    || value.variantGroupProperties !== null) return false;
  if (value.set !== null) {
    if (!value.set || typeof value.set !== 'object' || Array.isArray(value.set)
      || Object.keys(value.set).sort().join(',') !== 'id,key,name,variants'
      || !boundedString(value.set.id, MAX_COMPONENT_MAIN_ID_CODE_UNITS, { empty: false })
      || !NODE_ID_PATTERN.test(value.set.id)
      || !boundedString(value.set.name, MAX_COMPONENT_MAIN_NAME_CODE_UNITS)
      || !(value.set.key === null || boundedString(value.set.key, MAX_COMPONENT_MAIN_NAME_CODE_UNITS))
      || !Array.isArray(value.set.variants)
      || value.set.variants.length > MAX_COMPONENT_MAIN_VARIANTS
      || !value.set.variants.every((variant) => validNode(variant))) return false;
    const variantIds = value.set.variants.map((variant) => variant.id);
    if (new Set(variantIds).size !== variantIds.length
      || variantIds.filter((id) => id === value.mainComponent.id).length !== 1) return false;
  }
  return boundedJsonValue(value, 0, { values: 0 });
}

function safeText(value) {
  return String(value).replace(UNSAFE_TEXT_CONTROLS, ' ');
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatComponentMainResult(payload, { json = false } = {}) {
  const { schemaVersion: _schemaVersion, ...legacy } = payload;
  if (json) return safePrettyJson(legacy);
  const lines = [`${safeText(legacy.instance.name)} (${legacy.instance.id})`];
  const mainKey = legacy.mainComponent.key ? `, key ${safeText(legacy.mainComponent.key)}` : '';
  const remote = legacy.mainComponent.remote ? ', remote library' : '';
  lines.push(`  main: ${safeText(legacy.mainComponent.name)} (${legacy.mainComponent.id}${mainKey}${remote})`);
  if (legacy.set) {
    const setKey = legacy.set.key ? `, key ${safeText(legacy.set.key)}` : '';
    lines.push(`  set:  ${safeText(legacy.set.name)} (${legacy.set.id}${setKey}, ${legacy.set.variants.length} variants)`);
  }
  if (legacy.variantProperties && Object.keys(legacy.variantProperties).length > 0) {
    lines.push('  variant values:');
    for (const [name, value] of Object.entries(legacy.variantProperties)) {
      lines.push(`    ${safeText(name)} = ${safeText(value)}`);
    }
  }
  if (legacy.componentPropertyDefinitions
    && Object.keys(legacy.componentPropertyDefinitions).length > 0) {
    lines.push('  property definitions:');
    for (const [name, definition] of Object.entries(legacy.componentPropertyDefinitions)) {
      const options = definition?.variantOptions
        ? ` [${definition.variantOptions.map(safeText).join(' | ')}]`
        : '';
      lines.push(`    ${safeText(name)}: ${safeText(definition?.type)}${options} (default: ${safeText(JSON.stringify(definition?.defaultValue))})`);
    }
  }
  return lines.join('\n');
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeComponentMain(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeComponentMain requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentMainCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COMPONENT_MAIN_SERIALIZED_CODE_UNITS) {
    throw new Error('Component Main returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error('Component Main returned an invalid bounded result.');
  }
  if (!validPayload(payload, input)) {
    throw new Error('Component Main returned an invalid bounded result.');
  }
  return {
    stdout: formatComponentMainResult(payload, { json: input.json }),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    result: payload,
  };
}

export function componentMainPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Main routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === COMPONENT_MAIN_APPLICATION_ID
    ? 'command-application'
    : 'not-component-main';
}

export async function executeComponentMainPlan(plan, adapters = {}) {
  if (componentMainPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Component Main Command Application.`);
  }
  return executeComponentMain(parseComponentMainRequest(plan.argv), adapters);
}
