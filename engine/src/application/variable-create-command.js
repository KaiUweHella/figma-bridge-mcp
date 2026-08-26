// Bounded, journaled Variable Create Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseVariableCreateRequest,
  variableCreateArgvFromRequest,
  variableCreatePlanningArgvFromRequest,
} from './variable-create-request.js';

export { variableCreateArgvFromRequest, variableCreatePlanningArgvFromRequest } from './variable-create-request.js';

const VARIABLE_CREATE_APPLICATION_ID = 'var.create';
export const MAX_VARIABLE_CREATE_CANDIDATES = 100_000;
export const MAX_VARIABLE_CREATE_SERIALIZED_CODE_UNITS = 32_768;
const MAX_VARIABLE_CREATE_STRING_CODE_UNITS = 1024;
const MAX_VARIABLE_CREATE_MODES = 1_000;
const VARIABLE_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);

function normalizedRequest(request) {
  return parseVariableCreateRequest(variableCreateArgvFromRequest(request));
}

export function variableCreateCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const name = ${JSON.stringify(input.name)};
    const collectionQuery = ${JSON.stringify(input.collection)};
    const type = ${JSON.stringify(input.type)};
    const hasInitialValue = ${input.value !== undefined};
    const initialValue = ${input.value === undefined ? 'null' : JSON.stringify(input.value)};
    const allowDuplicate = ${input.allowDuplicate};
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(collections) || collections.length > ${MAX_VARIABLE_CREATE_CANDIDATES}) {
      throw new Error('Variable Create candidate limit exceeded.');
    }
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_VARIABLE_CREATE_STRING_CODE_UNITS} && (empty || value.length > 0);
    const byId = collections.filter((collection) => collection.id === collectionQuery);
    const byName = collections.filter((collection) => collection.name === collectionQuery);
    const matches = byId.length ? byId : byName;
    if (matches.length > 1) throw new Error('Variable Collection is ambiguous; use its id.');
    if (matches.length === 0) throw new Error('Variable Collection not found.');
    const collection = matches[0];
    if (collection.remote) throw new Error('Remote Variable Collections cannot receive local Variables.');
    if (typeof collection.id !== 'string' || collection.id.length < 1
      || collection.id.length > ${MAX_VARIABLE_CREATE_STRING_CODE_UNITS}
      || typeof collection.name !== 'string'
      || collection.name.length > ${MAX_VARIABLE_CREATE_STRING_CODE_UNITS}
      || typeof collection.defaultModeId !== 'string' || collection.defaultModeId.length < 1
      || collection.defaultModeId.length > ${MAX_VARIABLE_CREATE_STRING_CODE_UNITS}
      || !Array.isArray(collection.modes) || collection.modes.length < 1
      || collection.modes.length > ${MAX_VARIABLE_CREATE_MODES}
      || !collection.modes.some((mode) => mode && mode.modeId === collection.defaultModeId)
      || !Array.isArray(collection.variableIds)
      || collection.variableIds.length > ${MAX_VARIABLE_CREATE_CANDIDATES}
      || collection.variableIds.some((id) => !validText(id, false))
      || new Set(collection.variableIds).size !== collection.variableIds.length) {
      throw new Error('Variable Collection returned invalid bounded identity.');
    }
    const collectionVariables = [];
    for (let start = 0; start < collection.variableIds.length; start += 64) {
      collectionVariables.push(...await Promise.all(collection.variableIds.slice(start, start + 64)
        .map((id) => figma.variables.getVariableByIdAsync(id))));
    }
    if (collectionVariables.some((variable, index) => !variable
      || variable.id !== collection.variableIds[index] || !validText(variable.name)
      || variable.remote || variable.variableCollectionId !== collection.id)) {
      throw new Error('Variable Create could not load exact Collection Variable membership.');
    }
    const duplicates = collectionVariables.filter((variable) => variable.name === name);
    if (duplicates.length && !allowDuplicate) {
      throw new Error('A Variable with this exact name already exists in the Collection. Use its id or pass --allow-duplicate intentionally.');
    }
    const variable = figma.variables.createVariable(name, collection, type);
    const identity = (candidate = variable) => ({
      id: candidate.id,
      key: candidate.key || null,
      name: candidate.name,
      resolvedType: candidate.resolvedType,
      remote: !!candidate.remote,
      variableCollectionId: candidate.variableCollectionId,
    });
    const createdId = variable.id;
    const expectedScopes = Array.isArray(variable.scopes) ? [...variable.scopes] : null;
    const expectedHiddenFromPublishing = variable.hiddenFromPublishing;
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
      return actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key === expectedKeys[index]
          && equivalent(actual[key], expected[key]));
    };
    try {
      if (hasInitialValue) variable.setValueForMode(collection.defaultModeId, initialValue);
      const [verifiedCollection, verifiedVariable] = await Promise.all([
        figma.variables.getVariableCollectionByIdAsync(collection.id),
        figma.variables.getVariableByIdAsync(createdId),
      ]);
      if (!verifiedCollection || verifiedCollection.id !== collection.id
        || verifiedCollection.defaultModeId !== collection.defaultModeId
        || !Array.isArray(verifiedCollection.variableIds)
        || verifiedCollection.variableIds.length > ${MAX_VARIABLE_CREATE_CANDIDATES}
        || verifiedCollection.variableIds.some((id) => !validText(id, false))
        || new Set(verifiedCollection.variableIds).size !== verifiedCollection.variableIds.length
        || !verifiedCollection.variableIds.includes(createdId)) {
        throw new Error('Variable Create could not verify Collection membership.');
      }
      const created = identity(verifiedVariable || {});
      if (typeof created.id !== 'string' || created.id.length < 1
        || created.id.length > ${MAX_VARIABLE_CREATE_STRING_CODE_UNITS}
        || !(created.key === null || (typeof created.key === 'string'
          && created.key.length <= ${MAX_VARIABLE_CREATE_STRING_CODE_UNITS}))
        || created.name !== name || created.resolvedType !== type || created.remote !== false
        || created.variableCollectionId !== collection.id) {
        throw new Error('Variable Create encountered invalid created identity.');
      }
      if (!expectedScopes || expectedScopes.length > ${MAX_VARIABLE_CREATE_MODES}
        || expectedScopes.some((scope) => !validText(scope, false))
        || !Array.isArray(verifiedVariable.scopes)
        || verifiedVariable.scopes.length !== expectedScopes.length
        || verifiedVariable.scopes.some((scope, index) => scope !== expectedScopes[index])
        || typeof expectedHiddenFromPublishing !== 'boolean'
        || verifiedVariable.hiddenFromPublishing !== expectedHiddenFromPublishing
        || !verifiedVariable.valuesByMode || typeof verifiedVariable.valuesByMode !== 'object'
        || Array.isArray(verifiedVariable.valuesByMode)) {
        throw new Error('Variable Create encountered invalid created metadata.');
      }
      const stored = Object.prototype.hasOwnProperty.call(
        verifiedVariable.valuesByMode, collection.defaultModeId);
      if (hasInitialValue !== stored || (hasInitialValue
        && !equivalent(verifiedVariable.valuesByMode[collection.defaultModeId], initialValue))) {
        throw new Error('Variable Create could not verify the initial value.');
      }
      const payload = {
        schemaVersion: 1, status: 'created', variable: created,
        collection: { id: collection.id, name: collection.name, modeId: collection.defaultModeId },
        initialValueSet: hasInitialValue, duplicateCountBefore: duplicates.length, residue: [],
      };
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_VARIABLE_CREATE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Create result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      let cleanup = 'removed';
      try {
        variable.remove();
        const cleanupCollection = await figma.variables.getVariableCollectionByIdAsync(collection.id);
        if (!cleanupCollection || !Array.isArray(cleanupCollection.variableIds)
          || cleanupCollection.variableIds.length > ${MAX_VARIABLE_CREATE_CANDIDATES}
          || cleanupCollection.variableIds.some((id) => !validText(id, false))
          || new Set(cleanupCollection.variableIds).size !== cleanupCollection.variableIds.length
          || cleanupCollection.variableIds.includes(createdId)) cleanup = 'partial-residue';
      } catch { cleanup = 'partial-residue'; }
      const payload = {
        schemaVersion: 1, status: 'mutation-failed', cleanup,
        residue: cleanup === 'removed' ? [] : [identity()],
      };
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_VARIABLE_CREATE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Create failure evidence exceeded the result limit.');
      }
      return serialized;
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_VARIABLE_CREATE_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function validIdentity(value, input, { created = false } = {}) {
  return exactKeys(value, [
    'id', 'key', 'name', 'resolvedType', 'remote', 'variableCollectionId',
  ]) && boundedString(value.id, { empty: false })
    && (value.key === null || boundedString(value.key))
    && boundedString(value.name)
    && VARIABLE_TYPES.has(value.resolvedType)
    && value.remote === false
    && boundedString(value.variableCollectionId, { empty: false })
    && (!created || (value.name === input.name && value.resolvedType === input.type));
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'variable', 'collection', 'initialValueSet',
    'duplicateCountBefore', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'created'
    && validIdentity(value.variable, input, { created: true })
    && exactKeys(value.collection, ['id', 'name', 'modeId'])
    && boundedString(value.collection.id, { empty: false })
    && boundedString(value.collection.name)
    && boundedString(value.collection.modeId, { empty: false })
    && value.variable.variableCollectionId === value.collection.id
    && value.initialValueSet === (input.value !== undefined)
    && Number.isSafeInteger(value.duplicateCountBefore) && value.duplicateCountBefore >= 0
    && value.duplicateCountBefore <= MAX_VARIABLE_CREATE_CANDIDATES
    && (input.allowDuplicate || value.duplicateCountBefore === 0)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'cleanup', 'residue'])
    && value.schemaVersion === 1 && value.status === 'mutation-failed'
    && ['removed', 'partial-residue'].includes(value.cleanup)
    && Array.isArray(value.residue)
    && (value.cleanup === 'removed'
      ? value.residue.length === 0
      : value.residue.length === 1 && validIdentity(value.residue[0], input));
}

