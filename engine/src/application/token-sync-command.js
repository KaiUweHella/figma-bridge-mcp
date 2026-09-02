// Plan-bound three-way Token Sync. Workspace preparation, Figma observation,
// mutation and lock publication remain one Command Application without
// pretending that delete/retype or a multi-operation apply is atomic.

import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { withAssetOutputLock } from '../lib/asset-output-lock.js';
import { normalizeVariableScopes } from '../lib/variable-management.js';
import { variableScopePolicyCode, variableScopeQuestions } from '../lib/variable-scope-policy.js';
import {
  LOCKFILE_NAME,
  buildLock,
  canonicalValue,
  formatPlan,
  hexToFigmaRgb,
  parseLock,
  parseTokenFile,
  planSync,
  planTouchesFigma,
  resolveConflicts,
} from '../lib/token-sync.js';
import {
  parseTokenSyncRequest,
  tokenSyncArgvFromRequest,
  tokenSyncPlanningArgvFromRequest,
} from './token-sync-request.js';

export { tokenSyncArgvFromRequest, tokenSyncPlanningArgvFromRequest } from './token-sync-request.js';

const APPLICATION_ID = 'tokens.sync';
const SOURCE_TYPES = new Set(['BOOLEAN', 'COLOR', 'FLOAT', 'STRING']);
const NATIVE_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
const CODE_SYNTAX_PLATFORMS = new Set(['WEB', 'ANDROID', 'iOS']);
const MAX_ITEMS = 10_000;
const MAX_CANDIDATES = 100_000;
const MAX_NAME = 512;
const MAX_ID = 512;
const MAX_STRING = 16_384;
const MAX_CODE_SYNTAX = 1_024;
const MAX_MODES = 1_000;
const MAX_REPORT_ITEMS = 64;
const MAX_OPERATIONS = MAX_ITEMS * 4;
export const MAX_TOKEN_SYNC_PREPARED_CODE_UNITS = 1_500_000;
export const MAX_TOKEN_SYNC_SERIALIZED_CODE_UNITS = 2_000_000;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function safeText(value, maximum = MAX_NAME, { empty = false } = {}) {
  return typeof value === 'string' && value.length <= maximum
    && (empty || value.length > 0) && !UNSAFE.test(value);
}

function sourceError(message) { return new Error(`Invalid token sync source: ${message}.`); }

