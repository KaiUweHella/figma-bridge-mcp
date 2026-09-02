// Bounded best-effort rollback Variable Set Value Batch Command Application.

import { isDeepStrictEqual } from 'node:util';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_VARIABLE_FACTS_STRING_CODE_UNITS } from './variable-facts-command.js';
import { variableMutationPluginRuntimeCode } from './variable-mutation-runtime.js';
import {
  parseVariableSetValueBatchRequest,
  variableSetValueBatchArgvFromRequest,
  variableSetValueBatchPlanningArgvFromRequest,
  VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY,
} from './variable-set-value-batch-request.js';

export {
  variableSetValueBatchArgvFromRequest,
  variableSetValueBatchPlanningArgvFromRequest,
} from './variable-set-value-batch-request.js';

const VARIABLE_SET_VALUE_BATCH_APPLICATION_ID = 'var.set-value-batch';
export const MAX_VARIABLE_SET_VALUE_BATCH_CANDIDATES = 100_000;
export const MAX_VARIABLE_SET_VALUE_BATCH_SERIALIZED_CODE_UNITS = 1_000_000;
const RESOLVED_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);

function normalizedRequest(request) {
  return parseVariableSetValueBatchRequest(variableSetValueBatchArgvFromRequest(request));
}

export function variableSetValueBatchCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const inputs = ${JSON.stringify(input.items)};
    const policy = ${JSON.stringify(VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY)};
    ${variableMutationPluginRuntimeCode({ candidateLimit: MAX_VARIABLE_SET_VALUE_BATCH_CANDIDATES })}
    const easingTypes = new Set([
      'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK',
      'EASE_OUT_BACK', 'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE',
      'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING', 'HOLD',
    ]);
    const equivalent = (actual, expected) => {
      if (actual === expected) return true;
      if (typeof actual === 'number' && typeof expected === 'number') {
        return Number.isFinite(actual) && Number.isFinite(expected)
          && Math.abs(actual - expected) <= 1e-6;
      }
      if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object'
        || Array.isArray(actual) !== Array.isArray(expected)) return false;
      const actualKeys = Object.keys(actual);
      const expectedKeys = Object.keys(expected);
      return actualKeys.length === expectedKeys.length
        && actualKeys.every((key) => expectedKeys.includes(key)
          && equivalent(actual[key], expected[key]));
    };
    const resolveMode = (collection, query) => {
      const exact = collection.modes.filter((mode) => mode.modeId === query || mode.name === query);
      const matches = exact.length ? exact : collection.modes.filter((mode) =>
        mode.name.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) throw new Error('Variable mode is ambiguous; use its id.');
      if (!matches.length) throw new Error('Variable mode not found.');
      return matches[0];
    };
    const nextValueFor = (item, variable) => {
      if (item.alias !== null) {
        const aliasTarget = __bridgeResolveVariable(item.alias).variable;
        if (aliasTarget.resolvedType !== variable.resolvedType) {
          throw new Error('Alias type does not match the target Variable type.');
        }
        return {
          source: 'alias', aliasTarget,
          nextValue: figma.variables.createVariableAlias(aliasTarget),
        };
      }
      const literal = item.value;
      let nextValue;
      if (variable.resolvedType === 'STRING') nextValue = literal;
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
        catch { nextValue = { type: literal.trim().toUpperCase().replace(/[ -]+/g, '_') }; }
        if (nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue)) {
          nextValue.type = String(nextValue.type || '').toUpperCase().replace(/[ -]+/g, '_');
        }
        if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue)
          || !easingTypes.has(nextValue.type)) {
          throw new Error('EASING value must be a named easing or MotionEasing JSON object.');
        }
      }
      return { source: 'literal', aliasTarget: null, nextValue };
    };
    const identityFor = (entry) => ({
      index: entry.index, id: entry.variable.id, name: entry.variable.name,
      resolvedType: entry.variable.resolvedType,
      mode: { modeId: entry.mode.modeId, name: entry.mode.name },
      hadPrevious: entry.hadPrevious,
    });
    const compactVariable = (facts) => ({
      id: facts.id, name: facts.name, resolvedType: facts.resolvedType,
      collection: facts.collection,
    });
    const prepared = [];
    const resolvedPairs = new Set();
    for (let index = 0; index < inputs.length; index++) {
      const item = inputs[index];
      const resolved = __bridgeResolveVariable(item.variable, item.collection);
      const variable = resolved.variable;
      const collection = resolved.collection;
      if (variable.remote || collection.remote) {
        throw new Error('Variable Set Value Batch cannot update remote Variables.');
      }
      const mode = resolveMode(collection, item.mode);
      const pair = variable.id + '\\u0000' + mode.modeId;
      if (resolvedPairs.has(pair)) {
        throw new Error('Variable Set Value Batch contains a duplicate resolved Variable/mode pair.');
      }
      resolvedPairs.add(pair);
      const valueIntent = nextValueFor(item, variable);
      const preflightFacts = await __bridgeVariableFacts(variable, collection);
      if (!__bridgeValidateVariableFacts(preflightFacts)) {
        throw new Error('Variable Set Value Batch encountered incompatible preflight metadata.');
      }
      const hadPrevious = Object.prototype.hasOwnProperty.call(variable.valuesByMode, mode.modeId);
      const previous = hadPrevious ? variable.valuesByMode[mode.modeId] : null;
      if (hadPrevious && __bridgeComposedColorValue(previous)) {
        throw new Error('Variable Set Value Batch cannot restore composed color values because the public Figma Plugin API does not accept them in setValueForMode. Change the alias opacity in Figma or detach it before replacing this mode value.');
      }
      prepared.push({
        index, item, variable, collection, mode, resolution: resolved.resolution,
        hadPrevious, previous,
        ...valueIntent,
      });
    }
    const rollbackCoverage = {
      reversible: prepared.filter((entry) => entry.hadPrevious).map(identityFor),
      nonReversible: prepared.filter((entry) => !entry.hadPrevious).map(identityFor),
    };
    const attempted = [];
    const confirmed = [];
    const updates = [];
    try {
      for (const entry of prepared) {
        attempted.push(entry);
        entry.variable.setValueForMode(entry.mode.modeId, entry.nextValue);
        const facts = await __bridgeVariableFacts(entry.variable, entry.collection);
        if (!__bridgeValidateVariableFacts(facts)
          || !Object.prototype.hasOwnProperty.call(facts.valuesByMode, entry.mode.modeId)
          || !equivalent(facts.valuesByMode[entry.mode.modeId], entry.nextValue)) {
          throw new Error('Variable Set Value Batch encountered incompatible result metadata.');
        }
        confirmed.push(entry);
        updates.push({
          index: entry.index, query: entry.item.variable,
          collectionHint: entry.item.collection, resolution: entry.resolution,
          source: entry.source,
          aliasTarget: entry.aliasTarget === null ? null : {
            id: entry.aliasTarget.id, name: entry.aliasTarget.name,
            resolvedType: entry.aliasTarget.resolvedType,
          },
          variable: compactVariable(facts),
          mode: { modeId: entry.mode.modeId, name: entry.mode.name },
          value: facts.valuesByMode[entry.mode.modeId],
        });
      }
      const complete = {
        schemaVersion: 1, status: 'updated', outcome: 'committed', policy,
        rollbackCoverage, attempted: attempted.map(identityFor),
        confirmed: confirmed.map(identityFor), restored: [], residual: [],
        restoreFailures: [], updates,
      };
      const serialized = JSON.stringify(complete);
      if (serialized.length > ${MAX_VARIABLE_SET_VALUE_BATCH_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Set Value Batch result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      const restored = [];
      const residual = [];
      const restoreFailures = [];
      for (let index = attempted.length - 1; index >= 0; index--) {
        const entry = attempted[index];
        const identity = identityFor(entry);
        if (!entry.hadPrevious) {
          if (Object.prototype.hasOwnProperty.call(entry.variable.valuesByMode, entry.mode.modeId)) {
            residual.push({ ...identity, reason: 'no-reversal-api' });
          }
          continue;
        }
        let restoredValue = false;
        try {
          entry.variable.setValueForMode(entry.mode.modeId, entry.previous);
          restoredValue = Object.prototype.hasOwnProperty.call(
            entry.variable.valuesByMode, entry.mode.modeId)
            && equivalent(entry.variable.valuesByMode[entry.mode.modeId], entry.previous);
        } catch {}
        if (restoredValue) restored.push(identity);
        else {
          residual.push({ ...identity, reason: 'restore-failed' });
          restoreFailures.push({
            index: entry.index, id: entry.variable.id,
            modeId: entry.mode.modeId, reason: 'restore-failed',
          });
        }
      }
      const outcome = residual.length ? 'partial-residue' : 'rolled-back';
      const failure = {
        schemaVersion: 1, status: 'failed', outcome, policy, rollbackCoverage,
        attempted: attempted.map(identityFor), confirmed: confirmed.map(identityFor),
        restored, residual, restoreFailures, updates: [],
      };
      const serialized = JSON.stringify(failure);
      if (serialized.length > ${MAX_VARIABLE_SET_VALUE_BATCH_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Set Value Batch failure evidence exceeded the result limit.');
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

function validIdentity(value, itemCount) {
  return exactKeys(value, ['index', 'id', 'name', 'resolvedType', 'mode', 'hadPrevious'])
    && Number.isSafeInteger(value.index) && value.index >= 0 && value.index < itemCount
    && boundedString(value.id, { empty: false }) && boundedString(value.name, { empty: false })
    && RESOLVED_TYPES.has(value.resolvedType)
    && exactKeys(value.mode, ['modeId', 'name'])
    && boundedString(value.mode.modeId, { empty: false }) && boundedString(value.mode.name, { empty: false })
    && typeof value.hadPrevious === 'boolean';
}

function validIdentityList(value, itemCount) {
  return Array.isArray(value) && value.length <= itemCount
    && value.every((identity) => validIdentity(identity, itemCount))
    && new Set(value.map((identity) => identity.index)).size === value.length
    && new Set(value.map((identity) => `${identity.id}\u0000${identity.mode.modeId}`)).size === value.length;
}

function validResidualList(value, itemCount) {
  return Array.isArray(value) && value.length <= itemCount
    && value.every((entry) => exactKeys(entry, [
      'index', 'id', 'name', 'resolvedType', 'mode', 'hadPrevious', 'reason',
    ]) && validIdentity({
      index: entry.index, id: entry.id, name: entry.name,
      resolvedType: entry.resolvedType, mode: entry.mode, hadPrevious: entry.hadPrevious,
    }, itemCount) && ['no-reversal-api', 'restore-failed'].includes(entry.reason))
    && new Set(value.map((entry) => entry.index)).size === value.length;
}

function sameIdentity(left, right) {
  return !!right && left.index === right.index && left.id === right.id && left.name === right.name
    && left.resolvedType === right.resolvedType
    && left.mode.modeId === right.mode.modeId && left.mode.name === right.mode.name
    && left.hadPrevious === right.hadPrevious;
}

function baseIdentity(value) {
  return {
    index: value.index, id: value.id, name: value.name,
    resolvedType: value.resolvedType, mode: value.mode, hadPrevious: value.hadPrevious,
  };
}

function literalValueForType(literal, type) {
  if (type === 'STRING') return literal;
  if (type === 'BOOLEAN') return literal.toLowerCase() === 'true';
  if (type === 'FLOAT' || type === 'TIMING') return Number(literal);
  if (type === 'COLOR') {
    let hex = literal.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
    if (!hex) return undefined;
    if (hex.length <= 4) hex = [...hex].map((character) => character + character).join('');
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  let easing;
  try { easing = JSON.parse(literal); }
  catch { easing = { type: literal }; }
  if (easing && typeof easing === 'object' && !Array.isArray(easing)) {
    easing.type = String(easing.type || '').toUpperCase().replace(/[ -]+/g, '_');
  }
  return easing;
}

function equivalent(actual, expected) {
  if (isDeepStrictEqual(actual, expected)) return true;
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Number.isFinite(actual) && Number.isFinite(expected)
      && Math.abs(actual - expected) <= 1e-6;
  }
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object'
    || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key) => expectedKeys.includes(key)
      && equivalent(actual[key], expected[key]));
}

function validCoverage(value, itemCount) {
  if (!exactKeys(value, ['reversible', 'nonReversible'])
    || !validIdentityList(value.reversible, itemCount)
    || !validIdentityList(value.nonReversible, itemCount)) return false;
  const all = [...value.reversible, ...value.nonReversible];
  return all.length === itemCount
    && new Set(all.map((entry) => entry.index)).size === itemCount
    && value.reversible.every((entry) => entry.hadPrevious)
    && value.nonReversible.every((entry) => !entry.hadPrevious);
}

function validUpdate(value, input, index) {
  if (!exactKeys(value, [
    'index', 'query', 'collectionHint', 'resolution', 'source', 'aliasTarget',
    'variable', 'mode', 'value',
  ]) || value.index !== index || value.query !== input.variable
    || value.collectionHint !== input.collection || !['id', 'name'].includes(value.resolution)
    || value.source !== (input.alias === null ? 'literal' : 'alias')
    || !exactKeys(value.variable, ['id', 'name', 'resolvedType', 'collection'])
    || !boundedString(value.variable.id, { empty: false })
    || !boundedString(value.variable.name, { empty: false })
    || !RESOLVED_TYPES.has(value.variable.resolvedType)
    || !exactKeys(value.variable.collection, ['id', 'name'])
    || !boundedString(value.variable.collection.id, { empty: false })
    || !boundedString(value.variable.collection.name, { empty: false })
    || !exactKeys(value.mode, ['modeId', 'name'])
    || !boundedString(value.mode.modeId, { empty: false })
    || !boundedString(value.mode.name, { empty: false })) return false;
  if (input.alias === null) {
    return value.aliasTarget === null
      && equivalent(value.value, literalValueForType(input.value, value.variable.resolvedType));
  }
  return exactKeys(value.aliasTarget, ['id', 'name', 'resolvedType'])
    && boundedString(value.aliasTarget.id, { empty: false })
    && boundedString(value.aliasTarget.name, { empty: false })
    && value.aliasTarget.resolvedType === value.variable.resolvedType
    && exactKeys(value.value, ['type', 'id'])
    && value.value.type === 'VARIABLE_ALIAS' && value.value.id === value.aliasTarget.id;
}

function validCommon(value, input) {
  const count = input.items.length;
  if (!(value.schemaVersion === 1
    && value.policy === VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY
    && validCoverage(value.rollbackCoverage, count)
    && validIdentityList(value.attempted, count)
    && validIdentityList(value.confirmed, count)
    && validIdentityList(value.restored, count)
    && validResidualList(value.residual, count)
    && Array.isArray(value.restoreFailures) && value.restoreFailures.length <= count
    && value.restoreFailures.every((entry) => exactKeys(entry, [
      'index', 'id', 'modeId', 'reason',
    ]) && Number.isSafeInteger(entry.index) && entry.index >= 0 && entry.index < count
      && boundedString(entry.id, { empty: false })
      && boundedString(entry.modeId, { empty: false }) && entry.reason === 'restore-failed')
    && new Set(value.restoreFailures.map((entry) => entry.index)).size
      === value.restoreFailures.length
    && Array.isArray(value.updates) && value.updates.length <= count)) return false;
  const coverage = [...value.rollbackCoverage.reversible, ...value.rollbackCoverage.nonReversible];
  const byIndex = new Map(coverage.map((entry) => [entry.index, entry]));
  const identities = [
    ...value.attempted, ...value.confirmed, ...value.restored,
    ...value.residual.map(baseIdentity),
  ];
  return identities.every((entry) => sameIdentity(entry, byIndex.get(entry.index)))
    && value.residual.every((entry) => entry.hadPrevious
      ? entry.reason === 'restore-failed' : entry.reason === 'no-reversal-api')
    && value.restoreFailures.every((failure) => value.residual.some((entry) =>
      entry.index === failure.index && entry.id === failure.id
      && entry.mode.modeId === failure.modeId && entry.reason === 'restore-failed'))
    && value.attempted.every((entry, index) => entry.index === index)
    && value.confirmed.every((entry, index) => entry.index === index);
}

function validSuccess(value, input) {
  const count = input.items.length;
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'policy', 'rollbackCoverage',
    'attempted', 'confirmed', 'restored', 'residual', 'restoreFailures', 'updates',
  ]) && value.status === 'updated' && value.outcome === 'committed'
    && validCommon(value, input)
    && value.attempted.length === count && value.confirmed.length === count
    && value.restored.length === 0 && value.residual.length === 0
    && value.restoreFailures.length === 0 && value.updates.length === count
    && value.updates.every((update, index) => {
      const identity = value.rollbackCoverage.reversible
        .concat(value.rollbackCoverage.nonReversible)
        .find((entry) => entry.index === index);
      return validUpdate(update, input.items[index], index)
        && update.variable.id === identity.id
        && update.mode.modeId === identity.mode.modeId;
    });
}

function validFailure(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'policy', 'rollbackCoverage',
    'attempted', 'confirmed', 'restored', 'residual', 'restoreFailures', 'updates',
  ]) && value.status === 'failed' && ['rolled-back', 'partial-residue'].includes(value.outcome)
    && validCommon(value, input) && value.updates.length === 0
    && (value.outcome === 'rolled-back' ? value.residual.length === 0 : value.residual.length > 0)
    && value.confirmed.length <= value.attempted.length
    && value.restored.every((entry) =>
      !value.residual.some((residual) => residual.index === entry.index))
    && value.confirmed.every((entry) => entry.hadPrevious
      ? value.restored.some((restored) => restored.index === entry.index)
        || value.residual.some((residual) => residual.index === entry.index)
      : value.residual.some((residual) => residual.index === entry.index));
}

