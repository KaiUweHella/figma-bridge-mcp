// Bounded, journaled Variable Batch Creation Command Application.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_VARIABLE_DESCRIPTION_CODE_UNITS,
  normalizeVariableScopes,
  normalizeVariableValue,
} from '../lib/variable-management.js';
import { VARIABLE_SCOPES_BY_TYPE } from '../lib/variable-scope-policy.js';
import {
  MAX_VARIABLE_CREATE_BATCH_ITEMS,
  parseVariableCreateBatchRequest,
  variableCreateBatchArgvFromRequest,
  variableCreateBatchPlanningArgvFromRequest,
} from './variable-create-batch-request.js';

export {
  variableCreateBatchArgvFromRequest,
  variableCreateBatchPlanningArgvFromRequest,
} from './variable-create-batch-request.js';

const VARIABLE_CREATE_BATCH_APPLICATION_ID = 'var.create-batch';
export const MAX_VARIABLE_CREATE_BATCH_CANDIDATES = 100_000;
export const MAX_VARIABLE_CREATE_BATCH_SERIALIZED_CODE_UNITS = 1_000_000;
const MAX_VARIABLE_CREATE_BATCH_STRING_CODE_UNITS = 1024;
const MAX_VARIABLE_CREATE_BATCH_MODES = 1_000;
const VARIABLE_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);

function normalizedRequest(request) {
  return parseVariableCreateBatchRequest(variableCreateBatchArgvFromRequest(request));
}

