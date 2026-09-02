// Bounded, rollback-owned Variable Set Value Command Application.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  isVariableFactsPayload,
  MAX_VARIABLE_FACTS_CONTAINER_ENTRIES,
  MAX_VARIABLE_FACTS_DEPTH,
  MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS,
  MAX_VARIABLE_FACTS_STRING_CODE_UNITS,
  MAX_VARIABLE_FACTS_VALUES,
  variableFactsLegacyProjection,
} from './variable-facts-command.js';
import {
  parseVariableSetValueRequest,
  variableSetValueArgvFromRequest,
  variableSetValuePlanningArgvFromRequest,
} from './variable-set-value-request.js';
import { variableMutationPluginRuntimeCode } from './variable-mutation-runtime.js';

export { variableSetValueArgvFromRequest, variableSetValuePlanningArgvFromRequest } from './variable-set-value-request.js';

const VARIABLE_SET_VALUE_APPLICATION_ID = 'var.set-value';
export const MAX_VARIABLE_SET_VALUE_CANDIDATES = 100_000;
export const MAX_VARIABLE_SET_VALUE_SERIALIZED_CODE_UNITS = MAX_VARIABLE_FACTS_SERIALIZED_CODE_UNITS + 32_768;
const MAX_VARIABLE_SET_VALUE_LABEL_CODE_UNITS = 1024;
const VARIABLE_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);

function normalizedRequest(request) {
  return parseVariableSetValueRequest(variableSetValueArgvFromRequest(request));
}

