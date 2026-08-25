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
    const [collections, variables] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);
    if (!Array.isArray(collections) || collections.length > ${MAX_VARIABLE_SET_VALUE_CANDIDATES}
      || !Array.isArray(variables) || variables.length > ${MAX_VARIABLE_SET_VALUE_CANDIDATES}) {
      throw new Error('Variable Set Value candidate limit exceeded.');
    }
    const resolveOne = (kind, value, pool, exact, tail = null) => {
      const exactMatches = pool.filter((item) => exact(item, value));
      const tailMatches = tail ? pool.filter((item) => tail(item, value)) : [];
      const partial = pool.filter((item) => item.name.toLowerCase().includes(value.toLowerCase()));
      const matches = exactMatches.length ? exactMatches : (tailMatches.length ? tailMatches : partial);
      if (matches.length > 1) throw new Error(kind + ' is ambiguous; use its id.');
      if (!matches.length) throw new Error(kind + ' not found.');
      return matches[0];
    };
    let selectedCollection = null;
    if (collectionHint !== null) {
      const direct = collections.filter((item) => item.id === collectionHint);
      selectedCollection = direct.length ? direct[0] : resolveOne(
        'Variable Collection', collectionHint, collections, (item, value) => item.name === value,
      );
    }
    const resolveVariable = (value, collection = null) => {
      const pool = collection
        ? variables.filter((item) => item.variableCollectionId === collection.id) : variables;
      const direct = pool.filter((item) => item.id === value);
      return direct.length ? direct[0] : resolveOne(
        'Variable', value, pool, (item, candidate) => item.name === candidate,
        (item, candidate) => item.name.endsWith('/' + candidate),
      );
    };
    const variable = resolveVariable(query, selectedCollection);
    const collection = selectedCollection || collections.find((item) =>
      item.id === variable.variableCollectionId);
    if (!collection) throw new Error('Variable Collection not found.');
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
      aliasTarget = resolveVariable(aliasQuery);
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
      };
      if (hex.length === 8) nextValue.a = parseInt(hex.slice(6, 8), 16) / 255;
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

    const hadPrevious = Object.prototype.hasOwnProperty.call(variable.valuesByMode, mode.modeId);
    const previous = hadPrevious ? variable.valuesByMode[mode.modeId] : null;
    let attempted = false;
    try {
      attempted = true;
      variable.setValueForMode(mode.modeId, nextValue);
      const facts = {
        schemaVersion: 1, id: variable.id, key: variable.key || null,
        name: variable.name, description: variable.description || '',
        resolvedType: variable.resolvedType, remote: !!variable.remote,
        variableCollectionId: variable.variableCollectionId,
        collection: { id: collection.id, name: collection.name },
        hiddenFromPublishing: !!variable.hiddenFromPublishing,
        scopes: variable.scopes, codeSyntax: variable.codeSyntax,
        valuesByMode: variable.valuesByMode,
        modes: collection.modes.map((entry) => ({ modeId: entry.modeId, name: entry.name })),
        publishStatus: await variable.getPublishStatusAsync(),
      };
      const allowedTypes = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
      const allowedStatuses = new Set(['UNPUBLISHED', 'CURRENT', 'CHANGED']);
      const allowedScopes = new Set(${JSON.stringify([
        'ALL_SCOPES', 'TEXT_CONTENT', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP',
        'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR',
        'STROKE_FLOAT', 'EFFECT_FLOAT', 'EFFECT_COLOR', 'OPACITY', 'FONT_FAMILY',
        'FONT_STYLE', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING',
        'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT',
      ])});
      const boundedText = (value, empty = true) => typeof value === 'string'
        && value.length <= ${MAX_VARIABLE_FACTS_STRING_CODE_UNITS}
        && (empty || value.length > 0);
      const exactObject = (value, keys) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const actual = Object.keys(value);
        return actual.length === keys.length && actual.every((key) => keys.includes(key));
      };
      const aliasValue = (value) => value && typeof value === 'object'
        && exactObject(value, ['type', 'id'])
        && value.type === 'VARIABLE_ALIAS' && boundedText(value.id, false);
      const unit = (value) => typeof value === 'number' && Number.isFinite(value)
        && value >= 0 && value <= 1;
      const valueForType = (value, type) => {
        if (aliasValue(value)) return true;
        if (type === 'BOOLEAN') return typeof value === 'boolean';
        if (type === 'STRING') return boundedText(value);
        if (type === 'FLOAT' || type === 'TIMING') {
          return typeof value === 'number' && Number.isFinite(value);
        }
        if (type === 'COLOR') return (exactObject(value, ['r', 'g', 'b'])
          || exactObject(value, ['r', 'g', 'b', 'a']))
          && unit(value.r) && unit(value.g) && unit(value.b)
          && (value.a === undefined || unit(value.a));
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || !easingTypes.has(value.type)
          || !Object.keys(value).every((key) => [
            'type', 'easingFunctionCubicBezier', 'easingFunctionSpring',
          ].includes(key))) return false;
        if (value.easingFunctionCubicBezier !== undefined) {
          const bezier = value.easingFunctionCubicBezier;
          if (!exactObject(bezier, ['x1', 'y1', 'x2', 'y2'])
            || !unit(bezier.x1) || !unit(bezier.x2)
            || typeof bezier.y1 !== 'number' || !Number.isFinite(bezier.y1)
            || typeof bezier.y2 !== 'number' || !Number.isFinite(bezier.y2)) return false;
        }
        if (value.easingFunctionSpring !== undefined) {
          const spring = value.easingFunctionSpring;
          if (!exactObject(spring, ['bounce']) || !unit(spring.bounce)) return false;
        }
        return true;
      };
      const modeIds = new Set();
      const validModes = Array.isArray(facts.modes)
        && facts.modes.length <= ${MAX_VARIABLE_FACTS_CONTAINER_ENTRIES}
        && facts.modes.every((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || Object.keys(entry).length !== 2 || !boundedText(entry.modeId, false)
            || !boundedText(entry.name, false) || modeIds.has(entry.modeId)) return false;
          modeIds.add(entry.modeId);
          return true;
        });
      const validCodeSyntax = facts.codeSyntax && typeof facts.codeSyntax === 'object'
        && !Array.isArray(facts.codeSyntax) && Object.entries(facts.codeSyntax).every(
          ([platform, syntax]) => ['WEB', 'ANDROID', 'iOS'].includes(platform)
            && boundedText(syntax),
        );
      const validValues = facts.valuesByMode && typeof facts.valuesByMode === 'object'
        && !Array.isArray(facts.valuesByMode)
        && Object.entries(facts.valuesByMode).length <= ${MAX_VARIABLE_FACTS_CONTAINER_ENTRIES}
        && Object.entries(facts.valuesByMode).every(([modeId, value]) =>
          modeId.length <= 128 && modeIds.has(modeId)
            && valueForType(value, facts.resolvedType));
      if (!boundedText(facts.id, false) || !(facts.key === null || boundedText(facts.key, false))
        || !boundedText(facts.name, false) || !boundedText(facts.description)
        || !facts.name || !allowedTypes.has(facts.resolvedType) || facts.remote
        || !boundedText(facts.variableCollectionId, false)
        || facts.variableCollectionId !== collection.id
        || !facts.collection || facts.collection.id !== collection.id
        || !boundedText(facts.collection.name, false)
        || !Array.isArray(facts.scopes) || !facts.scopes.every((scope) => allowedScopes.has(scope))
        || !validCodeSyntax || !validModes || !validValues
        || !allowedStatuses.has(facts.publishStatus)
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
        schemaVersion: 1, status: 'updated', resolution: variable.id === query ? 'id' : 'name',
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
    };
    if (hex.length === 8) color.a = parseInt(hex.slice(6, 8), 16) / 255;
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
        && isDeepStrictEqual(value.value,
          literalValueForType(input.value, value.variable.resolvedType))
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
