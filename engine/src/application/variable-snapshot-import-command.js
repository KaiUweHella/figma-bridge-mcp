// Exact, journaled multi-Collection Variable Snapshot v2 import.

import { normalizeVariableSnapshotV2 } from '../lib/variable-snapshot.js';
import { evalTransportEnvelopeError } from '../lib/protocol-contract.js';

const MAX_RESULT_CODE_UNITS = 262_144;
const MAX_FAILURE_ITEMS = 64;

function normalizedSource(value) {
  const snapshot = normalizeVariableSnapshotV2(value);
  if (snapshot.complete !== true) {
    throw new Error('Variable Snapshot v2 is incomplete and cannot be imported exactly. Re-export it from one stable Figma document revision.');
  }
  for (const collection of snapshot.collections) {
    if (collection.defaultMode !== collection.modes[0]?.handle) {
      throw new Error('Variable Snapshot v2 declares a non-first default mode that the Figma Plugin API cannot recreate exactly.');
    }
    for (const variable of collection.variables) {
      for (const value of Object.values(variable.values)) {
        if (value?.$alias?.status === 'unresolved') {
          throw new Error('Variable Snapshot v2 contains an unresolved external Alias and cannot be imported exactly.');
        }
      }
    }
  }
  return snapshot;
}

export function prepareVariableSnapshotImport(snapshot) {
  const normalized = normalizedSource(snapshot);
  variableSnapshotImportCode(normalized);
  return normalized;
}

