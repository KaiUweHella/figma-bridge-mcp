// Value-returning Node Binding Facts Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  nodeBindingsArgvFromRequest,
  nodeBindingsPlanningArgvFromRequest,
  parseNodeBindingsRequest,
} from './node-bindings-request.js';
import { NODE_BINDINGS_TYPED_READ } from '../lib/typed-read-operations.js';

export {
  nodeBindingsArgvFromRequest,
  nodeBindingsPlanningArgvFromRequest,
} from './node-bindings-request.js';

const NODE_BINDINGS_APPLICATION_ID = 'node.bindings';
export const MAX_NODE_BINDING_NODES = 128;
export const MAX_NODE_BINDING_FACTS = 384;
export const MAX_NODE_BINDING_LABEL_CODE_UNITS = 512;
export const MAX_NODE_BINDING_RESOURCES = 20_000;
export const NODE_BINDING_LOOKUP_TIMEOUT_MS = 7000;
export const MAX_NODE_BINDING_SERIALIZED_CODE_UNITS = 1_000_000;
const MAX_NODE_BINDING_FIELD_CODE_UNITS = 128;
const MAX_NODE_BINDING_ID_CODE_UNITS = 512;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const NODE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESOLVED_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function safeBoundedText(value, limit) {
  return typeof value === 'string' && value.length <= limit
    && !UNSAFE_TEXT_CONTROLS.test(value);
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function normalizedRequest(request) {
  return parseNodeBindingsRequest(nodeBindingsArgvFromRequest(request));
}

export function nodeBindingsCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const MAX_NODES = ${MAX_NODE_BINDING_NODES};
    const MAX_FACTS = ${MAX_NODE_BINDING_FACTS};
    const MAX_LABEL = ${MAX_NODE_BINDING_LABEL_CODE_UNITS};
    const MAX_RESOURCES = ${MAX_NODE_BINDING_RESOURCES};
    const MAX_FIELD = ${MAX_NODE_BINDING_FIELD_CODE_UNITS};
    const MAX_ID = ${MAX_NODE_BINDING_ID_CODE_UNITS};
    const LOOKUP_TIMEOUT_MS = ${NODE_BINDING_LOOKUP_TIMEOUT_MS};
    const targetId = ${input.nodeId ? JSON.stringify(input.nodeId) : 'null'};
    const clean = (value, limit) => {
      const text = String(value == null ? '' : value)
        .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]/g, ' ');
      if (text.length > limit) throw new Error('Figma Node Binding Facts exceed the bounded result contract.');
      return text;
    };
    async function findTarget(id) {
      let timeoutHandle;
      try {
        return await Promise.race([
          figma.getNodeByIdAsync(id),
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(
              'Figma node lookup timed out before the bounded read: ' + id,
            )), LOOKUP_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timeoutHandle != null) clearTimeout(timeoutHandle);
      }
    }
    const target = targetId ? await findTarget(targetId) : null;
    if (targetId && !target) throw new Error('Node not found in the targeted Figma document: ' + targetId);
    const nodes = targetId ? [target] : Array.from(figma.currentPage.selection || []);
    if (nodes.length > MAX_NODES) throw new Error('Figma selection exceeds the bounded Node Binding Facts contract.');

    const variableCache = new Map();
    const collectionCache = new Map();
    let localVariables = null;
    let localCollections = null;
    let factCount = 0;
    async function localVariable(id) {
      if (localVariables === null) {
        localVariables = false;
        if (typeof figma.variables.getLocalVariablesAsync === 'function') {
          try {
            const candidates = await figma.variables.getLocalVariablesAsync();
            if (!Array.isArray(candidates) || candidates.length > MAX_RESOURCES) {
              throw new Error('Figma local Variable catalog exceeds the bounded Node Binding Facts contract.');
            }
            localVariables = new Map(candidates
              .filter((candidate) => candidate && candidate.remote === false
                && typeof candidate.id === 'string' && candidate.id.length <= MAX_ID)
              .map((candidate) => [candidate.id, candidate]));
          } catch (error) {
            if (/exceeds the bounded/.test(String(error && error.message || error))) throw error;
          }
        }
      }
      return localVariables && localVariables.get(id) || null;
    }
    async function localCollection(id) {
      if (localCollections === null) {
        localCollections = false;
        if (typeof figma.variables.getLocalVariableCollectionsAsync === 'function') {
          try {
            const candidates = await figma.variables.getLocalVariableCollectionsAsync();
            if (!Array.isArray(candidates) || candidates.length > MAX_RESOURCES) {
              throw new Error('Figma local Collection catalog exceeds the bounded Node Binding Facts contract.');
            }
            localCollections = new Map(candidates
              .filter((candidate) => candidate && candidate.remote === false
                && typeof candidate.id === 'string' && candidate.id.length <= MAX_ID)
              .map((candidate) => [candidate.id, candidate]));
          } catch (error) {
            if (/exceeds the bounded/.test(String(error && error.message || error))) throw error;
          }
        }
      }
      return localCollections && localCollections.get(id) || null;
    }
    async function collectionFact(collectionId) {
      if (!collectionId) return null;
      const id = clean(collectionId, MAX_ID);
      if (collectionCache.has(id)) return collectionCache.get(id);
      let collection = await localCollection(id);
      if (!collection && typeof figma.variables.getVariableCollectionByIdAsync === 'function') {
        try { collection = await figma.variables.getVariableCollectionByIdAsync(id); } catch {}
      }
      const fact = {
        id,
        name: collection ? clean(collection.name, MAX_LABEL) : null,
        resolved: !!collection,
      };
      collectionCache.set(id, fact);
      return fact;
    }
    async function variableFact(alias) {
      if (!alias || typeof alias.id !== 'string') {
        throw new Error('Figma returned unsupported node binding topology.');
      }
      const id = clean(alias.id, MAX_ID);
      if (variableCache.has(id)) return variableCache.get(id);
      let variable = await localVariable(id);
      if (!variable && typeof figma.variables.getVariableByIdAsync === 'function') {
        try { variable = await figma.variables.getVariableByIdAsync(id); } catch {}
      }
      const fact = variable ? {
        id,
        name: clean(variable.name, MAX_LABEL),
        resolvedType: clean(variable.resolvedType, 64),
        collection: await collectionFact(variable.variableCollectionId),
        resolved: true,
      } : {
        id,
        name: null,
        resolvedType: null,
        collection: null,
        resolved: false,
      };
      variableCache.set(id, fact);
      return fact;
    }
    async function bindingFact(field, alias, index = null, propertyName = null) {
      factCount++;
      if (factCount > MAX_FACTS) {
        throw new Error('Figma node bindings exceed the bounded Node Binding Facts contract.');
      }
      return {
        field: clean(field, MAX_FIELD),
        index,
        propertyName: propertyName == null ? null : clean(propertyName, MAX_LABEL),
        variable: await variableFact(alias),
      };
    }

    const results = [];
    for (const node of nodes) {
      const bindings = [];
      for (const [field, value] of Object.entries(node.boundVariables || {})) {
        if (field === 'componentProperties' && value && typeof value === 'object'
          && !Array.isArray(value) && typeof value.id !== 'string') {
          for (const [propertyName, alias] of Object.entries(value)) {
            if (alias == null) continue;
            bindings.push(await bindingFact(field, alias, null, propertyName));
          }
        } else if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            if (value[index] == null) continue;
            bindings.push(await bindingFact(field, value[index], index));
          }
        } else if (value != null) {
          bindings.push(await bindingFact(field, value));
        }
      }
      results.push({
        id: clean(node.id, 96),
        name: clean(node.name, MAX_LABEL),
        type: clean(node.type, 64),
        bindings,
      });
    }
    return {
      schemaVersion: 1,
      source: targetId ? 'node' : 'selection',
      nodes: results,
    };
  })()`;
}

function validCollection(value) {
  return value === null || (hasExactKeys(value, ['id', 'name', 'resolved'])
    && safeBoundedText(value.id, MAX_NODE_BINDING_ID_CODE_UNITS)
    && value.id.length > 0
    && (value.name === null || safeBoundedText(value.name, MAX_NODE_BINDING_LABEL_CODE_UNITS))
    && typeof value.resolved === 'boolean'
    && (!value.resolved || value.name !== null));
}

function validVariable(value) {
  return hasExactKeys(value, ['id', 'name', 'resolvedType', 'collection', 'resolved'])
    && safeBoundedText(value.id, MAX_NODE_BINDING_ID_CODE_UNITS)
    && value.id.length > 0
    && (value.name === null || safeBoundedText(value.name, MAX_NODE_BINDING_LABEL_CODE_UNITS))
    && (value.resolvedType === null || (typeof value.resolvedType === 'string'
      && RESOLVED_TYPE_PATTERN.test(value.resolvedType)))
    && validCollection(value.collection)
    && typeof value.resolved === 'boolean'
    && (value.resolved
      ? value.name !== null && value.resolvedType !== null
      : value.name === null && value.resolvedType === null && value.collection === null);
}

function validBinding(value) {
  return hasExactKeys(value, ['field', 'index', 'propertyName', 'variable'])
    && safeBoundedText(value.field, MAX_NODE_BINDING_FIELD_CODE_UNITS)
    && value.field.length > 0
    && (value.index === null || (Number.isSafeInteger(value.index) && value.index >= 0))
    && (value.propertyName === null
      || safeBoundedText(value.propertyName, MAX_NODE_BINDING_LABEL_CODE_UNITS))
    && (value.propertyName === null
      || (value.field === 'componentProperties' && value.index === null))
    && validVariable(value.variable);
}

function validResult(value) {
  if (!hasExactKeys(value, ['schemaVersion', 'source', 'nodes']) || value.schemaVersion !== 1
    || !['node', 'selection'].includes(value.source)
    || !Array.isArray(value.nodes) || value.nodes.length > MAX_NODE_BINDING_NODES) return false;
  let facts = 0;
  for (const node of value.nodes) {
    if (!hasExactKeys(node, ['id', 'name', 'type', 'bindings'])
      || typeof node.id !== 'string' || node.id.length > 96 || !NODE_ID_PATTERN.test(node.id)
      || !safeBoundedText(node.name, MAX_NODE_BINDING_LABEL_CODE_UNITS)
      || typeof node.type !== 'string' || !NODE_TYPE_PATTERN.test(node.type)
      || !Array.isArray(node.bindings) || !node.bindings.every(validBinding)) return false;
    facts += node.bindings.length;
  }
  return facts <= MAX_NODE_BINDING_FACTS
    && (value.source === 'selection' || value.nodes.length === 1);
}

function bindingLabel(binding) {
  if (binding.propertyName !== null) {
    return `${binding.field}[${JSON.stringify(binding.propertyName)}]`;
  }
  return binding.index === null ? binding.field : `${binding.field}.${binding.index}`;
}

export function formatNodeBindingsResult(result, { json = false } = {}) {
  if (!validResult(result)) throw new Error('Node Bindings returned an invalid bounded result.');
  if (json) return JSON.stringify(result, null, 2);
  if (result.source === 'selection' && result.nodes.length === 0) return 'No node selected';
  return result.nodes.map((node) => {
    const lines = [`${node.name} (${node.id}):`];
    if (node.bindings.length === 0) lines.push('  No variable bindings');
    for (const binding of node.bindings) {
      const variable = binding.variable;
      const identity = variable.resolved ? variable.name : `${variable.id} (unresolved)`;
      const collection = variable.collection
        ? ` [${variable.collection.name || variable.collection.id}]`
        : '';
      const type = variable.resolvedType ? ` · ${variable.resolvedType}` : '';
      lines.push(`  ${bindingLabel(binding)}: ${identity}${collection}${type}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

