// Bounded, journaled neutral Token Preset Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseTokenPresetRequest,
  tokenPresetArgvFromRequest,
  tokenPresetPlanningArgvFromRequest,
} from './token-preset-request.js';

export { tokenPresetArgvFromRequest, tokenPresetPlanningArgvFromRequest } from './token-preset-request.js';

const APPLICATION_IDS = new Set(['tokens.spacing', 'tokens.radii']);
const MAX_CANDIDATES = 100_000;
const MAX_MODES = 1_000;
const MAX_STRING = 1_024;
const MAX_ITEMS = 64;
export const MAX_TOKEN_PRESET_SERIALIZED_CODE_UNITS = 1_000_000;

const PRESETS = Object.freeze({
  spacing: Object.freeze({
    scope: 'GAP', prefix: 'spacing', output: 'spacing variables',
    values: Object.freeze({
      '0': 0, '0.5': 2, '1': 4, '1.5': 6, '2': 8, '2.5': 10,
      '3': 12, '3.5': 14, '4': 16, '5': 20, '6': 24, '7': 28,
      '8': 32, '9': 36, '10': 40, '11': 44, '12': 48,
      '14': 56, '16': 64, '20': 80, '24': 96, '28': 112,
      '32': 128, '36': 144, '40': 160, '44': 176, '48': 192,
    }),
  }),
  radii: Object.freeze({
    scope: 'CORNER_RADIUS', prefix: 'radius', output: 'radius variables',
    values: Object.freeze({
      none: 0, sm: 2, default: 4, md: 6, lg: 8,
      xl: 12, '2xl': 16, '3xl': 24, full: 9999,
    }),
  }),
});

function normalizedRequest(request) {
  return parseTokenPresetRequest(tokenPresetArgvFromRequest(request));
}

function presetItems(input) {
  const preset = PRESETS[input.preset];
  return Object.entries(preset.values).map(([suffix, value], index) => ({
    index, name: `${preset.prefix}/${suffix}`, value,
  }));
}