function normalizedCodeSyntax(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw sourceError('codeSyntax must be an object');
  }
  const entries = Object.entries(value);
  if (entries.some(([platform, syntax]) => !CODE_SYNTAX_PLATFORMS.has(platform)
    || !safeText(syntax, MAX_CODE_SYNTAX, { empty: true }))) {
    throw sourceError('codeSyntax must contain only bounded WEB, ANDROID, or iOS text');
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedSourceValue(type, value) {
  if (type === 'COLOR') {
    const encoded = hexToFigmaRgb(value);
    if (!encoded) throw sourceError('COLOR values must use a hexadecimal sRGB form');
    return { value, encoded };
  }
  if (type === 'FLOAT') {
    const encoded = canonicalValue(type, value);
    if (typeof encoded !== 'number' || !Number.isFinite(encoded)) {
      throw sourceError('FLOAT values must be finite numeric values');
    }
    return { value: encoded, encoded };
  }
  if (type === 'BOOLEAN') {
    if (typeof value !== 'boolean') throw sourceError('BOOLEAN values must be true or false');
    const encoded = canonicalValue(type, value);
    return { value: encoded, encoded };
  }
  const encoded = String(value ?? '');
  if (!safeText(encoded, MAX_STRING, { empty: true })) {
    throw sourceError(`STRING values must be at most ${MAX_STRING} safe code units`);
  }
  return { value: encoded, encoded };
}

function normalizedToken(name, token) {
  if (!safeText(name)) throw sourceError('token names must be bounded safe text');
  if (!token || typeof token !== 'object' || Array.isArray(token)) {
    throw sourceError(`token ${name} is malformed`);
  }
  const type = String(token.type || '').toUpperCase();
  if (!SOURCE_TYPES.has(type)) throw sourceError(`token ${name} has unsupported type ${type || '(missing)'}`);
  const value = normalizedSourceValue(type, token.value);
  let scopes;
  if (Object.hasOwn(token, 'scopes')) {
    try { scopes = normalizeVariableScopes(token.scopes, type); }
    catch (error) { throw sourceError(`token ${name} scopes are invalid: ${error.message}`); }
  }
  const codeSyntax = normalizedCodeSyntax(token.codeSyntax);
  if (token.variableId !== undefined && !safeText(token.variableId, MAX_ID)) {
    throw sourceError(`token ${name} variableId is invalid`);
  }
  return Object.freeze({
    name, type, value: value.value, encodedValue: value.encoded,
    ...(token.variableId === undefined ? {} : { variableId: token.variableId }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(codeSyntax === undefined ? {} : { codeSyntax }),
  });
}

function normalizedLock(value) {
  if (!exact(value, ['version', 'collection', 'fileKey', 'syncedAt', 'tokens'])
    || value.version !== 1
    || (value.collection !== null && !safeText(value.collection))
    || (value.fileKey !== null && !safeText(value.fileKey, MAX_ID))
    || (value.syncedAt !== null && !safeText(value.syncedAt, 128))
    || !value.tokens || typeof value.tokens !== 'object' || Array.isArray(value.tokens)) return null;
  const entries = Object.entries(value.tokens);
  if (entries.length > MAX_ITEMS) return null;
  const tokens = {};
  try {
    for (const [name, token] of entries) {
      if (!safeText(name) || !token || typeof token !== 'object' || Array.isArray(token)
        || !SOURCE_TYPES.has(token.type)) return null;
      const normalized = normalizedSourceValue(token.type, token.value);
      const scopes = Object.hasOwn(token, 'scopes')
        ? normalizeVariableScopes(token.scopes, token.type) : undefined;
      const codeSyntax = normalizedCodeSyntax(token.codeSyntax);
      if (token.id !== undefined && !safeText(token.id, MAX_ID)) return null;
      tokens[name] = {
        type: token.type, value: normalized.value,
        ...(token.id === undefined ? {} : { id: token.id }),
        ...(scopes === undefined ? {} : { scopes }),
        ...(codeSyntax === undefined ? {} : { codeSyntax }),
      };
    }
  } catch { return null; }
  return { ...value, tokens };
}

function normalizedPrepared(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.request || !Array.isArray(value.tokens) || !Array.isArray(value.declaredElsewhere)
    || typeof value.lockPath !== 'string' || typeof value.lockInvalid !== 'boolean'
    || (value.lock !== null && typeof value.lock !== 'object')) {
    throw new TypeError('Token Sync requires a prepared bounded source.');
  }
  const request = parseTokenSyncRequest(tokenSyncArgvFromRequest(value.request));
  const tokens = value.tokens.map((token) => normalizedToken(token.name, token));
  if (!tokens.length || tokens.length > MAX_ITEMS
    || new Set(tokens.map((token) => token.name)).size !== tokens.length) {
    throw new TypeError('Token Sync prepared tokens are empty, excessive, or duplicated.');
  }
  if (!safeText(value.lockPath, 4_096)) throw new TypeError('Token Sync lock path is invalid.');
  const lock = value.lock === null ? null : normalizedLock(value.lock);
  if (value.lock !== null && !lock) throw new TypeError('Token Sync prepared lock is invalid.');
  const declaredElsewhere = value.declaredElsewhere.map((item) => {
    if (!exact(item, ['name', 'collection']) || !safeText(item.name)
      || !safeText(item.collection)) throw new TypeError('Token Sync collection metadata is invalid.');
    return Object.freeze({ ...item });
  });
  const prepared = { request, tokens, lock, lockPath: value.lockPath,
    lockInvalid: value.lockInvalid, declaredElsewhere };
  if (JSON.stringify(prepared).length > MAX_TOKEN_SYNC_PREPARED_CODE_UNITS) {
    throw sourceError('normalized source exceeds the bounded Plugin transport limit');
  }
  return Object.freeze(prepared);
}

/**
 * @param {any} plan
 * @param {{workspaceIO?: {readText: Function, exists: Function, write: Function}}} [options]
 */
export function prepareTokenSyncPlan(plan, { workspaceIO } = {}) {
  if (tokenSyncPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Sync.`);
  }
  if (!workspaceIO || typeof workspaceIO.readText !== 'function'
    || typeof workspaceIO.exists !== 'function') {
    throw new TypeError('Token Sync requires WorkspaceIO.');
  }
  const request = parseTokenSyncRequest(plan.argv);
  const parsed = parseTokenFile(request.file,
    workspaceIO.readText(request.file, { role: 'token-file' }));
  const declaredElsewhere = [];
  const tokens = [];
  for (const [name, token] of parsed) {
    if (token.collection && token.collection !== request.collection) {
      declaredElsewhere.push({ name, collection: token.collection });
      continue;
    }
    tokens.push(normalizedToken(name, token));
  }
  if (!tokens.length) {
    throw sourceError('no tokens remain for the selected Collection; syncing an empty source would look like "delete everything", so it is refused');
  }
  if (tokens.length > MAX_ITEMS) throw sourceError(`at most ${MAX_ITEMS} tokens are accepted`);
  const lockPath = request.lockfile || join(dirname(request.file), LOCKFILE_NAME);
  const lockExists = workspaceIO.exists(lockPath, { role: 'token-lockfile', kind: 'file' });
  const parsedLock = lockExists
    ? parseLock(workspaceIO.readText(lockPath, { role: 'token-lockfile' })) : null;
  const lock = normalizedLock(parsedLock);
  if (lock?.collection && lock.collection !== request.collection) {
    throw sourceError(`lockfile belongs to Collection ${JSON.stringify(lock.collection)}, not ${JSON.stringify(request.collection)}`);
  }
  if (lock?.fileKey && plan.target.fileKey && lock.fileKey !== plan.target.fileKey) {
    throw sourceError('lockfile belongs to a different explicit Figma file target');
  }
  return normalizedPrepared({
    request, tokens, lock, lockPath,
    lockInvalid: lockExists && lock === null,
    declaredElsewhere,
  });
}

/**
 * Hold one process-safe lease from prior-lock read through Figma verification
 * and atomic publication. Dry-runs do not create a lease or Workspace bytes.
 * @param {any} plan
 * @param {{workspaceIO?:any,remainingMs?:()=>number}} adapters
 * @param {(prepared:any)=>Promise<any>} operation
 */
export async function withTokenSyncPlanLock(plan, {
  workspaceIO,
  remainingMs = () => Number.POSITIVE_INFINITY,
} = {}, operation) {
  if (tokenSyncPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Sync.`);
  }
  if (typeof operation !== 'function') throw new TypeError('Token Sync requires a transaction operation.');
  const request = parseTokenSyncRequest(plan.argv);
  if (!request.apply) {
    return operation(prepareTokenSyncPlan(plan, { workspaceIO }));
  }
  if (!workspaceIO || typeof workspaceIO.ensureDirectory !== 'function'
    || typeof workspaceIO.authorizePath !== 'function'
    || typeof workspaceIO.readText !== 'function' || typeof workspaceIO.write !== 'function') {
    throw new TypeError('Token Sync apply requires lock-capable WorkspaceIO.');
  }
  const lockPath = request.lockfile || join(dirname(request.file), LOCKFILE_NAME);
  const canonicalLockParent = workspaceIO.ensureDirectory(dirname(lockPath), {
    role: 'token-lockfile-directory',
  });
  const canonicalLockPath = workspaceIO.authorizePath(join(canonicalLockParent, basename(lockPath)), {
    access: 'write', role: 'token-lockfile', kind: 'file',
  }).canonical;
  const digest = createHash('sha256').update(canonicalLockPath).digest('hex').slice(0, 16);
  return withAssetOutputLock(dirname(canonicalLockPath), {
    io: workspaceIO,
    lockDirectory: `.figma-bridge-token-sync-${digest}.lock`,
    remainingMs,
  }, async () => operation(prepareTokenSyncPlan(plan, { workspaceIO })));
}

function pluginPrelude() {
  return `
    const unsafeText = /${UNSAFE.source}/u;
    const validText = (value, maximum = ${MAX_NAME}, empty = false) => typeof value === 'string'
      && value.length <= maximum && (empty || value.length > 0) && !unsafeText.test(value);
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length <= ${MAX_TOKEN_SYNC_SERIALIZED_CODE_UNITS}) return serialized;
      return JSON.stringify({ schemaVersion: 1, status: 'failed', outcome: 'no-mutation',
        failure: 'result-limit', attempted: 0, confirmed: 0, residueCount: 0,
        residue: [], residueOmitted: 0 });
    };
    const failedRead = (failure) => bounded({ schemaVersion: 1, status: 'failed',
      outcome: 'no-mutation', failure, attempted: 0, confirmed: 0,
      residueCount: 0, residue: [], residueOmitted: 0 });
    const compactValue = (value) => value === undefined ? { hasValue: false, value: null }
      : { hasValue: true, value };
    const rowFor = (variable, modeId) => {
      const selected = compactValue(variable.valuesByMode && variable.valuesByMode[modeId]);
      return { id: variable.id, name: variable.name, type: variable.resolvedType,
        hasValue: selected.hasValue, value: selected.value,
        alias: Boolean(selected.hasValue && selected.value && typeof selected.value === 'object'
          && (selected.value.type === 'VARIABLE_ALIAS' || selected.value.type === 'VARIABLE_EXPRESSION')),
        scopes: Array.isArray(variable.scopes) ? Array.from(variable.scopes) : [],
        codeSyntax: variable.codeSyntax && typeof variable.codeSyntax === 'object'
          ? Object.fromEntries(Object.entries(variable.codeSyntax).sort(([a], [b]) => a.localeCompare(b))) : {} };
    };
    const validCollection = (collection) => collection && validText(collection.id, ${MAX_ID})
      && validText(collection.name) && collection.remote !== true
      && Array.isArray(collection.modes) && collection.modes.length > 0
      && collection.modes.length <= ${MAX_MODES}
      && collection.modes.every((mode) => mode && validText(mode.modeId, ${MAX_ID})
        && validText(mode.name, ${MAX_NAME}, true))
      && new Set(collection.modes.map((mode) => mode.modeId)).size === collection.modes.length
      && Array.isArray(collection.variableIds) && collection.variableIds.length <= ${MAX_CANDIDATES}
      && collection.variableIds.every((id) => validText(id, ${MAX_ID}))
      && new Set(collection.variableIds).size === collection.variableIds.length;
    const validVariable = (variable) => variable && validText(variable.id, ${MAX_ID})
      && validText(variable.name) && validText(variable.variableCollectionId, ${MAX_ID})
      && ${JSON.stringify([...NATIVE_TYPES])}.includes(variable.resolvedType)
      && variable.remote !== true;
  `;
}

