// Bounded, rollback-owned Collection Metadata Update Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  collectionFactsLegacyProjection,
  isCollectionFactsPayload,
  MAX_COLLECTION_FACTS_SERIALIZED_CODE_UNITS,
} from './collection-facts-command.js';
import { collectionMutationPluginRuntimeCode } from './collection-mutation-runtime.js';
import {
  collectionUpdateArgvFromRequest,
  collectionUpdatePlanningArgvFromRequest,
  parseCollectionUpdateRequest,
} from './collection-update-request.js';

export {
  collectionUpdateArgvFromRequest,
  collectionUpdatePlanningArgvFromRequest,
} from './collection-update-request.js';

const COLLECTION_UPDATE_APPLICATION_ID = 'col.update';
export const MAX_COLLECTION_UPDATE_SERIALIZED_CODE_UNITS =
  MAX_COLLECTION_FACTS_SERIALIZED_CODE_UNITS + 32_768;
const UPDATE_FIELDS = ['name', 'hiddenFromPublishing'];

function normalizedRequest(request) {
  return parseCollectionUpdateRequest(collectionUpdateArgvFromRequest(request));
}

function requestedFields(input) {
  return [
    ...(input.name === undefined ? [] : ['name']),
    ...(input.hidden === undefined ? [] : ['hiddenFromPublishing']),
  ];
}

