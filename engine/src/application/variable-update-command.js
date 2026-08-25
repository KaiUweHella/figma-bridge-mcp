// Bounded, rollback-owned Variable Metadata Update Command Application.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  isVariableFactsPayload,
  MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS,
  MAX_VARIABLE_FACTS_STRING_CODE_UNITS,
  variableFactsLegacyProjection,
} from './variable-facts-command.js';
import { variableMutationPluginRuntimeCode } from './variable-mutation-runtime.js';
import {
  parseVariableUpdateRequest,
  variableUpdateArgvFromRequest,
  variableUpdatePlanningArgvFromRequest,
} from './variable-update-request.js';

export {
  variableUpdateArgvFromRequest,
  variableUpdatePlanningArgvFromRequest,
} from './variable-update-request.js';

const VARIABLE_UPDATE_APPLICATION_ID = 'var.update';
export const MAX_VARIABLE_UPDATE_CANDIDATES = 100_000;
export const MAX_VARIABLE_UPDATE_SERIALIZED_CODE_UNITS =
  MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS + 32_768;
const UPDATE_FIELDS = ['name', 'description', 'hiddenFromPublishing', 'scopes'];

function normalizedRequest(request) {
  return parseVariableUpdateRequest(variableUpdateArgvFromRequest(request));
}

function requestedFields(input) {
  return [
    ...(input.name === undefined ? [] : ['name']),
    ...(input.description === undefined ? [] : ['description']),
    ...(input.hidden === undefined ? [] : ['hiddenFromPublishing']),
    ...(input.scopes === undefined ? [] : ['scopes']),
  ];
}

