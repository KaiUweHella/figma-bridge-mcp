// Bounded, journaled Variable Collection Extension Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_COLLECTION_FACTS_CANDIDATES,
  MAX_COLLECTION_FACTS_MODES,
} from './collection-facts-command.js';
import { collectionMutationPluginRuntimeCode } from './collection-mutation-runtime.js';
import {
  collectionExtendArgvFromRequest,
  collectionExtendPlanningArgvFromRequest,
  parseCollectionExtendRequest,
} from './collection-extend-request.js';

export {
  collectionExtendArgvFromRequest,
  collectionExtendPlanningArgvFromRequest,
} from './collection-extend-request.js';

const COLLECTION_EXTEND_APPLICATION_ID = 'col.extend';
export const MAX_COLLECTION_EXTEND_SERIALIZED_CODE_UNITS = 2_000_000;
const MAX_COLLECTION_EXTEND_STRING_CODE_UNITS = 1024;
const PUBLISH_STATUSES = new Set(['UNPUBLISHED', 'CURRENT', 'CHANGED']);

function normalizedRequest(request) {
  return parseCollectionExtendRequest(collectionExtendArgvFromRequest(request));
}

export function collectionExtendCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.collection)};
    const name = ${JSON.stringify(input.name)};
    ${collectionMutationPluginRuntimeCode()}
    let source = null;
    let resolution = 'library-key';
    try {
      const resolved = __bridgeResolveCollection(query);
      source = resolved.collection;
      resolution = resolved.resolution;
    } catch (error) {
      if (!/Variable Collection not found\./.test(String(error && error.message))) throw error;
    }
    if (source) {
      const sourceFacts = await __bridgeCollectionFacts(source);
      if (!__bridgeValidateCollectionFacts(sourceFacts)) {
        throw new Error('Collection Extension encountered incompatible source metadata.');
      }
      if (typeof source.extend !== 'function') {
        throw new Error('Collection extension is unavailable in this Figma editor.');
      }
    } else if (typeof figma.variables.extendLibraryCollectionByKeyAsync !== 'function') {
      throw new Error('Library collection extension is unavailable in this Figma editor.');
    }
    const idsBefore = new Set(__bridgeCollections.map((collection) => collection.id));
    let extension;
    if (source) extension = source.extend(name);
    else extension = await figma.variables.extendLibraryCollectionByKeyAsync(query, name);
    const identity = () => ({
      id: typeof extension?.id === 'string'
        && extension.id.length <= ${MAX_COLLECTION_EXTEND_STRING_CODE_UNITS} ? extension.id : null,
      name: typeof extension?.name === 'string'
        && extension.name.length <= ${MAX_COLLECTION_EXTEND_STRING_CODE_UNITS} ? extension.name : null,
    });
    const bounded = (payload, failure = false) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COLLECTION_EXTEND_SERIALIZED_CODE_UNITS}) {
        throw new Error(failure
          ? 'Collection Extension failure evidence exceeded the result limit.'
          : 'Collection Extension result exceeded the bounded result limit.');
      }
      return serialized;
    };
    const extensionFacts = async (collection) => ({
      id: collection.id,
      key: collection.key || null,
      name: collection.name,
      remote: !!collection.remote,
      isExtension: !!collection.isExtension,
      hiddenFromPublishing: !!collection.hiddenFromPublishing,
      defaultModeId: collection.defaultModeId,
      modes: collection.modes.map((mode) => ({
        modeId: mode.modeId, name: mode.name, parentModeId: mode.parentModeId,
      })),
      variableIds: [...collection.variableIds],
      publishStatus: await collection.getPublishStatusAsync(),
      parentVariableCollectionId: collection.parentVariableCollectionId,
      rootVariableCollectionId: collection.rootVariableCollectionId,
    });
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_COLLECTION_EXTEND_STRING_CODE_UNITS} && (empty || value.length > 0);
    const validFacts = (facts) => {
      if (!facts || typeof facts !== 'object' || Array.isArray(facts)
        || Object.keys(facts).length !== 12
        || !validText(facts.id, false)
        || !(facts.key === null || validText(facts.key, false))
        || !validText(facts.name) || facts.remote !== false || facts.isExtension !== true
        || typeof facts.hiddenFromPublishing !== 'boolean'
        || !validText(facts.defaultModeId, false)
        || !Array.isArray(facts.modes) || facts.modes.length > ${MAX_COLLECTION_FACTS_MODES}
        || !Array.isArray(facts.variableIds)
        || facts.variableIds.length > ${MAX_COLLECTION_FACTS_CANDIDATES}
        || !['UNPUBLISHED', 'CURRENT', 'CHANGED'].includes(facts.publishStatus)
        || !validText(facts.parentVariableCollectionId, false)
        || !validText(facts.rootVariableCollectionId, false)) return false;
      const modeIds = new Set();
      const parentModeIds = new Set();
      if (!facts.modes.every((mode) => mode && typeof mode === 'object'
        && !Array.isArray(mode) && Object.keys(mode).length === 3
        && validText(mode.modeId, false) && validText(mode.name)
        && validText(mode.parentModeId, false)
        && !modeIds.has(mode.modeId) && !!modeIds.add(mode.modeId)
        && !parentModeIds.has(mode.parentModeId) && !!parentModeIds.add(mode.parentModeId))) return false;
      if (!modeIds.has(facts.defaultModeId)) return false;
      const variableIds = new Set();
      return facts.variableIds.every((id) => validText(id, false)
        && !variableIds.has(id) && !!variableIds.add(id));
    };
    try {
      const createdId = extension && extension.id;
      if (!validText(createdId, false) || idsBefore.has(createdId)) {
        throw new Error('Collection Extension encountered invalid created identity.');
      }
      const collectionsAfter = await figma.variables.getLocalVariableCollectionsAsync();
      if (!Array.isArray(collectionsAfter)
        || collectionsAfter.length > ${MAX_COLLECTION_FACTS_CANDIDATES}) {
        throw new Error('Collection Extension postcondition candidate limit exceeded.');
      }
      const matches = collectionsAfter.filter((collection) => collection.id === createdId);
      if (matches.length !== 1) {
        throw new Error('Collection Extension could not prove the created Collection locally.');
      }
      const facts = await extensionFacts(matches[0]);
      if (!validFacts(facts) || facts.name !== name) {
        throw new Error('Collection Extension encountered invalid extension metadata.');
      }
      if (source) {
        const expectedRoot = source.isExtension
          ? source.rootVariableCollectionId : source.id;
        const parentModes = new Set(source.modes.map((mode) => mode.modeId));
        const parentVariables = new Set(source.variableIds);
        if (facts.parentVariableCollectionId !== source.id
          || facts.rootVariableCollectionId !== expectedRoot
          || facts.modes.length !== source.modes.length
          || !facts.modes.every((mode) => parentModes.has(mode.parentModeId))
          || facts.variableIds.length !== source.variableIds.length
          || !facts.variableIds.every((id) => parentVariables.has(id))) {
          throw new Error('Collection Extension encountered inconsistent local inheritance topology.');
        }
      }
      return bounded({
        schemaVersion: 1, status: 'extended', resolution, query,
        source: source ? { kind: 'local', id: source.id } : { kind: 'library-key' },
        collection: facts, residue: [],
      });
    } catch {
      let cleanup = 'removed';
      try {
        extension.remove();
        const collectionsAfterCleanup = await figma.variables.getLocalVariableCollectionsAsync();
        if (!Array.isArray(collectionsAfterCleanup)
          || collectionsAfterCleanup.length > ${MAX_COLLECTION_FACTS_CANDIDATES}
          || collectionsAfterCleanup.some((collection) => collection.id === extension.id)) {
          cleanup = 'partial-residue';
        }
      } catch { cleanup = 'partial-residue'; }
      return bounded({
        schemaVersion: 1, status: 'mutation-failed', cleanup,
        residue: cleanup === 'removed' ? [] : [identity()],
      }, true);
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_COLLECTION_EXTEND_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function validExtensionFacts(value, input) {
  if (!exactKeys(value, [
    'id', 'key', 'name', 'remote', 'isExtension', 'hiddenFromPublishing',
    'defaultModeId', 'modes', 'variableIds', 'publishStatus',
    'parentVariableCollectionId', 'rootVariableCollectionId',
  ]) || !boundedString(value.id, { empty: false })
    || !(value.key === null || boundedString(value.key, { empty: false }))
    || value.name !== input.name || value.remote !== false || value.isExtension !== true
    || typeof value.hiddenFromPublishing !== 'boolean'
    || !boundedString(value.defaultModeId, { empty: false })
    || !Array.isArray(value.modes) || value.modes.length > MAX_COLLECTION_FACTS_MODES
    || !Array.isArray(value.variableIds)
    || value.variableIds.length > MAX_COLLECTION_FACTS_CANDIDATES
    || !PUBLISH_STATUSES.has(value.publishStatus)
    || !boundedString(value.parentVariableCollectionId, { empty: false })
    || !boundedString(value.rootVariableCollectionId, { empty: false })) return false;
  const modeIds = new Set(); const parentModeIds = new Set();
  for (const mode of value.modes) {
    if (!exactKeys(mode, ['modeId', 'name', 'parentModeId'])
      || !boundedString(mode.modeId, { empty: false }) || !boundedString(mode.name)
      || !boundedString(mode.parentModeId, { empty: false })
      || modeIds.has(mode.modeId) || parentModeIds.has(mode.parentModeId)) return false;
    modeIds.add(mode.modeId); parentModeIds.add(mode.parentModeId);
  }
  if (!modeIds.has(value.defaultModeId)) return false;
  const variableIds = new Set();
  return value.variableIds.every((id) => boundedString(id, { empty: false })
    && !variableIds.has(id) && !!variableIds.add(id));
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'source', 'collection', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'extended'
    && ['id', 'name', 'library-key'].includes(value.resolution)
    && value.query === input.collection
    && validExtensionFacts(value.collection, input)
    && ((value.resolution === 'library-key'
      && exactKeys(value.source, ['kind']) && value.source.kind === 'library-key')
      || (['id', 'name'].includes(value.resolution)
        && exactKeys(value.source, ['kind', 'id']) && value.source.kind === 'local'
        && boundedString(value.source.id, { empty: false })
        && value.collection.parentVariableCollectionId === value.source.id))
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value) {
  if (!exactKeys(value, ['schemaVersion', 'status', 'cleanup', 'residue'])
    || value.schemaVersion !== 1 || value.status !== 'mutation-failed'
    || !['removed', 'partial-residue'].includes(value.cleanup)
    || !Array.isArray(value.residue)) return false;
  if (value.cleanup === 'removed') return value.residue.length === 0;
  return value.residue.length === 1
    && exactKeys(value.residue[0], ['id', 'name'])
    && (value.residue[0].id === null || boundedString(value.residue[0].id, { empty: false }))
    && (value.residue[0].name === null || boundedString(value.residue[0].name));
}

function mutationFailure(payload) {
  const removed = payload.cleanup === 'removed';
  const error = new Error(removed
    ? 'Collection Extension failed after creation; the created Collection was removed.'
    : 'Collection Extension failed after creation; one created Collection may remain.');
  const residue = removed ? [] : [{
    kind: 'variable-collection',
    handle: payload.residue[0].id || '(unknown)',
    reason: 'remove-or-verification-failed',
  }];
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = removed ? 'rolled-back' : 'partial-residue';
  error.mutationReport = {
    version: 1, outcome: error.mutationOutcome, created: 1,
    removed: removed ? 1 : 0, residueCount: residue.length,
    residue, residueTruncated: false,
  };
  throw error;
}

function legacyProjection(collection) {
  return {
    id: collection.id, key: collection.key, name: collection.name,
    remote: collection.remote, isExtension: collection.isExtension,
    hiddenFromPublishing: collection.hiddenFromPublishing,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes, variableIds: collection.variableIds,
    publishStatus: collection.publishStatus,
  };
}

export async function executeCollectionExtend(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeCollectionExtend requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(collectionExtendCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COLLECTION_EXTEND_SERIALIZED_CODE_UNITS) {
    throw new Error('Collection Extension returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Collection Extension returned invalid JSON.'); }
  if (payload?.status === 'mutation-failed') {
    if (!validFailure(payload)) throw new Error('Collection Extension returned an invalid bounded result.');
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Collection Extension returned an invalid bounded result.');
  }
  return { stdout: JSON.stringify(legacyProjection(payload.collection), null, 2), stderr: '', result: payload };
}

export function collectionExtendPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Collection Extension routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === COLLECTION_EXTEND_APPLICATION_ID
    ? 'command-application' : 'not-collection-extend';
}

export async function executeCollectionExtendPlan(plan, adapters = {}) {
  if (collectionExtendPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Collection Extension.`);
  }
  return executeCollectionExtend(parseCollectionExtendRequest(plan.argv), adapters);
}