export function tokenSyncReadCode(prepared) {
  const input = normalizedPrepared(prepared);
  const names = input.tokens.map((token) => token.name);
  return `(async () => {
    const collectionName = ${JSON.stringify(input.request.collection)};
    const relevantNames = new Set(${JSON.stringify(names)});
    ${pluginPrelude()}
    try {
      const fileKey = validText(figma.fileKey, ${MAX_ID}) ? figma.fileKey : null;
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const variables = await figma.variables.getLocalVariablesAsync();
      if (!Array.isArray(collections) || collections.length > ${MAX_CANDIDATES}
        || !Array.isArray(variables) || variables.length > ${MAX_CANDIDATES}
        || collections.some((collection) => !validCollection(collection))
        || variables.some((variable) => !validVariable(variable))
        || new Set(collections.map((collection) => collection.id)).size !== collections.length
        || new Set(variables.map((variable) => variable.id)).size !== variables.length) {
        return failedRead('catalog-invalid');
      }
      const matches = collections.filter((collection) => collection.name === collectionName);
      if (matches.length > 1) return failedRead('collection-ambiguous');
      const collection = matches[0] || null;
      const elsewhere = [];
      const collectionById = new Map(collections.map((item) => [item.id, item]));
      for (const variable of variables) {
        if ((!collection || variable.variableCollectionId !== collection.id)
          && relevantNames.has(variable.name)) {
          const owner = collectionById.get(variable.variableCollectionId);
          if (owner) elsewhere.push({ name: variable.name, collection: owner.name });
        }
      }
      if (!collection) return bounded({ schemaVersion: 1, status: 'read', fileKey,
        collection: null, modeId: null, modes: 0, variables: [], elsewhere });
      const members = variables.filter((variable) => variable.variableCollectionId === collection.id);
      if (members.length > ${MAX_ITEMS}) return failedRead('collection-limit');
      if (new Set(members.map((variable) => variable.name)).size !== members.length) {
        return failedRead('variable-name-ambiguous');
      }
      const declared = new Set(collection.variableIds);
      if (members.length !== declared.size || members.some((variable) => !declared.has(variable.id))) {
        return failedRead('membership-invalid');
      }
      const modeId = collection.modes[0].modeId;
      const rows = members.map((variable) => rowFor(variable, modeId));
      return bounded({ schemaVersion: 1, status: 'read', fileKey, collection: {
        id: collection.id, name: collection.name }, modeId,
      modes: collection.modes.length, variables: rows, elsewhere });
    } catch { return failedRead('catalog-unavailable'); }
  })()`;
}

function boundedJsonValue(value) {
  try { return JSON.stringify(value).length <= MAX_STRING; } catch { return false; }
}

function validRow(value) {
  if (!exact(value, ['id', 'name', 'type', 'hasValue', 'value', 'alias', 'scopes', 'codeSyntax'])
    || !safeText(value.id, MAX_ID) || !safeText(value.name) || !NATIVE_TYPES.has(value.type)
    || typeof value.hasValue !== 'boolean' || typeof value.alias !== 'boolean'
    || (!value.hasValue && (value.value !== null || value.alias)) || !boundedJsonValue(value.value)
    || !Array.isArray(value.scopes) || value.scopes.length > 32
    || value.scopes.some((scope) => !safeText(scope, 128))
    || new Set(value.scopes).size !== value.scopes.length
    || !value.codeSyntax || typeof value.codeSyntax !== 'object' || Array.isArray(value.codeSyntax)
    || Object.entries(value.codeSyntax).some(([platform, syntax]) => !CODE_SYNTAX_PLATFORMS.has(platform)
      || !safeText(syntax, MAX_CODE_SYNTAX, { empty: true }))) return false;
  return !value.alias || value.value && typeof value.value === 'object'
    && ((value.value.type === 'VARIABLE_ALIAS' && safeText(value.value.id, MAX_ID))
      || value.value.type === 'VARIABLE_EXPRESSION');
}

function validRead(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return false;
  if (value.status === 'failed') {
    return exact(value, ['schemaVersion', 'status', 'outcome', 'failure', 'attempted', 'confirmed',
      'residueCount', 'residue', 'residueOmitted']) && value.outcome === 'no-mutation'
      && safeText(value.failure, 128) && value.attempted === 0 && value.confirmed === 0
      && value.residueCount === 0 && Array.isArray(value.residue) && !value.residue.length
      && value.residueOmitted === 0;
  }
  return exact(value, ['schemaVersion', 'status', 'fileKey', 'collection', 'modeId', 'modes', 'variables', 'elsewhere'])
    && value.status === 'read'
    && (value.fileKey === null || safeText(value.fileKey, MAX_ID))
    && (value.collection === null || exact(value.collection, ['id', 'name'])
      && safeText(value.collection.id, MAX_ID) && safeText(value.collection.name))
    && (value.collection === null ? value.modeId === null && value.modes === 0
      : safeText(value.modeId, MAX_ID) && Number.isSafeInteger(value.modes)
        && value.modes > 0 && value.modes <= MAX_MODES)
    && Array.isArray(value.variables) && value.variables.length <= MAX_ITEMS
    && value.variables.every(validRow)
    && new Set(value.variables.map((row) => row.id)).size === value.variables.length
    && Array.isArray(value.elsewhere) && value.elsewhere.length <= MAX_ITEMS
    && value.elsewhere.every((item) => exact(item, ['name', 'collection'])
      && safeText(item.name) && safeText(item.collection));
}

