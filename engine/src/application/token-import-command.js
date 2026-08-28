// Bounded, preflighted and journaled Single-Collection Token Import Application.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { variableScopeDecision, variableScopesForToken } from '../lib/variable-scope-policy.js';
import { MOTION_EASING_NUMBER_SCALE } from '../lib/motion-easing.js';
import {
  parseTokenImportRequest,
  tokenImportArgvFromRequest,
  tokenImportPlanningArgvFromRequest,
} from './token-import-request.js';
import {
  MAX_TOKEN_IMPORT_ITEMS,
  normalizeTokenImportItems,
  readTokenImportSource,
} from './token-import-source.js';

export { tokenImportArgvFromRequest, tokenImportPlanningArgvFromRequest } from './token-import-request.js';

const APPLICATION_ID = 'tokens.import';
const MAX_CANDIDATES = 100_000;
const MAX_MODES = 1_000;
const MAX_TEXT = 16_384;
const MAX_REPORT_ITEMS = 200;
const MAX_NATIVE_ID = 512;
const MAX_FAILURE_RESIDUE_ITEMS = 64;
export const MAX_TOKEN_IMPORT_SERIALIZED_CODE_UNITS = 262_144;

function normalizedPrepared(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.request || !Array.isArray(value.items)
    || value.items.length < 1 || value.items.length > MAX_TOKEN_IMPORT_ITEMS) {
    throw new TypeError('Token Import requires a prepared bounded source.');
  }
  const request = parseTokenImportRequest(tokenImportArgvFromRequest(value.request));
  return Object.freeze({ request, items: normalizeTokenImportItems(value.items) });
}

export function prepareTokenImportPlan(plan, { workspaceIO } = {}) {
  if (tokenImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Import.`);
  }
  const request = parseTokenImportRequest(plan.argv);
  return Object.freeze({ request, items: readTokenImportSource(request, workspaceIO) });
}

export function prepareTokenImportItems(plan, items) {
  if (tokenImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Import.`);
  }
  return prepareTokenImportRequestItems(parseTokenImportRequest(plan.argv), items);
}

/** Reuse the deep Single-Collection mutation after another owning Command
 * Application has produced the same closed token request and bounded items. */
export function prepareTokenImportRequestItems(request, items) {
  return normalizedPrepared({ request, items });
}

