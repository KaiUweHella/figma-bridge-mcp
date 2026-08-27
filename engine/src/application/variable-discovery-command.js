// Bounded Variable Discovery Command Application shared by Commander and MCP.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_VARIABLE_DISCOVERY_RESULTS,
  parseVariableDiscoveryRequest,
  variableDiscoveryArgvFromRequest,
  variableDiscoveryPlanningArgvFromRequest,
} from './variable-discovery-request.js';

export {
  variableDiscoveryArgvFromRequest,
  variableDiscoveryPlanningArgvFromRequest,
} from './variable-discovery-request.js';

export const MAX_VARIABLE_DISCOVERY_CANDIDATES = 100_000;
export const MAX_VARIABLE_DISCOVERY_SERIALIZED_CODE_UNITS = 1_000_000;
const MAX_VARIABLE_DISCOVERY_LABEL_CODE_UNITS = 512;
const MAX_VARIABLE_DISCOVERY_ID_CODE_UNITS = 1024;
const VARIABLE_TYPES = new Set(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);
const APPLICATION_IDS = new Set(['var.list', 'var.find']);

function normalizedRequest(request) {
  return parseVariableDiscoveryRequest(variableDiscoveryArgvFromRequest(request));
}

export function variableDiscoveryRequestFromArgv(args) {
  return parseVariableDiscoveryRequest(args);
}

function wildcardMatches(value, pattern) {
  if (pattern === null) return true;
  const source = value.toLowerCase();
  const parts = pattern.toLowerCase().split('*');
  let cursor = 0;
  for (const part of parts) {
    if (!part) continue;
    const index = source.indexOf(part, cursor);
    if (index < 0) return false;
    cursor = index + part.length;
  }
  return true;
}