async function readFigma(prepared, evaluate, remainingMs) {
  const timeoutMs = assertTokenSyncTimeRemaining(remainingMs, 'plugin-read', {
    dispatchState: 'not-dispatched',
  });
  const serialized = await evaluate(tokenSyncReadCode(prepared), {
    phase: 'plugin-read', timeoutMs,
  });
  if (typeof serialized !== 'string' || serialized.length > MAX_TOKEN_SYNC_SERIALIZED_CODE_UNITS) {
    throw new Error('Token Sync returned an invalid bounded read result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw new Error('Token Sync returned invalid read JSON.'); }
  if (!validRead(payload)) throw new Error('Token Sync returned an invalid bounded read result.');
  if (payload.status === 'failed') throw mutationFailure(
    `Token Sync preflight failed [dispatch:failed] [mutation:no-mutation]: ${payload.failure}.`,
    payload,
  );
  return payload;
}

function codeMap(prepared) {
  return new Map(prepared.tokens.map(({ name, encodedValue: _encoded, ...token }) => [name, token]));
}

function figmaMap(read) {
  return new Map(read.variables.filter((row) => !row.alias).map((row) => [row.name, {
    type: row.type, value: row.hasValue ? row.value : undefined, id: row.id,
    scopes: row.scopes, codeSyntax: row.codeSyntax,
  }]));
}

function encodedOperation(token) {
  const prepared = normalizedSourceValue(token.type, token.value);
  return {
    name: token.name, type: token.type, value: prepared.encoded,
    ...(Object.hasOwn(token, 'scopes') ? { scopes: token.scopes } : {}),
    ...(Object.hasOwn(token, 'codeSyntax') ? { codeSyntax: token.codeSyntax } : {}),
  };
}

function mutationInput(prepared, read, syncPlan) {
  const operations = [
    ...syncPlan.rename.map((token) => ({ kind: 'rename', id: token.id,
      from: token.from, name: token.name })),
    ...syncPlan.update.filter((token) => !token.typeChange).map((token) => ({
      kind: 'update', id: token.id, ...encodedOperation(token),
    })),
    ...syncPlan.update.filter((token) => token.typeChange).map((token) => ({
      kind: 'retype', id: token.id, ...encodedOperation(token),
    })),
    ...syncPlan.create.map((token) => ({ kind: 'create', ...encodedOperation(token) })),
    ...syncPlan.delete.filter((token) => token.willDelete).map((token) => ({
      kind: 'delete', id: token.id, name: token.name,
    })),
  ];
  return Object.freeze({
    collectionName: prepared.request.collection,
    collection: read.collection,
    modeId: read.modeId,
    before: read.variables,
    operations,
  });
}

export function tokenSyncMutationCode(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.before)
    || !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS
    || !safeText(value.collectionName)) {
    throw new TypeError('Token Sync mutation requires a bounded prepared plan.');
  }
  const serializedInput = JSON.stringify(value);
  if (serializedInput.length > MAX_TOKEN_SYNC_PREPARED_CODE_UNITS) {
    throw new Error('Token Sync mutation exceeds the bounded Plugin transport limit.');
  }
  return `(async () => {
    const input = ${serializedInput};
    ${pluginPrelude()}
    ${variableScopePolicyCode()}
    const equivalent = (actual, expected) => {
      if (typeof actual === 'number' && typeof expected === 'number') {
        return Number.isFinite(actual) && Number.isFinite(expected)
          && (Object.is(actual, expected) || Math.fround(actual) === Math.fround(expected));
      }
      if (actual === null || expected === null || typeof actual !== 'object'
        || typeof expected !== 'object') return Object.is(actual, expected);
      if (Array.isArray(actual) !== Array.isArray(expected)) return false;
      const left = Object.keys(actual).sort(); const right = Object.keys(expected).sort();
      return left.length === right.length && left.every((key, index) => key === right[index]
        && equivalent(actual[key], expected[key]));
    };
    const sameRow = (left, right) => left && right && left.id === right.id
      && left.name === right.name && left.type === right.type
      && left.hasValue === right.hasValue && left.alias === right.alias
      && equivalent(left.value, right.value) && equivalent(left.scopes, right.scopes)
      && equivalent(left.codeSyntax, right.codeSyntax);
    const valueEquivalent = (actual, expected, type) => {
      if (type !== 'COLOR') return equivalent(actual, expected);
      if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object'
        || Array.isArray(actual) || Array.isArray(expected)) return false;
      return ['r', 'g', 'b'].every((key) => equivalent(actual[key], expected[key]))
        && equivalent(Object.hasOwn(actual, 'a') ? actual.a : 1,
          Object.hasOwn(expected, 'a') ? expected.a : 1);
    };
    const targetMatches = (row, operation) => row && row.name === operation.name
      && row.type === operation.type && row.hasValue && !row.alias
      && valueEquivalent(row.value, operation.value, operation.type)
      && (!Object.hasOwn(operation, 'scopes') || equivalent(row.scopes, operation.scopes))
      && (!Object.hasOwn(operation, 'codeSyntax')
        || equivalent(row.codeSyntax, operation.codeSyntax));
    const failureResult = (outcome, attempted, confirmed, residue, failure) => {
      const shown = residue.slice(0, ${MAX_REPORT_ITEMS});
      return { schemaVersion: 1, status: 'failed', outcome, failure,
        attempted, confirmed, residueCount: residue.length, residue: shown,
        residueOmitted: Math.max(0, residue.length - shown.length) };
    };
    const readState = async () => {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const variables = await figma.variables.getLocalVariablesAsync();
      if (!Array.isArray(collections) || collections.length > ${MAX_CANDIDATES}
        || !Array.isArray(variables) || variables.length > ${MAX_CANDIDATES}
        || collections.some((collection) => !validCollection(collection))
        || variables.some((variable) => !validVariable(variable))) throw new Error('catalog-invalid');
      const matches = collections.filter((collection) => collection.name === input.collectionName);
      if (matches.length > 1) throw new Error('collection-ambiguous');
      const collection = input.collection
        ? collections.find((item) => item.id === input.collection.id) || null
        : matches[0] || null;
      if (input.collection && (!collection || collection.name !== input.collection.name)) {
        throw new Error('collection-changed');
      }
      if (!collection) return { collection: null, modeId: null, rows: [], variables };
      const modeId = collection.modes[0].modeId;
      const members = variables.filter((variable) => variable.variableCollectionId === collection.id);
      const declared = new Set(collection.variableIds);
      if (members.length !== declared.size || members.some((variable) => !declared.has(variable.id))) {
        throw new Error('membership-invalid');
      }
      if (new Set(members.map((variable) => variable.name)).size !== members.length) {
        throw new Error('variable-name-ambiguous');
      }
      return { collection, modeId, rows: members.map((variable) => rowFor(variable, modeId)), variables };
    };
    let initial;
    try { initial = await readState(); }
    catch { return bounded(failureResult('no-mutation', 0, 0, [], 'preflight-unavailable')); }
    if (Boolean(input.collection) !== Boolean(initial.collection)
      || input.modeId !== initial.modeId || input.before.length !== initial.rows.length) {
      return bounded(failureResult('no-mutation', 0, 0, [], 'preflight-changed'));
    }
    const initialById = new Map(initial.rows.map((row) => [row.id, row]));
    if (input.before.some((row) => !sameRow(row, initialById.get(row.id)))) {
      return bounded(failureResult('no-mutation', 0, 0, [], 'preflight-changed'));
    }

    const attemptedOps = [];
    const directFailures = [];
    const createdByOperation = new Map();
    let collection = initial.collection;
    let collectionCreated = false;
    if (!collection) {
      try {
        collection = figma.variables.createVariableCollection(input.collectionName);
        collectionCreated = true;
        if (!validCollection(collection)) throw new Error('collection-factory-invalid');
      } catch { directFailures.push('collection-create'); }
    }
    const modeId = collection ? collection.modes[0].modeId : null;
    const byId = new Map(initial.variables.map((variable) => [variable.id, variable]));
    const applyMetadata = (variable, operation) => {
      if (Object.hasOwn(operation, 'scopes')) variable.scopes = [...operation.scopes];
      if (Object.hasOwn(operation, 'codeSyntax')) {
        const current = variable.codeSyntax && typeof variable.codeSyntax === 'object'
          ? variable.codeSyntax : {};
        if (typeof variable.removeVariableCodeSyntax === 'function') {
          for (const platform of Object.keys(current)) {
            if (!Object.hasOwn(operation.codeSyntax, platform)) {
              variable.removeVariableCodeSyntax(platform);
            }
          }
        }
        for (const [platform, syntax] of Object.entries(operation.codeSyntax)) {
          variable.setVariableCodeSyntax(platform, syntax);
        }
      }
    };
    if (!directFailures.length) {
      for (let index = 0; index < input.operations.length; index++) {
        const operation = input.operations[index]; attemptedOps.push(index);
        try {
          if (!collection || !modeId) throw new Error('collection-unavailable');
          if (operation.kind === 'rename') {
            const variable = byId.get(operation.id);
            if (!variable) throw new Error('target-missing');
            variable.name = operation.name;
          } else if (operation.kind === 'update') {
            const variable = byId.get(operation.id);
            if (!variable) throw new Error('target-missing');
            variable.setValueForMode(modeId, operation.value); applyMetadata(variable, operation);
          } else if (operation.kind === 'retype') {
            const previous = byId.get(operation.id);
            if (!previous) throw new Error('target-missing');
            previous.remove(); byId.delete(operation.id);
            const variable = figma.variables.createVariable(operation.name, collection, operation.type);
            createdByOperation.set(index, variable.id); byId.set(variable.id, variable);
            if (!Object.hasOwn(operation, 'scopes')) __scopeTokenVariable(variable, operation.name, operation.type);
            variable.setValueForMode(modeId, operation.value); applyMetadata(variable, operation);
          } else if (operation.kind === 'create') {
            const variable = figma.variables.createVariable(operation.name, collection, operation.type);
            createdByOperation.set(index, variable.id); byId.set(variable.id, variable);
            if (!Object.hasOwn(operation, 'scopes')) __scopeTokenVariable(variable, operation.name, operation.type);
            variable.setValueForMode(modeId, operation.value); applyMetadata(variable, operation);
          } else if (operation.kind === 'delete') {
            const variable = byId.get(operation.id);
            if (!variable) throw new Error('target-missing');
            variable.remove(); byId.delete(operation.id);
          } else throw new Error('operation-invalid');
        } catch { directFailures.push(String(index)); }
        if (directFailures.length) break;
      }
    }

    let fresh;
    try { fresh = await readState(); }
    catch {
      const attempted = attemptedOps.length + (collectionCreated ? 1 : 0);
      const possibleResidue = [
        ...(collectionCreated ? [{ kind: 'variable-collection', operation: 'create' }] : []),
        ...attemptedOps.map((index) => ({ kind: 'variable', operation: input.operations[index].kind })),
      ];
      return bounded(failureResult('verification-unavailable', attempted, 0, possibleResidue,
        'postcondition-unavailable'));
    }
    const freshById = new Map(fresh.rows.map((row) => [row.id, row]));
    const targetedIds = new Set(input.operations.filter((operation) => operation.id)
      .map((operation) => operation.id));
    let fullPostcondition = Boolean(fresh.collection)
      && fresh.collection.name === input.collectionName
      && fresh.rows.length === input.before.length
        + input.operations.filter((operation) => operation.kind === 'create').length
        - input.operations.filter((operation) => operation.kind === 'delete').length;
    for (const row of input.before) {
      if (!targetedIds.has(row.id) && !sameRow(row, freshById.get(row.id))) fullPostcondition = false;
    }
    const confirmedIndexes = [];
    const newIds = [];
    for (let index = 0; index < input.operations.length; index++) {
      const operation = input.operations[index];
      const createdId = createdByOperation.get(index);
      const current = createdId ? freshById.get(createdId) : freshById.get(operation.id);
      const confirmed = operation.kind === 'rename'
        ? current && current.name === operation.name
        : operation.kind === 'update' ? targetMatches(current, operation)
          : operation.kind === 'create' ? targetMatches(current, operation)
            : operation.kind === 'retype' ? !freshById.has(operation.id)
              && targetMatches(current, operation)
              : operation.kind === 'delete' ? !freshById.has(operation.id) : false;
      if (confirmed) confirmedIndexes.push(index); else fullPostcondition = false;
      if (createdId && current) newIds.push({ index, name: operation.name, id: createdId });
    }
    const success = directFailures.length === 0 && fullPostcondition
      && confirmedIndexes.length === input.operations.length;
    if (success) {
      const counts = { created: 0, updated: 0, retyped: 0, renamed: 0, deleted: 0 };
      for (const operation of input.operations) {
        const field = operation.kind === 'create' ? 'created'
          : operation.kind === 'update' ? 'updated'
            : operation.kind === 'retype' ? 'retyped'
              : operation.kind === 'rename' ? 'renamed' : 'deleted';
        counts[field]++;
      }
      const complete = { schemaVersion: 1, status: 'complete', outcome: 'committed',
        attempted: input.operations.length + (collectionCreated ? 1 : 0),
        confirmed: input.operations.length + (collectionCreated ? 1 : 0),
        collectionCreated, counts, newIds };
      const serialized = JSON.stringify(complete);
      if (serialized.length <= ${MAX_TOKEN_SYNC_SERIALIZED_CODE_UNITS}) return serialized;
    }
    const residue = [];
    if (collectionCreated && fresh.collection) residue.push({ kind: 'variable-collection', operation: 'create' });
    for (let index = 0; index < input.operations.length; index++) {
      const operation = input.operations[index];
      const before = operation.id ? initialById.get(operation.id) : null;
      const createdId = createdByOperation.get(index);
      const current = createdId ? freshById.get(createdId) : operation.id ? freshById.get(operation.id) : null;
      const changed = operation.kind === 'create' ? Boolean(current)
        : operation.kind === 'retype' ? !sameRow(before, freshById.get(operation.id)) || Boolean(current)
          : !sameRow(before, current);
      if (changed) residue.push({ kind: 'variable', operation: operation.kind });
    }
    const attempted = attemptedOps.length + (collectionCreated ? 1 : 0);
    const outcome = residue.length ? 'partial-residue' : 'no-mutation';
    return bounded(failureResult(outcome, attempted,
      confirmedIndexes.length + (collectionCreated && fresh.collection ? 1 : 0),
      residue, directFailures.length ? 'operation-failed' : 'postcondition-failed'));
  })()`;
}

