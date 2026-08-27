// Plan-bound Command Application for lossless, preflighted Component Combine.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  componentCombineArgvFromRequest,
  componentCombinePlanningArgvFromRequest,
  MAX_COMPONENT_COMBINE_COMPONENTS,
  MAX_COMPONENT_COMBINE_NAME_CODE_UNITS,
  parseComponentCombineRequest,
} from './component-combine-request.js';

export {
  componentCombineArgvFromRequest,
  componentCombinePlanningArgvFromRequest,
} from './component-combine-request.js';

const COMPONENT_COMBINE_APPLICATION_ID = 'component.combine';
export const MAX_COMPONENT_COMBINE_ANCESTOR_DEPTH = 128;
export const MAX_COMPONENT_COMBINE_SERIALIZED_CODE_UNITS = 262_144;
const MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS = 96;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function normalizedRequest(request) {
  return parseComponentCombineRequest(componentCombineArgvFromRequest(request));
}

export function componentCombineRequestFromArgv(args) {
  return parseComponentCombineRequest(args);
}

export function componentCombineCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const componentIds = ${JSON.stringify(input.componentIds)};
    const setName = ${JSON.stringify(input.name)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const pageFor = (node) => {
      const seen = new Set();
      let current = node;
      for (let depth = 0; current && depth <= ${MAX_COMPONENT_COMBINE_ANCESTOR_DEPTH}; depth++) {
        if (seen.has(current)) throw new Error('Component ancestry contains a cycle.');
        seen.add(current);
        if (current.type === 'PAGE') return current;
        if (current !== node && ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(current.type)) {
          throw new Error('Component ' + clean(node.id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS})
            + ' cannot be reparented from inside ' + clean(current.type, 64) + '.');
        }
        current = current.parent;
      }
      throw new Error('Component ' + clean(node.id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS})
        + ' has no bounded Figma page ancestry.');
    };

    const components = [];
    const pages = [];
    for (const id of componentIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new Error('Component not found: ' + clean(id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS}));
      if (node.type === 'COMPONENT_SET') {
        throw new Error('Component Set input ' + clean(id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS})
          + ' is already a set. Add a variant with ["component","add-variant","<set>","Axis=Value"].');
      }
      if (node.type !== 'COMPONENT') {
        throw new Error('Component Combine requires COMPONENT nodes; got ' + clean(node.type, 64)
          + ' for ' + clean(id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS}) + '.');
      }
      if (node.remote !== false) {
        throw new Error('Component ' + clean(id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS})
          + ' is remote and cannot be structurally combined in this file.');
      }
      if (node.parent && node.parent.type === 'COMPONENT_SET') {
        throw new Error('Component ' + clean(id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS})
          + ' is already a Variant in a Component Set. Add a variant with ["component","add-variant","<set>","Axis=Value"].');
      }
      components.push(node);
      pages.push(pageFor(node));
    }
    const pageIds = new Set(pages.map((page) => page.id));
    if (pageIds.size !== 1) {
      throw new Error('All Components must belong to the same Figma page before Component Combine.');
    }
    const destination = pages[0];
    if (!destination || typeof destination.appendChild !== 'function') {
      throw new Error('The shared Component page cannot contain a Component Set.');
    }

    const set = figma.combineAsVariants(components, destination);
    set.name = setName;
    delete globalThis.__invCache;

    const verified = await figma.getNodeByIdAsync(set.id);
    if (!verified || verified.type !== 'COMPONENT_SET' || verified.name !== setName) {
      throw new Error('Component Combine could not freshly verify the resulting Component Set.');
    }
    if (!Array.isArray(verified.children)
      || verified.children.length !== componentIds.length
      || verified.children.length > ${MAX_COMPONENT_COMBINE_COMPONENTS}) {
      throw new Error('Component Combine did not produce the complete requested membership.');
    }
    const inputIndex = new Map(componentIds.map((id, index) => [id, index]));
    const variants = verified.children.map((variant) => ({
      id: clean(variant && variant.id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS}),
      name: clean(variant && variant.name, ${MAX_COMPONENT_COMBINE_NAME_CODE_UNITS}),
      type: variant && variant.type,
      parentId: variant && variant.parent && variant.parent.id,
      inputIndex: inputIndex.get(variant && variant.id),
    }));
    if (variants.some((variant) => variant.type !== 'COMPONENT'
      || variant.parentId !== verified.id
      || !Number.isInteger(variant.inputIndex))) {
      throw new Error('Component Combine did not produce the complete requested membership.');
    }
    const membership = variants.map((variant) => variant.id);
    if (new Set(membership).size !== componentIds.length
      || componentIds.some((id) => !membership.includes(id))) {
      throw new Error('Component Combine did not produce the complete requested membership.');
    }
    const payload = {
      schemaVersion: 1,
      status: 'combined',
      set: {
        id: clean(verified.id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS}),
        name: clean(verified.name, ${MAX_COMPONENT_COMBINE_NAME_CODE_UNITS}),
        pageId: clean(destination.id, ${MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS}),
      },
      variants: variants.map(({ id, name, inputIndex: index }) => ({ id, name, inputIndex: index })),
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_COMPONENT_COMBINE_SERIALIZED_CODE_UNITS}) {
      throw new Error('Component Combine result exceeds its bounded response limit.');
    }
    return serialized;
  })()`;
}

function validString(value, maximum, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= maximum
    && (empty || value.length > 0) && !UNSAFE_TEXT_CONTROLS.test(value);
}

function validId(value) {
  return validString(value, MAX_COMPONENT_COMBINE_NODE_ID_CODE_UNITS, { empty: false })
    && NODE_ID_PATTERN.test(value);
}

function validateComponentCombineResult(value, input) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'schemaVersion,set,status,variants'
    || value.schemaVersion !== 1 || value.status !== 'combined'
    || !value.set || typeof value.set !== 'object' || Array.isArray(value.set)
    || Object.keys(value.set).sort().join(',') !== 'id,name,pageId'
    || !validId(value.set.id) || !validId(value.set.pageId)
    || !validString(value.set.name, MAX_COMPONENT_COMBINE_NAME_CODE_UNITS, { empty: false })
    || value.set.name !== input.name
    || !Array.isArray(value.variants)
    || value.variants.length !== input.componentIds.length
    || value.variants.length > MAX_COMPONENT_COMBINE_COMPONENTS) {
    throw new Error('Component Combine returned an invalid bounded result.');
  }
  const ids = [];
  const inputIndexes = [];
  for (const variant of value.variants) {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)
      || Object.keys(variant).sort().join(',') !== 'id,inputIndex,name'
      || !validId(variant.id)
      || !validString(variant.name, MAX_COMPONENT_COMBINE_NAME_CODE_UNITS)
      || !Number.isInteger(variant.inputIndex)
      || variant.inputIndex < 0 || variant.inputIndex >= input.componentIds.length
      || input.componentIds[variant.inputIndex] !== variant.id) {
      throw new Error('Component Combine returned an invalid bounded result.');
    }
    ids.push(variant.id);
    inputIndexes.push(variant.inputIndex);
  }
  if (new Set(ids).size !== input.componentIds.length
    || new Set(inputIndexes).size !== input.componentIds.length
    || input.componentIds.some((id) => !ids.includes(id))) {
    throw new Error('Component Combine returned an invalid bounded result.');
  }
  return value;
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatComponentCombineResult(result, { json = false } = {}) {
  if (json) return safePrettyJson(result);
  const lines = [
    `Combined ${result.variants.length} Components into ${JSON.stringify(result.set.name)} (${result.set.id})`,
    '  verified Variants:',
  ];
  for (const [index, variant] of result.variants.entries()) {
    lines.push(`    ${index + 1}. ${JSON.stringify(variant.name)} (${variant.id}, input ${variant.inputIndex + 1})`);
  }
  return lines.join('\n');
}

export async function executeComponentCombine(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Component Combine command requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentCombineCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COMPONENT_COMBINE_SERIALIZED_CODE_UNITS) {
    const error = new Error('Component Combine returned an invalid bounded result.');
    error.kind = 'plugin-result';
    error.phase = 'plugin-response';
    error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
    validateComponentCombineResult(payload, input);
  } catch (cause) {
    const error = new Error('Component Combine returned an invalid bounded result.', { cause });
    error.kind = 'plugin-result';
    error.phase = 'plugin-response';
    error.outcome = 'unknown-after-dispatch';
    throw error;
  }
  return {
    stdout: formatComponentCombineResult(payload, { json: input.json }),
    stderr: '',
    result: payload,
  };
}

export function componentCombinePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Component Combine routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === COMPONENT_COMBINE_APPLICATION_ID
    ? 'command-application'
    : 'not-component-combine';
}

export async function executeComponentCombinePlan(plan, adapters = {}) {
  if (componentCombinePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Component Combine.`);
  }
  return executeComponentCombine(componentCombineRequestFromArgv(plan.argv), adapters);
}
