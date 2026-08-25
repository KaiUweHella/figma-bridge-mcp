// Bounded, irreversible Collection Delete Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_COLLECTION_FACTS_CANDIDATES } from './collection-facts-command.js';
import { collectionMutationPluginRuntimeCode } from './collection-mutation-runtime.js';
import {
  collectionDeleteArgvFromRequest,
  collectionDeletePlanningArgvFromRequest,
  parseCollectionDeleteRequest,
} from './collection-delete-request.js';

export {
  collectionDeleteArgvFromRequest,
  collectionDeletePlanningArgvFromRequest,
} from './collection-delete-request.js';

const COLLECTION_DELETE_APPLICATION_ID = 'col.delete';
export const MAX_COLLECTION_DELETE_SERIALIZED_CODE_UNITS = 65_536;
const MAX_COLLECTION_DELETE_RESIDUE = 16;

function normalizedRequest(request) {
  return parseCollectionDeleteRequest(collectionDeleteArgvFromRequest(request));
}

export function collectionDeleteCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.collection)};
    ${collectionMutationPluginRuntimeCode()}
    const resolved = __bridgeResolveCollection(query);
    const collection = resolved.collection;
    if (collection.remote) throw new Error('Remote Collections cannot be deleted.');
    const facts = await __bridgeCollectionFacts(collection);
    if (!__bridgeValidateCollectionFacts(facts)) {
      throw new Error('Collection Delete encountered incompatible preflight metadata.');
    }
    const variablesBefore = await figma.variables.getLocalVariablesAsync();
    if (!Array.isArray(variablesBefore)
      || variablesBefore.length > ${MAX_COLLECTION_FACTS_CANDIDATES}) {
      throw new Error('Collection Delete Variable candidate limit exceeded.');
    }
    const members = variablesBefore.filter((variable) =>
      variable.variableCollectionId === collection.id);
    const memberIds = new Set(members.map((variable) => variable.id));
    if (memberIds.size !== members.length || memberIds.size !== facts.variableIds.length
      || !facts.variableIds.every((id) => memberIds.has(id))) {
      throw new Error('Collection Delete encountered inconsistent Variable membership.');
    }
    const deleted = { id: collection.id, name: collection.name, variableCount: members.length };
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COLLECTION_DELETE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Collection Delete result exceeded the bounded result limit.');
      }
      return serialized;
    };
    try {
      collection.remove();
      const collectionsAfter = await figma.variables.getLocalVariableCollectionsAsync();
      const variablesAfter = await figma.variables.getLocalVariablesAsync();
      if (!Array.isArray(collectionsAfter)
        || collectionsAfter.length > ${MAX_COLLECTION_FACTS_CANDIDATES}
        || !Array.isArray(variablesAfter)
        || variablesAfter.length > ${MAX_COLLECTION_FACTS_CANDIDATES}) {
        throw new Error('Collection Delete postcondition candidate limit exceeded.');
      }
      const collectionAbsent = !collectionsAfter.some((item) => item.id === collection.id);
      const remainingMemberIds = facts.variableIds.filter((id) =>
        variablesAfter.some((variable) => variable.id === id));
      if (!collectionAbsent || remainingMemberIds.length) {
        throw new Error('Collection Delete encountered incomplete removal postconditions.');
      }
      return bounded({
        schemaVersion: 1, status: 'deleted', resolution: resolved.resolution,
        query, deleted, residue: [],
      });
    } catch {
      const collectionsAfter = await figma.variables.getLocalVariableCollectionsAsync();
      const variablesAfter = await figma.variables.getLocalVariablesAsync();
      if (!Array.isArray(collectionsAfter)
        || collectionsAfter.length > ${MAX_COLLECTION_FACTS_CANDIDATES}
        || !Array.isArray(variablesAfter)
        || variablesAfter.length > ${MAX_COLLECTION_FACTS_CANDIDATES}) {
        throw new Error('Collection Delete failure evidence candidate limit exceeded.');
      }
      const collectionPresent = collectionsAfter.some((item) => item.id === collection.id);
      const remainingMemberIds = facts.variableIds.filter((id) =>
        variablesAfter.some((variable) => variable.id === id));
      const allMembersPresent = remainingMemberIds.length === facts.variableIds.length;
      const outcome = collectionPresent && allMembersPresent ? 'unchanged'
        : !collectionPresent && remainingMemberIds.length === 0
          ? 'irreversible-applied' : 'partial-residue';
      const fullResidue = [
        ...(collectionPresent ? [{ kind: 'variable-collection', id: collection.id }] : []),
        ...remainingMemberIds.map((id) => ({ kind: 'variable', id })),
      ];
      const residue = outcome === 'unchanged' ? []
        : outcome === 'irreversible-applied' ? [{ kind: 'deleted-collection', id: collection.id }]
          : fullResidue.slice(0, ${MAX_COLLECTION_DELETE_RESIDUE});
      return bounded({
        schemaVersion: 1, status: 'failed', outcome, query, deleted,
        collectionPresent, remainingVariableCount: remainingMemberIds.length,
        restoreReason: outcome === 'unchanged' ? null : 'no-reversal-api',
        residue, residueTruncated: outcome === 'partial-residue'
          && fullResidue.length > ${MAX_COLLECTION_DELETE_RESIDUE},
      });
    }
  })()`;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= 1024 && (empty || value.length > 0);
}

function validDeleted(value) {
  return exactKeys(value, ['id', 'name', 'variableCount'])
    && boundedString(value.id, { empty: false }) && boundedString(value.name, { empty: false })
    && Number.isSafeInteger(value.variableCount) && value.variableCount >= 0
    && value.variableCount <= MAX_COLLECTION_FACTS_CANDIDATES;
}

function validResidue(value) {
  return exactKeys(value, ['kind', 'id'])
    && ['variable-collection', 'variable', 'deleted-collection'].includes(value.kind)
    && boundedString(value.id, { empty: false });
}

function validSuccess(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'resolution', 'query', 'deleted', 'residue'])
    && value.schemaVersion === 1 && value.status === 'deleted'
    && ['id', 'name'].includes(value.resolution) && value.query === input.collection
    && validDeleted(value.deleted)
    && (value.resolution !== 'id' || value.deleted.id === input.collection)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'query', 'deleted', 'collectionPresent',
    'remainingVariableCount', 'restoreReason', 'residue', 'residueTruncated',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'irreversible-applied', 'partial-residue'].includes(value.outcome)
    || value.query !== input.collection || !validDeleted(value.deleted)
    || typeof value.collectionPresent !== 'boolean'
    || !Number.isSafeInteger(value.remainingVariableCount)
    || value.remainingVariableCount < 0
    || value.remainingVariableCount > value.deleted.variableCount
    || !Array.isArray(value.residue) || value.residue.length > MAX_COLLECTION_DELETE_RESIDUE
    || !value.residue.every(validResidue) || typeof value.residueTruncated !== 'boolean') return false;
  if (value.outcome === 'unchanged') {
    return value.collectionPresent && value.remainingVariableCount === value.deleted.variableCount
      && value.restoreReason === null && value.residue.length === 0
      && value.residueTruncated === false;
  }
  if (value.outcome === 'irreversible-applied') {
    return !value.collectionPresent && value.remainingVariableCount === 0
      && value.restoreReason === 'no-reversal-api' && value.residue.length === 1
      && value.residue[0].kind === 'deleted-collection'
      && value.residue[0].id === value.deleted.id && value.residueTruncated === false;
  }
  return value.restoreReason === 'no-reversal-api' && value.residue.length > 0;
}

function mutationFailure(payload) {
  const messages = {
    unchanged: 'Collection Delete failed before the Collection or its Variables were removed.',
    'irreversible-applied': 'Collection Delete was applied, but complete postcondition validation failed; the deleted Collection cannot be restored.',
    'partial-residue': 'Collection Delete failed with partial irreversible residue.',
  };
  const error = new Error(messages[payload.outcome]);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.collectionDeleteMutationReport = {
    version: 1, outcome: payload.outcome,
    variableCount: payload.deleted.variableCount,
    remainingVariableCount: payload.remainingVariableCount,
    collectionPresent: payload.collectionPresent,
    restoreReason: payload.restoreReason,
    residueCount: payload.residue.length,
    residueTruncated: payload.residueTruncated,
  };
  throw error;
}

export async function executeCollectionDelete(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeCollectionDelete requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(collectionDeleteCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COLLECTION_DELETE_SERIALIZED_CODE_UNITS) {
    throw new Error('Collection Delete returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Collection Delete returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Collection Delete returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Collection Delete returned an invalid bounded result.');
  }
  return {
    stdout: JSON.stringify(payload.deleted, null, 2).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    stderr: '', result: payload,
  };
}

export function collectionDeletePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Collection Delete routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === COLLECTION_DELETE_APPLICATION_ID
    ? 'command-application' : 'not-collection-delete';
}

export async function executeCollectionDeletePlan(plan, adapters = {}) {
  if (collectionDeletePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Collection Delete.`);
  }
  return executeCollectionDelete(parseCollectionDeleteRequest(plan.argv), adapters);
}