export function variableCreateBatchCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const items = ${JSON.stringify(input.items)};
    const collectionQuery = ${JSON.stringify(input.collection)};
    const modeQuery = ${JSON.stringify(input.mode)};
    const allowDuplicate = ${input.allowDuplicate};
    const variableTypes = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
    const scopeOptions = ${JSON.stringify(VARIABLE_SCOPES_BY_TYPE)};
    const [collections, variables] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);
    if (!Array.isArray(collections) || collections.length > ${MAX_VARIABLE_CREATE_BATCH_CANDIDATES}
      || !Array.isArray(variables) || variables.length > ${MAX_VARIABLE_CREATE_BATCH_CANDIDATES}) {
      throw new Error('Variable Batch Creation candidate limit exceeded.');
    }
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_VARIABLE_CREATE_BATCH_STRING_CODE_UNITS} && (empty || value.length > 0);
    if (new Set(collections.map((item) => item.id)).size !== collections.length
      || new Set(variables.map((item) => item.id)).size !== variables.length) {
      throw new Error('Variable Batch Creation encountered duplicate native identities.');
    }
    const directCollections = collections.filter((item) => item.id === collectionQuery);
    const exactCollections = collections.filter((item) => item.name === collectionQuery);
    const collectionMatches = directCollections.length ? directCollections : exactCollections;
    if (collectionMatches.length > 1) {
      throw new Error('Variable Collection is ambiguous; use its id.');
    }
    if (!collectionMatches.length) throw new Error('Variable Collection not found.');
    const collection = collectionMatches[0];
    if (!validText(collection.id, false) || !validText(collection.name)
      || collection.remote || !validText(collection.defaultModeId, false)
      || !Array.isArray(collection.modes) || collection.modes.length < 1
      || collection.modes.length > ${MAX_VARIABLE_CREATE_BATCH_MODES}
      || collection.modes.some((mode) => !mode || !validText(mode.modeId, false)
        || !validText(mode.name))
      || new Set(collection.modes.map((mode) => mode.modeId)).size !== collection.modes.length
      || !collection.modes.some((mode) => mode.modeId === collection.defaultModeId)) {
      throw new Error('Variable Batch Creation encountered invalid Collection metadata.');
    }
    let mode;
    let modeResolution;
    if (modeQuery === null) {
      mode = collection.modes.find((item) => item.modeId === collection.defaultModeId);
      modeResolution = 'default';
    } else {
      const directModes = collection.modes.filter((item) => item.modeId === modeQuery);
      const exactModes = collection.modes.filter((item) => item.name === modeQuery);
      const partialModes = collection.modes.filter((item) =>
        item.name.toLowerCase().includes(modeQuery.toLowerCase()));
      const modeMatches = directModes.length ? directModes
        : (exactModes.length ? exactModes : partialModes);
      if (modeMatches.length > 1) throw new Error('Variable mode is ambiguous; use its id.');
      if (!modeMatches.length) throw new Error('Variable mode not found.');
      mode = modeMatches[0];
      modeResolution = directModes.length ? 'id' : 'name';
    }
    const localVariables = variables.filter((variable) =>
      variable.variableCollectionId === collection.id);
    if (localVariables.some((variable) => !validText(variable.id, false)
      || !validText(variable.name) || variable.remote
      || !variableTypes.has(variable.resolvedType))) {
      throw new Error('Variable Batch Creation encountered invalid Variable metadata.');
    }
    const duplicateCountBefore = items.reduce((count, item) => count
      + localVariables.filter((variable) => variable.name === item.name).length, 0);
    if (!allowDuplicate && duplicateCountBefore > 0) {
      throw new Error('A Variable with one requested exact name already exists in the Collection. Pass --allow-duplicate intentionally.');
    }
    if (!allowDuplicate && new Set(items.map((item) => item.name)).size !== items.length) {
      throw new Error('Duplicate names in one batch require --allow-duplicate.');
    }
    const compact = (variable, index) => ({
      index, id: variable.id, name: variable.name,
      resolvedType: variable.resolvedType, variableCollectionId: variable.variableCollectionId,
    });
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_VARIABLE_CREATE_BATCH_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Batch Creation result exceeded the bounded result limit.');
      }
      return serialized;
    };
    const equivalent = (actual, expected) => {
      if (typeof actual === 'number' && typeof expected === 'number') {
        return Number.isFinite(actual) && Number.isFinite(expected)
          && (Object.is(actual, expected) || Math.fround(actual) === Math.fround(expected));
      }
      if (actual === null || expected === null || typeof actual !== 'object'
        || typeof expected !== 'object') return Object.is(actual, expected);
      if (Array.isArray(actual) !== Array.isArray(expected)) return false;
      const actualKeys = Object.keys(actual).sort();
      const expectedKeys = Object.keys(expected).sort();
      if (expectedKeys.length === 1 && expectedKeys[0] === 'type'
        && typeof expected.type === 'string' && actual.type === expected.type) {
        if (actualKeys.length === 1) return true;
        if (actualKeys.length !== 2) return false;
        if (actualKeys.includes('easingFunctionCubicBezier')) {
          const curve = actual.easingFunctionCubicBezier;
          return curve && typeof curve === 'object' && !Array.isArray(curve)
            && Object.keys(curve).sort().join(',') === 'x1,x2,y1,y2'
            && Number.isFinite(curve.x1) && curve.x1 >= 0 && curve.x1 <= 1
            && Number.isFinite(curve.x2) && curve.x2 >= 0 && curve.x2 <= 1
            && Number.isFinite(curve.y1) && Number.isFinite(curve.y2);
        }
        const spring = actual.easingFunctionSpring;
        return spring && typeof spring === 'object' && !Array.isArray(spring)
          && Object.keys(spring).join(',') === 'bounce'
          && Number.isFinite(spring.bounce) && spring.bounce >= 0 && spring.bounce <= 1;
      }
      return actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key === expectedKeys[index]
          && equivalent(actual[key], expected[key]));
    };
    const journal = [];
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const variable = figma.variables.createVariable(item.name, collection, item.type);
        const nativeMetadata = {
          description: variable.description,
          hiddenFromPublishing: variable.hiddenFromPublishing,
          scopes: Array.isArray(variable.scopes) ? [...variable.scopes] : null,
        };
        journal.push({ variable, index, nativeMetadata });
        if (Object.prototype.hasOwnProperty.call(item, 'value')) {
          variable.setValueForMode(mode.modeId, item.value);
        }
        if (Object.prototype.hasOwnProperty.call(item, 'description')) {
          variable.description = item.description;
        }
        if (Object.prototype.hasOwnProperty.call(item, 'hidden')) {
          variable.hiddenFromPublishing = item.hidden;
        }
        if (Object.prototype.hasOwnProperty.call(item, 'scopes')) {
          variable.scopes = [...item.scopes];
        }
      }
      const after = await figma.variables.getLocalVariablesAsync();
      if (!Array.isArray(after) || after.length > ${MAX_VARIABLE_CREATE_BATCH_CANDIDATES}) {
        throw new Error('Variable Batch Creation verification catalog was unavailable.');
      }
      const afterById = new Map();
      for (const variable of after) {
        if (!validText(variable.id, false) || afterById.has(variable.id)) {
          throw new Error('Variable Batch Creation verification returned invalid identities.');
        }
        afterById.set(variable.id, variable);
      }
      const created = [];
      for (const entry of journal) {
        const item = items[entry.index];
        const variable = afterById.get(entry.variable.id);
        if (!variable || variable.name !== item.name || variable.resolvedType !== item.type
          || variable.remote || variable.variableCollectionId !== collection.id
          || !variable.valuesByMode || typeof variable.valuesByMode !== 'object') {
          throw new Error('Variable Batch Creation encountered incompatible created identity.');
        }
        const expectedDescription = Object.prototype.hasOwnProperty.call(item, 'description')
          ? item.description : entry.nativeMetadata.description;
        const expectedHidden = Object.prototype.hasOwnProperty.call(item, 'hidden')
          ? item.hidden : entry.nativeMetadata.hiddenFromPublishing;
        const expectedScopes = Object.prototype.hasOwnProperty.call(item, 'scopes')
          ? item.scopes : entry.nativeMetadata.scopes;
        const allowedScopes = scopeOptions[item.type] || ['ALL_SCOPES'];
        const validScopeSet = Array.isArray(variable.scopes)
          && new Set(variable.scopes).size === variable.scopes.length
          && (!variable.scopes.includes('ALL_SCOPES') || variable.scopes.length === 1)
          && variable.scopes.every((scope) => allowedScopes.includes(scope));
        if (typeof expectedDescription !== 'string'
          || expectedDescription.length > ${MAX_VARIABLE_DESCRIPTION_CODE_UNITS}
          || variable.description !== expectedDescription
          || typeof expectedHidden !== 'boolean'
          || variable.hiddenFromPublishing !== expectedHidden
          || !Array.isArray(expectedScopes) || !validScopeSet
          || !Array.isArray(variable.scopes)
          || variable.scopes.length !== expectedScopes.length
          || variable.scopes.some((scope, index) => scope !== expectedScopes[index])) {
          throw new Error('Variable Batch Creation encountered incompatible created metadata.');
        }
        const observedModeIds = Object.keys(variable.valuesByMode);
        if (observedModeIds.length > collection.modes.length
          || observedModeIds.some((modeId) => !collection.modes.some((item) => item.modeId === modeId))) {
          throw new Error('Variable Batch Creation encountered invalid native mode values.');
        }
        const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
        const stored = Object.prototype.hasOwnProperty.call(variable.valuesByMode, mode.modeId);
        if (hasValue && (!stored
          || !equivalent(variable.valuesByMode[mode.modeId], item.value))) {
          throw new Error('Variable Batch Creation encountered incompatible initial value.');
        }
        created.push({
          ...compact(variable, entry.index),
          metadata: {
            description: variable.description,
            hiddenFromPublishing: variable.hiddenFromPublishing,
            scopes: [...variable.scopes],
          },
          modeValue: {
            modeId: mode.modeId,
            source: hasValue ? 'requested-initial' : (stored ? 'native-default' : 'absent'),
            stored,
            value: stored ? variable.valuesByMode[mode.modeId] : null,
          },
          observedModeCount: observedModeIds.length,
        });
      }
      return bounded({
        schemaVersion: 1, status: 'created', collection: {
          query: collectionQuery, id: collection.id, name: collection.name,
          resolution: directCollections.length ? 'id' : 'name',
        }, mode: { query: modeQuery, modeId: mode.modeId, name: mode.name, resolution: modeResolution },
        created, duplicateCountBefore, residue: [],
      });
    } catch (error) {
      if (!journal.length) throw error;
      const attempted = journal.map((entry) => compact(entry.variable, entry.index));
      for (let index = journal.length - 1; index >= 0; index--) {
        try { journal[index].variable.remove(); } catch {}
      }
      let after;
      try { after = await figma.variables.getLocalVariablesAsync(); } catch {}
      if (!Array.isArray(after) || after.length > ${MAX_VARIABLE_CREATE_BATCH_CANDIDATES}) {
        return bounded({
          schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
          attempted, removed: [], residue: attempted, residueTruncated: false,
        });
      }
      const remainingIds = new Set();
      const validAfter = after.every((variable) => validText(variable.id, false)
        && !remainingIds.has(variable.id) && !!remainingIds.add(variable.id));
      if (!validAfter) {
        return bounded({
          schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
          attempted, removed: [], residue: attempted, residueTruncated: false,
        });
      }
      const residue = attempted.filter((item) => remainingIds.has(item.id));
      const removed = attempted.filter((item) => !remainingIds.has(item.id));
      return bounded({
        schemaVersion: 1, status: 'failed',
        outcome: residue.length ? 'partial-residue' : 'rolled-back',
        attempted, removed, residue, residueTruncated: false,
      });
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_VARIABLE_CREATE_BATCH_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function validTarget(value, input) {
  return exactKeys(value, ['index', 'id', 'name', 'resolvedType', 'variableCollectionId'])
    && Number.isSafeInteger(value.index) && value.index >= 0 && value.index < input.items.length
    && boundedString(value.id, { empty: false })
    && value.name === input.items[value.index].name
    && value.resolvedType === input.items[value.index].type
    && boundedString(value.variableCollectionId, { empty: false });
}

function uniqueTargets(values, input) {
  return Array.isArray(values) && values.length <= MAX_VARIABLE_CREATE_BATCH_ITEMS
    && values.every((value) => validTarget(value, input))
    && new Set(values.map((value) => value.id)).size === values.length
    && new Set(values.map((value) => value.index)).size === values.length;
}

function validObservedValue(value, type) {
  try { return isDeepStrictEqual(normalizeVariableValue(value, type), value); }
  catch { return false; }
}

function equivalent(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Number.isFinite(actual) && Number.isFinite(expected)
      && (Object.is(actual, expected) || Math.fround(actual) === Math.fround(expected));
  }
  if (actual === null || expected === null || typeof actual !== 'object'
    || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (expectedKeys.length === 1 && expectedKeys[0] === 'type'
    && typeof expected.type === 'string' && actual.type === expected.type) {
    if (actualKeys.length === 1) return true;
    if (actualKeys.length !== 2) return false;
    if (actualKeys.includes('easingFunctionCubicBezier')) {
      const curve = actual.easingFunctionCubicBezier;
      return curve && typeof curve === 'object' && !Array.isArray(curve)
        && Object.keys(curve).sort().join(',') === 'x1,x2,y1,y2'
        && Number.isFinite(curve.x1) && curve.x1 >= 0 && curve.x1 <= 1
        && Number.isFinite(curve.x2) && curve.x2 >= 0 && curve.x2 <= 1
        && Number.isFinite(curve.y1) && Number.isFinite(curve.y2);
    }
    const spring = actual.easingFunctionSpring;
    return spring && typeof spring === 'object' && !Array.isArray(spring)
      && Object.keys(spring).join(',') === 'bounce'
      && Number.isFinite(spring.bounce) && spring.bounce >= 0 && spring.bounce <= 1;
  }
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]
      && equivalent(actual[key], expected[key]));
}

