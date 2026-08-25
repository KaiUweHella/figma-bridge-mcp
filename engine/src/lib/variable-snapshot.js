// Closed, deeply canonical Variable Snapshot v2 contract.

import {
  normalizeVariableValue,
  parseVariableType,
} from '../lib/variable-management.js';
import { VARIABLE_SCOPES_BY_TYPE } from '../lib/variable-scope-policy.js';
import { parseBoundedJson } from '../lib/workspace-io.js';

export const MAX_VARIABLE_SNAPSHOT_COLLECTIONS = 1_000;
export const MAX_VARIABLE_SNAPSHOT_MODES = 1_000;
export const MAX_VARIABLE_SNAPSHOT_VARIABLES = 10_000;
export const MAX_VARIABLE_SNAPSHOT_SERIALIZED_BYTES = 8 * 1024 * 1024;
const MAX_IDENTITY = 512;
const MAX_DESCRIPTION = 16_384;
const MAX_SYNTAX = 1_024;
const UNSAFE_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/u;
const PLATFORM = new Set(['WEB', 'ANDROID', 'iOS']);

function sourceError(message) {
  return new Error(`Invalid Variable Snapshot v2: ${message}.`);
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function closed(value, required, optional = []) {
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function identity(value, label, { handle = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_IDENTITY
    || UNSAFE_CONTROLS.test(value) || (handle && !HANDLE.test(value))) {
    throw sourceError(`${label} is empty, unsafe, malformed, or too long`);
  }
  return value;
}

function optionalSourceKey(value, label) {
  if (value === undefined) return undefined;
  return identity(value, label);
}

function metadata(variable, type, label) {
  if (typeof variable.description !== 'string'
    || variable.description.length > MAX_DESCRIPTION) {
    throw sourceError(`${label} description must be bounded text`);
  }
  if (typeof variable.hiddenFromPublishing !== 'boolean') {
    throw sourceError(`${label} hiddenFromPublishing must be boolean`);
  }
  const allowedScopes = new Set(VARIABLE_SCOPES_BY_TYPE[type] || ['ALL_SCOPES']);
  if (!Array.isArray(variable.scopes) || variable.scopes.length > 32
    || new Set(variable.scopes).size !== variable.scopes.length
    || variable.scopes.some((scope) => typeof scope !== 'string'
      || !allowedScopes.has(scope))) {
    throw sourceError(`${label} scopes are duplicate, unknown, or incompatible with ${type}`);
  }
  if (!plain(variable.codeSyntax)
    || Object.keys(variable.codeSyntax).some((platform) => !PLATFORM.has(platform)
      || typeof variable.codeSyntax[platform] !== 'string'
      || variable.codeSyntax[platform].length > MAX_SYNTAX)) {
    throw sourceError(`${label} codeSyntax must contain only bounded WEB, ANDROID, or iOS text`);
  }
  return {
    description: variable.description,
    hiddenFromPublishing: variable.hiddenFromPublishing,
    scopes: [...variable.scopes],
    codeSyntax: { ...variable.codeSyntax },
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function normalizeVariableSnapshotV2(input) {
  if (!closed(input, ['schemaVersion', 'kind', 'complete', 'collections'])
    || input.schemaVersion !== 2 || input.kind !== 'figma-variable-snapshot'
    || typeof input.complete !== 'boolean' || !Array.isArray(input.collections)
    || input.collections.length > MAX_VARIABLE_SNAPSHOT_COLLECTIONS) {
    throw sourceError('root contract is not the closed schemaVersion 2 shape');
  }
  const collectionHandles = new Set();
  const modeOwners = new Map();
  const variableFacts = new Map();
  let modeCount = 0;
  let variableCount = 0;

  const collections = input.collections.map((collection, collectionIndex) => {
    const label = `collection at index ${collectionIndex}`;
    if (!closed(collection,
      ['handle', 'name', 'hiddenFromPublishing', 'defaultMode', 'modes', 'variables'],
      ['sourceKey'])) throw sourceError(`${label} is not a closed object`);
    const handle = identity(collection.handle, `${label} handle`, { handle: true });
    if (collectionHandles.has(handle)) throw sourceError(`duplicate Collection handle ${handle}`);
    collectionHandles.add(handle);
    const name = identity(collection.name, `${label} name`);
    const sourceKey = optionalSourceKey(collection.sourceKey, `${label} sourceKey`);
    if (typeof collection.hiddenFromPublishing !== 'boolean') {
      throw sourceError(`${label} hiddenFromPublishing must be boolean`);
    }
    if (!Array.isArray(collection.modes) || !collection.modes.length) {
      throw sourceError(`${label} requires at least one mode`);
    }
    modeCount += collection.modes.length;
    if (modeCount > MAX_VARIABLE_SNAPSHOT_MODES) {
      throw sourceError(`at most ${MAX_VARIABLE_SNAPSHOT_MODES} modes are accepted`);
    }
    const modes = collection.modes.map((mode, modeIndex) => {
      if (!closed(mode, ['handle', 'name'])) {
        throw sourceError(`${label} mode at index ${modeIndex} is not closed`);
      }
      const modeHandle = identity(mode.handle,
        `${label} mode at index ${modeIndex} handle`, { handle: true });
      if (modeOwners.has(modeHandle)) throw sourceError(`duplicate mode handle ${modeHandle}`);
      modeOwners.set(modeHandle, handle);
      return {
        handle: modeHandle,
        name: identity(mode.name, `${label} mode at index ${modeIndex} name`),
      };
    });
    if (!((typeof collection.defaultMode === 'string'
      && modeOwners.get(collection.defaultMode) === handle)
      || (input.complete === false && collection.defaultMode === null))) {
      throw sourceError(`${label} defaultMode must reference one of its modes`);
    }
    if (!Array.isArray(collection.variables)) {
      throw sourceError(`${label} variables must be an array`);
    }
    variableCount += collection.variables.length;
    if (variableCount > MAX_VARIABLE_SNAPSHOT_VARIABLES) {
      throw sourceError(`at most ${MAX_VARIABLE_SNAPSHOT_VARIABLES} Variables are accepted`);
    }
    const variables = collection.variables.map((variable, variableIndex) => {
      const variableLabel = `${label} Variable at index ${variableIndex}`;
      if (!closed(variable, [
        'handle', 'name', 'type', 'description', 'hiddenFromPublishing',
        'scopes', 'codeSyntax', 'values',
      ], ['sourceKey'])) throw sourceError(`${variableLabel} is not a closed object`);
      const variableHandle = identity(variable.handle,
        `${variableLabel} handle`, { handle: true });
      if (variableFacts.has(variableHandle)) {
        throw sourceError(`duplicate Variable handle ${variableHandle}`);
      }
      let type;
      try { type = parseVariableType(variable.type); }
      catch { throw sourceError(`${variableLabel} type is unsupported`); }
      const normalized = {
        handle: variableHandle,
        name: identity(variable.name, `${variableLabel} name`),
        type,
        ...(variable.sourceKey === undefined ? {} : {
          sourceKey: optionalSourceKey(variable.sourceKey, `${variableLabel} sourceKey`),
        }),
        ...metadata(variable, type, variableLabel),
        values: variable.values,
      };
      variableFacts.set(variableHandle, { collection: handle, type });
      return normalized;
    });
    return {
      handle, name,
      ...(sourceKey === undefined ? {} : { sourceKey }),
      hiddenFromPublishing: collection.hiddenFromPublishing,
      defaultMode: collection.defaultMode,
      modes,
      variables,
    };
  });

  for (const collection of collections) {
    for (const variable of collection.variables) {
      if (!plain(variable.values)) {
        throw sourceError(`Variable ${variable.handle} values must be a closed mode map`);
      }
      const values = {};
      for (const [modeHandle, raw] of Object.entries(variable.values)) {
        const safeModeHandle = identity(modeHandle, 'Variable value mode handle', { handle: true });
        if (modeOwners.get(safeModeHandle) !== collection.handle) {
          throw sourceError(`Variable ${variable.handle} references a foreign or missing mode`);
        }
        if (plain(raw) && Object.keys(raw).length === 1 && Object.hasOwn(raw, '$alias')) {
          const alias = raw.$alias;
          if (!plain(alias) || !['local', 'unresolved'].includes(alias.status)) {
            throw sourceError(`Variable ${variable.handle} has a malformed Alias`);
          }
          if (alias.status === 'local') {
            if (!closed(alias, ['status', 'collection', 'variable'])) {
              throw sourceError(`Variable ${variable.handle} local Alias is not closed`);
            }
            const target = variableFacts.get(alias.variable);
            if (!target || target.collection !== alias.collection
              || target.type !== variable.type) {
              throw sourceError(`Variable ${variable.handle} local Alias target is missing, misowned, or incompatible`);
            }
            values[safeModeHandle] = {
              $alias: {
                status: 'local',
                collection: identity(alias.collection, 'Alias Collection handle', { handle: true }),
                variable: identity(alias.variable, 'Alias Variable handle', { handle: true }),
              },
            };
          } else {
            if (!closed(alias, ['status', 'sourceId'])) {
              throw sourceError(`Variable ${variable.handle} unresolved Alias is not closed`);
            }
            values[safeModeHandle] = {
              $alias: {
                status: 'unresolved',
                sourceId: identity(alias.sourceId, 'unresolved Alias sourceId'),
              },
            };
          }
        } else {
          try { values[safeModeHandle] = normalizeVariableValue(raw, variable.type); }
          catch { throw sourceError(`Variable ${variable.handle} has an incompatible literal value`); }
          if (variable.type === 'STRING' && values[safeModeHandle].length > MAX_DESCRIPTION) {
            throw sourceError(`Variable ${variable.handle} STRING value is too long`);
          }
        }
      }
      variable.values = values;
    }
  }

  // Local Alias edges form one source-identity graph. A cycle cannot be
  // recreated deterministically and must be rejected before import planning.
  const aliasEdges = new Map([...variableFacts.keys()].map((handle) => [handle, new Set()]));
  for (const collection of collections) {
    for (const variable of collection.variables) {
      for (const value of Object.values(variable.values)) {
        if (value?.$alias?.status === 'local') {
          aliasEdges.get(variable.handle).add(value.$alias.variable);
        }
      }
    }
  }
  const incoming = new Map([...aliasEdges.keys()].map((handle) => [handle, 0]));
  for (const targets of aliasEdges.values()) {
    for (const target of targets) incoming.set(target, incoming.get(target) + 1);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([handle]) => handle);
  let visited = 0;
  while (ready.length) {
    const handle = ready.pop();
    visited += 1;
    for (const target of aliasEdges.get(handle)) {
      const remaining = incoming.get(target) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  if (visited !== aliasEdges.size) throw sourceError('local Alias graph contains a cycle');

  const normalized = {
    schemaVersion: 2,
    kind: 'figma-variable-snapshot',
    complete: input.complete,
    collections,
  };
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VARIABLE_SNAPSHOT_SERIALIZED_BYTES) {
    throw sourceError(`serialized contract exceeds ${MAX_VARIABLE_SNAPSHOT_SERIALIZED_BYTES} bytes`);
  }
  try { parseBoundedJson(serialized, { role: 'variable-snapshot-v2' }); }
  catch { throw sourceError('contract exceeds workspace structure limits'); }
  return deepFreeze(normalized);
}