function validCount(value, maximum = MAX_OPERATIONS + 1) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validMutation(value, operationCount) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return false;
  if (value.status === 'complete') {
    return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'confirmed',
      'collectionCreated', 'counts', 'newIds']) && value.outcome === 'committed'
      && validCount(value.attempted) && value.confirmed === value.attempted
      && typeof value.collectionCreated === 'boolean'
      && exact(value.counts, ['created', 'updated', 'retyped', 'renamed', 'deleted'])
      && Object.values(value.counts).every((count) => validCount(count))
      && Object.values(value.counts).reduce((sum, count) => sum + count, 0) === operationCount
      && Array.isArray(value.newIds) && value.newIds.length <= operationCount
      && value.newIds.every((item) => exact(item, ['index', 'name', 'id'])
        && Number.isSafeInteger(item.index) && item.index >= 0 && item.index < operationCount
        && safeText(item.name) && safeText(item.id, MAX_ID))
      && new Set(value.newIds.map((item) => item.index)).size === value.newIds.length
      && new Set(value.newIds.map((item) => item.id)).size === value.newIds.length;
  }
  return exact(value, ['schemaVersion', 'status', 'outcome', 'failure', 'attempted', 'confirmed',
    'residueCount', 'residue', 'residueOmitted']) && value.status === 'failed'
    && ['no-mutation', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && safeText(value.failure, 128) && validCount(value.attempted)
    && validCount(value.confirmed) && value.confirmed <= value.attempted
    && validCount(value.residueCount) && Array.isArray(value.residue)
    && value.residue.length <= MAX_REPORT_ITEMS && validCount(value.residueOmitted)
    && value.residue.length + value.residueOmitted === value.residueCount
    && value.residue.every((item) => exact(item, ['kind', 'operation'])
      && ['variable', 'variable-collection'].includes(item.kind)
      && ['create', 'update', 'retype', 'rename', 'delete'].includes(item.operation))
    && (value.outcome !== 'no-mutation' || value.residueCount === 0)
    && (value.outcome !== 'partial-residue' || value.residueCount > 0);
}

