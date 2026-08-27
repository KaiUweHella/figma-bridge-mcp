// Bounded, journaled Variable Create Command Application.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_VARIABLE_DESCRIPTION_CODE_UNITS,
  normalizeVariableScopes,
  normalizeVariableValue,
} from '../lib/variable-management.js';
import { VARIABLE_SCOPES_BY_TYPE } from '../lib/variable-scope-policy.js';
import {
  parseVariableCreateRequest,
  variableCreateArgvFromRequest,
  variableCreatePlanningArgvFromRequest,
} from './variable-create-request.js';

export { variableCreateArgvFromRequest, variableCreatePlanningArgvFromRequest } from './variable-create-request.js';

const VARIABLE_CREATE_APPLICATION_ID = 'var.create';
export const MAX_VARIABLE_CREATE_CANDIDATES = 100_000;
export const MAX_VARIABLE_CREATE_SERIALIZED_CODE_UNITS = 131_072;
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
    const hasDescription = ${input.description !== undefined};
    const nextDescription = ${JSON.stringify(input.description ?? null)};
    const hasHidden = ${input.hidden !== undefined};
    const nextHidden = ${JSON.stringify(input.hidden ?? null)};
    const hasScopes = ${input.scopes !== undefined};
    const nextScopes = ${JSON.stringify(input.scopes ?? null)};
    const allowDuplicate = ${input.allowDuplicate};
    const scopeOptions = ${JSON.stringify(VARIABLE_SCOPES_BY_TYPE)};
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
    const nativeDescription = variable.description;
    const nativeScopes = Array.isArray(variable.scopes) ? [...variable.scopes] : null;
    const nativeHiddenFromPublishing = variable.hiddenFromPublishing;
    const expectedDescription = hasDescription ? nextDescription : nativeDescription;
    const expectedScopes = hasScopes ? [...nextScopes] : nativeScopes;
    const expectedHiddenFromPublishing = hasHidden ? nextHidden : nativeHiddenFromPublishing;
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
    try {
      if (hasInitialValue) variable.setValueForMode(collection.defaultModeId, initialValue);
      if (hasDescription) variable.description = nextDescription;
      if (hasHidden) variable.hiddenFromPublishing = nextHidden;
      if (hasScopes) variable.scopes = [...nextScopes];
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
      const allowedScopes = scopeOptions[type] || ['ALL_SCOPES'];
      const validScopeSet = Array.isArray(verifiedVariable?.scopes)
        && new Set(verifiedVariable.scopes).size === verifiedVariable.scopes.length
        && (!verifiedVariable.scopes.includes('ALL_SCOPES')
          || verifiedVariable.scopes.length === 1)
        && verifiedVariable.scopes.every((scope) => allowedScopes.includes(scope));
      if (typeof created.id !== 'string' || created.id.length < 1
        || created.id.length > ${MAX_VARIABLE_CREATE_STRING_CODE_UNITS}
        || !(created.key === null || (typeof created.key === 'string'
          && created.key.length <= ${MAX_VARIABLE_CREATE_STRING_CODE_UNITS}))
        || created.name !== name || created.resolvedType !== type || created.remote !== false
        || created.variableCollectionId !== collection.id) {
        throw new Error('Variable Create encountered invalid created identity.');
      }
      if (typeof expectedDescription !== 'string'
        || expectedDescription.length > ${MAX_VARIABLE_DESCRIPTION_CODE_UNITS}
        || verifiedVariable.description !== expectedDescription
        || !expectedScopes || !validScopeSet
        || expectedScopes.length > ${MAX_VARIABLE_CREATE_MODES}
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
      const observedModeIds = Object.keys(verifiedVariable.valuesByMode);
      if (observedModeIds.length > collection.modes.length
        || observedModeIds.some((modeId) => !collection.modes.some((mode) => mode.modeId === modeId))) {
        throw new Error('Variable Create encountered invalid native mode values.');
      }
      const stored = Object.prototype.hasOwnProperty.call(
        verifiedVariable.valuesByMode, collection.defaultModeId);
      if (hasInitialValue && (!stored
        || !equivalent(verifiedVariable.valuesByMode[collection.defaultModeId], initialValue))) {
        throw new Error('Variable Create could not verify the initial value.');
      }
      const modeValue = {
        modeId: collection.defaultModeId,
        source: hasInitialValue ? 'requested-initial' : (stored ? 'native-default' : 'absent'),
        stored,
        value: stored ? verifiedVariable.valuesByMode[collection.defaultModeId] : null,
      };
      const payload = {
        schemaVersion: 1, status: 'created', variable: created,
        collection: { id: collection.id, name: collection.name, modeId: collection.defaultModeId },
        metadata: {
          description: verifiedVariable.description,
          hiddenFromPublishing: verifiedVariable.hiddenFromPublishing,
          scopes: [...verifiedVariable.scopes],
        },
        initialValueSet: hasInitialValue, modeValue, observedModeCount: observedModeIds.length,
        duplicateCountBefore: duplicates.length, residue: [],
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

function validObservedValue(value, type) {
  try { return isDeepStrictEqual(normalizeVariableValue(value, type), value); }
  catch { return false; }
}

function validModeValue(value, input, collection) {
  if (!exactKeys(value, ['modeId', 'source', 'stored', 'value'])
    || value.modeId !== collection.modeId || typeof value.stored !== 'boolean') return false;
  if (!value.stored) {
    return input.value === undefined && value.source === 'absent' && value.value === null;
  }
  if (!validObservedValue(value.value, input.type)) return false;
  if (input.value === undefined) return value.source === 'native-default';
  return value.source === 'requested-initial' && equivalent(value.value, input.value);
}

function validMetadata(value, input) {
  let normalizedScopes;
  try { normalizedScopes = normalizeVariableScopes(value?.scopes, input.type); }
  catch { return false; }
  return exactKeys(value, ['description', 'hiddenFromPublishing', 'scopes'])
    && typeof value.description === 'string'
    && value.description.length <= MAX_VARIABLE_DESCRIPTION_CODE_UNITS
    && typeof value.hiddenFromPublishing === 'boolean'
    && Array.isArray(value.scopes) && value.scopes.length <= MAX_VARIABLE_CREATE_MODES
    && isDeepStrictEqual(normalizedScopes, value.scopes)
    && (input.description === undefined || value.description === input.description)
    && (input.hidden === undefined || value.hiddenFromPublishing === input.hidden)
    && (input.scopes === undefined || isDeepStrictEqual(value.scopes, input.scopes));
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'variable', 'collection', 'metadata', 'initialValueSet', 'modeValue',
    'observedModeCount', 'duplicateCountBefore', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'created'
    && validIdentity(value.variable, input, { created: true })
    && exactKeys(value.collection, ['id', 'name', 'modeId'])
    && boundedString(value.collection.id, { empty: false })
    && boundedString(value.collection.name)
    && boundedString(value.collection.modeId, { empty: false })
    && value.variable.variableCollectionId === value.collection.id
    && validMetadata(value.metadata, input)
    && value.initialValueSet === (input.value !== undefined)
    && validModeValue(value.modeValue, input, value.collection)
    && Number.isSafeInteger(value.observedModeCount) && value.observedModeCount >= 0
    && value.observedModeCount <= MAX_VARIABLE_CREATE_MODES
    && value.observedModeCount >= (value.modeValue.stored ? 1 : 0)
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
