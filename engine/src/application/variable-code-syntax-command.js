// Bounded, rollback-owned Variable Code Syntax Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  isVariableFactsPayload,
  MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS,
  MAX_VARIABLE_FACTS_STRING_CODE_UNITS,
  variableFactsLegacyProjection,
} from './variable-facts-command.js';
import { variableMutationPluginRuntimeCode } from './variable-mutation-runtime.js';
import {
  parseVariableCodeSyntaxRequest,
  variableCodeSyntaxArgvFromRequest,
  variableCodeSyntaxPlanningArgvFromRequest,
} from './variable-code-syntax-request.js';

export {
  variableCodeSyntaxArgvFromRequest,
  variableCodeSyntaxPlanningArgvFromRequest,
} from './variable-code-syntax-request.js';

const VARIABLE_CODE_SYNTAX_APPLICATION_ID = 'var.code-syntax';
export const MAX_VARIABLE_CODE_SYNTAX_CANDIDATES = 100_000;
export const MAX_VARIABLE_CODE_SYNTAX_SERIALIZED_CODE_UNITS =
  MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS + 32_768;

function normalizedRequest(request) {
  return parseVariableCodeSyntaxRequest(variableCodeSyntaxArgvFromRequest(request));
}

export function variableCodeSyntaxCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.variable)};
    const collectionHint = ${JSON.stringify(input.collection)};
    const platform = ${JSON.stringify(input.platform)};
    const nextSyntax = ${JSON.stringify(input.value)};
    const remove = ${input.remove};
    ${variableMutationPluginRuntimeCode({ candidateLimit: MAX_VARIABLE_CODE_SYNTAX_CANDIDATES })}
    const resolved = __bridgeResolveVariable(query, collectionHint);
    const variable = resolved.variable;
    const collection = resolved.collection;
    if (variable.remote || collection.remote) {
      throw new Error('Remote Variables cannot update code syntax.');
    }
    const preflightFacts = await __bridgeVariableFacts(variable, collection);
    if (!__bridgeValidateVariableFacts(preflightFacts)) {
      throw new Error('Variable Code Syntax encountered incompatible preflight metadata.');
    }
    const hadPrevious = Object.prototype.hasOwnProperty.call(variable.codeSyntax, platform);
    const previous = hadPrevious ? variable.codeSyntax[platform] : null;
    let attempted = false;
    try {
      attempted = true;
      if (remove) variable.removeVariableCodeSyntax(platform);
      else variable.setVariableCodeSyntax(platform, nextSyntax);
      const facts = await __bridgeVariableFacts(variable, collection);
      const affectedValid = remove
        ? !Object.prototype.hasOwnProperty.call(facts.codeSyntax, platform)
        : facts.codeSyntax[platform] === nextSyntax;
      if (!__bridgeValidateVariableFacts(facts) || !affectedValid) {
        throw new Error('Variable Code Syntax encountered incompatible result metadata.');
      }
      const complete = {
        schemaVersion: 1, status: 'updated', resolution: resolved.resolution,
        query, collectionHint, matchedName: variable.name, platform,
        operation: remove ? 'remove' : 'set', previouslyDefined: hadPrevious,
        value: remove ? null : facts.codeSyntax[platform], variable: facts, residue: [],
      };
      const serialized = JSON.stringify(complete);
      if (serialized.length > ${MAX_VARIABLE_CODE_SYNTAX_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Code Syntax result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      let outcome = 'partial-residue';
      if (!hadPrevious && remove) outcome = 'rolled-back';
      else {
        try {
          if (hadPrevious) variable.setVariableCodeSyntax(platform, previous);
          else variable.removeVariableCodeSyntax(platform);
          outcome = 'rolled-back';
        } catch {}
      }
      const failure = {
        schemaVersion: 1, status: 'failed', outcome, attempted,
        query, collectionHint, matchedName: variable.name, platform,
        operation: remove ? 'remove' : 'set', hadPrevious,
        restoreReason: outcome === 'rolled-back' ? null : 'restore-failed',
        variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType },
        residue: outcome === 'rolled-back' ? [] : [{
          id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
        }],
      };
      const serialized = JSON.stringify(failure);
      if (serialized.length > 32_768) {
        throw new Error('Variable Code Syntax failure evidence exceeded the result limit.');
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

function inputIdentity(value, input) {
  return value.query === input.variable && value.collectionHint === input.collection
    && boundedString(value.matchedName, { empty: false })
    && value.platform === input.platform
    && value.operation === (input.remove ? 'remove' : 'set');
}

function validFailure(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'query', 'collectionHint',
    'matchedName', 'platform', 'operation', 'hadPrevious', 'restoreReason',
    'variable', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'failed' && value.attempted === true
    && inputIdentity(value, input)
    && ['rolled-back', 'partial-residue'].includes(value.outcome)
    && typeof value.hadPrevious === 'boolean'
    && exactKeys(value.variable, ['id', 'name', 'resolvedType'])
    && boundedString(value.variable.id, { empty: false })
    && boundedString(value.variable.name, { empty: false })
    && value.variable.name === value.matchedName
    && ['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']
      .includes(value.variable.resolvedType)
    && Array.isArray(value.residue)
    && (value.outcome === 'rolled-back'
      ? value.restoreReason === null && value.residue.length === 0
      : value.restoreReason === 'restore-failed' && value.residue.length === 1
        && exactKeys(value.residue[0], ['id', 'name', 'resolvedType'])
        && value.residue[0].id === value.variable.id);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'collectionHint', 'matchedName',
    'platform', 'operation', 'previouslyDefined', 'value', 'variable', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'updated'
    && ['id', 'name'].includes(value.resolution) && inputIdentity(value, input)
    && typeof value.previouslyDefined === 'boolean'
    && isVariableFactsPayload(value.variable)
    && value.variable.name === value.matchedName
    && (value.resolution !== 'id' || value.variable.id === input.variable)
    && (input.collection === null || value.variable.collection.id === input.collection
      || value.variable.collection.name.toLowerCase().includes(input.collection.toLowerCase()))
    && (input.remove
      ? value.value === null
        && !Object.prototype.hasOwnProperty.call(value.variable.codeSyntax, input.platform)
      : value.value === input.value && value.variable.codeSyntax[input.platform] === input.value)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function mutationFailure(payload) {
  const rolledBack = payload.outcome === 'rolled-back';
  const error = new Error(rolledBack
    ? 'Variable Code Syntax failed after mutation; the previous platform syntax was restored.'
    : 'Variable Code Syntax failed after mutation; the previous platform syntax could not be restored.');
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.variableCodeSyntaxMutationReport = {
    version: 1, outcome: payload.outcome, attempted: 1,
    restored: rolledBack ? 1 : 0, restoreReason: payload.restoreReason,
    residueCount: payload.residue.length,
  };
  throw error;
}

export async function executeVariableCodeSyntax(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableCodeSyntax requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableCodeSyntaxCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_CODE_SYNTAX_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Code Syntax returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Code Syntax returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Variable Code Syntax returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Variable Code Syntax returned an invalid bounded result.');
  }
  return {
    stdout: JSON.stringify(variableFactsLegacyProjection(payload.variable), null, 2).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    stderr: '', result: payload,
  };
}

export function variableCodeSyntaxPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Code Syntax routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_CODE_SYNTAX_APPLICATION_ID
    ? 'command-application' : 'not-variable-code-syntax';
}

export async function executeVariableCodeSyntaxPlan(plan, adapters = {}) {
  if (variableCodeSyntaxPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Code Syntax.`);
  }
  return executeVariableCodeSyntax(parseVariableCodeSyntaxRequest(plan.argv), adapters);
}