export function variableSnapshotImportCode(source) {
  const snapshot = normalizedSource(source);
  const code = `(async () => {
    const SOURCE = ${JSON.stringify(snapshot)};
    const MAX_RESULT = ${MAX_RESULT_CODE_UNITS};
    const MAX_FAILURE_ITEMS = ${MAX_FAILURE_ITEMS};
    const validId = (value) => typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(value);
    const validText = (value, maximum = 16384) => typeof value === 'string'
      && value.length <= maximum;
    const equivalent = (actual, expected) => {
      if (typeof actual === 'number' && typeof expected === 'number') {
        return Number.isFinite(actual) && Number.isFinite(expected)
          && (Object.is(actual, expected) || Math.fround(actual) === Math.fround(expected));
      }
      if (actual === null || expected === null || typeof actual !== 'object'
        || typeof expected !== 'object') return Object.is(actual, expected);
      if (Array.isArray(actual) !== Array.isArray(expected)) return false;
      const a = Object.keys(actual).sort(); const b = Object.keys(expected).sort();
      return a.length === b.length && a.every((key, index) => key === b[index]
        && equivalent(actual[key], expected[key]));
    };
    const valueEquivalent = (actual, expected, type) => {
      if (type === 'COLOR') {
        const color = (value) => value && typeof value === 'object' && !Array.isArray(value)
          && ['r', 'g', 'b'].every((key) => Object.hasOwn(value, key));
        return color(actual) && color(expected)
          && ['r', 'g', 'b'].every((key) => equivalent(actual[key], expected[key]))
          && equivalent(Object.hasOwn(actual, 'a') ? actual.a : 1,
            Object.hasOwn(expected, 'a') ? expected.a : 1);
      }
      return equivalent(actual, expected);
    };
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > MAX_RESULT) throw new Error('Variable Snapshot Import result exceeded its bound.');
      return serialized;
    };
    const validateCollection = (collection) => {
      if (!collection || !validId(collection.id) || !validText(collection.name, 512)
        || collection.remote || !validId(collection.defaultModeId)
        || !Array.isArray(collection.modes) || !collection.modes.length
        || collection.modes.length > 1000
        || collection.modes.some((mode) => !mode || !validId(mode.modeId)
          || !validText(mode.name, 512))
        || new Set(collection.modes.map((mode) => mode.modeId)).size !== collection.modes.length
        || !collection.modes.some((mode) => mode.modeId === collection.defaultModeId)
        || !Array.isArray(collection.variableIds) || collection.variableIds.length > 10000
        || collection.variableIds.some((id) => !validId(id))
        || new Set(collection.variableIds).size !== collection.variableIds.length
        || typeof collection.hiddenFromPublishing !== 'boolean') {
        throw new Error('Variable Snapshot Import encountered invalid Collection metadata.');
      }
      return collection;
    };
    const loadVariables = async (ids) => {
      const values = [];
      for (let start = 0; start < ids.length; start += 64) {
        values.push(...await Promise.all(ids.slice(start, start + 64)
          .map((id) => figma.variables.getVariableByIdAsync(id))));
      }
      return values;
    };
    const targetCatalog = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(targetCatalog) || targetCatalog.length > 100000
      || targetCatalog.some((collection) => !collection || !validId(collection.id)
        || !validText(collection.name, 512))
      || new Set(targetCatalog.map((collection) => collection.id)).size !== targetCatalog.length) {
      throw new Error('Variable Snapshot Import encountered an invalid target Collection catalog.');
    }
    const sourceNames = new Set(SOURCE.collections.map((collection) => collection.name));
    const conflicts = targetCatalog.filter((collection) => sourceNames.has(collection.name));
    if (conflicts.length) {
      throw new Error('Variable Snapshot Import target already contains one or more source Collection names. Exact import never merges by display name.');
    }

    const journal = [];
    const journalIds = new Set();
    const collectionByHandle = new Map();
    const modeByHandle = new Map();
    const variableByHandle = new Map();
    const journaled = (kind, handle, resource, ownerId = null) => {
      if (!resource || typeof resource.remove !== 'function' || !validId(resource.id)
        || journalIds.has(resource.id)
        || (kind === 'variable' && !validId(ownerId))
        || (kind === 'collection' && ownerId !== null)) {
        try { resource?.remove?.(); } catch {}
        throw new Error('Variable Snapshot Import factory returned invalid native identity.');
      }
      const entry = {
        kind, handle, id: resource.id, ownerId, resource, journalIndex: journal.length,
      };
      journalIds.add(resource.id); journal.push(entry); return resource;
    };
    try {
      for (const sourceCollection of SOURCE.collections) {
        let collection = journaled('collection', sourceCollection.handle,
          figma.variables.createVariableCollection(sourceCollection.name));
        collection = validateCollection(collection);
        if (collection.name !== sourceCollection.name || collection.modes.length !== 1) {
          throw new Error('Variable Snapshot Import Collection factory returned incompatible topology.');
        }
        const firstMode = sourceCollection.modes[0];
        const nativeDefaultId = collection.defaultModeId;
        if (collection.modes[0].name !== firstMode.name) {
          collection.renameMode(nativeDefaultId, firstMode.name);
        }
        modeByHandle.set(firstMode.handle, nativeDefaultId);
        for (const sourceMode of sourceCollection.modes.slice(1)) {
          const modeId = collection.addMode(sourceMode.name);
          if (!validId(modeId)) throw new Error('Variable Snapshot Import addMode returned invalid identity.');
          modeByHandle.set(sourceMode.handle, modeId);
        }
        collection.hiddenFromPublishing = sourceCollection.hiddenFromPublishing;
        collectionByHandle.set(sourceCollection.handle, collection);
      }

      for (const sourceCollection of SOURCE.collections) {
        const collection = collectionByHandle.get(sourceCollection.handle);
        for (const sourceVariable of sourceCollection.variables) {
          const variable = journaled('variable', sourceVariable.handle,
            figma.variables.createVariable(sourceVariable.name, collection, sourceVariable.type),
            collection.id);
          if (variable.name !== sourceVariable.name || variable.resolvedType !== sourceVariable.type
            || variable.remote || variable.variableCollectionId !== collection.id) {
            throw new Error('Variable Snapshot Import Variable factory returned incompatible identity.');
          }
          variable.description = sourceVariable.description;
          variable.hiddenFromPublishing = sourceVariable.hiddenFromPublishing;
          if (!['EASING', 'TIMING'].includes(sourceVariable.type)) {
            variable.scopes = [...sourceVariable.scopes];
          }
          for (const [platform, syntax] of Object.entries(sourceVariable.codeSyntax)) {
            variable.setVariableCodeSyntax(platform, syntax);
          }
          variableByHandle.set(sourceVariable.handle, variable);
        }
      }

      let aliasCount = 0;
      for (const sourceCollection of SOURCE.collections) {
        for (const sourceVariable of sourceCollection.variables) {
          const variable = variableByHandle.get(sourceVariable.handle);
          for (const [modeHandle, sourceValue] of Object.entries(sourceVariable.values)) {
            if (sourceValue?.$alias?.status === 'local') continue;
            variable.setValueForMode(modeByHandle.get(modeHandle), sourceValue);
          }
        }
      }
      for (const sourceCollection of SOURCE.collections) {
        for (const sourceVariable of sourceCollection.variables) {
          const variable = variableByHandle.get(sourceVariable.handle);
          for (const [modeHandle, sourceValue] of Object.entries(sourceVariable.values)) {
            if (sourceValue?.$alias?.status !== 'local') continue;
            const target = variableByHandle.get(sourceValue.$alias.variable);
            if (!target) throw new Error('Variable Snapshot Import local Alias target disappeared.');
            variable.setValueForMode(modeByHandle.get(modeHandle),
              figma.variables.createVariableAlias(target));
            aliasCount += 1;
          }
        }
      }

      for (const sourceCollection of SOURCE.collections) {
        const expectedCollection = collectionByHandle.get(sourceCollection.handle);
        const actualCollection = validateCollection(
          await figma.variables.getVariableCollectionByIdAsync(expectedCollection.id));
        const expectedModes = sourceCollection.modes.map((mode) => ({
          modeId: modeByHandle.get(mode.handle), name: mode.name,
        }));
        if (actualCollection.id !== expectedCollection.id
          || actualCollection.name !== sourceCollection.name
          || actualCollection.hiddenFromPublishing !== sourceCollection.hiddenFromPublishing
          || actualCollection.defaultModeId !== modeByHandle.get(sourceCollection.defaultMode)
          || !equivalent(actualCollection.modes, expectedModes)) {
          throw new Error('Variable Snapshot Import could not verify Collection topology.');
        }
        const expectedVariables = sourceCollection.variables.map((sourceVariable) =>
          variableByHandle.get(sourceVariable.handle));
        const actualVariables = await loadVariables(expectedVariables.map((variable) => variable.id));
        const membership = new Set(actualCollection.variableIds);
        if (actualCollection.variableIds.length !== expectedVariables.length) {
          throw new Error('Variable Snapshot Import Collection membership changed.');
        }
        for (let index = 0; index < sourceCollection.variables.length; index++) {
          const sourceVariable = sourceCollection.variables[index];
          const expectedVariable = expectedVariables[index];
          const actual = actualVariables[index];
          if (!actual || actual.id !== expectedVariable.id || !membership.has(actual.id)
            || actual.name !== sourceVariable.name || actual.resolvedType !== sourceVariable.type
            || actual.remote || actual.variableCollectionId !== actualCollection.id
            || actual.description !== sourceVariable.description
            || actual.hiddenFromPublishing !== sourceVariable.hiddenFromPublishing
            || !equivalent(actual.scopes, sourceVariable.scopes)
            || !equivalent(actual.codeSyntax, sourceVariable.codeSyntax)) {
            throw new Error('Variable Snapshot Import could not verify Variable metadata.');
          }
          const expectedModeIds = new Set(Object.keys(sourceVariable.values)
            .map((handle) => modeByHandle.get(handle)));
          const actualModeIds = Object.keys(actual.valuesByMode || {});
          if (actualModeIds.length !== expectedModeIds.size
            || actualModeIds.some((modeId) => !expectedModeIds.has(modeId))) {
            throw new Error('Variable Snapshot Import could not verify exact mode values.');
          }
          for (const [modeHandle, sourceValue] of Object.entries(sourceVariable.values)) {
            const actualValue = actual.valuesByMode[modeByHandle.get(modeHandle)];
            if (sourceValue?.$alias?.status === 'local') {
              const target = variableByHandle.get(sourceValue.$alias.variable);
              if (!actualValue || actualValue.type !== 'VARIABLE_ALIAS'
                || actualValue.id !== target.id) {
                throw new Error('Variable Snapshot Import could not verify a local Alias.');
              }
            } else if (!valueEquivalent(actualValue, sourceValue, sourceVariable.type)) {
              throw new Error('Variable Snapshot Import could not verify a literal value.');
            }
          }
        }
      }
      return bounded({ schemaVersion: 1, status: 'complete',
        collections: SOURCE.collections.length,
        variables: SOURCE.collections.reduce((sum, collection) => sum + collection.variables.length, 0),
        aliases: aliasCount, residue: 0 });
    } catch (error) {
      if (!journal.length) throw error;
      const attempted = journal.map(({ kind, handle, id, journalIndex }) => ({
        kind, handle, id, journalIndex,
      }));
      const ownedVariablesByCollection = new Map();
      for (const entry of journal) {
        if (entry.kind !== 'variable') continue;
        const ids = ownedVariablesByCollection.get(entry.ownerId) || new Set();
        ids.add(entry.id); ownedVariablesByCollection.set(entry.ownerId, ids);
      }
      for (let index = journal.length - 1; index >= 0; index--) {
        const entry = journal[index];
        try {
          if (entry.kind === 'collection') {
            const current = await figma.variables.getVariableCollectionByIdAsync(entry.id);
            if (!current) continue;
            if (!Array.isArray(current.variableIds) || current.variableIds.length > 100000
              || current.variableIds.some((id) => !validId(id))
              || new Set(current.variableIds).size !== current.variableIds.length
              || current.variableIds.some((id) =>
                !ownedVariablesByCollection.get(entry.id)?.has(id))) continue;
          }
          entry.resource.remove();
        } catch {}
      }
      let checks = null;
      try {
        const [freshCollections, freshVariables] = await Promise.all([
          figma.variables.getLocalVariableCollectionsAsync(),
          figma.variables.getLocalVariablesAsync(),
        ]);
        if (!Array.isArray(freshCollections) || freshCollections.length > 100000
          || freshCollections.some((entry) => !entry || !validId(entry.id)
            || !Array.isArray(entry.variableIds) || entry.variableIds.length > 100000
            || entry.variableIds.some((id) => !validId(id))
            || new Set(entry.variableIds).size !== entry.variableIds.length)
          || new Set(freshCollections.map((entry) => entry.id)).size !== freshCollections.length
          || !Array.isArray(freshVariables) || freshVariables.length > 100000
          || freshVariables.some((entry) => !entry || !validId(entry.id)
            || !validId(entry.variableCollectionId))
          || new Set(freshVariables.map((entry) => entry.id)).size !== freshVariables.length) {
          throw new Error('invalid cleanup catalog');
        }
        const collectionsById = new Map(freshCollections.map((entry) => [entry.id, entry]));
        const variablesById = new Map(freshVariables.map((entry) => [entry.id, entry]));
        checks = journal.map((entry) => {
          if (entry.kind === 'collection') return collectionsById.get(entry.id) || null;
          const variable = variablesById.get(entry.id) || null;
          const owner = collectionsById.get(entry.ownerId) || null;
          const membershipHasId = owner?.variableIds.includes(entry.id) === true;
          if ((variable !== null) !== membershipHasId
            || (variable && variable.variableCollectionId !== entry.ownerId)) {
            throw new Error('incoherent cleanup membership');
          }
          return variable;
        });
      } catch { checks = null; }
      const verifiable = Array.isArray(checks) && checks.length === attempted.length;
      const residue = verifiable ? attempted.filter((_entry, index) => checks[index] !== null) : attempted;
      const removed = verifiable ? attempted.filter((_entry, index) => checks[index] === null) : [];
      const outcome = !verifiable ? 'verification-unavailable'
        : residue.length ? 'partial-residue' : 'rolled-back';
      return bounded({ schemaVersion: 1, status: 'failed', outcome,
        attempted: attempted.length, removed: removed.map((entry) => entry.journalIndex),
        residue: { total: residue.length, indexes: residue.map((entry) => entry.journalIndex),
          items: residue.slice(0, MAX_FAILURE_ITEMS),
          omitted: Math.max(0, residue.length - MAX_FAILURE_ITEMS) },
        failure: String(error?.message || 'mutation failed').slice(0, 1024) });
    }
  })()`;
  if (evalTransportEnvelopeError(code)) {
    throw new Error('Variable Snapshot v2 exact import exceeds an authenticated 5 MiB transport envelope after JSON encoding. Export or import a smaller snapshot.');
  }
  return code;
}

