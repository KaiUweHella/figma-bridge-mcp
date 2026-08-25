// Exact bounded Collection Facts Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  collectionFactsArgvFromRequest,
  parseCollectionFactsRequest,
} from './collection-facts-request.js';

export { collectionFactsArgvFromRequest } from './collection-facts-request.js';

const COLLECTION_FACTS_APPLICATION_ID = 'col.show';
export const MAX_COLLECTION_FACTS_CANDIDATES = 100_000;
export const MAX_COLLECTION_FACTS_MODES = 1000;
export const MAX_COLLECTION_FACTS_SERIALIZED_CODE_UNITS = 2_000_000;
const MAX_COLLECTION_FACTS_STRING_CODE_UNITS = 1024;
const MAX_AMBIGUOUS_COLLECTION_LABELS = 8;
const PUBLISH_STATUSES = new Set(['UNPUBLISHED', 'CURRENT', 'CHANGED']);

function normalizedRequest(request) {
  return parseCollectionFactsRequest(collectionFactsArgvFromRequest(request));
}

export function collectionFactsCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.collection)};
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(collections) || collections.length > ${MAX_COLLECTION_FACTS_CANDIDATES}) {
      throw new Error('Collection Facts candidate limit exceeded.');
    }
    const safeLabel = (value) => String(value == null ? '' : value)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]/g, ' ')
      .slice(0, 256);
    let collection = null;
    try { collection = await figma.variables.getVariableCollectionByIdAsync(query); } catch {}
    if (collection && !collections.some((item) => item.id === collection.id)) collection = null;
    if (!collection) {
      const exact = collections.filter((item) => item.name === query);
      const matches = exact.length ? exact : collections.filter((item) =>
        item.name.toLowerCase().includes(String(query).toLowerCase()));
      if (matches.length > 1) {
        const shown = matches.slice(0, ${MAX_AMBIGUOUS_COLLECTION_LABELS})
          .map((item) => safeLabel(item.name));
        const remainder = matches.length - shown.length;
        throw new Error('Ambiguous collection "' + safeLabel(query) + '": '
          + matches.length + ' matches (' + shown.join(', ')
          + (remainder > 0 ? ', +' + remainder + ' more' : '') + ')');
      }
      if (!matches.length) throw new Error('Collection not found: ' + safeLabel(query));
      collection = matches[0];
    }
    if (!collection || typeof collection.id !== 'string' || collection.id.length < 1
      || collection.id.length > ${MAX_COLLECTION_FACTS_STRING_CODE_UNITS}
      || typeof collection.key !== 'string'
      || collection.key.length > ${MAX_COLLECTION_FACTS_STRING_CODE_UNITS}
      || typeof collection.name !== 'string'
      || collection.name.length > ${MAX_COLLECTION_FACTS_STRING_CODE_UNITS}
      || typeof collection.defaultModeId !== 'string'
      || collection.defaultModeId.length < 1
      || collection.defaultModeId.length > ${MAX_COLLECTION_FACTS_STRING_CODE_UNITS}
      || !Array.isArray(collection.modes) || collection.modes.length > ${MAX_COLLECTION_FACTS_MODES}
      || !Array.isArray(collection.variableIds)
      || collection.variableIds.length > ${MAX_COLLECTION_FACTS_CANDIDATES}) {
      throw new Error('Collection Facts encountered invalid collection metadata.');
    }
    const payload = {
      schemaVersion: 1,
      id: collection.id,
      key: collection.key || null,
      name: collection.name,
      remote: !!collection.remote,
      isExtension: !!collection.isExtension,
      hiddenFromPublishing: !!collection.hiddenFromPublishing,
      defaultModeId: collection.defaultModeId,
      modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
      variableIds: [...collection.variableIds],
      publishStatus: await collection.getPublishStatusAsync(),
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_COLLECTION_FACTS_SERIALIZED_CODE_UNITS}) {
      throw new Error('Collection Facts serialized-size limit exceeded.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_COLLECTION_FACTS_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function validPayload(value) {
  if (!exactKeys(value, [
    'schemaVersion', 'id', 'key', 'name', 'remote', 'isExtension',
    'hiddenFromPublishing', 'defaultModeId', 'modes', 'variableIds', 'publishStatus',
  ]) || value.schemaVersion !== 1 || !boundedString(value.id, { empty: false })
    || !(value.key === null || boundedString(value.key, { empty: false }))
    || !boundedString(value.name) || typeof value.remote !== 'boolean'
    || typeof value.isExtension !== 'boolean'
    || typeof value.hiddenFromPublishing !== 'boolean'
    || !boundedString(value.defaultModeId, { empty: false })
    || !Array.isArray(value.modes) || value.modes.length > MAX_COLLECTION_FACTS_MODES
    || !Array.isArray(value.variableIds)
    || value.variableIds.length > MAX_COLLECTION_FACTS_CANDIDATES
    || !PUBLISH_STATUSES.has(value.publishStatus)) return false;
  const modeIds = new Set();
  for (const mode of value.modes) {
    if (!exactKeys(mode, ['modeId', 'name'])
      || !boundedString(mode.modeId, { empty: false }) || !boundedString(mode.name)
      || modeIds.has(mode.modeId)) return false;
    modeIds.add(mode.modeId);
  }
  if (!modeIds.has(value.defaultModeId)) return false;
  const variableIds = new Set();
  for (const id of value.variableIds) {
    if (!boundedString(id, { empty: false }) || variableIds.has(id)) return false;
    variableIds.add(id);
  }
  return true;
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeCollectionFacts(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeCollectionFacts requires evaluate(code)');
  }
  const serialized = await adapters.evaluate(collectionFactsCode(request));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_COLLECTION_FACTS_SERIALIZED_CODE_UNITS) {
    throw new Error('Collection Facts returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Collection Facts returned invalid JSON.'); }
  if (!validPayload(payload)) throw new Error('Collection Facts returned an invalid bounded result.');
  const { schemaVersion: _schemaVersion, ...legacyProjection } = payload;
  return { stdout: safePrettyJson(legacyProjection), stderr: '', result: payload };
}

export function collectionFactsPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Collection Facts routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === COLLECTION_FACTS_APPLICATION_ID
    ? 'command-application' : 'not-collection-facts';
}

export async function executeCollectionFactsPlan(plan, adapters = {}) {
  if (collectionFactsPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Collection Facts.`);
  }
  return executeCollectionFacts(parseCollectionFactsRequest(plan.argv), adapters);
}