/** @param {object} request @param {{typedRead?: Function, evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeNodeBindings(request, adapters = {}) {
  if (typeof adapters.typedRead !== 'function' && typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeNodeBindings requires typedRead(operation, request, fallbackCode) or evaluate(code)');
  }
  const input = normalizedRequest(request);
  const fallbackCode = nodeBindingsCode(input);
  const value = typeof adapters.typedRead === 'function'
    ? await adapters.typedRead(NODE_BINDINGS_TYPED_READ, { nodeId: input.nodeId }, fallbackCode)
    : await adapters.evaluate(fallbackCode);
  let result = value;
  if (typeof value === 'string') {
    if (value.length > MAX_NODE_BINDING_SERIALIZED_CODE_UNITS) {
      throw new Error('Node Bindings returned an invalid bounded result.');
    }
    try { result = JSON.parse(value); }
    catch { throw new Error('Node Bindings returned invalid JSON.'); }
  }
  if (!validResult(result)) throw new Error('Node Bindings returned an invalid bounded result.');
  return {
    stdout: formatNodeBindingsResult(result, { json: input.json }),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    result,
  };
}

export function nodeBindingsPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Bindings routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === NODE_BINDINGS_APPLICATION_ID
    && plan.execution.pluginDispatch === 'typed-read'
    ? 'command-application'
    : 'not-node-bindings';
}

export async function executeNodeBindingsPlan(plan, adapters = {}) {
  if (nodeBindingsPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Node Bindings Command Application.`);
  }
  return executeNodeBindings(parseNodeBindingsRequest(plan.argv), adapters);
}