function validCreatedTarget(value, input) {
  if (!exactKeys(value, [
    'index', 'id', 'name', 'resolvedType', 'variableCollectionId',
    'metadata', 'modeValue', 'observedModeCount',
  ])) return false;
  const target = {
    index: value.index, id: value.id, name: value.name,
    resolvedType: value.resolvedType, variableCollectionId: value.variableCollectionId,
  };
  if (!validTarget(target, input)
    || !Number.isSafeInteger(value.observedModeCount) || value.observedModeCount < 0
    || value.observedModeCount > MAX_VARIABLE_CREATE_BATCH_MODES
    || !exactKeys(value.modeValue, ['modeId', 'source', 'stored', 'value'])
    || typeof value.modeValue.stored !== 'boolean'
    || !boundedString(value.modeValue.modeId, { empty: false })) return false;
  const item = input.items[value.index];
  let normalizedScopes;
  try { normalizedScopes = normalizeVariableScopes(value.metadata?.scopes, item.type); }
  catch { return false; }
  if (!exactKeys(value.metadata, ['description', 'hiddenFromPublishing', 'scopes'])
    || typeof value.metadata.description !== 'string'
    || value.metadata.description.length > MAX_VARIABLE_DESCRIPTION_CODE_UNITS
    || typeof value.metadata.hiddenFromPublishing !== 'boolean'
    || !isDeepStrictEqual(normalizedScopes, value.metadata.scopes)
    || (item.description !== undefined && value.metadata.description !== item.description)
    || (item.hidden !== undefined && value.metadata.hiddenFromPublishing !== item.hidden)
    || (item.scopes !== undefined && !isDeepStrictEqual(value.metadata.scopes, item.scopes))) {
    return false;
  }
  const hasValue = Object.prototype.hasOwnProperty.call(item, 'value');
  if (!value.modeValue.stored) {
    return !hasValue && value.modeValue.source === 'absent' && value.modeValue.value === null;
  }
  if (value.observedModeCount < 1
    || !validObservedValue(value.modeValue.value, item.type)) return false;
  return hasValue
    ? value.modeValue.source === 'requested-initial'
      && equivalent(value.modeValue.value, item.value)
    : value.modeValue.source === 'native-default';
}