function safeText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '�');
}

function mutationFailure(payload) {
  const removed = payload.cleanup === 'removed';
  const error = new Error(removed
    ? 'Variable Create failed after creation; the created Variable was removed.'
    : 'Variable Create failed after creation; one created Variable may remain.');
  const residue = removed ? [] : [{
    kind: 'variable', handle: payload.residue[0].id, reason: 'remove-failed',
  }];
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = removed ? 'rolled-back' : 'partial-residue';
  error.mutationReport = {
    version: 1,
    outcome: error.mutationOutcome,
    created: 1,
    removed: removed ? 1 : 0,
    residueCount: residue.length,
    residue,
    residueTruncated: false,
  };
  throw error;
}

export async function executeVariableCreate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableCreate requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableCreateCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_CREATE_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Create returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Create returned invalid JSON.'); }
  if (payload?.status === 'mutation-failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Variable Create returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Variable Create returned an invalid bounded result.');
  }
  return {
    stdout: `Created ${input.type.toLowerCase()} variable: ${safeText(payload.variable.name)}`,
    stderr: '',
    result: payload,
  };
}

export function variableCreatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Create routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_CREATE_APPLICATION_ID
    ? 'command-application' : 'not-variable-create';
}

export async function executeVariableCreatePlan(plan, adapters = {}) {
  if (variableCreatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Create.`);
  }
  return executeVariableCreate(parseVariableCreateRequest(plan.argv), adapters);
}