function mutationFailure(payload) {
  const error = new Error(payload.outcome === 'rolled-back'
    ? 'Variable Set Value Batch failed; all remaining attempted values were restored or unchanged.'
    : 'Variable Set Value Batch failed and left explicitly reported mode-value residue.');
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = payload.outcome;
  error.variableValueBatchMutationReport = {
    version: 1, policy: payload.policy, outcome: payload.outcome,
    reversible: payload.rollbackCoverage.reversible.length,
    nonReversible: payload.rollbackCoverage.nonReversible.length,
    attempted: payload.attempted.length, confirmed: payload.confirmed.length,
    restored: payload.restored.length, residueCount: payload.residual.length,
    restoreFailureCount: payload.restoreFailures.length,
    residual: payload.residual,
  };
  throw error;
}

export async function executeVariableSetValueBatch(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableSetValueBatch requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableSetValueBatchCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_SET_VALUE_BATCH_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Set Value Batch returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Variable Set Value Batch returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw new Error('Variable Set Value Batch returned an invalid bounded result.');
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input)) {
    throw new Error('Variable Set Value Batch returned an invalid bounded result.');
  }
  return {
    stdout: JSON.stringify(payload, null, 2).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    stderr: '', result: payload,
  };
}

export function variableSetValueBatchPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Set Value Batch routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === VARIABLE_SET_VALUE_BATCH_APPLICATION_ID
    ? 'command-application' : 'not-variable-set-value-batch';
}

export async function executeVariableSetValueBatchPlan(plan, adapters = {}) {
  if (variableSetValueBatchPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Set Value Batch.`);
  }
  return executeVariableSetValueBatch(parseVariableSetValueBatchRequest(plan.argv), adapters);
}