function uniqueCreatedTargets(values, input) {
  return Array.isArray(values) && values.length <= MAX_VARIABLE_CREATE_BATCH_ITEMS
    && values.every((value) => validCreatedTarget(value, input))
    && new Set(values.map((value) => value.id)).size === values.length
    && new Set(values.map((value) => value.index)).size === values.length;
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'collection', 'mode', 'created',
    'duplicateCountBefore', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'created'
    && exactKeys(value.collection, ['query', 'id', 'name', 'resolution'])
    && value.collection.query === input.collection
    && boundedString(value.collection.id, { empty: false })
    && boundedString(value.collection.name)
    && ['id', 'name'].includes(value.collection.resolution)
    && (value.collection.resolution === 'id'
      ? value.collection.id === input.collection : value.collection.name === input.collection)
    && exactKeys(value.mode, ['query', 'modeId', 'name', 'resolution'])
    && value.mode.query === input.mode && boundedString(value.mode.modeId, { empty: false })
    && boundedString(value.mode.name) && ['default', 'id', 'name'].includes(value.mode.resolution)
    && (input.mode === null ? value.mode.resolution === 'default'
      : (value.mode.resolution === 'id' ? value.mode.modeId === input.mode
        : value.mode.resolution === 'name'
          && value.mode.name.toLowerCase().includes(input.mode.toLowerCase())))
    && uniqueCreatedTargets(value.created, input) && value.created.length === input.items.length
    && value.created.every((target) => target.modeValue.modeId === value.mode.modeId)
    && value.created.every((target) => target.variableCollectionId === value.collection.id)
    && Number.isSafeInteger(value.duplicateCountBefore) && value.duplicateCountBefore >= 0
    && value.duplicateCountBefore <= MAX_VARIABLE_CREATE_BATCH_CANDIDATES * input.items.length
    && (input.allowDuplicate || value.duplicateCountBefore === 0)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function exactPartition(attempted, removed, residue) {
  const combined = [...removed, ...residue];
  return combined.length === attempted.length
    && attempted.every((target) => combined.some((item) => item.id === target.id
      && item.index === target.index && item.name === target.name
      && item.resolvedType === target.resolvedType
      && item.variableCollectionId === target.variableCollectionId));
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'removed', 'residue', 'residueTruncated',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !uniqueTargets(value.attempted, input) || value.attempted.length < 1
    || !uniqueTargets(value.removed, input) || !uniqueTargets(value.residue, input)
    || !exactPartition(value.attempted, value.removed, value.residue)
    || value.residueTruncated !== false) return false;
  if (value.outcome === 'rolled-back') {
    return value.removed.length === value.attempted.length && value.residue.length === 0;
  }
  if (value.outcome === 'partial-residue') {
    return value.removed.length < value.attempted.length && value.residue.length > 0;
  }
  return value.removed.length === 0 && isDeepStrictEqual(value.residue, value.attempted);
}

