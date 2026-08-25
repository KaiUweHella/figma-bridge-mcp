// Bounded, irreversible exact Variable Deletion Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_VARIABLE_DELETE_TARGETS,
  parseVariableDeleteRequest,
  variableDeleteArgvFromRequest,
  variableDeletePlanningArgvFromRequest,
} from './variable-delete-request.js';

export {
  variableDeleteArgvFromRequest,
  variableDeletePlanningArgvFromRequest,
} from './variable-delete-request.js';

const VARIABLE_DELETE_APPLICATION_ID = 'var.delete';
const MAX_VARIABLE_DELETE_CANDIDATES = 100_000;
const MAX_VARIABLE_DELETE_STRING_CODE_UNITS = 1024;
export const MAX_VARIABLE_DELETE_SERIALIZED_CODE_UNITS = 1_000_000;

function normalizedRequest(request) {
  return parseVariableDeleteRequest(variableDeleteArgvFromRequest(request));
}

export function variableDeleteCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const queries = ${JSON.stringify(input.names)};
    const collectionQuery = ${JSON.stringify(input.collection)};
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    if (!Array.isArray(collections) || collections.length > ${MAX_VARIABLE_DELETE_CANDIDATES}
      || !Array.isArray(variables) || variables.length > ${MAX_VARIABLE_DELETE_CANDIDATES}) {
      throw new Error('Variable Deletion candidate limit exceeded.');
    }
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_VARIABLE_DELETE_STRING_CODE_UNITS} && (empty || value.length > 0);
    if (new Set(collections.map((item) => item.id)).size !== collections.length
      || new Set(variables.map((item) => item.id)).size !== variables.length) {
      throw new Error('Variable Deletion encountered duplicate native identities.');
    }
    const resolveCollection = (query) => {
      const direct = collections.filter((item) => item.id === query);
      const exact = collections.filter((item) => item.name === query);
      const partial = collections.filter((item) =>
        item.name.toLowerCase().includes(query.toLowerCase()));
      const matches = direct.length ? direct : (exact.length ? exact : partial);
      if (matches.length > 1) throw new Error('Variable Collection is ambiguous; use its id.');
      if (!matches.length) throw new Error('Variable Collection not found.');
      const collection = matches[0];
      if (!validText(collection.id, false) || !validText(collection.name)
        || collection.remote) throw new Error('Variable Deletion encountered invalid Collection metadata.');
      return {
        collection,
        resolution: direct.length ? 'id' : 'name',
      };
    };
    const scoped = collectionQuery === null ? null : resolveCollection(collectionQuery);
    const scope = scoped && scoped.collection;
    const pool = scope ? variables.filter((variable) => variable.variableCollectionId === scope.id) : variables;
    const targets = [];
    const missing = [];
    const targetIds = new Set();
    for (const query of queries) {
      const direct = pool.filter((variable) => variable.id === query);
      const exact = pool.filter((variable) => variable.name === query);
      const matches = direct.length ? direct : exact;
      if (matches.length > 1) {
        throw new Error('Variable name is ambiguous; use its id or --collection.');
      }
      if (!matches.length) { missing.push(query); continue; }
      const variable = matches[0];
      const owner = collections.find((collection) =>
        collection.id === variable.variableCollectionId);
      if (!validText(variable.id, false) || !validText(variable.name, false)
        || variable.remote || !owner || !validText(owner.id, false)
        || !validText(owner.name) || owner.remote
        || (scope && owner.id !== scope.id)) {
        throw new Error('Variable Deletion encountered invalid Variable ownership metadata.');
      }
      if (targetIds.has(variable.id)) {
        throw new Error('Variable Deletion inputs resolve to the same Variable more than once.');
      }
      targetIds.add(variable.id);
      targets.push({
        query, id: variable.id, name: variable.name,
        collectionId: owner.id, resolution: direct.length ? 'id' : 'name', variable,
      });
    }
    if (targets.length > ${MAX_VARIABLE_DELETE_TARGETS}) {
      throw new Error('Variable Deletion target limit exceeded.');
    }
    const scopeFacts = scope ? {
      query: collectionQuery, id: scope.id, name: scope.name,
      resolution: scoped.resolution,
    } : null;
    const compact = (target) => ({
      query: target.query, id: target.id, name: target.name,
      collectionId: target.collectionId, resolution: target.resolution,
    });
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_VARIABLE_DELETE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Deletion result exceeded the bounded result limit.');
      }
      return serialized;
    };
    if (!targets.length) return bounded({
      schemaVersion: 1, status: 'deleted', scope: scopeFacts,
      deleted: [], missing, residue: [],
    });
    for (const target of targets) {
      try { target.variable.remove(); } catch {}
    }
    let after;
    try { after = await figma.variables.getLocalVariablesAsync(); } catch {}
    const afterIds = Array.isArray(after) ? new Set() : null;
    const validAfter = Array.isArray(after) && after.length <= ${MAX_VARIABLE_DELETE_CANDIDATES}
      && after.every((variable) => validText(variable.id, false)
        && !afterIds.has(variable.id) && !!afterIds.add(variable.id));
    if (!validAfter) {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        scope: scopeFacts, targeted: targets.map(compact), deleted: [], missing,
        residue: targets.map(compact), residueTruncated: false,
      });
    }
    const remainingIds = afterIds;
    const deleted = targets.filter((target) => !remainingIds.has(target.id));
    const residue = targets.filter((target) => remainingIds.has(target.id));
    if (!residue.length) return bounded({
      schemaVersion: 1, status: 'deleted', scope: scopeFacts,
      deleted: deleted.map(compact), missing, residue: [],
    });
    return bounded({
      schemaVersion: 1, status: 'failed',
      outcome: deleted.length ? 'partial-residue' : 'unchanged',
      scope: scopeFacts, targeted: targets.map(compact),
      deleted: deleted.map(compact), missing,
      residue: residue.map(compact), residueTruncated: false,
    });
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_VARIABLE_DELETE_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function validScope(value, input) {
  if (value === null) return input.collection === null;
  return input.collection !== null
    && exactKeys(value, ['query', 'id', 'name', 'resolution'])
    && value.query === input.collection
    && boundedString(value.id, { empty: false }) && boundedString(value.name)
    && ['id', 'name'].includes(value.resolution)
    && (value.resolution === 'id'
      ? value.id === input.collection
      : value.name.toLowerCase().includes(input.collection.toLowerCase()));
}