export function variableUpdateCommandCode(request) {
  const input = normalizedRequest(request);
  const fields = requestedFields(input);
  return `(async () => {
    const query = ${JSON.stringify(input.variable)};
    const collectionHint = ${JSON.stringify(input.collection)};
    const hasName = ${input.name !== undefined};
    const nextName = ${JSON.stringify(input.name ?? null)};
    const hasDescription = ${input.description !== undefined};
    const nextDescription = ${JSON.stringify(input.description ?? null)};
    const hasHidden = ${input.hidden !== undefined};
    const nextHidden = ${JSON.stringify(input.hidden ?? null)};
    const hasScopes = ${input.scopes !== undefined};
    const nextScopes = ${JSON.stringify(input.scopes ?? null)};
    const requested = ${JSON.stringify(fields)};
    ${variableMutationPluginRuntimeCode({ candidateLimit: MAX_VARIABLE_UPDATE_CANDIDATES })}
    const resolved = __bridgeResolveVariable(query, collectionHint);
    const variable = resolved.variable;
    const collection = resolved.collection;
    if (variable.remote || collection.remote) {
      throw new Error('Remote Variables cannot update metadata.');
    }
    const preflightFacts = await __bridgeVariableFacts(variable, collection);
    if (!__bridgeValidateVariableFacts(preflightFacts)) {
      throw new Error('Variable Update encountered incompatible preflight metadata.');
    }
    const matchedNameBefore = variable.name;
    const previous = {
      name: variable.name,
      description: variable.description,
      hiddenFromPublishing: variable.hiddenFromPublishing,
      scopes: [...variable.scopes],
    };
    let attempted = false;
    try {
      attempted = true;
      if (hasName) variable.name = nextName;
      if (hasDescription) variable.description = nextDescription;
      if (hasHidden) variable.hiddenFromPublishing = nextHidden;
      if (hasScopes) variable.scopes = [...nextScopes];
      const facts = await __bridgeVariableFacts(variable, collection);
      const affectedValid = (!hasName || facts.name === nextName)
        && (!hasDescription || facts.description === nextDescription)
        && (!hasHidden || facts.hiddenFromPublishing === nextHidden)
        && (!hasScopes || (facts.scopes.length === nextScopes.length
          && facts.scopes.every((scope, index) => scope === nextScopes[index])));
      if (!__bridgeValidateVariableFacts(facts) || !affectedValid) {
        throw new Error('Variable Update encountered incompatible result metadata.');
      }
      const complete = {
        schemaVersion: 1, status: 'updated', resolution: resolved.resolution,
        query, collectionHint, matchedNameBefore, requestedFields: requested,
        variable: facts, residue: [],
      };
      const serialized = JSON.stringify(complete);
      if (serialized.length > ${MAX_VARIABLE_UPDATE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Update result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      const restoreFailures = [];
      const restore = (field, apply, verify) => {
        if (!requested.includes(field)) return;
        try { apply(); } catch { restoreFailures.push(field); return; }
        if (!verify()) restoreFailures.push(field);
      };
      restore('name', () => { variable.name = previous.name; },
        () => variable.name === previous.name);
      restore('description', () => { variable.description = previous.description; },
        () => variable.description === previous.description);
      restore('hiddenFromPublishing',
        () => { variable.hiddenFromPublishing = previous.hiddenFromPublishing; },
        () => variable.hiddenFromPublishing === previous.hiddenFromPublishing);
      restore('scopes', () => { variable.scopes = [...previous.scopes]; },
        () => variable.scopes.length === previous.scopes.length
          && variable.scopes.every((scope, index) => scope === previous.scopes[index]));
      const outcome = restoreFailures.length ? 'partial-residue' : 'rolled-back';
      const failure = {
        schemaVersion: 1, status: 'failed', outcome, attempted,
        query, collectionHint, matchedNameBefore, requestedFields: requested,
        restoreFailures, restoreReason: outcome === 'rolled-back' ? null : 'restore-failed',
        variable: {
          id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
        },
        residue: outcome === 'rolled-back' ? [] : [{
          id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
        }],
      };
      const serialized = JSON.stringify(failure);
      if (serialized.length > 32_768) {
        throw new Error('Variable Update failure evidence exceeded the result limit.');
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
  return typeof value === 'string' && value.length <= MAX_VARIABLE_FACTS_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function sameMembers(value, expected) {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function inputIdentity(value, input, fields) {
  return value.query === input.variable && value.collectionHint === input.collection
    && boundedString(value.matchedNameBefore, { empty: false })
    && sameMembers(value.requestedFields, fields);
}

function validIdentity(value) {
  return exactKeys(value, ['id', 'name', 'resolvedType'])
    && boundedString(value.id, { empty: false }) && boundedString(value.name, { empty: false })
    && ['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']
      .includes(value.resolvedType);
}

function validFailure(value, input, fields) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'query', 'collectionHint',
    'matchedNameBefore', 'requestedFields', 'restoreFailures', 'restoreReason',
    'variable', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'failed' && value.attempted === true
    && inputIdentity(value, input, fields)
    && ['rolled-back', 'partial-residue'].includes(value.outcome)
    && validIdentity(value.variable)
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
        && value.residue[0].id === value.variable.id);
}

function validSuccess(value, input, fields) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'collectionHint',
    'matchedNameBefore', 'requestedFields', 'variable', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'updated'
    && ['id', 'name'].includes(value.resolution) && inputIdentity(value, input, fields)
    && isVariableFactsPayload(value.variable)
    && (value.resolution !== 'id' || value.variable.id === input.variable)
    && (input.collection === null || value.variable.collection.id === input.collection
      || value.variable.collection.name.toLowerCase().includes(input.collection.toLowerCase()))
    && (input.name === undefined || value.variable.name === input.name)
    && (input.description === undefined || value.variable.description === input.description)
    && (input.hidden === undefined || value.variable.hiddenFromPublishing === input.hidden)
    && (input.scopes === undefined || isDeepStrictEqual(value.variable.scopes, input.scopes))
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function mutationFailure(payload) {
  const rolledBack = payload.outcome === 'rolled-back';
  const error = new Error(rolledBack
    ? 'Variable Update failed after mutation; every requested metadata field was restored.'
    : `Variable Update failed after mutation; fields could not be restored: ${payload.restoreFailures.join(', ')}.`);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.variableUpdateMutationReport = {
    version: 1, outcome: payload.outcome, attempted: payload.requestedFields.length,
    restored: payload.requestedFields.length - payload.restoreFailures.length,
    restoreReason: payload.restoreReason,
    restoreFailures: payload.restoreFailures,
    residueCount: payload.residue.length,
  };
  throw error;
}

export async function executeVariableUpdate(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableUpdate requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const fields = requestedFields(input);
  const serialized = await adapters.evaluate(variableUpdateCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_UPDATE_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Update returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Update returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input, fields)) {
      throw new Error('Variable Update returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input, fields)) {
    throw new Error('Variable Update returned an invalid bounded result.');
  }
  return {
    stdout: JSON.stringify(variableFactsLegacyProjection(payload.variable), null, 2).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    stderr: '', result: payload,
  };
}

export function variableUpdatePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Update routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_UPDATE_APPLICATION_ID
    ? 'command-application' : 'not-variable-update';
}

export async function executeVariableUpdatePlan(plan, adapters = {}) {
  if (variableUpdatePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Update.`);
  }
  return executeVariableUpdate(parseVariableUpdateRequest(plan.argv), adapters);
}
