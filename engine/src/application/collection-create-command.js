// Bounded, journaled Collection Create Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  collectionCreateArgvFromRequest,
  collectionCreatePlanningArgvFromRequest,
  parseCollectionCreateRequest,
} from './collection-create-request.js';

export {
  collectionCreateArgvFromRequest,
  collectionCreatePlanningArgvFromRequest,
} from './collection-create-request.js';

const COLLECTION_CREATE_APPLICATION_ID = 'col.create';
export const MAX_COLLECTION_CREATE_CANDIDATES = 100_000;
export const MAX_COLLECTION_CREATE_SERIALIZED_CODE_UNITS = 32_768;
const MAX_COLLECTION_CREATE_STRING_CODE_UNITS = 1024;

function normalizedRequest(request) {
  return parseCollectionCreateRequest(collectionCreateArgvFromRequest(request));
}

export function collectionCreateCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const name = ${JSON.stringify(input.name)};
    const allowDuplicate = ${input.allowDuplicate};
    const existing = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(existing) || existing.length > ${MAX_COLLECTION_CREATE_CANDIDATES}) {
      throw new Error('Collection Create candidate limit exceeded.');
    }
    const duplicates = existing.filter((collection) => collection.name === name);
    if (duplicates.length && !allowDuplicate) {
      throw new Error('A local Variable Collection with this exact name already exists. Use its id or pass --allow-duplicate intentionally.');
    }
    const collection = figma.variables.createVariableCollection(name);
    const identity = () => ({
      id: collection.id,
      key: collection.key || null,
      name: collection.name,
      remote: !!collection.remote,
      defaultModeId: collection.defaultModeId,
    });
    try {
      const created = identity();
      if (typeof created.id !== 'string' || created.id.length < 1
        || created.id.length > ${MAX_COLLECTION_CREATE_STRING_CODE_UNITS}
        || !(created.key === null || (typeof created.key === 'string'
          && created.key.length <= ${MAX_COLLECTION_CREATE_STRING_CODE_UNITS}))
        || typeof created.name !== 'string'
        || created.name.length > ${MAX_COLLECTION_CREATE_STRING_CODE_UNITS}
        || created.name !== name || created.remote !== false
        || typeof created.defaultModeId !== 'string' || created.defaultModeId.length < 1
        || created.defaultModeId.length > ${MAX_COLLECTION_CREATE_STRING_CODE_UNITS}) {
        throw new Error('Collection Create encountered invalid created identity.');
      }
      const payload = {
        schemaVersion: 1, status: 'created', collection: created,
        duplicateCountBefore: duplicates.length, residue: [],
      };
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COLLECTION_CREATE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Collection Create result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      let cleanup = 'removed';
      try { collection.remove(); } catch { cleanup = 'partial-residue'; }
      const payload = {
        schemaVersion: 1, status: 'mutation-failed', cleanup,
        residue: cleanup === 'removed' ? [] : [identity()],
      };
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COLLECTION_CREATE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Collection Create failure evidence exceeded the result limit.');
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
  return typeof value === 'string' && value.length <= MAX_COLLECTION_CREATE_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function validIdentity(value, input, { created = false } = {}) {
  return exactKeys(value, ['id', 'key', 'name', 'remote', 'defaultModeId'])
    && boundedString(value.id, { empty: false })
    && (value.key === null || boundedString(value.key))
    && boundedString(value.name)
    && value.remote === false
    && boundedString(value.defaultModeId, { empty: false })
    && (!created || value.name === input.name);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'collection', 'duplicateCountBefore', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'created'
    && validIdentity(value.collection, input, { created: true })
    && Number.isSafeInteger(value.duplicateCountBefore) && value.duplicateCountBefore >= 0
    && value.duplicateCountBefore <= MAX_COLLECTION_CREATE_CANDIDATES
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
    ? 'Collection Create failed after creation; the created Collection was removed.'
    : 'Collection Create failed after creation; one created Collection may remain.');
  const residue = removed ? [] : [{
    kind: 'variable-collection',
    handle: payload.residue[0].id,
    reason: 'remove-failed',
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

export async function executeCollectionCreate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeCollectionCreate requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(collectionCreateCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COLLECTION_CREATE_SERIALIZED_CODE_UNITS) {
    throw new Error('Collection Create returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Collection Create returned invalid JSON.'); }
  if (payload?.status === 'mutation-failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Collection Create returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Collection Create returned an invalid bounded result.');
  }
  return {
    stdout: `✓ Created collection: ${safeText(payload.collection.name)}`,
    stderr: '',
    result: payload,
  };
}

export function collectionCreatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Collection Create routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === COLLECTION_CREATE_APPLICATION_ID
    ? 'command-application' : 'not-collection-create';
}

export async function executeCollectionCreatePlan(plan, adapters = {}) {
  if (collectionCreatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Collection Create.`);
  }
  return executeCollectionCreate(parseCollectionCreateRequest(plan.argv), adapters);
}