export function tokenPresetCommandCode(request) {
  const input = normalizedRequest(request);
  const preset = PRESETS[input.preset];
  const items = presetItems(input);
  return `(async () => {
    const preset = ${JSON.stringify(input.preset)};
    const collectionName = ${JSON.stringify(input.collection)};
    const requiredScope = ${JSON.stringify(preset.scope)};
    const items = ${JSON.stringify(items)};
    const beforeCollections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(beforeCollections) || beforeCollections.length > ${MAX_CANDIDATES}
    ) {
      throw new Error('Token Preset candidate limit exceeded.');
    }
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_STRING} && (empty || value.length > 0);
    if (new Set(beforeCollections.map((item) => item.id)).size !== beforeCollections.length) {
      throw new Error('Token Preset encountered duplicate native identities.');
    }
    const loadVariables = async (ids) => {
      const loaded = [];
      for (let start = 0; start < ids.length; start += 64) {
        loaded.push(...await Promise.all(ids.slice(start, start + 64)
          .map((id) => figma.variables.getVariableByIdAsync(id))));
      }
      return loaded;
    };
    const collectionMatches = beforeCollections.filter((item) => item.name === collectionName);
    if (collectionMatches.length > 1) {
      throw new Error('Token Preset Collection name is ambiguous.');
    }
    const validateCollection = (collection) => {
      if (!collection || !validText(collection.id, false) || collection.name !== collectionName
        || collection.remote || !validText(collection.defaultModeId, false)
        || !Array.isArray(collection.modes) || collection.modes.length < 1
        || collection.modes.length > ${MAX_MODES}
        || !Array.isArray(collection.variableIds)
        || collection.variableIds.length > ${MAX_CANDIDATES}
        || collection.variableIds.some((id) => !validText(id, false))
        || new Set(collection.variableIds).size !== collection.variableIds.length
        || collection.modes.some((mode) => !mode || !validText(mode.modeId, false)
          || !validText(mode.name))
        || new Set(collection.modes.map((mode) => mode.modeId)).size !== collection.modes.length
        || !collection.modes.some((mode) => mode.modeId === collection.defaultModeId)) {
        throw new Error('Token Preset encountered invalid Collection metadata.');
      }
      return collection.modes.find((mode) => mode.modeId === collection.defaultModeId);
    };
    let collection = collectionMatches[0] || null;
    let mode = collection ? validateCollection(collection) : null;
    const expectedNames = new Set(items.map((item) => item.name));
    const collectionVariables = collection ? await loadVariables(collection.variableIds) : [];
    if (collectionVariables.some((variable, index) => !variable
      || variable.id !== collection.variableIds[index])) {
      throw new Error('Token Preset could not load exact Collection Variable membership.');
    }
    const beforeOwned = collectionVariables.filter((variable) => expectedNames.has(variable.name));
    if (beforeOwned.some((variable) => !validText(variable.id, false)
      || !validText(variable.name, false) || variable.remote
      || !validText(variable.resolvedType, false) || !variable.valuesByMode
      || typeof variable.valuesByMode !== 'object' || Array.isArray(variable.valuesByMode)
      || !Array.isArray(variable.scopes) || variable.scopes.length > 32
      || variable.scopes.some((scope) => !validText(scope, false)))) {
      throw new Error('Token Preset encountered invalid Variable metadata.');
    }
    for (const item of items) {
      if (beforeOwned.filter((variable) => variable.name === item.name).length > 1) {
        throw new Error('Token Preset Variable name is ambiguous in the target Collection.');
      }
    }
    const equivalent = (actual, expected) => typeof actual === 'number'
      && Number.isFinite(actual) && Math.fround(actual) === Math.fround(expected);
    const stateFor = (variable, item) => {
      const hasValue = Object.prototype.hasOwnProperty.call(variable.valuesByMode, mode.modeId);
      if (variable.resolvedType !== 'FLOAT') return 'wrong-type';
      if (!hasValue) return 'missing-value';
      if (!equivalent(variable.valuesByMode[mode.modeId], item.value)) return 'different-value';
      return variable.scopes.includes(requiredScope) || variable.scopes.includes('ALL_SCOPES')
        ? 'matching' : 'scope-mismatch';
    };
    const compactVariable = (variable, item, state) => ({
      index: item.index, id: variable.id, name: variable.name,
      resolvedType: variable.resolvedType,
      variableCollectionId: variable.variableCollectionId, state,
    });
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_TOKEN_PRESET_SERIALIZED_CODE_UNITS}) {
        throw new Error('Token Preset result exceeded the bounded result limit.');
      }
      return serialized;
    };
    const journal = [];
    const journaled = (kind, resource, name) => {
      if (!resource || typeof resource.remove !== 'function' || !validText(resource.id, false)
        || journal.some((entry) => entry.id === resource.id)) {
        try { resource?.remove?.(); } catch {}
        throw new Error('Token Preset factory returned invalid native identity.');
      }
      journal.push({ kind, resource, id: resource.id, name });
      return resource;
    };
    try {
      let collectionCreated = false;
      if (!collection) {
        collection = journaled('collection',
          figma.variables.createVariableCollection(collectionName), collectionName);
        collectionCreated = true;
        mode = validateCollection(collection);
      }
      const existingEntries = [];
      const createdEntries = [];
      for (const item of items) {
        const present = beforeOwned.find((variable) => variable.name === item.name);
        if (present) {
          existingEntries.push({ variable: present, item });
          continue;
        }
        const variable = journaled('variable',
          figma.variables.createVariable(item.name, collection, 'FLOAT'), item.name);
        createdEntries.push({ variable, item });
        variable.scopes = [requiredScope];
        variable.setValueForMode(mode.modeId, item.value);
      }
      const afterCollection = await figma.variables.getVariableCollectionByIdAsync(collection.id);
      if (!afterCollection) {
        throw new Error('Token Preset could not verify its target Collection.');
      }
      const afterMode = validateCollection(afterCollection);
      if (afterMode.modeId !== mode.modeId) {
        throw new Error('Token Preset default mode changed during execution.');
      }
      const verificationIds = [
        ...createdEntries.map((entry) => entry.variable.id),
        ...existingEntries.map((entry) => entry.variable.id),
      ];
      const verifiedVariables = await loadVariables(verificationIds);
      if (verifiedVariables.some((variable, index) => !variable
        || variable.id !== verificationIds[index])
        || new Set(verificationIds).size !== verificationIds.length
        || verificationIds.some((id) => !afterCollection.variableIds.includes(id))) {
        throw new Error('Token Preset verification returned stale Variable identity.');
      }
      const byId = new Map(verifiedVariables.map((variable) => [variable.id, variable]));
      const created = [];
      for (const entry of createdEntries) {
        const variable = byId.get(entry.variable.id);
        if (!variable || variable.name !== entry.item.name || variable.remote
          || variable.resolvedType !== 'FLOAT' || variable.variableCollectionId !== collection.id
          || !Array.isArray(variable.scopes) || variable.scopes.length !== 1
          || variable.scopes[0] !== requiredScope || !variable.valuesByMode
          || !equivalent(variable.valuesByMode[mode.modeId], entry.item.value)) {
          throw new Error('Token Preset could not verify one created Variable.');
        }
        created.push(compactVariable(variable, entry.item, 'created'));
      }
      const existing = [];
      for (const entry of existingEntries) {
        const variable = byId.get(entry.variable.id);
        if (!variable || variable.name !== entry.item.name || variable.remote
          || variable.variableCollectionId !== collection.id || !variable.valuesByMode
          || typeof variable.valuesByMode !== 'object' || Array.isArray(variable.valuesByMode)
          || !Array.isArray(variable.scopes) || variable.scopes.length > 32
          || variable.scopes.some((scope) => !validText(scope, false))) {
          throw new Error('Token Preset verification returned stale existing Variable facts.');
        }
        existing.push(compactVariable(variable, entry.item, stateFor(variable, entry.item)));
      }
      return bounded({
        schemaVersion: 1, status: 'created', preset,
        collection: { id: collection.id, name: collection.name, created: collectionCreated },
        mode: { id: afterMode.modeId, name: afterMode.name }, expectedCount: items.length,
        created, existing,
        conflictCount: existing.filter((item) => item.state !== 'matching').length,
        residue: [],
      });
    } catch (error) {
      if (!journal.length) throw error;
      const attempted = journal.map(({ kind, id, name }) => ({ kind, id, name }));
      for (let index = journal.length - 1; index >= 0; index--) {
        try { journal[index].resource.remove(); } catch {}
      }
      let checks;
      try {
        checks = await Promise.all(attempted.map((item) => item.kind === 'collection'
          ? figma.variables.getVariableCollectionByIdAsync(item.id)
          : figma.variables.getVariableByIdAsync(item.id)));
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
function validVariable(value, input, states) {
  const items = presetItems(input);
  return exactKeys(value, ['index', 'id', 'name', 'resolvedType', 'variableCollectionId', 'state'])
    && Number.isSafeInteger(value.index) && value.index >= 0 && value.index < items.length
    && text(value.id, false) && value.name === items[value.index].name
    && text(value.resolvedType, false) && text(value.variableCollectionId, false)
    && states.includes(value.state);
}
function uniqueVariables(values, input, states) {
  return Array.isArray(values) && values.length <= MAX_ITEMS
    && values.every((item) => validVariable(item, input, states))
    && new Set(values.map((item) => item.id)).size === values.length
    && new Set(values.map((item) => item.index)).size === values.length;
}
function validSuccess(value, input) {
  const itemCount = presetItems(input).length;
  return exactKeys(value, ['schemaVersion', 'status', 'preset', 'collection', 'mode',
    'expectedCount', 'created', 'existing', 'conflictCount', 'residue'])
    && value.schemaVersion === 1 && value.status === 'created' && value.preset === input.preset
    && exactKeys(value.collection, ['id', 'name', 'created'])
    && text(value.collection.id, false) && value.collection.name === input.collection
    && typeof value.collection.created === 'boolean'
    && exactKeys(value.mode, ['id', 'name']) && text(value.mode.id, false) && text(value.mode.name)
    && value.expectedCount === itemCount
    && uniqueVariables(value.created, input, ['created'])
    && value.created.every((item) => item.resolvedType === 'FLOAT')
    && uniqueVariables(value.existing, input,
      ['matching', 'missing-value', 'different-value', 'scope-mismatch', 'wrong-type'])
    && value.existing.every((item) => item.state === 'wrong-type'
      ? item.resolvedType !== 'FLOAT' : item.resolvedType === 'FLOAT')
    && new Set([...value.created, ...value.existing].map((item) => item.id)).size === itemCount
    && [...value.created, ...value.existing].every((item) =>
      item.variableCollectionId === value.collection.id)
    && new Set([...value.created, ...value.existing].map((item) => item.index)).size === itemCount
    && value.created.length + value.existing.length === itemCount
    && (!value.collection.created
      || (value.existing.length === 0 && value.created.length === itemCount))
    && Number.isSafeInteger(value.conflictCount) && value.conflictCount >= 0
    && value.conflictCount === value.existing.filter((item) => item.state !== 'matching').length
    && Array.isArray(value.residue) && value.residue.length === 0;
}
function validResource(value) {
  return exactKeys(value, ['kind', 'id', 'name'])
    && ['collection', 'variable'].includes(value.kind)
    && text(value.id, false) && text(value.name, false);
}
function uniqueResources(values) {
  return Array.isArray(values) && values.length <= MAX_ITEMS + 1
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
  const expectedNames = new Set(presetItems(input).map((item) => item.name));
  const collections = value.attempted.filter((item) => item.kind === 'collection');
  const variables = value.attempted.filter((item) => item.kind === 'variable');
  if (collections.length > 1 || (collections.length === 1
    && (value.attempted[0] !== collections[0] || collections[0].name !== input.collection))
    || variables.length > expectedNames.size
    || variables.some((item) => !expectedNames.has(item.name))
    || new Set(variables.map((item) => item.name)).size !== variables.length) return false;
  const partition = [...value.removed, ...value.residue];
  return partition.length === value.attempted.length
    && value.attempted.every((item) => partition.filter((entry) => entry.id === item.id
      && entry.kind === item.kind && entry.name === item.name).length === 1)
    && (value.outcome === 'rolled-back' ? value.residue.length === 0
      : value.outcome === 'partial-residue' ? value.residue.length > 0
        : value.removed.length === 0 && value.residue.length === value.attempted.length);
}

export async function executeTokenPreset(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeTokenPreset requires evaluate(code)');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(tokenPresetCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_TOKEN_PRESET_SERIALIZED_CODE_UNITS) {
    throw new Error('Token Preset returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw new Error('Token Preset returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Token Preset returned an invalid bounded result.');
    const error = new Error(payload.outcome === 'rolled-back'
      ? 'Token Preset failed; every command-created resource was removed.'
      : 'Token Preset failed; one or more command-created resources may remain.');
    error.kind = 'execution'; error.phase = 'plugin-execution'; error.outcome = 'unknown-after-dispatch';
    error.dispatchState = 'failed'; error.mutationOutcome = payload.outcome;
    error.mutationReport = { version: 1, outcome: payload.outcome,
      created: payload.attempted.length, removed: payload.removed.length,
      residueCount: payload.residue.length,
      residue: payload.residue.map((item) => ({ kind: item.kind, handle: item.id,
        reason: payload.outcome === 'verification-unavailable' ? 'verification-unavailable' : 'remove-failed' })),
      residueTruncated: false };
    throw error;
  }
  if (!validSuccess(payload, input)) throw new Error('Token Preset returned an invalid bounded result.');
  const output = PRESETS[input.preset].output;
  return {
    stdout: `Created ${payload.created.length} ${output}`,
    stderr: payload.conflictCount
      ? `Preserved ${payload.conflictCount} existing preset variables with missing, different, or incompatible values.` : '',
    result: payload,
  };
}

export function tokenPresetPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Token Preset routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-token-preset';
}

export async function executeTokenPresetPlan(plan, adapters = {}) {
  if (tokenPresetPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Preset.`);
  }
  return executeTokenPreset(parseTokenPresetRequest(plan.argv), adapters);
}