export function tokenImportCommandCode(prepared) {
  const input = normalizedPrepared(prepared);
  const items = input.items.map((item) => {
    const scopes = ['EASING', 'TIMING'].includes(item.type) ? null
      : item.scopes || variableScopesForToken(item.name, item.type) || ['ALL_SCOPES'];
    return { ...item, scopes };
  });
  return `(async () => {
    const collectionName = ${JSON.stringify(input.request.collection)};
    const items = ${JSON.stringify(items)};
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_TEXT} && (empty || value.length > 0);
    const validId = (value) => typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,${MAX_NATIVE_ID - 1}}$/.test(value);
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
    const easingEquivalent = (actual, expected) => {
      if (typeof actual === 'number' && typeof expected === 'number') {
        return equivalent(actual, expected)
          || Math.round(actual * ${MOTION_EASING_NUMBER_SCALE})
            === Math.round(expected * ${MOTION_EASING_NUMBER_SCALE});
      }
      if (actual === null || expected === null || typeof actual !== 'object'
        || typeof expected !== 'object') return Object.is(actual, expected);
      if (Array.isArray(actual) !== Array.isArray(expected)) return false;
      const a = Object.keys(actual).sort(); const b = Object.keys(expected).sort();
      return a.length === b.length && a.every((key, index) => key === b[index]
        && easingEquivalent(actual[key], expected[key]));
    };
    const valueEquivalent = (actual, expected, type) => {
      if (type === 'EASING') {
        if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object'
          || Array.isArray(actual) || Array.isArray(expected) || actual.type !== expected.type
          || Object.keys(actual).some((key) => !['type', 'easingFunctionCubicBezier',
            'easingFunctionSpring'].includes(key))) return false;
        if (Object.hasOwn(expected, 'easingFunctionCubicBezier')) {
          return easingEquivalent(actual.easingFunctionCubicBezier, expected.easingFunctionCubicBezier);
        }
        if (Object.hasOwn(expected, 'easingFunctionSpring')) {
          return easingEquivalent(actual.easingFunctionSpring, expected.easingFunctionSpring);
        }
        return true;
      }
      if (type !== 'COLOR') return equivalent(actual, expected);
      const color = (value) => value && typeof value === 'object' && !Array.isArray(value)
        && ['r', 'g', 'b'].every((key) => Object.hasOwn(value, key));
      return color(actual) && color(expected)
        && ['r', 'g', 'b'].every((key) => equivalent(actual[key], expected[key]))
        && equivalent(Object.hasOwn(actual, 'a') ? actual.a : 1,
          Object.hasOwn(expected, 'a') ? expected.a : 1);
    };
    const summary = (values) => ({ total: values.length, items: values.slice(0, ${MAX_REPORT_ITEMS}),
      omitted: Math.max(0, values.length - ${MAX_REPORT_ITEMS}) });
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_TOKEN_IMPORT_SERIALIZED_CODE_UNITS}) {
        throw new Error('Token Import result exceeded the bounded result limit.');
      }
      return serialized;
    };
    const validateCollection = (collection) => {
      if (!collection || !validId(collection.id) || collection.name !== collectionName
        || collection.remote || !validId(collection.defaultModeId)
        || !Array.isArray(collection.modes) || collection.modes.length < 1
        || collection.modes.length > ${MAX_MODES}
        || collection.modes.some((mode) => !mode || !validId(mode.modeId)
          || !validText(mode.name))
        || new Set(collection.modes.map((mode) => mode.modeId)).size !== collection.modes.length
        || !collection.modes.some((mode) => mode.modeId === collection.defaultModeId)
        || !Array.isArray(collection.variableIds)
        || collection.variableIds.length > ${MAX_CANDIDATES}
        || collection.variableIds.some((id) => !validId(id))
        || new Set(collection.variableIds).size !== collection.variableIds.length) {
        throw new Error('Token Import encountered invalid Collection metadata.');
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
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(collections) || collections.length > ${MAX_CANDIDATES}
      || collections.some((collection) => !collection || !validId(collection.id)
        || !validText(collection.name))
      || new Set(collections.map((collection) => collection.id)).size !== collections.length) {
      throw new Error('Token Import encountered an invalid Collection catalog.');
    }
    const matches = collections.filter((collection) => collection.name === collectionName);
    if (matches.length > 1) throw new Error('Token Import Collection name is ambiguous.');
    let collection = matches[0] ? validateCollection(matches[0]) : null;
    const existing = collection ? await loadVariables(collection.variableIds) : [];
    if (existing.some((variable, index) => !variable
      || variable.id !== collection.variableIds[index] || !validId(variable.id)
      || !validText(variable.name) || variable.remote
      || variable.variableCollectionId !== collection.id)) {
      throw new Error('Token Import could not load exact Collection Variable membership.');
    }
    const byName = new Map();
    for (const variable of existing) {
      const list = byName.get(variable.name) || []; list.push(variable); byName.set(variable.name, list);
    }
    const conflicts = [];
    const existingModeId = collection?.defaultModeId || null;
    for (const item of items) {
      const found = byName.get(item.name) || [];
      if (found.length > 1) conflicts.push(item.name + ': ambiguous existing name');
      else if (found.length === 1 && found[0].resolvedType !== item.type) {
        conflicts.push(item.name + ': existing type differs');
      } else if (found.length === 1) {
        const variable = found[0];
        const actual = variable.valuesByMode && variable.valuesByMode[existingModeId];
        const target = item.alias ? (byName.get(item.alias) || []) : [];
        const valueMatches = item.alias
          ? target.length === 1 && actual && actual.type === 'VARIABLE_ALIAS'
            && actual.id === target[0].id
          : valueEquivalent(actual, item.value, item.type);
        if (!valueMatches || (item.scopes !== null && !equivalent(variable.scopes, item.scopes))
          || (Object.hasOwn(item, 'description') && variable.description !== item.description)
          || (Object.hasOwn(item, 'codeSyntax') && !equivalent(variable.codeSyntax, item.codeSyntax))) {
          conflicts.push(item.name + ': existing value or metadata differs');
        }
      }
    }
    if (conflicts.length) throw new Error('Token Import preflight conflicts: ' + conflicts.slice(0, 8).join(', '));
    const journal = [];
    const journalIds = new Set();
    const journaled = (kind, resource, name) => {
      if (!resource || typeof resource.remove !== 'function' || !validId(resource.id)
        || journalIds.has(resource.id)) {
        try { resource?.remove?.(); } catch {}
        throw new Error('Token Import factory returned invalid native identity.');
      }
      journalIds.add(resource.id);
      journal.push({ kind, resource, id: resource.id, name }); return resource;
    };
    try {
      let collectionCreated = false;
      if (!collection) {
        collection = journaled('collection',
          figma.variables.createVariableCollection(collectionName), collectionName);
        collection = validateCollection(collection); collectionCreated = true;
      }
      const modeId = collection.defaultModeId;
      const resolved = new Map(existing.map((variable) => [variable.name, variable]));
      const created = [];
      const createdIndexes = [];
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        if (resolved.has(item.name)) continue;
        const variable = journaled('variable',
          figma.variables.createVariable(item.name, collection, item.type), item.name);
        if (variable.name !== item.name || variable.resolvedType !== item.type || variable.remote
          || variable.variableCollectionId !== collection.id) {
          throw new Error('Token Import Variable factory returned incompatible identity.');
        }
        if (Object.hasOwn(item, 'description')) variable.description = item.description;
        if (item.scopes !== null) variable.scopes = [...item.scopes];
        for (const [platform, syntax] of Object.entries(item.codeSyntax || {})) {
          variable.setVariableCodeSyntax(platform, syntax);
        }
        resolved.set(item.name, variable); created.push(item.name); createdIndexes.push(itemIndex);
      }
      const createdNames = new Set(created);
      for (const item of items) {
        const variable = resolved.get(item.name);
        if (!createdNames.has(item.name)) continue;
        const value = item.alias
          ? figma.variables.createVariableAlias(resolved.get(item.alias)) : item.value;
        variable.setValueForMode(modeId, value);
      }
      const createdIndexSet = new Set(createdIndexes);
      const matchingIndexes = items.map((_item, index) => index)
        .filter((index) => !createdIndexSet.has(index));
      const verifiedCollection = validateCollection(
        await figma.variables.getVariableCollectionByIdAsync(collection.id));
      if (verifiedCollection.id !== collection.id || verifiedCollection.defaultModeId !== modeId) {
        throw new Error('Token Import Collection identity changed during verification.');
      }
      const expectedVariables = items.map((item) => resolved.get(item.name));
      const verified = await loadVariables(expectedVariables.map((variable) => variable.id));
      const verifiedMembership = new Set(verifiedCollection.variableIds);
      for (let index = 0; index < verified.length; index++) {
        const variable = verified[index]; const item = items[index];
        const expectedVariable = expectedVariables[index];
        const expected = item.alias ? resolved.get(item.alias) : null;
        const actual = variable?.valuesByMode?.[modeId];
        if (!variable || variable.id !== expectedVariable.id || variable.name !== item.name
          || variable.resolvedType !== item.type
          || variable.variableCollectionId !== verifiedCollection.id || variable.remote
          || !verifiedMembership.has(variable.id)
          || (Object.hasOwn(item, 'description') && variable.description !== item.description)
          || (item.scopes !== null && !equivalent(variable.scopes, item.scopes))
          || (Object.hasOwn(item, 'codeSyntax') && !equivalent(variable.codeSyntax, item.codeSyntax))
          || (item.alias ? !(actual && actual.type === 'VARIABLE_ALIAS' && actual.id === expected.id)
            : !valueEquivalent(actual, item.value, item.type))) {
          throw new Error('Token Import could not verify token ' + item.name + '.');
        }
      }
      return bounded({ schemaVersion: 1, status: 'complete', collection: {
        id: verifiedCollection.id, name: verifiedCollection.name,
        created: collectionCreated, modeId,
      }, created: { total: createdIndexes.length, indexes: createdIndexes },
      matching: { total: matchingIndexes.length, indexes: matchingIndexes }, residue: summary([]) });
    } catch (error) {
      if (!journal.length) throw error;
      const attempted = journal.map(({ kind, id, name }, journalIndex) => ({ kind, id, name, journalIndex }));
      const variableIds = new Set(journal.filter((entry) => entry.kind === 'variable').map((entry) => entry.id));
      for (let index = journal.length - 1; index >= 0; index--) {
        const entry = journal[index];
        try {
          if (entry.kind === 'collection') {
            const current = await figma.variables.getVariableCollectionByIdAsync(entry.id);
            if (current && (!Array.isArray(current.variableIds)
              || current.variableIds.some((id) => !variableIds.has(id)))) continue;
          }
          entry.resource.remove();
        } catch {}
      }
      let checks = null;
      try {
        const cleanupCollections = await figma.variables.getLocalVariableCollectionsAsync();
        if (!Array.isArray(cleanupCollections) || cleanupCollections.length > ${MAX_CANDIDATES}
          || cleanupCollections.some((candidate) => !candidate || !validId(candidate.id))
          || new Set(cleanupCollections.map((candidate) => candidate.id)).size
            !== cleanupCollections.length) {
          throw new Error('Token Import cleanup Collection catalog was unavailable.');
        }
        const cleanupCollection = cleanupCollections.find((candidate) => candidate.id === collection.id) || null;
        const membershipAvailable = cleanupCollection === null
          || (Array.isArray(cleanupCollection.variableIds)
            && cleanupCollection.variableIds.length <= ${MAX_CANDIDATES}
            && cleanupCollection.variableIds.every((id) => validId(id))
            && new Set(cleanupCollection.variableIds).size === cleanupCollection.variableIds.length);
        if (!membershipAvailable) throw new Error('Token Import cleanup membership was unavailable.');
        const cleanupMembership = new Set(cleanupCollection?.variableIds || []);
        checks = new Array(attempted.length);
        for (let index = 0; index < attempted.length; index++) {
          const entry = attempted[index];
          if (entry.kind === 'collection') checks[index] = cleanupCollection;
          else checks[index] = cleanupMembership.has(entry.id) ? entry : null;
        }
      } catch { checks = null; }
      const verifiable = Array.isArray(checks) && checks.length === attempted.length;
      const residue = verifiable ? attempted.filter((_item, index) => checks[index] !== null) : attempted;
      const removed = verifiable ? attempted.filter((_item, index) => checks[index] === null) : [];
      const outcome = !verifiable ? 'verification-unavailable'
        : residue.length ? 'partial-residue' : 'rolled-back';
      const residueItems = residue.slice(0, ${MAX_FAILURE_RESIDUE_ITEMS});
      return bounded({ schemaVersion: 1, status: 'failed', outcome,
        attempted: { total: attempted.length,
          collectionAttempted: attempted[0]?.kind === 'collection' },
        removed: { total: removed.length, indexes: removed.map((item) => item.journalIndex) },
        residue: { total: residue.length, indexes: residue.map((item) => item.journalIndex),
          items: residueItems, omitted: residue.length - residueItems.length },
        failure: String(error?.message || 'mutation failed').slice(0, 1024) });
    }
  })()`;
}

