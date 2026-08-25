// Bounded Collection Mode mutation Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  collectionFactsLegacyProjection,
  isCollectionFactsPayload,
  MAX_COLLECTION_FACTS_CANDIDATES,
  MAX_COLLECTION_FACTS_SERIALIZED_CODE_UNITS,
} from './collection-facts-command.js';
import { collectionMutationPluginRuntimeCode } from './collection-mutation-runtime.js';
import {
  collectionModeArgvFromRequest,
  collectionModePlanningArgvFromRequest,
  parseCollectionModeRequest,
} from './collection-mode-request.js';

export {
  collectionModeArgvFromRequest,
  collectionModePlanningArgvFromRequest,
} from './collection-mode-request.js';

const COLLECTION_MODE_APPLICATION_IDS = new Set([
  'col.mode-add', 'col.mode-rename', 'col.mode-remove',
]);
export const MAX_COLLECTION_MODE_SERIALIZED_CODE_UNITS =
  MAX_COLLECTION_FACTS_SERIALIZED_CODE_UNITS + 32_768;

function normalizedRequest(request) {
  return parseCollectionModeRequest(collectionModeArgvFromRequest(request));
}

export function collectionModeCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const action = ${JSON.stringify(input.action)};
    const collectionQuery = ${JSON.stringify(input.collection)};
    const modeQuery = ${JSON.stringify(input.mode)};
    const requestedName = ${JSON.stringify(input.name)};
    ${collectionMutationPluginRuntimeCode()}
    const resolvedCollection = __bridgeResolveCollection(collectionQuery);
    const collection = resolvedCollection.collection;
    if (collection.remote) throw new Error('Remote Collections cannot mutate modes.');
    const before = await __bridgeCollectionFacts(collection);
    if (!__bridgeValidateCollectionFacts(before)) {
      throw new Error('Collection Mode encountered incompatible preflight metadata.');
    }
    const matchedCollectionNameBefore = collection.name;
    const sameArray = (left, right) => left.length === right.length
      && left.every((entry, index) => entry === right[index]);
    const sameOutsideModes = (left, right, allowDefaultChange = false) =>
      left.id === right.id && left.key === right.key && left.name === right.name
      && left.remote === right.remote && left.isExtension === right.isExtension
      && left.hiddenFromPublishing === right.hiddenFromPublishing
      && (allowDefaultChange || left.defaultModeId === right.defaultModeId)
      && sameArray(left.variableIds, right.variableIds);
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COLLECTION_MODE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Collection Mode result exceeded the bounded result limit.');
      }
      return serialized;
    };
    if (action === 'add') {
      if (typeof collection.addMode !== 'function') {
        throw new Error('This Collection cannot add modes.');
      }
      let createdModeId = null;
      try {
        createdModeId = collection.addMode(requestedName);
        const facts = await __bridgeCollectionFacts(collection);
        const affectedMode = facts.modes.find((mode) => mode.modeId === createdModeId) || null;
        const priorModesPreserved = before.modes.every((prior) => facts.modes.some((mode) =>
          mode.modeId === prior.modeId && mode.name === prior.name));
        if (!__bridgeValidateCollectionFacts(facts) || !sameOutsideModes(before, facts)
          || typeof createdModeId !== 'string' || createdModeId.length < 1
          || createdModeId.length > 1024 || before.modes.some((mode) => mode.modeId === createdModeId)
          || facts.modes.length !== before.modes.length + 1 || !priorModesPreserved
          || !affectedMode || affectedMode.name !== requestedName) {
          throw new Error('Collection Mode Add encountered incompatible result metadata.');
        }
        return bounded({
          schemaVersion: 1, status: 'updated', action,
          collectionResolution: resolvedCollection.resolution,
          collectionQuery, modeQuery: null, requestedName,
          matchedCollectionNameBefore, matchedModeNameBefore: null,
          affectedMode, affectedVariableCount: 0,
          collection: facts, residue: [],
        });
      } catch {
        if (createdModeId === null) {
          throw new Error('Collection Mode Add failed before returning a created mode identity.');
        }
        let cleanup = 'removed';
        try {
          collection.removeMode(createdModeId);
          if (collection.modes.some((mode) => mode.modeId === createdModeId)) cleanup = 'partial-residue';
        } catch { cleanup = 'partial-residue'; }
        const residue = cleanup === 'removed' ? [] : [{
          modeId: createdModeId,
          name: collection.modes.find((mode) => mode.modeId === createdModeId)?.name
            || requestedName,
        }];
        return bounded({
          schemaVersion: 1, status: 'failed', action,
          outcome: cleanup === 'removed' ? 'rolled-back' : 'partial-residue',
          collectionQuery, modeQuery: null, requestedName,
          matchedCollectionNameBefore, matchedModeNameBefore: null,
          affectedMode: { modeId: createdModeId, name: requestedName },
          affectedVariableCount: 0,
          restoreReason: cleanup === 'removed' ? null : 'remove-failed', residue,
        });
      }
    }
    const resolvedMode = __bridgeResolveMode(collection, modeQuery);
    const selected = resolvedMode.mode;
    const matchedModeNameBefore = selected.name;
    if (action === 'rename') {
      try {
        collection.renameMode(selected.modeId, requestedName);
        const facts = await __bridgeCollectionFacts(collection);
        const affectedMode = facts.modes.find((mode) => mode.modeId === selected.modeId) || null;
        const otherModesPreserved = before.modes.every((prior) => prior.modeId === selected.modeId
          || facts.modes.some((mode) => mode.modeId === prior.modeId && mode.name === prior.name));
        if (!__bridgeValidateCollectionFacts(facts) || !sameOutsideModes(before, facts)
          || facts.modes.length !== before.modes.length || !otherModesPreserved
          || !affectedMode || affectedMode.name !== requestedName) {
          throw new Error('Collection Mode Rename encountered incompatible result metadata.');
        }
        return bounded({
          schemaVersion: 1, status: 'updated', action,
          collectionResolution: resolvedCollection.resolution,
          modeResolution: resolvedMode.resolution,
          collectionQuery, modeQuery, requestedName,
          matchedCollectionNameBefore, matchedModeNameBefore,
          affectedMode, affectedVariableCount: 0,
          collection: facts, residue: [],
        });
      } catch {
        let restored = true;
        try {
          collection.renameMode(selected.modeId, matchedModeNameBefore);
          restored = collection.modes.some((mode) => mode.modeId === selected.modeId
            && mode.name === matchedModeNameBefore);
        } catch { restored = false; }
        const current = collection.modes.find((mode) => mode.modeId === selected.modeId);
        const affectedMode = { modeId: selected.modeId, name: current?.name || requestedName };
        return bounded({
          schemaVersion: 1, status: 'failed', action,
          outcome: restored ? 'rolled-back' : 'partial-residue',
          collectionQuery, modeQuery, requestedName,
          matchedCollectionNameBefore, matchedModeNameBefore,
          affectedMode, affectedVariableCount: 0,
          restoreReason: restored ? null : 'rename-restore-failed',
          residue: restored ? [] : [affectedMode],
        });
      }
    }
    const variables = await figma.variables.getLocalVariablesAsync();
    if (!Array.isArray(variables) || variables.length > ${MAX_COLLECTION_FACTS_CANDIDATES}) {
      throw new Error('Collection Mode Remove Variable candidate limit exceeded.');
    }
    const members = variables.filter((variable) => variable.variableCollectionId === collection.id);
    const affectedVariableCount = members.filter((variable) =>
      variable.valuesByMode && Object.prototype.hasOwnProperty.call(
        variable.valuesByMode, selected.modeId)).length;
    const removedMode = { modeId: selected.modeId, name: selected.name };
    try {
      collection.removeMode(selected.modeId);
      const facts = await __bridgeCollectionFacts(collection);
      const removed = !facts.modes.some((mode) => mode.modeId === selected.modeId);
      const otherModesPreserved = before.modes.every((prior) => prior.modeId === selected.modeId
        || facts.modes.some((mode) => mode.modeId === prior.modeId && mode.name === prior.name));
      const valuesRemoved = members.every((variable) => !variable.valuesByMode
        || !Object.prototype.hasOwnProperty.call(variable.valuesByMode, selected.modeId));
      if (!__bridgeValidateCollectionFacts(facts)
        || !sameOutsideModes(before, facts, true) || !removed || !otherModesPreserved
        || facts.modes.length !== before.modes.length - 1 || !valuesRemoved) {
        throw new Error('Collection Mode Remove encountered incompatible result metadata.');
      }
      return bounded({
        schemaVersion: 1, status: 'updated', action,
        collectionResolution: resolvedCollection.resolution,
        modeResolution: resolvedMode.resolution,
        collectionQuery, modeQuery, requestedName: null,
        matchedCollectionNameBefore, matchedModeNameBefore,
        affectedMode: removedMode, affectedVariableCount,
        collection: facts, residue: [],
      });
    } catch {
      const removed = !collection.modes.some((mode) => mode.modeId === selected.modeId);
      return bounded({
        schemaVersion: 1, status: 'failed', action,
        outcome: removed ? 'irreversible-applied' : 'unchanged',
        collectionQuery, modeQuery, requestedName: null,
        matchedCollectionNameBefore, matchedModeNameBefore,
        affectedMode: removedMode, affectedVariableCount,
        restoreReason: removed ? 'no-reversal-api' : null,
        residue: removed ? [removedMode] : [],
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

function validMode(value) {
  return exactKeys(value, ['modeId', 'name'])
    && boundedString(value.modeId, { empty: false }) && boundedString(value.name, { empty: false });
}

function commonIdentity(value, input) {
  return value.collectionQuery === input.collection
    && value.modeQuery === input.mode && value.requestedName === input.name
    && boundedString(value.matchedCollectionNameBefore, { empty: false })
    && (input.action === 'add'
      ? value.matchedModeNameBefore === null
      : boundedString(value.matchedModeNameBefore, { empty: false }))
    && validMode(value.affectedMode)
    && Number.isSafeInteger(value.affectedVariableCount)
    && value.affectedVariableCount >= 0
    && value.affectedVariableCount <= MAX_COLLECTION_FACTS_CANDIDATES;
}

function validSuccess(value, input) {
  const keys = [
    'schemaVersion', 'status', 'action', 'collectionResolution',
    ...(input.action === 'add' ? [] : ['modeResolution']),
    'collectionQuery', 'modeQuery', 'requestedName', 'matchedCollectionNameBefore',
    'matchedModeNameBefore', 'affectedMode', 'affectedVariableCount', 'collection', 'residue',
  ];
  return exactKeys(value, keys) && value.schemaVersion === 1 && value.status === 'updated'
    && value.action === input.action && ['id', 'name'].includes(value.collectionResolution)
    && (input.action === 'add' || ['id', 'name'].includes(value.modeResolution))
    && commonIdentity(value, input) && isCollectionFactsPayload(value.collection)
    && (value.collectionResolution !== 'id' || value.collection.id === input.collection)
    && (input.action === 'add'
      ? value.affectedMode.name === input.name && value.affectedVariableCount === 0
        && value.collection.modes.some((mode) => mode.modeId === value.affectedMode.modeId
          && mode.name === input.name)
      : input.action === 'rename'
        ? value.affectedMode.name === input.name && value.affectedVariableCount === 0
          && value.collection.modes.some((mode) => mode.modeId === value.affectedMode.modeId
            && mode.name === input.name)
        : !value.collection.modes.some((mode) => mode.modeId === value.affectedMode.modeId))
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'action', 'outcome', 'collectionQuery', 'modeQuery',
    'requestedName', 'matchedCollectionNameBefore', 'matchedModeNameBefore',
    'affectedMode', 'affectedVariableCount', 'restoreReason', 'residue',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed' || value.action !== input.action
    || !commonIdentity(value, input) || !Array.isArray(value.residue)) return false;
  if (input.action === 'remove') {
    return ['unchanged', 'irreversible-applied'].includes(value.outcome)
      && (value.outcome === 'unchanged'
        ? value.restoreReason === null && value.residue.length === 0
        : value.restoreReason === 'no-reversal-api' && value.residue.length === 1
          && validMode(value.residue[0])
          && value.residue[0].modeId === value.affectedMode.modeId);
  }
  const reason = input.action === 'add' ? 'remove-failed' : 'rename-restore-failed';
  return ['rolled-back', 'partial-residue'].includes(value.outcome)
    && (value.outcome === 'rolled-back'
      ? value.restoreReason === null && value.residue.length === 0
      : value.restoreReason === reason && value.residue.length === 1
        && validMode(value.residue[0])
        && value.residue[0].modeId === value.affectedMode.modeId);
}

function mutationFailure(payload) {
  const messages = {
    'rolled-back': `Collection Mode ${payload.action} failed; its mutation was restored.`,
    'partial-residue': `Collection Mode ${payload.action} failed; one mode may remain changed.`,
    unchanged: 'Collection Mode remove failed before the selected mode was removed.',
    'irreversible-applied': 'Collection Mode remove was applied, but complete result validation failed; the removed mode cannot be restored.',
  };
  const error = new Error(messages[payload.outcome]);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.collectionModeMutationReport = {
    version: 1, action: payload.action, outcome: payload.outcome,
    affectedVariableCount: payload.affectedVariableCount,
    restoreReason: payload.restoreReason, residueCount: payload.residue.length,
  };
  throw error;
}

export async function executeCollectionMode(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeCollectionMode requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(collectionModeCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COLLECTION_MODE_SERIALIZED_CODE_UNITS) {
    throw new Error('Collection Mode returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Collection Mode returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Collection Mode returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Collection Mode returned an invalid bounded result.');
  }
  return {
    stdout: JSON.stringify(collectionFactsLegacyProjection(payload.collection), null, 2).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    stderr: '', result: payload,
  };
}

export function collectionModePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Collection Mode routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && COLLECTION_MODE_APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-collection-mode';
}

export async function executeCollectionModePlan(plan, adapters = {}) {
  if (collectionModePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Collection Mode.`);
  }
  return executeCollectionMode(parseCollectionModeRequest(plan.argv), adapters);
}