export function variableDiscoveryCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const [variables, collections] = await Promise.all([
      figma.variables.getLocalVariablesAsync(),
      figma.variables.getLocalVariableCollectionsAsync(),
    ]);
    if (!Array.isArray(variables) || variables.length > ${MAX_VARIABLE_DISCOVERY_CANDIDATES}
      || !Array.isArray(collections) || collections.length > ${MAX_VARIABLE_DISCOVERY_CANDIDATES}) {
      throw new Error('Variable Discovery candidate limit exceeded.');
    }
    const collectionById = new Map();
    for (const collection of collections) {
      if (!collection || typeof collection.id !== 'string' || typeof collection.name !== 'string'
        || collection.id.length < 1 || collection.id.length > ${MAX_VARIABLE_DISCOVERY_ID_CODE_UNITS}
        || collection.name.length > ${MAX_VARIABLE_DISCOVERY_LABEL_CODE_UNITS}
        || collectionById.has(collection.id)) {
        throw new Error('Variable Discovery encountered invalid collection identity.');
      }
      collectionById.set(collection.id, { id: collection.id, name: collection.name });
    }
    const pattern = ${JSON.stringify(input.pattern)};
    const wildcardMatches = (value) => {
      if (pattern === null) return true;
      const source = value.toLowerCase();
      const parts = pattern.toLowerCase().split('*');
      let cursor = 0;
      for (const part of parts) {
        if (!part) continue;
        const index = source.indexOf(part, cursor);
        if (index < 0) return false;
        cursor = index + part.length;
      }
      return true;
    };
    const rows = [];
    const seen = new Set();
    for (const variable of variables) {
      if (!variable || typeof variable.id !== 'string' || typeof variable.name !== 'string'
        || typeof variable.variableCollectionId !== 'string'
        || typeof variable.resolvedType !== 'string'
        || variable.id.length < 1 || variable.id.length > ${MAX_VARIABLE_DISCOVERY_ID_CODE_UNITS}
        || variable.name.length > ${MAX_VARIABLE_DISCOVERY_LABEL_CODE_UNITS}
        || seen.has(variable.id)) {
        throw new Error('Variable Discovery encountered invalid variable identity.');
      }
      seen.add(variable.id);
      const collection = collectionById.get(variable.variableCollectionId);
      if (!collection) throw new Error('Variable Discovery encountered a missing local collection.');
      if (!wildcardMatches(variable.name)) continue;
      rows.push({ id: variable.id, name: variable.name, resolvedType: variable.resolvedType, collection });
    }
    const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    rows.sort((left, right) => compareText(left.name, right.name)
      || compareText(left.collection.name, right.collection.name)
      || compareText(left.resolvedType, right.resolvedType)
      || compareText(left.id, right.id));
    const total = rows.length;
    const projected = rows.slice(0, ${input.limit});
    const payload = {
      schemaVersion: 1,
      action: ${JSON.stringify(input.action)},
      pattern: ${JSON.stringify(input.pattern)},
      total,
      returned: projected.length,
      omitted: total - projected.length,
      complete: projected.length === total,
      variables: projected,
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_VARIABLE_DISCOVERY_SERIALIZED_CODE_UNITS}) {
      throw new Error('Variable Discovery serialized-size limit exceeded. Lower --limit.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, limit, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= limit && (empty || value.length > 0);
}

function validResult(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'action', 'pattern', 'total', 'returned', 'omitted', 'complete', 'variables',
  ]) || value.schemaVersion !== 1 || value.action !== input.action || value.pattern !== input.pattern
    || !Number.isSafeInteger(value.total) || value.total < 0
    || value.total > MAX_VARIABLE_DISCOVERY_CANDIDATES
    || !Number.isSafeInteger(value.returned) || value.returned < 0 || value.returned > input.limit
    || !Number.isSafeInteger(value.omitted) || value.omitted < 0
    || value.total !== value.returned + value.omitted
    || value.complete !== (value.omitted === 0)
    || (value.omitted > 0 && value.returned !== input.limit)
    || !Array.isArray(value.variables) || value.variables.length !== value.returned) return false;
  const ids = new Set();
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const compare = (left, right) => compareText(left.name, right.name)
    || compareText(left.collection.name, right.collection.name)
    || compareText(left.resolvedType, right.resolvedType)
    || compareText(left.id, right.id);
  for (const variable of value.variables) {
    if (!exactKeys(variable, ['id', 'name', 'resolvedType', 'collection'])
      || !boundedString(variable.id, MAX_VARIABLE_DISCOVERY_ID_CODE_UNITS, { empty: false })
      || !boundedString(variable.name, MAX_VARIABLE_DISCOVERY_LABEL_CODE_UNITS)
      || !VARIABLE_TYPES.has(variable.resolvedType)
      || !exactKeys(variable.collection, ['id', 'name'])
      || !boundedString(variable.collection.id, MAX_VARIABLE_DISCOVERY_ID_CODE_UNITS, { empty: false })
      || !boundedString(variable.collection.name, MAX_VARIABLE_DISCOVERY_LABEL_CODE_UNITS)
      || ids.has(variable.id) || !wildcardMatches(variable.name, input.pattern)) return false;
    ids.add(variable.id);
  }
  if (value.variables.some((variable, index) => index > 0
    && compare(value.variables[index - 1], variable) >= 0)) return false;
  return true;
}

function safeText(value, limit = MAX_VARIABLE_DISCOVERY_LABEL_CODE_UNITS) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�').slice(0, limit);
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeVariableDiscovery(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeVariableDiscovery requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(variableDiscoveryCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_VARIABLE_DISCOVERY_SERIALIZED_CODE_UNITS) {
    throw new Error('Variable Discovery returned an invalid bounded result.');
  }
  let result;
  try { result = JSON.parse(serialized); }
  catch { throw new Error('Variable Discovery returned invalid JSON.'); }
  if (!validResult(result, input)) {
    throw new Error('Variable Discovery returned an invalid bounded result.');
  }
  let stdout;
  if (input.json) {
    stdout = safePrettyJson(result);
  } else {
    const lines = result.variables.map((variable) => input.action === 'list'
      ? `${safeText(variable.name)} (${variable.resolvedType})`
      : safeText(variable.name));
    if (!lines.length) {
      lines.push(input.action === 'list'
        ? 'No local variables found.'
        : `No variables found matching "${safeText(input.pattern, 160)}".`);
    }
    if (!result.complete) {
      lines.push(`(${result.omitted} more variable(s) omitted — raise --limit up to ${MAX_VARIABLE_DISCOVERY_RESULTS})`);
    }
    stdout = lines.join('\n');
  }
  return { stdout, stderr: '', result };
}

export function variableDiscoveryPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Variable Discovery routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-variable-discovery';
}

export async function executeVariableDiscoveryPlan(plan, adapters = {}) {
  if (variableDiscoveryPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Variable Discovery.`);
  }
  return executeVariableDiscovery(parseVariableDiscoveryRequest(plan.argv), adapters);
}