function validTarget(value, input) {
  return exactKeys(value, ['query', 'id', 'name', 'collectionId', 'resolution'])
    && input.names.includes(value.query)
    && boundedString(value.id, { empty: false })
    && boundedString(value.name, { empty: false })
    && boundedString(value.collectionId, { empty: false })
    && ['id', 'name'].includes(value.resolution)
    && (value.resolution === 'id' ? value.id === value.query : value.name === value.query);
}

function uniqueTargets(values, input) {
  if (!Array.isArray(values) || values.length > MAX_VARIABLE_DELETE_TARGETS
    || !values.every((value) => validTarget(value, input))) return false;
  return new Set(values.map((value) => value.id)).size === values.length
    && new Set(values.map((value) => value.query)).size === values.length;
}

function validMissing(values, input) {
  return Array.isArray(values) && values.length <= input.names.length
    && values.every((value) => input.names.includes(value))
    && new Set(values).size === values.length;
}

function exactInputPartition(input, targeted, missing) {
  const queries = [...targeted.map((target) => target.query), ...missing];
  return queries.length === input.names.length
    && new Set(queries).size === queries.length
    && input.names.every((query) => queries.includes(query));
}

function validSuccess(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'scope', 'deleted', 'missing', 'residue'])
    && value.schemaVersion === 1 && value.status === 'deleted'
    && validScope(value.scope, input) && uniqueTargets(value.deleted, input)
    && validMissing(value.missing, input)
    && exactInputPartition(input, value.deleted, value.missing)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function targetPartition(targeted, deleted, residue) {
  const partition = [...deleted, ...residue];
  const ids = partition.map((target) => target.id);
  return ids.length === targeted.length && new Set(ids).size === ids.length
    && targeted.every((target) => partition.some((item) =>
      item.id === target.id && item.query === target.query && item.name === target.name
      && item.collectionId === target.collectionId && item.resolution === target.resolution));
}

function validFailure(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'scope', 'targeted', 'deleted',
    'missing', 'residue', 'residueTruncated',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['unchanged', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || !validScope(value.scope, input) || !uniqueTargets(value.targeted, input)
    || !uniqueTargets(value.deleted, input) || !validMissing(value.missing, input)
    || !uniqueTargets(value.residue, input) || value.residueTruncated !== false
    || value.targeted.length < 1
    || !exactInputPartition(input, value.targeted, value.missing)
    || !targetPartition(value.targeted, value.deleted, value.residue)
  ) return false;
  if (value.outcome === 'unchanged') {
    return value.deleted.length === 0 && value.residue.length === value.targeted.length;
  }
  if (value.outcome === 'partial-residue') {
    return value.deleted.length > 0 && value.residue.length > 0;
  }
  return value.deleted.length === 0 && value.residue.length === value.targeted.length;
}

function mutationFailure(payload) {
  const messages = {
    unchanged: 'Variable Deletion failed before any targeted Variable was removed.',
    'partial-residue': 'Variable Deletion applied only part of the exact requested batch; removed Variables cannot be restored.',
    'verification-unavailable': 'Variable Deletion was dispatched, but complete removal verification is unavailable.',
  };
  const error = new Error(messages[payload.outcome]);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.variableDeleteMutationReport = {
    version: 1, outcome: payload.outcome,
    targetedCount: payload.targeted.length,
    deletedCount: payload.deleted.length,
    missingCount: payload.missing.length,
    residueCount: payload.residue.length,
    residueTruncated: payload.residueTruncated,
  };
  throw error;
}

function safeLabel(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '�');
}

function legacyOutput(payload) {
  const lines = [];
  if (payload.deleted.length) lines.push(`✓ Deleted: ${payload.deleted.map((item) => safeLabel(item.query)).join(', ')}`);
  if (payload.missing.length) lines.push(`⚠ Not deleted: ${payload.missing.map(safeLabel).join(', ')}`);
  return lines.join('\n');
}

export async function executeVariableDelete(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableDelete requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableDeleteCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_DELETE_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Deletion returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Deletion returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Variable Deletion returned an invalid bounded result.');
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Variable Deletion returned an invalid bounded result.');
  }
  return { stdout: legacyOutput(payload), stderr: '', result: payload };
}

export function variableDeletePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Deletion routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_DELETE_APPLICATION_ID
    ? 'command-application' : 'not-variable-delete';
}

export async function executeVariableDeletePlan(plan, adapters = {}) {
  if (variableDeletePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Deletion.`);
  }
  return executeVariableDelete(parseVariableDeleteRequest(plan.argv), adapters);
}
