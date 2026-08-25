// Canonical generated Plugin runtime for exact local Variable mutations.

import {
  MAX_VARIABLE_FACTS_CONTAINER_ENTRIES,
  MAX_VARIABLE_FACTS_DEPTH,
  MAX_VARIABLE_FACTS_STRING_CODE_UNITS,
  MAX_VARIABLE_FACTS_VALUES,
} from './variable-facts-command.js';

export function variableMutationPluginRuntimeCode({ candidateLimit = 100_000 } = {}) {
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1) {
    throw new TypeError('Variable mutation candidateLimit must be a positive safe integer.');
  }
  return `
const __bridgeCollections = await figma.variables.getLocalVariableCollectionsAsync();
const __bridgeVariables = await figma.variables.getLocalVariablesAsync();
if (!Array.isArray(__bridgeCollections) || __bridgeCollections.length > ${candidateLimit}
  || !Array.isArray(__bridgeVariables) || __bridgeVariables.length > ${candidateLimit}) {
  throw new Error('Variable mutation candidate limit exceeded.');
}
const __bridgeResolveOne = (kind, value, pool, exact, tail = null) => {
  const exactMatches = pool.filter((item) => exact(item, value));
  const tailMatches = tail ? pool.filter((item) => tail(item, value)) : [];
  const partial = pool.filter((item) => item.name.toLowerCase().includes(value.toLowerCase()));
  const matches = exactMatches.length ? exactMatches : (tailMatches.length ? tailMatches : partial);
  if (matches.length > 1) throw new Error(kind + ' is ambiguous; use its id.');
  if (!matches.length) throw new Error(kind + ' not found.');
  return matches[0];
};
const __bridgeResolveCollection = (value) => {
  const direct = __bridgeCollections.filter((item) => item.id === value);
  return direct.length ? direct[0] : __bridgeResolveOne(
    'Variable Collection', value, __bridgeCollections, (item, query) => item.name === query,
  );
};
const __bridgeResolveVariable = (value, collectionHint = null) => {
  const collection = collectionHint === null ? null : __bridgeResolveCollection(collectionHint);
  const pool = collection ? __bridgeVariables.filter((item) =>
    item.variableCollectionId === collection.id) : __bridgeVariables;
  const direct = pool.filter((item) => item.id === value);
  const variable = direct.length ? direct[0] : __bridgeResolveOne(
    'Variable', value, pool, (item, query) => item.name === query,
    (item, query) => item.name.endsWith('/' + query),
  );
  const owner = collection || __bridgeCollections.find((item) =>
    item.id === variable.variableCollectionId);
  if (!owner) throw new Error('Variable Collection not found.');
  return { variable, collection: owner, resolution: direct.length ? 'id' : 'name' };
};
const __bridgeVariableFacts = async (variable, collection) => ({
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
});
const __bridgeValidateVariableFacts = (facts) => {
  const allowedTypes = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
  const allowedStatuses = new Set(['UNPUBLISHED', 'CURRENT', 'CHANGED']);
  const allowedScopes = new Set(${JSON.stringify([
    'ALL_SCOPES', 'TEXT_CONTENT', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP',
    'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR',
    'STROKE_FLOAT', 'EFFECT_FLOAT', 'EFFECT_COLOR', 'OPACITY', 'FONT_FAMILY',
    'FONT_STYLE', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING',
    'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT',
  ])});
  const easingTypes = new Set([
    'EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK',
    'EASE_OUT_BACK', 'EASE_IN_AND_OUT_BACK', 'CUSTOM_CUBIC_BEZIER', 'GENTLE',
    'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING', 'HOLD',
  ]);
  const boundedText = (value, empty = true) => typeof value === 'string'
    && value.length <= ${MAX_VARIABLE_FACTS_STRING_CODE_UNITS}
    && (empty || value.length > 0);
  const exactObject = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
  };
  const aliasValue = (value) => exactObject(value, ['type', 'id'])
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
      if (!exactObject(entry, ['modeId', 'name']) || !boundedText(entry.modeId, false)
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
      modeId.length <= 128 && modeIds.has(modeId) && valueForType(value, facts.resolvedType));
  let boundedCount = 0;
  const boundedSeen = new Set();
  const boundedJson = (value, depth = 0) => {
    boundedCount++;
    if (boundedCount > ${MAX_VARIABLE_FACTS_VALUES} || depth > ${MAX_VARIABLE_FACTS_DEPTH}) {
      return false;
    }
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return boundedText(value);
    if (!value || typeof value !== 'object' || boundedSeen.has(value)) return false;
    boundedSeen.add(value);
    const keys = Object.keys(value);
    if (keys.length > ${MAX_VARIABLE_FACTS_CONTAINER_ENTRIES}
      || keys.some((key) => key.length > 128)) return false;
    const valid = Array.isArray(value)
      ? value.every((item) => boundedJson(item, depth + 1))
      : keys.every((key) => boundedJson(value[key], depth + 1));
    boundedSeen.delete(value);
    return valid;
  };
  return boundedText(facts.id, false)
    && (facts.key === null || boundedText(facts.key, false))
    && boundedText(facts.name, false) && boundedText(facts.description)
    && allowedTypes.has(facts.resolvedType) && facts.remote === false
    && boundedText(facts.variableCollectionId, false)
    && exactObject(facts.collection, ['id', 'name'])
    && facts.collection.id === facts.variableCollectionId
    && boundedText(facts.collection.name, false)
    && typeof facts.hiddenFromPublishing === 'boolean'
    && Array.isArray(facts.scopes) && facts.scopes.every((scope) => allowedScopes.has(scope))
    && validCodeSyntax && validModes && validValues
    && allowedStatuses.has(facts.publishStatus)
    && boundedJson(facts);
};`;
}