const nativeId = (value) => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(value);
const handle = (value) => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/.test(value);

function validPayload(value, snapshot) {
  const collectionCount = snapshot.collections.length;
  const variableCount = snapshot.collections.reduce((sum, collection) =>
    sum + collection.variables.length, 0);
  const aliasCount = snapshot.collections.reduce((sum, collection) => sum
    + collection.variables.reduce((inner, variable) => inner
      + Object.values(variable.values).filter((entry) => entry?.$alias?.status === 'local').length, 0), 0);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1) return false;
  if (value.status === 'complete') {
    return Object.keys(value).sort().join(',')
        === 'aliases,collections,residue,schemaVersion,status,variables'
      && value.collections === collectionCount && value.variables === variableCount
      && value.aliases === aliasCount && value.residue === 0;
  }
  if (value.status !== 'failed'
    || Object.keys(value).sort().join(',')
      !== 'attempted,failure,outcome,removed,residue,schemaVersion,status'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !Number.isSafeInteger(value.attempted) || value.attempted < 1
    || value.attempted > collectionCount + variableCount
    || !Array.isArray(value.removed) || new Set(value.removed).size !== value.removed.length
    || !value.residue || typeof value.residue !== 'object' || Array.isArray(value.residue)
    || Object.keys(value.residue).sort().join(',') !== 'indexes,items,omitted,total'
    || !Number.isSafeInteger(value.residue.total) || value.residue.total < 0
    || value.residue.total > value.attempted
    || !Array.isArray(value.residue.indexes)
    || value.residue.indexes.length !== value.residue.total
    || new Set(value.residue.indexes).size !== value.residue.indexes.length
    || !Array.isArray(value.residue.items)
    || value.residue.items.length !== Math.min(value.residue.total, MAX_FAILURE_ITEMS)
    || !Number.isSafeInteger(value.residue.omitted)
    || value.residue.omitted !== value.residue.total - value.residue.items.length
    || typeof value.failure !== 'string' || value.failure.length > 1024) return false;
  const indexes = [...value.removed, ...value.residue.indexes];
  if (indexes.length !== value.attempted || new Set(indexes).size !== value.attempted
    || indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= value.attempted)) {
    return false;
  }
  const expectedJournal = [
    ...snapshot.collections.map((collection) => ({
      kind: 'collection', handle: collection.handle,
    })),
    ...snapshot.collections.flatMap((collection) => collection.variables.map((variable) => ({
      kind: 'variable', handle: variable.handle,
    }))),
  ];
  if (value.residue.items.some((item, itemIndex) => {
    const expectedIndex = value.residue.indexes[itemIndex];
    const expected = expectedJournal[expectedIndex];
    return !item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'handle,id,journalIndex,kind'
      || !['collection', 'variable'].includes(item.kind) || !handle(item.handle)
      || !nativeId(item.id) || !Number.isSafeInteger(item.journalIndex)
      || item.journalIndex !== expectedIndex || !expected
      || item.kind !== expected.kind || item.handle !== expected.handle;
  })) return false;
  return value.removed.length + value.residue.total === value.attempted
    && (value.outcome === 'rolled-back' ? value.residue.total === 0
      : value.outcome === 'partial-residue' ? value.residue.total > 0
        : value.removed.length === 0 && value.residue.total === value.attempted);
}