export function variableSetValueCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.variable)};
    const collectionHint = ${JSON.stringify(input.collection)};
    const modeQuery = ${JSON.stringify(input.mode)};
    const literal = ${JSON.stringify(input.value)};
    const aliasQuery = ${JSON.stringify(input.alias)};
    ${variableMutationPluginRuntimeCode({ candidateLimit: MAX_VARIABLE_SET_VALUE_CANDIDATES })}
    const resolved = __bridgeResolveVariable(query, collectionHint);
    const variable = resolved.variable;
    const collection = resolved.collection;
    if (variable.remote || collection.remote) throw new Error('Remote Variables cannot be updated.');
    const exactModes = collection.modes.filter((mode) =>
      mode.modeId === modeQuery || mode.name === modeQuery);
    const modeMatches = exactModes.length ? exactModes : collection.modes.filter((mode) =>
      mode.name.toLowerCase().includes(modeQuery.toLowerCase()));
    if (modeMatches.length > 1) throw new Error('Variable mode is ambiguous; use its id.');
    if (!modeMatches.length) throw new Error('Variable mode not found.');
    const mode = modeMatches[0];

    let nextValue;
    let aliasTarget = null;
    let source = 'literal';
    const easingTypes = new Set([
      'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK',
      'EASE_OUT_BACK', 'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE',
      'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING', 'HOLD',
    ]);
    if (aliasQuery !== null) {
      aliasTarget = __bridgeResolveVariable(aliasQuery).variable;
      if (aliasTarget.resolvedType !== variable.resolvedType) {
        throw new Error('Alias type does not match the target Variable type.');
      }
      nextValue = figma.variables.createVariableAlias(aliasTarget);
      source = 'alias';
    } else if (variable.resolvedType === 'STRING') nextValue = literal;
    else if (variable.resolvedType === 'BOOLEAN') {
      if (!/^(true|false)$/i.test(literal)) throw new Error('BOOLEAN value must be true or false.');
      nextValue = literal.toLowerCase() === 'true';
    } else if (variable.resolvedType === 'FLOAT' || variable.resolvedType === 'TIMING') {
      nextValue = Number(literal);
      if (!Number.isFinite(nextValue)) throw new Error(variable.resolvedType + ' value must be finite.');
      if (variable.resolvedType === 'TIMING' && nextValue < 0) {
        throw new Error('TIMING value must be zero or greater.');
      }
    } else if (variable.resolvedType === 'COLOR') {
      const match = literal.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
      if (!match) throw new Error('COLOR value must be hexadecimal.');
      let hex = match[1];
      if (hex.length <= 4) hex = [...hex].map((character) => character + character).join('');
      nextValue = {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    } else {
      try { nextValue = JSON.parse(literal); }
      catch {
        nextValue = { type: literal.trim().toUpperCase().replace(/[ -]+/g, '_') };
      }
      if (nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue)) {
        nextValue.type = String(nextValue.type || '').toUpperCase().replace(/[ -]+/g, '_');
      }
      if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue)
        || !easingTypes.has(nextValue.type)) {
        throw new Error('EASING value must be a named easing or MotionEasing JSON object.');
      }
    }

    const preflightFacts = await __bridgeVariableFacts(variable, collection);
    if (!__bridgeValidateVariableFacts(preflightFacts)) {
      throw new Error('Variable Set Value encountered incompatible preflight metadata.');
    }
    const hadPrevious = Object.prototype.hasOwnProperty.call(variable.valuesByMode, mode.modeId);
    const previous = hadPrevious ? variable.valuesByMode[mode.modeId] : null;
    if (hadPrevious && __bridgeComposedColorValue(previous)) {
      throw new Error('Variable Set Value cannot restore composed color values because the public Figma Plugin API does not accept them in setValueForMode. Change the alias opacity in Figma or detach it before replacing this mode value.');
    }
    let attempted = false;
    try {
      attempted = true;
      variable.setValueForMode(mode.modeId, nextValue);
      const facts = await __bridgeVariableFacts(variable, collection);
      if (!__bridgeValidateVariableFacts(facts)
        || !Object.prototype.hasOwnProperty.call(facts.valuesByMode, mode.modeId)) {
        throw new Error('Variable Set Value encountered incompatible result metadata.');
      }
      let values = 0;
      const seen = new Set();
      const verify = (value, depth = 0) => {
        values++;
        if (values > ${MAX_VARIABLE_FACTS_VALUES} || depth > ${MAX_VARIABLE_FACTS_DEPTH}) {
          throw new Error('Variable Set Value result structure limit exceeded.');
        }
        if (value === null || typeof value === 'boolean') return;
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) throw new Error('Variable Set Value returned a non-finite number.');
          return;
        }
        if (typeof value === 'string') {
          if (value.length > ${MAX_VARIABLE_FACTS_STRING_CODE_UNITS}) {
            throw new Error('Variable Set Value result string limit exceeded.');
          }
          return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) {
          throw new Error('Variable Set Value returned non-JSON facts.');
        }
        seen.add(value);
        const entries = Array.isArray(value) ? value : Object.keys(value);
        if (entries.length > ${MAX_VARIABLE_FACTS_CONTAINER_ENTRIES}) {
          throw new Error('Variable Set Value result container limit exceeded.');
        }
        if (Array.isArray(value)) for (const item of value) verify(item, depth + 1);
        else for (const key of entries) verify(value[key], depth + 1);
        seen.delete(value);
      };
      const complete = {
        schemaVersion: 1, status: 'updated', resolution: resolved.resolution,
        query, collectionHint, matchedName: variable.name, source,
        aliasTarget: aliasTarget === null ? null : {
          id: aliasTarget.id, name: aliasTarget.name, resolvedType: aliasTarget.resolvedType,
        },
        variable: facts, mode: { modeId: mode.modeId, name: mode.name },
        value: variable.valuesByMode[mode.modeId], residue: [],
      };
      verify(complete);
      const serialized = JSON.stringify(complete);
      if (serialized.length > ${MAX_VARIABLE_SET_VALUE_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Set Value result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      let outcome = 'partial-residue';
      let restoreReason = hadPrevious ? 'restore-failed' : 'no-reversal-api';
      if (hadPrevious) {
        try {
          variable.setValueForMode(mode.modeId, previous);
          outcome = 'rolled-back';
          restoreReason = null;
        } catch {}
      }
      const failure = {
        schemaVersion: 1, status: 'failed', outcome, attempted,
        query, collectionHint, matchedName: variable.name,
        variable: { id: variable.id, name: variable.name, resolvedType: variable.resolvedType },
        mode: { modeId: mode.modeId, name: mode.name }, hadPrevious,
        restoreReason, residue: outcome === 'rolled-back' ? [] : [{
          id: variable.id, name: variable.name, resolvedType: variable.resolvedType,
        }],
      };
      const serialized = JSON.stringify(failure);
      if (serialized.length > 32_768) {
        throw new Error('Variable Set Value failure evidence exceeded the result limit.');
      }
      return serialized;
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_VARIABLE_SET_VALUE_LABEL_CODE_UNITS
    && (empty || value.length > 0);
}

function literalValueForType(literal, type) {
  if (type === 'STRING') return literal;
  if (type === 'BOOLEAN') return literal.toLowerCase() === 'true';
  if (type === 'FLOAT' || type === 'TIMING') return Number(literal);
  if (type === 'COLOR') {
    let hex = literal.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
    if (!hex) return undefined;
    if (hex.length <= 4) hex = [...hex].map((character) => character + character).join('');
    const color = {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
    return color;
  }
  let easing;
  try { easing = JSON.parse(literal); }
  catch { easing = { type: literal }; }
  if (easing && typeof easing === 'object' && !Array.isArray(easing)) {
    easing.type = String(easing.type || '').toUpperCase().replace(/[ -]+/g, '_');
  }
  return easing;
}

function literalResultMatches(value, literal, type) {
  const expected = literalValueForType(literal, type);
  if (type !== 'COLOR') return isDeepStrictEqual(value, expected);
  if (!exactKeys(value, ['r', 'g', 'b', 'a'])
    || !exactKeys(expected, ['r', 'g', 'b', 'a'])) return false;
  return ['r', 'g', 'b', 'a'].every((channel) =>
    typeof value[channel] === 'number' && Number.isFinite(value[channel])
      && Math.abs(value[channel] - expected[channel]) <= 1e-6);
}

function validAliasTarget(value, input, resolvedType, resultValue) {
  if (!exactKeys(value, ['id', 'name', 'resolvedType'])
    || !boundedString(value.id, { empty: false })
    || !boundedString(value.name, { empty: false })
    || value.resolvedType !== resolvedType
    || !exactKeys(resultValue, ['type', 'id'])
    || resultValue.type !== 'VARIABLE_ALIAS' || resultValue.id !== value.id) return false;
  const query = input.alias.toLowerCase();
  return value.id === input.alias || value.name === input.alias
    || value.name.endsWith(`/${input.alias}`)
    || value.name.toLowerCase().includes(query);
}

function validFailure(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'variable', 'mode',
    'hadPrevious', 'restoreReason', 'residue', 'query', 'collectionHint', 'matchedName',
  ]) && value.schemaVersion === 1 && value.status === 'failed' && value.attempted === true
    && ['rolled-back', 'partial-residue'].includes(value.outcome)
    && value.query === input.variable && value.collectionHint === input.collection
    && boundedString(value.matchedName, { empty: false })
    && exactKeys(value.variable, ['id', 'name', 'resolvedType'])
    && boundedString(value.variable.id, { empty: false })
    && boundedString(value.variable.name, { empty: false })
    && value.variable.name === value.matchedName
    && VARIABLE_TYPES.has(value.variable.resolvedType)
    && exactKeys(value.mode, ['modeId', 'name'])
    && boundedString(value.mode.modeId, { empty: false }) && boundedString(value.mode.name)
    && typeof value.hadPrevious === 'boolean'
    && Array.isArray(value.residue)
    && (value.outcome === 'rolled-back'
      ? value.hadPrevious && value.restoreReason === null && value.residue.length === 0
      : ['restore-failed', 'no-reversal-api'].includes(value.restoreReason)
        && value.residue.length === 1
        && exactKeys(value.residue[0], ['id', 'name', 'resolvedType'])
        && value.residue[0].id === value.variable.id);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'collectionHint', 'matchedName',
    'source', 'aliasTarget', 'variable', 'mode', 'value', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'updated'
    && ['id', 'name'].includes(value.resolution) && value.query === input.variable
    && value.collectionHint === input.collection && boundedString(value.matchedName, { empty: false })
    && value.source === (input.alias === null ? 'literal' : 'alias')
    && isVariableFactsPayload(value.variable)
    && value.variable.name === value.matchedName
    && (value.resolution !== 'id' || value.variable.id === input.variable)
    && (input.collection === null || value.variable.collection.id === input.collection
      || value.variable.collection.name.toLowerCase().includes(input.collection.toLowerCase()))
    && exactKeys(value.mode, ['modeId', 'name'])
    && boundedString(value.mode.modeId, { empty: false }) && boundedString(value.mode.name)
    && (value.mode.modeId === input.mode
      || value.mode.name.toLowerCase().includes(input.mode.toLowerCase()))
    && (input.alias === null
      ? value.aliasTarget === null
        && literalResultMatches(value.value, input.value, value.variable.resolvedType)
      : validAliasTarget(value.aliasTarget, input, value.variable.resolvedType, value.value))
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function mutationFailure(payload) {
  const rolledBack = payload.outcome === 'rolled-back';
  const error = new Error(rolledBack
    ? 'Variable Set Value failed after the setter; the previous mode value was restored.'
    : payload.restoreReason === 'no-reversal-api'
      ? 'Variable Set Value failed after setting a previously empty mode; Figma exposes no API to remove that mode value.'
      : 'Variable Set Value failed after the setter; the previous mode value could not be restored.');
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.variableValueMutationReport = {
    version: 1, outcome: payload.outcome, attempted: 1,
    restored: rolledBack ? 1 : 0, restoreReason: payload.restoreReason,
    residueCount: payload.residue.length,
  };
  throw error;
}

export async function executeVariableSetValue(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableSetValue requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableSetValueCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_SET_VALUE_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Set Value returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Set Value returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Variable Set Value returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)
    || !Object.prototype.hasOwnProperty.call(payload.variable.valuesByMode, payload.mode.modeId)
    || !isDeepStrictEqual(payload.value, payload.variable.valuesByMode[payload.mode.modeId])
    || !Array.isArray(payload.residue) || payload.residue.length !== 0) {
    throw new Error('Variable Set Value returned an invalid bounded result.');
  }
  const legacy = {
    variable: variableFactsLegacyProjection(payload.variable),
    mode: payload.mode,
    value: payload.value,
  };
  return {
    stdout: JSON.stringify(legacy, null, 2).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    stderr: '', result: payload,
  };
}

export function variableSetValuePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Set Value routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_SET_VALUE_APPLICATION_ID
    ? 'command-application' : 'not-variable-set-value';
}

export async function executeVariableSetValuePlan(plan, adapters = {}) {
  if (variableSetValuePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Set Value.`);
  }
  return executeVariableSetValue(parseVariableSetValueRequest(plan.argv), adapters);
}