function failureMatchesMutationInput(value, input) {
  if (value.status !== 'failed') return true;
  const possibleCollection = input.collection === null ? 1 : 0;
  const maximumAttempted = input.operations.length + possibleCollection;
  if (value.attempted > maximumAttempted || value.residueCount > value.attempted
    || value.confirmed > value.residueCount) return false;
  if (!['preflight-unavailable', 'preflight-changed', 'result-limit',
    'postcondition-unavailable', 'operation-failed', 'postcondition-failed']
    .includes(value.failure)) return false;
  if (['preflight-unavailable', 'preflight-changed', 'result-limit'].includes(value.failure)) {
    return value.outcome === 'no-mutation' && value.attempted === 0
      && value.confirmed === 0 && value.residueCount === 0;
  }
  if (value.failure === 'postcondition-unavailable'
    && (value.outcome !== 'verification-unavailable'
      || value.confirmed !== 0 || value.residueCount !== value.attempted)) return false;
  if (value.outcome === 'no-mutation' && value.confirmed !== 0) return false;

  const collectionResidue = value.residue.filter((item) => item.kind === 'variable-collection');
  if (collectionResidue.length > 1 || collectionResidue.some((item) => item.operation !== 'create')
    || (collectionResidue.length && !possibleCollection)
    || (collectionResidue.length && value.residue[0].kind !== 'variable-collection')) return false;
  const variableResidue = value.residue.filter((item) => item.kind === 'variable');
  const possiblePrefixes = possibleCollection && value.attempted > 0
    ? [value.attempted, value.attempted - 1] : [value.attempted];
  return possiblePrefixes.some((prefixLength) => {
    if (prefixLength < 0 || prefixLength > input.operations.length) return false;
    let residueIndex = 0;
    for (const operation of input.operations.slice(0, prefixLength)) {
      if (residueIndex < variableResidue.length
        && variableResidue[residueIndex].operation === operation.kind) residueIndex++;
    }
    return residueIndex === variableResidue.length;
  });
}

function mutationFailure(message, payload) {
  const outcome = payload.outcome;
  return Object.assign(new Error(message), {
    kind: 'execution',
    phase: 'plugin-execution',
    outcome: 'unknown-after-dispatch',
    dispatchState: 'failed',
    mutationOutcome: outcome,
    mutationReport: {
      version: 1, outcome, attempted: payload.attempted,
      restored: 0, residueCount: payload.residueCount,
    },
  });
}

function mutationVerificationFailure(message, input, cause, forcedDispatchState = null) {
  const possible = input.operations.length + (input.collection ? 0 : 1);
  const inheritedDispatch = ['not-dispatched', 'completed', 'failed', 'unknown']
    .includes(cause?.dispatchState) ? cause.dispatchState : null;
  const dispatchState = forcedDispatchState || inheritedDispatch || 'unknown';
  const inheritedOutcome = ['no-mutation', 'rolled-back', 'partial-residue', 'verification-unavailable']
    .includes(cause?.mutationOutcome) ? cause.mutationOutcome : null;
  const mutationOutcome = dispatchState === 'not-dispatched'
    ? 'no-mutation' : inheritedOutcome || 'verification-unavailable';
  const inheritedReport = cause?.mutationReport;
  const attempted = dispatchState === 'not-dispatched' || mutationOutcome === 'no-mutation' ? 0
    : validCount(inheritedReport?.attempted) ? inheritedReport.attempted : possible;
  const restored = mutationOutcome === 'no-mutation' ? 0
    : validCount(inheritedReport?.restored) ? inheritedReport.restored : 0;
  const residueCount = ['no-mutation', 'rolled-back'].includes(mutationOutcome) ? 0
    : validCount(inheritedReport?.residueCount) ? inheritedReport.residueCount : possible;
  return Object.assign(new Error(
    `${message} [dispatch:${dispatchState}] [mutation:${mutationOutcome}].`,
    cause === undefined ? undefined : { cause },
  ), {
    kind: cause?.kind || 'execution',
    phase: cause?.phase || 'plugin-verification',
    outcome: dispatchState === 'not-dispatched' ? 'not-dispatched' : 'unknown-after-dispatch',
    dispatchState,
    mutationOutcome,
    mutationReport: {
      version: 1, outcome: mutationOutcome, attempted, restored, residueCount,
    },
  });
}