function mutationFailure(payload) {
  const reason = payload.failure.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/gu, '�');
  const error = new Error(payload.outcome === 'rolled-back'
    ? `Variable Snapshot Import failed and was rolled back: ${reason}`
    : `Variable Snapshot Import failed; command-created resources may remain: ${reason}`);
  error.kind = 'execution'; error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch'; error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.mutationReport = { version: 1, outcome: payload.outcome,
    created: payload.attempted, removed: payload.removed.length,
    residueCount: payload.residue.total,
    residue: payload.residue.items.map((item) => ({
      kind: item.kind, handle: item.id,
      reason: payload.outcome === 'verification-unavailable'
        ? 'verification-unavailable' : 'remove-failed',
    })), residueTruncated: payload.residue.omitted > 0 };
  throw error;
}

export async function executeVariableSnapshotImport(source, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Variable Snapshot Import requires evaluate(code).');
  }
  const snapshot = normalizedSource(source);
  const serialized = await adapters.evaluate(variableSnapshotImportCode(snapshot));
  if (typeof serialized !== 'string' || serialized.length > MAX_RESULT_CODE_UNITS) {
    throw new Error('Variable Snapshot Import returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Snapshot Import returned invalid JSON.'); }
  if (!validPayload(payload, snapshot)) {
    throw new Error('Variable Snapshot Import returned an invalid bounded result.');
  }
  if (payload.status === 'failed') mutationFailure(payload);
  return {
    stdout: `Imported ${payload.variables} Variable(s) across ${payload.collections} Collection(s); wired ${payload.aliases} Alias value(s).`,
    stderr: '', result: payload,
  };
}