function summary(value, itemValidator) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.total) && value.total >= 0 && value.total <= MAX_CANDIDATES + 1
    && Array.isArray(value.items) && value.items.length <= MAX_REPORT_ITEMS
    && value.items.length === Math.min(value.total, MAX_REPORT_ITEMS)
    && value.items.every(itemValidator)
    && Number.isSafeInteger(value.omitted) && value.omitted === value.total - value.items.length;
}
function partition(value, length) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'indexes,total'
    && Number.isSafeInteger(value.total) && value.total >= 0 && value.total <= length
    && Array.isArray(value.indexes) && value.indexes.length === value.total
    && value.indexes.every((index) => Number.isSafeInteger(index) && index >= 0 && index < length)
    && new Set(value.indexes).size === value.indexes.length;
}
const text = (value, empty = true) => typeof value === 'string' && value.length <= MAX_TEXT
  && (empty || value.length > 0);
const nativeId = (value) => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(value);
const resource = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === 'id,journalIndex,kind,name'
  && Number.isSafeInteger(value.journalIndex) && value.journalIndex >= 0
  && ['collection', 'variable'].includes(value.kind)
  && nativeId(value.id)
  && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 512;

function validPayload(value, prepared) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return false;
  if (value.status === 'failed') {
    if (!(Object.keys(value).sort().join(',')
      === 'attempted,failure,outcome,removed,residue,schemaVersion,status'
      && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
      && value.attempted && Object.keys(value.attempted).sort().join(',') === 'collectionAttempted,total'
      && Number.isSafeInteger(value.attempted.total) && value.attempted.total > 0
      && value.attempted.total <= prepared.items.length
        + (value.attempted.collectionAttempted ? 1 : 0)
      && typeof value.attempted.collectionAttempted === 'boolean'
      && partition(value.removed, value.attempted.total)
      && value.residue && Object.keys(value.residue).sort().join(',') === 'indexes,items,omitted,total'
      && Number.isSafeInteger(value.residue.total) && value.residue.total >= 0
      && value.residue.total <= value.attempted.total
      && Array.isArray(value.residue.indexes) && value.residue.indexes.length === value.residue.total
      && value.residue.indexes.every((index) => Number.isSafeInteger(index)
        && index >= 0 && index < value.attempted.total)
      && new Set(value.residue.indexes).size === value.residue.indexes.length
      && Array.isArray(value.residue.items)
      && value.residue.items.length === Math.min(value.residue.total, MAX_FAILURE_RESIDUE_ITEMS)
      && value.residue.items.every(resource)
      && value.residue.items.every((item, index) => item.journalIndex === value.residue.indexes[index])
      && Number.isSafeInteger(value.residue.omitted)
      && value.residue.omitted === value.residue.total - value.residue.items.length
      && value.removed.total + value.residue.total === value.attempted.total && text(value.failure)
    && (value.outcome === 'rolled-back' ? value.residue.total === 0
      : value.outcome === 'partial-residue' ? value.residue.total > 0
        : value.removed.total === 0 && value.residue.total === value.attempted.total))) return false;
    const allIndexes = [...value.removed.indexes, ...value.residue.indexes];
    if (new Set(allIndexes).size !== value.attempted.total
      || !allIndexes.every((index) => index >= 0 && index < value.attempted.total)) return false;
    const preparedNames = new Set(prepared.items.map((item) => item.name));
    const variableFacts = value.residue.items.filter((item) => item.kind === 'variable');
    return new Set(variableFacts.map((item) => item.name)).size === variableFacts.length
      && value.residue.items.every((item) => item.kind === 'collection'
      ? value.attempted.collectionAttempted && item.journalIndex === 0
        && item.name === prepared.request.collection
      : preparedNames.has(item.name)
        && (!value.attempted.collectionAttempted || item.journalIndex !== 0));
  }
  if (Object.keys(value).sort().join(',') !== 'collection,created,matching,residue,schemaVersion,status') return false;
  if (!(value.status === 'complete' && value.collection
    && Object.keys(value.collection).sort().join(',') === 'created,id,modeId,name'
    && nativeId(value.collection.id)
    && value.collection.name === prepared.request.collection && typeof value.collection.created === 'boolean'
    && nativeId(value.collection.modeId)
    && partition(value.created, prepared.items.length)
    && partition(value.matching, prepared.items.length)
    && value.created.total + value.matching.total === prepared.items.length
    && summary(value.residue, resource) && value.residue.total === 0)) return false;
  if (value.collection.created
    && (value.created.total !== prepared.items.length || value.matching.total !== 0)) return false;
  const combined = [...value.created.indexes, ...value.matching.indexes];
  return new Set(combined).size === prepared.items.length
    && combined.every((index) => index >= 0 && index < prepared.items.length);
}