async function applyFigma(prepared, read, syncPlan, evaluate, remainingMs) {
  const input = mutationInput(prepared, read, syncPlan);
  let serialized;
  try {
    const timeoutMs = assertTokenSyncTimeRemaining(remainingMs, 'plugin-mutation', {
      dispatchState: 'completed',
    });
    serialized = await evaluate(tokenSyncMutationCode(input), {
      phase: 'plugin-mutation', timeoutMs,
    });
  }
  catch (error) {
    if (error?.kind === 'timeout' && error?.phase === 'plugin-mutation') throw error;
    throw mutationVerificationFailure('Token Sync apply transport failed', input, error);
  }
  if (typeof serialized !== 'string' || serialized.length > MAX_TOKEN_SYNC_SERIALIZED_CODE_UNITS) {
    throw mutationVerificationFailure('Token Sync returned an invalid bounded mutation result', input,
      undefined, 'completed');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch (error) {
    throw mutationVerificationFailure('Token Sync returned invalid mutation JSON', input,
      error, 'completed');
  }
  if (!validMutation(payload, input.operations.length)
    || !failureMatchesMutationInput(payload, input)) {
    throw mutationVerificationFailure('Token Sync returned an invalid bounded mutation result', input,
      undefined, 'completed');
  }
  if (payload.status === 'complete') {
    const expectedCollectionCreated = input.collection === null;
    const expectedCounts = { created: 0, updated: 0, retyped: 0, renamed: 0, deleted: 0 };
    for (const operation of input.operations) {
      const field = operation.kind === 'create' ? 'created'
        : operation.kind === 'update' ? 'updated'
          : operation.kind === 'retype' ? 'retyped'
            : operation.kind === 'rename' ? 'renamed' : 'deleted';
      expectedCounts[field]++;
    }
    const expectedCreatedIndexes = input.operations
      .map((operation, index) => ['create', 'retype'].includes(operation.kind) ? index : null)
      .filter((index) => index !== null);
    const returnedCreatedIndexes = payload.newIds.map((item) => item.index).sort((a, b) => a - b);
    const beforeIds = new Set(input.before.map((row) => row.id));
    if (payload.collectionCreated !== expectedCollectionCreated
      || payload.attempted !== input.operations.length + Number(expectedCollectionCreated)
      || payload.confirmed !== payload.attempted
      || !isDeepStrictEqual(payload.counts, expectedCounts)
      || payload.newIds.some((item) => input.operations[item.index].name !== item.name
        || beforeIds.has(item.id))
      || !isDeepStrictEqual(returnedCreatedIndexes, expectedCreatedIndexes)) {
      throw mutationVerificationFailure('Token Sync returned inconsistent completion evidence',
        input, undefined, 'completed');
    }
  }
  if (payload.status === 'failed') {
    throw mutationFailure(
      `Token Sync apply failed [dispatch:failed] [mutation:${payload.outcome}] with `
        + `${payload.residueCount} verified residual operation(s).`, payload,
    );
  }
  return { payload, input };
}

function planAndWarnings(prepared, read) {
  const codeTokens = codeMap(prepared);
  const figmaTokens = figmaMap(read);
  let syncPlan = planSync(codeTokens, figmaTokens, prepared.lock, {
    prune: prepared.request.prune,
  });
  if (prepared.request.ours) syncPlan = resolveConflicts(syncPlan, 'ours');
  if (prepared.request.theirs) syncPlan = resolveConflicts(syncPlan, 'theirs');
  const aliasRows = read.variables.filter((row) => row.alias);
  const aliases = aliasRows.map((row) => row.name);
  for (const row of aliasRows.filter((item) => codeTokens.has(item.name))) {
    const name = row.name;
    const token = codeTokens.get(name);
    const figmaShape = row.value && row.value.type === 'VARIABLE_EXPRESSION'
      ? '{VARIABLE_EXPRESSION}' : '{VARIABLE_ALIAS}';
    syncPlan.conflict.push({ name, reason: 'alias-in-figma', code: token.value,
      figma: figmaShape, lock: prepared.lock?.tokens?.[name]?.value ?? null,
      type: token.type });
    syncPlan.create = syncPlan.create.filter((item) => item.name !== name);
  }
  const lines = [formatPlan(syncPlan, {
    collection: prepared.request.collection + (read.collection ? '' : ' (will be created)'),
    file: prepared.request.file,
    apply: prepared.request.apply,
    prune: prepared.request.prune,
  })];
  if (prepared.declaredElsewhere.length) {
    lines.unshift(`Ignoring ${prepared.declaredElsewhere.length} token(s) whose collection metadata targets another Collection.`);
  }
  if (prepared.lockInvalid) {
    lines.unshift('The lockfile is unreadable or from a newer version; treating this as a first sync.');
  }
  const questions = variableScopeQuestions([
    ...syncPlan.create,
    ...syncPlan.update.filter((token) => token.typeChange),
  ], prepared.request.collection);
  if (questions.length) {
    lines.push(`SCOPE DECISION REQUIRED for ${questions.length} token(s); unspecified scopes retain Figma defaults.`);
  }
  const elsewhereByName = new Map();
  for (const item of read.elsewhere) {
    const owners = elsewhereByName.get(item.name) || new Set(); owners.add(item.collection);
    elsewhereByName.set(item.name, owners);
  }
  const misplaced = syncPlan.create.filter((token) => elsewhereByName.has(token.name));
  if (misplaced.length && misplaced.length >= syncPlan.create.length / 2) {
    const owners = [...new Set(misplaced.flatMap((token) => [...elsewhereByName.get(token.name)]))];
    lines.push(`${misplaced.length} planned name(s) already exist in ${owners.map((name) => `"${name}"`).join(', ')}; applying would duplicate them into "${prepared.request.collection}".`);
    lines.push(`Did you mean --collection ${JSON.stringify(owners[0])}?`);
  }
  if (read.modes > 1) {
    lines.push(`"${prepared.request.collection}" has ${read.modes} modes; sync preserves its established first-mode-only policy.`);
  }
  if (aliases.length) lines.push(`${aliases.length} alias Variable(s) are skipped and remain explicit diagnostics.`);
  return { codeTokens, figmaTokens, syncPlan, lines };
}

function lockTokens(prepared, context, mutation) {
  const ids = new Map([...context.figmaTokens].map(([name, token]) => [name, token.id]));
  for (const rename of context.syncPlan.rename) {
    ids.delete(rename.from); ids.set(rename.name, rename.id);
  }
  for (const deletion of context.syncPlan.delete.filter((item) => item.willDelete)) ids.delete(deletion.name);
  if (mutation) {
    for (const item of mutation.payload.newIds) ids.set(item.name, item.id);
  }
  const synced = new Map();
  for (const [name, token] of context.codeTokens) {
    synced.set(name, { ...token, id: ids.get(name) || token.variableId });
  }
  for (const deletion of context.syncPlan.delete.filter((item) => !item.willDelete)) {
    synced.set(deletion.name, { type: deletion.type, value: deletion.value, id: deletion.id });
  }
  for (const pull of context.syncPlan.pull) synced.delete(pull.name);
  for (const rename of context.syncPlan.rename) synced.delete(rename.from);
  for (const [name, token] of synced) {
    if (!safeText(token.id, MAX_ID)) {
      throw new Error(`Token Sync cannot publish a lock without a verified Variable identity for ${name}.`);
    }
  }
  return synced;
}

function publicationFailure(error, mutation) {
  const changed = mutation?.payload?.confirmed || 0;
  const outcome = changed > 0 ? 'partial-residue' : 'no-mutation';
  return Object.assign(new Error(
    `Token Sync lockfile publication failed [dispatch:completed] [mutation:${outcome}]; `
      + (changed > 0 ? `${changed} verified Figma mutation(s) remain committed.`
        : 'Figma was not mutated.'),
    { cause: error },
  ), {
    kind: 'execution', phase: 'workspace-publication',
    outcome: 'unknown-after-dispatch', dispatchState: 'completed',
    mutationOutcome: outcome,
    mutationReport: {
      version: 1, outcome, attempted: changed, restored: 0, residueCount: changed,
    },
  });
}

function tokenSyncDeadlineFailure(phase, { dispatchState, mutation = null }) {
  const confirmed = mutation?.payload?.confirmed || 0;
  const mutationOutcome = confirmed > 0 ? 'partial-residue' : 'no-mutation';
  return Object.assign(new Error(
    `Token Sync exceeded its Command Plan deadline before ${phase} `
      + `[dispatch:${dispatchState}] [mutation:${mutationOutcome}].`,
  ), {
    kind: 'timeout', phase,
    outcome: dispatchState === 'not-dispatched' ? 'not-dispatched' : 'unknown-after-dispatch',
    dispatchState,
    mutationOutcome,
    mutationReport: {
      version: 1, outcome: mutationOutcome, attempted: confirmed,
      restored: 0, residueCount: confirmed,
    },
  });
}

function assertTokenSyncTimeRemaining(remainingMs, phase, state) {
  if (typeof remainingMs !== 'function') return undefined;
  const remaining = Number(remainingMs());
  if (Number.isNaN(remaining) || remaining <= 0) {
    throw tokenSyncDeadlineFailure(phase, state);
  }
  return Number.isFinite(remaining) ? Math.max(1, Math.floor(remaining)) : undefined;
}

function targetLockFailure(message, dispatchState = 'not-dispatched') {
  return Object.assign(new Error(
    `${message} [dispatch:${dispatchState}] [mutation:no-mutation].`,
  ), {
    kind: 'targeting', phase: 'target-resolution',
    outcome: dispatchState === 'not-dispatched' ? 'not-dispatched' : 'unknown-after-dispatch',
    dispatchState, mutationOutcome: 'no-mutation',
    mutationReport: {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    },
  });
}

export async function executeTokenSync(prepared, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeTokenSync requires evaluate(code)');
  const input = normalizedPrepared(prepared);
  if (input.request.apply
    && (!adapters.workspaceIO || typeof adapters.workspaceIO.replace !== 'function')) {
    throw new TypeError('Token Sync apply requires atomic WorkspaceIO replacement.');
  }
  if (input.lock?.fileKey && adapters.fileKey && input.lock.fileKey !== adapters.fileKey) {
    throw targetLockFailure('Token Sync lockfile belongs to a different resolved Figma file target');
  }
  const read = await readFigma(input, adapters.evaluate, adapters.remainingMs);
  if (read.fileKey && adapters.fileKey && read.fileKey !== adapters.fileKey) {
    throw targetLockFailure(
      'Token Sync observed a different Figma file than its Command Plan target', 'completed',
    );
  }
  const provenFileKey = read.fileKey || adapters.fileKey || null;
  if (input.lock?.fileKey && !provenFileKey) {
    throw targetLockFailure(
      'Token Sync cannot prove the Figma file identity recorded by its lockfile; use an explicit file target',
      'completed',
    );
  }
  if (input.lock?.fileKey && input.lock.fileKey !== provenFileKey) {
    throw targetLockFailure(
      'Token Sync lockfile belongs to a different observed Figma file', 'completed',
    );
  }
  const context = planAndWarnings(input, read);
  const { syncPlan, lines } = context;
  if (syncPlan.conflict.length) {
    lines.push(`${syncPlan.conflict.length} conflict(s); nothing was applied.`);
    return { stdout: lines.join('\n\n'), stderr: '', code: 1,
      result: { schemaVersion: 1, status: 'conflict', conflicts: syncPlan.conflict.length } };
  }
  if (!input.request.apply) {
    const pending = planTouchesFigma(syncPlan);
    lines.push(pending
      ? 'Dry run. Re-run with --apply to write these changes to Figma.'
      : 'Figma is already in sync with this file.');
    return { stdout: lines.join('\n\n'), stderr: '', code: pending ? 1 : 0,
      result: { schemaVersion: 1, status: pending ? 'planned' : 'unchanged' } };
  }
  const retypes = syncPlan.update.filter((token) => token.typeChange);
  if (retypes.length) {
    lines.push(`${retypes.length} Variable(s) change type and will be recreated; native bindings cannot be preserved.`);
  }
  let mutation = null;
  if (planTouchesFigma(syncPlan)) {
    mutation = await applyFigma(input, read, syncPlan, adapters.evaluate, adapters.remainingMs);
  }
  let lockText;
  try {
    const tokens = lockTokens(input, context, mutation);
    lockText = JSON.stringify(buildLock({
      collection: input.request.collection,
      fileKey: provenFileKey,
      tokens,
    }), null, 2) + '\n';
  } catch (error) { throw publicationFailure(error, mutation); }
  assertTokenSyncTimeRemaining(adapters.remainingMs, 'workspace-publication', {
    dispatchState: 'completed', mutation,
  });
  try {
    adapters.workspaceIO.replace(input.lockPath, lockText, {
      role: 'token-lockfile', createParents: true,
    });
  } catch (error) { throw publicationFailure(error, mutation); }
  const counts = mutation?.payload?.counts
    || { created: 0, updated: 0, retyped: 0, renamed: 0, deleted: 0 };
  lines.push(`${counts.created} created, ${counts.updated} updated, ${counts.retyped} retyped, `
    + `${counts.renamed} renamed, ${counts.deleted} deleted.`);
  lines.push(`lockfile: ${input.lockPath}`);
  if (syncPlan.pull.length) {
    lines.push(`${syncPlan.pull.length} token(s) are newer in Figma; update the source and re-run before they become agreed state.`);
  }
  return { stdout: lines.join('\n\n'), stderr: '', code: 0,
    result: mutation?.payload || { schemaVersion: 1, status: 'complete', outcome: 'no-mutation' } };
}

export function tokenSyncPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Token Sync routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-token-sync';
}

export async function executeTokenSyncPlan(plan, prepared, adapters = {}) {
  if (tokenSyncPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Sync.`);
  }
  if (!isDeepStrictEqual(prepared?.request, parseTokenSyncRequest(plan.argv))) {
    throw new Error('Token Sync prepared source does not match its Command Plan.');
  }
  return executeTokenSync(prepared, adapters);
}
