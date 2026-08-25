// Bounded compact Collection Catalog Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  collectionCatalogArgvFromRequest,
  collectionCatalogPlanningArgvFromRequest,
  parseCollectionCatalogRequest,
} from './collection-catalog-request.js';

export {
  collectionCatalogArgvFromRequest,
  collectionCatalogPlanningArgvFromRequest,
} from './collection-catalog-request.js';

const COLLECTION_CATALOG_APPLICATION_ID = 'col.list';
export const MAX_COLLECTION_CATALOG_CANDIDATES = 10_000;
export const MAX_COLLECTION_CATALOG_MODES_PER_COLLECTION = 1000;
export const MAX_COLLECTION_CATALOG_VARIABLES_PER_COLLECTION = 100_000;
export const MAX_COLLECTION_CATALOG_SERIALIZED_CODE_UNITS = 500_000;
const MAX_COLLECTION_CATALOG_STRING_CODE_UNITS = 1024;

function normalizedRequest(request) {
  return parseCollectionCatalogRequest(collectionCatalogArgvFromRequest(request));
}

export function collectionCatalogCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(collections) || collections.length > ${MAX_COLLECTION_CATALOG_CANDIDATES}) {
      throw new Error('Collection Catalog candidate limit exceeded.');
    }
    const rows = [];
    const seen = new Set();
    for (const collection of collections) {
      if (!collection || typeof collection.id !== 'string' || collection.id.length < 1
        || collection.id.length > ${MAX_COLLECTION_CATALOG_STRING_CODE_UNITS}
        || typeof collection.name !== 'string'
        || collection.name.length > ${MAX_COLLECTION_CATALOG_STRING_CODE_UNITS}
        || typeof collection.key !== 'string'
        || collection.key.length > ${MAX_COLLECTION_CATALOG_STRING_CODE_UNITS}
        || !Array.isArray(collection.modes) || !Array.isArray(collection.variableIds)
        || collection.modes.length > ${MAX_COLLECTION_CATALOG_MODES_PER_COLLECTION}
        || collection.variableIds.length > ${MAX_COLLECTION_CATALOG_VARIABLES_PER_COLLECTION}
        || seen.has(collection.id)) {
        throw new Error('Collection Catalog encountered invalid collection metadata.');
      }
      seen.add(collection.id);
      rows.push({
        id: collection.id,
        key: collection.key,
        name: collection.name,
        remote: !!collection.remote,
        isExtension: !!collection.isExtension,
        hiddenFromPublishing: !!collection.hiddenFromPublishing,
        modeCount: collection.modes.length,
        variableCount: collection.variableIds.length,
      });
    }
    const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    rows.sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
    const total = rows.length;
    const projected = rows.slice(0, ${input.limit});
    const payload = {
      schemaVersion: 1,
      total,
      returned: projected.length,
      omitted: total - projected.length,
      complete: projected.length === total,
      collections: projected,
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_COLLECTION_CATALOG_SERIALIZED_CODE_UNITS}) {
      throw new Error('Collection Catalog serialized-size limit exceeded. Lower --limit.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_COLLECTION_CATALOG_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function validPayload(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'total', 'returned', 'omitted', 'complete', 'collections',
  ]) || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.total) || value.total < 0
    || value.total > MAX_COLLECTION_CATALOG_CANDIDATES
    || !Number.isSafeInteger(value.returned) || value.returned < 0 || value.returned > input.limit
    || !Number.isSafeInteger(value.omitted) || value.omitted < 0
    || value.total !== value.returned + value.omitted
    || value.complete !== (value.omitted === 0)
    || (value.omitted > 0 && value.returned !== input.limit)
    || !Array.isArray(value.collections) || value.collections.length !== value.returned) return false;
  const ids = new Set();
  let previous = null;
  for (const collection of value.collections) {
    if (!exactKeys(collection, [
      'id', 'key', 'name', 'remote', 'isExtension', 'hiddenFromPublishing',
      'modeCount', 'variableCount',
    ]) || !boundedString(collection.id, { empty: false }) || !boundedString(collection.key)
      || !boundedString(collection.name) || typeof collection.remote !== 'boolean'
      || typeof collection.isExtension !== 'boolean'
      || typeof collection.hiddenFromPublishing !== 'boolean'
      || !Number.isSafeInteger(collection.modeCount) || collection.modeCount < 0
      || collection.modeCount > MAX_COLLECTION_CATALOG_MODES_PER_COLLECTION
      || !Number.isSafeInteger(collection.variableCount) || collection.variableCount < 0
      || collection.variableCount > MAX_COLLECTION_CATALOG_VARIABLES_PER_COLLECTION
      || ids.has(collection.id)) return false;
    if (previous && (previous.name > collection.name
      || (previous.name === collection.name && previous.id >= collection.id))) return false;
    ids.add(collection.id);
    previous = collection;
  }
  return true;
}

function safeText(value, limit = MAX_COLLECTION_CATALOG_STRING_CODE_UNITS) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�').slice(0, limit);
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeCollectionCatalog(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeCollectionCatalog requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(collectionCatalogCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COLLECTION_CATALOG_SERIALIZED_CODE_UNITS) {
    throw new Error('Collection Catalog returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Collection Catalog returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Collection Catalog returned an invalid bounded result.');
  }
  let stdout;
  if (input.json) {
    stdout = safePrettyJson(payload);
  } else {
    const lines = payload.collections.map((collection) =>
      `${safeText(collection.name)} (${collection.variableCount} vars)`);
    if (!lines.length) lines.push('No local variable collections found.');
    if (!payload.complete) {
      lines.push(`(${payload.omitted} more collection(s) omitted — raise --limit)`);
    }
    stdout = lines.join('\n');
  }
  return { stdout, stderr: '', result: payload };
}

export function collectionCatalogPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Collection Catalog routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === COLLECTION_CATALOG_APPLICATION_ID
    ? 'command-application' : 'not-collection-catalog';
}

export async function executeCollectionCatalogPlan(plan, adapters = {}) {
  if (collectionCatalogPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Collection Catalog.`);
  }
  return executeCollectionCatalog(parseCollectionCatalogRequest(plan.argv), adapters);
}