function mutationFailure(payload) {
  const safeFailure = String(payload.failure).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '�');
  const error = new Error(payload.outcome === 'rolled-back'
    ? `Token Import failed and was rolled back: ${safeFailure}`
    : `Token Import failed; one or more command-created resources may remain: ${safeFailure}`);
  error.kind = 'execution'; error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch'; error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.mutationReport = { version: 1, outcome: payload.outcome,
    created: payload.attempted.total, removed: payload.removed.total,
    residueCount: payload.residue.total,
    residue: payload.residue.items.map((item) => ({ kind: item.kind, handle: item.id,
      reason: payload.outcome === 'verification-unavailable' ? 'verification-unavailable' : 'remove-failed' })),
    residueTruncated: payload.residue.omitted > 0 };
  throw error;
}

function scopeWarnings(prepared) {
  const questions = prepared.items.filter((item) => !item.scopes)
    .map((item) => variableScopeDecision(item.name, item.type, prepared.request.collection))
    .filter((item) => item?.status === 'USER_DECISION_REQUIRED');
  if (!questions.length) return '';
  return `SCOPE DECISION REQUIRED for ${questions.length} imported token(s).\n`
    + 'Ask the user before narrowing them; current scopes remain ALL_SCOPES.';
}

export async function executeTokenImport(prepared, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeTokenImport requires evaluate(code)');
  const input = normalizedPrepared(prepared);
  const serialized = await adapters.evaluate(tokenImportCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_TOKEN_IMPORT_SERIALIZED_CODE_UNITS) {
    throw new Error('Token Import returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw new Error('Token Import returned invalid JSON.'); }
  if (!validPayload(payload, input)) throw new Error('Token Import returned an invalid bounded result.');
  if (payload.status === 'failed') mutationFailure(payload);
  return { stdout: `Imported ${payload.created.total} token(s); ${payload.matching.total} already matched in ${input.request.collection}.`,
    stderr: scopeWarnings(input), result: payload };
}

export function tokenImportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Token Import routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-token-import';
}

export async function executeTokenImportPlan(plan, prepared, adapters = {}) {
  if (tokenImportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Import.`);
  }
  if (!isDeepStrictEqual(prepared?.request, parseTokenImportRequest(plan.argv))) {
    throw new Error('Token Import prepared source does not match its Command Plan.');
  }
  return executeTokenImport(prepared, adapters);
}