function mutationFailure(payload) {
  const messages = {
    'rolled-back': 'Variable Batch Creation failed; every created Variable was removed.',
    'partial-residue': 'Variable Batch Creation failed; one or more created Variables remain.',
    'verification-unavailable': 'Variable Batch Creation failed after dispatch; complete cleanup verification is unavailable.',
  };
  const error = new Error(messages[payload.outcome]);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.mutationReport = {
    version: 1, outcome: payload.outcome,
    created: payload.attempted.length,
    removed: payload.removed.length,
    residueCount: payload.residue.length,
    residue: payload.residue.map((item) => ({
      kind: 'variable', handle: item.id,
      reason: payload.outcome === 'verification-unavailable' ? 'verification-unavailable' : 'remove-failed',
    })),
    residueTruncated: false,
  };
  throw error;
}

export async function executeVariableCreateBatch(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableCreateBatch requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableCreateBatchCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_CREATE_BATCH_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Batch Creation returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Batch Creation returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Variable Batch Creation returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Variable Batch Creation returned an invalid bounded result.');
  }
  return {
    stdout: `Created ${payload.created.length} variables`,
    stderr: '',
    result: payload,
  };
}

export function variableCreateBatchPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Batch Creation routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_CREATE_BATCH_APPLICATION_ID
    ? 'command-application' : 'not-variable-create-batch';
}

export async function executeVariableCreateBatchPlan(plan, adapters = {}) {
  if (variableCreateBatchPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Batch Creation.`);
  }
  return executeVariableCreateBatch(parseVariableCreateBatchRequest(plan.argv), adapters);
}
