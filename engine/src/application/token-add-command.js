// Bounded, journaled single Token Add Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  variableScopeDecision,
  variableScopesForToken,
} from '../lib/variable-scope-policy.js';
import {
  parseTokenAddRequest,
  tokenAddArgvFromRequest,
  tokenAddPlanningArgvFromRequest,
} from './token-add-request.js';

export { tokenAddArgvFromRequest, tokenAddPlanningArgvFromRequest } from './token-add-request.js';

const APPLICATION_ID = 'tokens.add';
const MAX_CANDIDATES = 100_000;
const MAX_MODES = 1_000;
const MAX_STRING = 16_384;
export const MAX_TOKEN_ADD_SERIALIZED_CODE_UNITS = 65_536;

function normalizedRequest(request) {
  return parseTokenAddRequest(tokenAddArgvFromRequest(request));
}

export function tokenAddCommandCode(request) {
  const input = normalizedRequest(request);
  const automaticScopes = variableScopesForToken(input.name, input.type);
  const expectedScopes = automaticScopes || ['ALL_SCOPES'];
  return `(async () => {
    const input = ${JSON.stringify(input)};
    const automaticScopes = ${JSON.stringify(automaticScopes)};
    const expectedScopes = ${JSON.stringify(expectedScopes)};
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_STRING} && (empty || value.length > 0);
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_TOKEN_ADD_SERIALIZED_CODE_UNITS}) {
        throw new Error('Token Add result exceeded the bounded result limit.');
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
      return actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key === expectedKeys[index]
          && equivalent(actual[key], expected[key]));
    };
    const valueEquivalent = (actual, expected) => {
      if (input.type !== 'COLOR') return equivalent(actual, expected);
      const validColor = (value) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).every((key) => ['r', 'g', 'b', 'a'].includes(key))
        && ['r', 'g', 'b'].every((key) => Object.prototype.hasOwnProperty.call(value, key));
      if (!validColor(actual) || !validColor(expected)) return false;
      return ['r', 'g', 'b'].every((key) => equivalent(actual[key], expected[key]))
        && equivalent(Object.prototype.hasOwnProperty.call(actual, 'a') ? actual.a : 1,
          Object.prototype.hasOwnProperty.call(expected, 'a') ? expected.a : 1);
    };
    const beforeCollections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(beforeCollections) || beforeCollections.length > ${MAX_CANDIDATES}
      || beforeCollections.some((collection) => !collection
        || !validText(collection.id, false) || !validText(collection.name))) {
      throw new Error('Token Add encountered an invalid Collection catalog.');
    }
    if (new Set(beforeCollections.map((collection) => collection.id)).size
      !== beforeCollections.length) {
      throw new Error('Token Add encountered duplicate native Collection identities.');
    }
    const matches = beforeCollections.filter((collection) => collection.name === input.collection);
    if (matches.length > 1) throw new Error('Token Add Collection name is ambiguous.');
    const validateCollection = (collection) => {
      if (!collection || !validText(collection.id, false)
        || collection.name !== input.collection || collection.remote
        || !validText(collection.defaultModeId, false)
        || !Array.isArray(collection.modes) || collection.modes.length < 1
        || collection.modes.length > ${MAX_MODES}
        || collection.modes.some((mode) => !mode || !validText(mode.modeId, false)
          || !validText(mode.name))
        || new Set(collection.modes.map((mode) => mode.modeId)).size !== collection.modes.length
        || !collection.modes.some((mode) => mode.modeId === collection.defaultModeId)
        || !Array.isArray(collection.variableIds)
        || collection.variableIds.length > ${MAX_CANDIDATES}
        || collection.variableIds.some((id) => !validText(id, false))
        || new Set(collection.variableIds).size !== collection.variableIds.length) {
        throw new Error('Token Add encountered invalid Collection metadata.');
      }
      return collection;
    };
    const loadVariables = async (ids) => {
      const loaded = [];
      for (let start = 0; start < ids.length; start += 64) {
        loaded.push(...await Promise.all(ids.slice(start, start + 64)
          .map((id) => figma.variables.getVariableByIdAsync(id))));
      }
      return loaded;
    };
    let collection = matches[0] ? validateCollection(matches[0]) : null;
    const beforeVariables = collection ? await loadVariables(collection.variableIds) : [];
    if (beforeVariables.some((variable, index) => !variable
      || variable.id !== collection.variableIds[index]
      || !validText(variable.name) || variable.remote
      || variable.variableCollectionId !== collection.id)) {
      throw new Error('Token Add could not load exact Collection Variable membership.');
    }
    const duplicateCountBefore = beforeVariables.filter((variable) =>
      variable.name === input.name).length;
    if (duplicateCountBefore && !input.allowDuplicate) {
      throw new Error('A token with this exact name already exists in the Collection. Pass --allow-duplicate intentionally.');
    }
    const journal = [];
    const journaled = (kind, resource, name) => {
      if (!resource || typeof resource.remove !== 'function' || !validText(resource.id, false)
        || journal.some((entry) => entry.id === resource.id)) {
        try { resource?.remove?.(); } catch {}
        throw new Error('Token Add factory returned invalid native identity.');
      }
      journal.push({ kind, resource, id: resource.id, name });
      return resource;
    };
    try {
      let collectionCreated = false;
      if (!collection) {
        collection = journaled('collection',
          figma.variables.createVariableCollection(input.collection), input.collection);
        collection = validateCollection(collection);
        collectionCreated = true;
      }
      const modeId = collection.defaultModeId;
      const variable = journaled('variable',
        figma.variables.createVariable(input.name, collection, input.type), input.name);
      if (variable.name !== input.name || variable.resolvedType !== input.type || variable.remote
        || variable.variableCollectionId !== collection.id) {
        throw new Error('Token Add Variable factory returned incompatible identity.');
      }
      if (automaticScopes) variable.scopes = automaticScopes;
      variable.setValueForMode(modeId, input.value);

      const [afterCollection, afterVariable] = await Promise.all([
        figma.variables.getVariableCollectionByIdAsync(collection.id),
        figma.variables.getVariableByIdAsync(variable.id),
      ]);
      const verifiedCollection = validateCollection(afterCollection);
      if (verifiedCollection.defaultModeId !== modeId
        || !verifiedCollection.variableIds.includes(variable.id)) {
        throw new Error('Token Add Collection changed during verification.');
      }
      if (!afterVariable || afterVariable.id !== variable.id
        || afterVariable.name !== input.name || afterVariable.remote
        || afterVariable.resolvedType !== input.type
        || afterVariable.variableCollectionId !== verifiedCollection.id
        || !Array.isArray(afterVariable.scopes)
        || afterVariable.scopes.length !== expectedScopes.length
        || afterVariable.scopes.some((scope, index) => scope !== expectedScopes[index])
        || !afterVariable.valuesByMode || typeof afterVariable.valuesByMode !== 'object'
        || Array.isArray(afterVariable.valuesByMode)
        || !Object.prototype.hasOwnProperty.call(afterVariable.valuesByMode, modeId)
        || !valueEquivalent(afterVariable.valuesByMode[modeId], input.value)) {
        throw new Error('Token Add could not verify the created Variable.');
      }
      return bounded({
        schemaVersion: 1, status: 'created',
        collection: {
          id: verifiedCollection.id, name: verifiedCollection.name,
          created: collectionCreated, modeId,
        },
        variable: {
          id: afterVariable.id, key: afterVariable.key || null, name: afterVariable.name,
          resolvedType: afterVariable.resolvedType,
          variableCollectionId: afterVariable.variableCollectionId,
          scopes: [...afterVariable.scopes],
        },
        duplicateCountBefore, residue: [],
      });
    } catch (error) {
      if (!journal.length) throw error;
      const attempted = journal.map(({ kind, id, name }) => ({ kind, id, name }));
      const journalVariableIds = new Set(journal.filter((entry) => entry.kind === 'variable')
        .map((entry) => entry.id));
      for (let index = journal.length - 1; index >= 0; index--) {
        const entry = journal[index];
        try {
          if (entry.kind === 'collection') {
            const current = await figma.variables.getVariableCollectionByIdAsync(entry.id);
            if (current && (!Array.isArray(current.variableIds)
              || current.variableIds.some((id) => !journalVariableIds.has(id)))) continue;
          }
          entry.resource.remove();
        } catch {}
      }
      let checks;
      try {
        let cleanupCollection;
        let collectionMembershipAvailable = false;
        try {
          cleanupCollection = await figma.variables.getVariableCollectionByIdAsync(collection.id);
          collectionMembershipAvailable = cleanupCollection === null
            || (Array.isArray(cleanupCollection.variableIds)
              && cleanupCollection.variableIds.length <= ${MAX_CANDIDATES}
              && cleanupCollection.variableIds.every((id) => validText(id, false)));
        } catch {}
        checks = [];
        for (const item of attempted) {
          if (item.kind === 'collection') {
            if (!collectionMembershipAvailable) throw new Error('Collection cleanup unavailable.');
            checks.push(cleanupCollection);
            continue;
          }
          try {
            checks.push(await figma.variables.getVariableByIdAsync(item.id));
          } catch {
            if (!collectionMembershipAvailable || (cleanupCollection
              && cleanupCollection.variableIds.includes(item.id))) {
              throw new Error('Variable cleanup unavailable.');
            }
            checks.push(null);
          }
        }
      } catch {}
      if (!Array.isArray(checks) || checks.length !== attempted.length) {
        return bounded({ schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
          attempted, removed: [], residue: attempted, residueTruncated: false });
      }
      const residue = attempted.filter((item, index) => checks[index] !== null);
      const removed = attempted.filter((item) => !residue.some((entry) => entry.id === item.id));
      return bounded({ schemaVersion: 1, status: 'failed',
        outcome: residue.length ? 'partial-residue' : 'rolled-back',
        attempted, removed, residue, residueTruncated: false });
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function text(value, empty = true) {
  return typeof value === 'string' && value.length <= MAX_STRING && (empty || value.length > 0);
}
function validResource(value) {
  return exactKeys(value, ['kind', 'id', 'name'])
    && ['collection', 'variable'].includes(value.kind)
    && text(value.id, false) && text(value.name, false);
}
function uniqueResources(values) {
  return Array.isArray(values) && values.length <= 2
    && values.every(validResource)
    && new Set(values.map((item) => item.id)).size === values.length;
}
function validFailure(value, input) {
  if (!exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted',
    'removed', 'residue', 'residueTruncated'])
    || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !uniqueResources(value.attempted) || value.attempted.length < 1
    || !uniqueResources(value.removed) || !uniqueResources(value.residue)
    || value.residueTruncated !== false) return false;
  const collections = value.attempted.filter((item) => item.kind === 'collection');
  const variables = value.attempted.filter((item) => item.kind === 'variable');
  if (collections.length > 1 || variables.length > 1
    || (collections.length === 1 && (value.attempted[0] !== collections[0]
      || collections[0].name !== input.collection))
    || (variables.length === 1 && variables[0].name !== input.name)
    || (collections.length === 1 && variables.length === 1
      && value.attempted[1] !== variables[0])) return false;
  const partition = [...value.removed, ...value.residue];
  return partition.length === value.attempted.length
    && value.attempted.every((item) => partition.filter((entry) => entry.id === item.id
      && entry.kind === item.kind && entry.name === item.name).length === 1)
    && (value.outcome === 'rolled-back' ? value.residue.length === 0
      : value.outcome === 'partial-residue' ? value.residue.length > 0
        : value.removed.length === 0 && value.residue.length === value.attempted.length);
}
function validSuccess(value, input) {
  const expectedScopes = variableScopesForToken(input.name, input.type) || ['ALL_SCOPES'];
  return exactKeys(value, ['schemaVersion', 'status', 'collection', 'variable',
    'duplicateCountBefore', 'residue'])
    && value.schemaVersion === 1 && value.status === 'created'
    && exactKeys(value.collection, ['id', 'name', 'created', 'modeId'])
    && text(value.collection.id, false) && value.collection.name === input.collection
    && typeof value.collection.created === 'boolean' && text(value.collection.modeId, false)
    && exactKeys(value.variable, ['id', 'key', 'name', 'resolvedType',
      'variableCollectionId', 'scopes'])
    && text(value.variable.id, false)
    && (value.variable.key === null || text(value.variable.key))
    && value.variable.name === input.name && value.variable.resolvedType === input.type
    && value.variable.variableCollectionId === value.collection.id
    && Array.isArray(value.variable.scopes)
    && value.variable.scopes.length === expectedScopes.length
    && value.variable.scopes.every((scope, index) => scope === expectedScopes[index])
    && Number.isSafeInteger(value.duplicateCountBefore) && value.duplicateCountBefore >= 0
    && value.duplicateCountBefore <= MAX_CANDIDATES
    && (input.allowDuplicate || value.duplicateCountBefore === 0)
    && (!value.collection.created || value.duplicateCountBefore === 0)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function mutationFailure(payload) {
  const error = new Error(payload.outcome === 'rolled-back'
    ? 'Token Add failed; every command-created resource was removed.'
    : 'Token Add failed; one or more command-created resources may remain.');
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.mutationReport = {
    version: 1, outcome: payload.outcome,
    created: payload.attempted.length, removed: payload.removed.length,
    residueCount: payload.residue.length,
    residue: payload.residue.map((item) => ({
      kind: item.kind, handle: item.id,
      reason: payload.outcome === 'verification-unavailable'
        ? 'verification-unavailable' : 'remove-failed',
    })),
    residueTruncated: false,
  };
  throw error;
}

function scopeWarning(input) {
  const decision = variableScopeDecision(input.name, input.type, input.collection);
  if (decision?.status !== 'USER_DECISION_REQUIRED') return '';
  return `SCOPE DECISION REQUIRED for ${input.collection}/${input.name} (${input.type}).\n`
    + `Compatible scopes: ${decision.allowedScopes.join(', ')}.\n`
    + 'Ask the user before narrowing it; current scope remains ALL_SCOPES.';
}

export async function executeTokenAdd(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeTokenAdd requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(tokenAddCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_TOKEN_ADD_SERIALIZED_CODE_UNITS) {
    throw new Error('Token Add returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Token Add returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Token Add returned an invalid bounded result.');
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) throw new Error('Token Add returned an invalid bounded result.');
  return {
    stdout: `Created ${input.type.toLowerCase()} token: ${input.name}`,
    stderr: scopeWarning(input),
    result: payload,
  };
}

export function tokenAddPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Token Add routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-token-add';
}

export async function executeTokenAddPlan(plan, adapters = {}) {
  if (tokenAddPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Add.`);
  }
  return executeTokenAdd(parseTokenAddRequest(plan.argv), adapters);
}