export function collectionUpdateCommandCode(request) {
  const input = normalizedRequest(request);
  const fields = requestedFields(input);
  return `(async () => {
    const query = ${JSON.stringify(input.collection)};
    const hasName = ${input.name !== undefined};
    const nextName = ${JSON.stringify(input.name ?? null)};
    const hasHidden = ${input.hidden !== undefined};
    const nextHidden = ${JSON.stringify(input.hidden ?? null)};
    const requested = ${JSON.stringify(fields)};
    ${collectionMutationPluginRuntimeCode()}
    const resolved = __bridgeResolveCollection(query);
    const collection = resolved.collection;
    if (collection.remote) throw new Error('Remote Collections cannot update metadata.');
    const preflightFacts = await __bridgeCollectionFacts(collection);
    if (!__bridgeValidateCollectionFacts(preflightFacts)) {
      throw new Error('Collection Update encountered incompatible preflight metadata.');
    }
    const matchedNameBefore = collection.name;
    const previous = {
      name: collection.name,
      hiddenFromPublishing: collection.hiddenFromPublishing,
    };
    let attempted = false;
    try {
      attempted = true;
      if (hasName) collection.name = nextName;
      if (hasHidden) collection.hiddenFromPublishing = nextHidden;
      const facts = await __bridgeCollectionFacts(collection);
      const affectedValid = (!hasName || facts.name === nextName)
        && (!hasHidden || facts.hiddenFromPublishing === nextHidden);
      if (!__bridgeValidateCollectionFacts(facts) || !affectedValid) {
        throw new Error('Collection Update encountered incompatible result metadata.');
      }
      const complete = {
        schemaVersion: 1, status: 'updated', resolution: resolved.resolution,
        query, matchedNameBefore, requestedFields: requested,
        collection: facts, residue: [],
      };
      const serialized = JSON.stringify(complete);
      if (serialized.length > ${MAX_COLLECTION_UPDATE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Collection Update result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      const restoreFailures = [];
      const restore = (field, apply, verify) => {
        if (!requested.includes(field)) return;
        try { apply(); } catch { restoreFailures.push(field); return; }
        if (!verify()) restoreFailures.push(field);
      };
      restore('name', () => { collection.name = previous.name; },
        () => collection.name === previous.name);
      restore('hiddenFromPublishing',
        () => { collection.hiddenFromPublishing = previous.hiddenFromPublishing; },
        () => collection.hiddenFromPublishing === previous.hiddenFromPublishing);
      const outcome = restoreFailures.length ? 'partial-residue' : 'rolled-back';
      const identity = { id: collection.id, name: collection.name };
      const failure = {
        schemaVersion: 1, status: 'failed', outcome, attempted,
        query, matchedNameBefore, requestedFields: requested,
        restoreFailures, restoreReason: outcome === 'rolled-back' ? null : 'restore-failed',
        collection: identity,
        residue: outcome === 'rolled-back' ? [] : [identity],
      };
      const serialized = JSON.stringify(failure);
      if (serialized.length > 32_768) {
        throw new Error('Collection Update failure evidence exceeded the result limit.');
      }
      return serialized;
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

function sameMembers(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function inputIdentity(value, input, fields) {
  return value.query === input.collection
    && boundedString(value.matchedNameBefore, { empty: false })
    && sameMembers(value.requestedFields, fields);
}

function validIdentity(value) {
  return exactKeys(value, ['id', 'name'])
    && boundedString(value.id, { empty: false })
    && boundedString(value.name, { empty: false });
}

function validFailure(value, input, fields) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'query', 'matchedNameBefore',
    'requestedFields', 'restoreFailures', 'restoreReason', 'collection', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'failed' && value.attempted === true
    && inputIdentity(value, input, fields)
    && ['rolled-back', 'partial-residue'].includes(value.outcome)
    && validIdentity(value.collection)
    && Array.isArray(value.restoreFailures)
    && value.restoreFailures.length <= fields.length
    && value.restoreFailures.every((field, index) => fields.includes(field)
      && value.restoreFailures.indexOf(field) === index && UPDATE_FIELDS.includes(field))
    && Array.isArray(value.residue)
    && (value.outcome === 'rolled-back'
      ? value.restoreReason === null && value.restoreFailures.length === 0
        && value.residue.length === 0
      : value.restoreReason === 'restore-failed' && value.restoreFailures.length > 0
        && value.residue.length === 1 && validIdentity(value.residue[0])
        && value.residue[0].id === value.collection.id);
}

function validSuccess(value, input, fields) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'matchedNameBefore',
    'requestedFields', 'collection', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'updated'
    && ['id', 'name'].includes(value.resolution)
    && inputIdentity(value, input, fields)
    && isCollectionFactsPayload(value.collection)
    && (value.resolution !== 'id' || value.collection.id === input.collection)
    && (input.name === undefined || value.collection.name === input.name)
    && (input.hidden === undefined
      || value.collection.hiddenFromPublishing === input.hidden)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function mutationFailure(payload) {
  const rolledBack = payload.outcome === 'rolled-back';
  const error = new Error(rolledBack
    ? 'Collection Update failed after mutation; every requested metadata field was restored.'
    : `Collection Update failed after mutation; fields could not be restored: ${payload.restoreFailures.join(', ')}.`);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.collectionUpdateMutationReport = {
    version: 1, outcome: payload.outcome, attempted: payload.requestedFields.length,
    restored: payload.requestedFields.length - payload.restoreFailures.length,
    restoreReason: payload.restoreReason,
    restoreFailures: payload.restoreFailures,
    residueCount: payload.residue.length,
  };
  throw error;
}

export async function executeCollectionUpdate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeCollectionUpdate requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const fields = requestedFields(input);
  const serialized = await adapters.evaluate(collectionUpdateCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COLLECTION_UPDATE_SERIALIZED_CODE_UNITS) {
    throw new Error('Collection Update returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Collection Update returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input, fields)) {
      throw new Error('Collection Update returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input, fields)) {
    throw new Error('Collection Update returned an invalid bounded result.');
  }
  return {
    stdout: JSON.stringify(collectionFactsLegacyProjection(payload.collection), null, 2).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    stderr: '', result: payload,
  };
}

export function collectionUpdatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Collection Update routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === COLLECTION_UPDATE_APPLICATION_ID
    ? 'command-application' : 'not-collection-update';
}

export async function executeCollectionUpdatePlan(plan, adapters = {}) {
  if (collectionUpdatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Collection Update.`);
  }
  return executeCollectionUpdate(parseCollectionUpdateRequest(plan.argv), adapters);
}
