// Exact compact Token Publish Status Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseTokenPublishStatusRequest,
  tokenPublishStatusArgvFromRequest,
  tokenPublishStatusPlanningArgvFromRequest,
} from './token-publish-status-request.js';

export {
  tokenPublishStatusArgvFromRequest,
  tokenPublishStatusPlanningArgvFromRequest,
} from './token-publish-status-request.js';

const APPLICATION_IDS = new Set(['var.publish-status', 'col.publish-status']);
export const MAX_TOKEN_PUBLISH_STATUS_CANDIDATES = 100_000;
export const MAX_TOKEN_PUBLISH_STATUS_SERIALIZED_CODE_UNITS = 32_768;
const MAX_TOKEN_PUBLISH_STATUS_STRING_CODE_UNITS = 1024;
const MAX_AMBIGUOUS_LABELS = 8;
const PUBLISH_STATUSES = new Set(['UNPUBLISHED', 'CURRENT', 'CHANGED']);

function normalizedRequest(request) {
  return parseTokenPublishStatusRequest(tokenPublishStatusArgvFromRequest(request));
}

export function tokenPublishStatusCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const kind = ${JSON.stringify(input.kind)};
    const query = ${JSON.stringify(input.query)};
    const collectionHint = ${JSON.stringify(input.collection)};
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(collections) || collections.length > ${MAX_TOKEN_PUBLISH_STATUS_CANDIDATES}) {
      throw new Error('Token Publish Status candidate limit exceeded.');
    }
    const safeLabel = (value) => String(value == null ? '' : value)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      .slice(0, 256);
    const ambiguous = (type, value, matches, label) => {
      const shown = matches.slice(0, ${MAX_AMBIGUOUS_LABELS}).map(label);
      const remainder = matches.length - shown.length;
      throw new Error('Ambiguous ' + type + ' "' + safeLabel(value) + '": '
        + matches.length + ' matches (' + shown.join(', ')
        + (remainder > 0 ? ', +' + remainder + ' more' : '') + ')');
    };
    const resolveCollection = async (value) => {
      let direct = null;
      try { direct = await figma.variables.getVariableCollectionByIdAsync(value); } catch {}
      if (direct) return { value: direct, resolution: 'id' };
      const exact = collections.filter((item) => item.name === value);
      const matches = exact.length ? exact : collections.filter((item) =>
        item.name.toLowerCase().includes(String(value).toLowerCase()));
      if (matches.length > 1) ambiguous('collection', value, matches,
        (item) => safeLabel(item.name));
      if (!matches.length) throw new Error('Collection not found: ' + safeLabel(value));
      return { value: matches[0], resolution: exact.length ? 'exact-name' : 'partial-name' };
    };

    let subject;
    let resolution;
    let subjectCollection = null;
    let collectionResolution = null;
    if (kind === 'collection') {
      const selected = await resolveCollection(query);
      subject = selected.value;
      resolution = selected.resolution;
    } else {
      const selectedCollection = collectionHint === null
        ? null : await resolveCollection(collectionHint);
      collectionResolution = selectedCollection?.resolution || null;
      let variable = null;
      try { variable = await figma.variables.getVariableByIdAsync(query); } catch {}
      if (variable && selectedCollection
        && variable.variableCollectionId !== selectedCollection.value.id) {
        throw new Error('Variable is not in collection: ' + safeLabel(collectionHint));
      }
      resolution = 'id';
      if (!variable) {
        let pool = await figma.variables.getLocalVariablesAsync();
        if (!Array.isArray(pool) || pool.length > ${MAX_TOKEN_PUBLISH_STATUS_CANDIDATES}) {
          throw new Error('Token Publish Status candidate limit exceeded.');
        }
        if (selectedCollection) {
          pool = pool.filter((item) => item.variableCollectionId === selectedCollection.value.id);
        }
        const exact = pool.filter((item) => item.name === query);
        const tail = pool.filter((item) => item.name.endsWith('/' + query));
        const partial = pool.filter((item) =>
          item.name.toLowerCase().includes(String(query).toLowerCase()));
        const matches = exact.length ? exact : (tail.length ? tail : partial);
        if (matches.length > 1) ambiguous('variable', query, matches, (item) => {
          const collection = collections.find((candidate) =>
            candidate.id === item.variableCollectionId);
          return safeLabel((collection ? collection.name + '/' : '') + item.name);
        });
        if (!matches.length) throw new Error('Variable not found: ' + safeLabel(query));
        variable = matches[0];
        resolution = exact.length ? 'exact-name' : (tail.length ? 'tail-name' : 'partial-name');
      }
      subject = variable;
      const collection = selectedCollection?.value
        || collections.find((item) => item.id === variable.variableCollectionId)
        || await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      if (!collection) throw new Error('Variable collection not found.');
      subjectCollection = { id: collection.id, name: collection.name };
    }
    if (!subject || typeof subject.id !== 'string' || subject.id.length < 1
      || subject.id.length > ${MAX_TOKEN_PUBLISH_STATUS_STRING_CODE_UNITS}
      || typeof subject.name !== 'string'
      || subject.name.length > ${MAX_TOKEN_PUBLISH_STATUS_STRING_CODE_UNITS}) {
      throw new Error('Token Publish Status encountered invalid identity metadata.');
    }
    if (subjectCollection && (typeof subjectCollection.id !== 'string'
      || subjectCollection.id.length < 1
      || subjectCollection.id.length > ${MAX_TOKEN_PUBLISH_STATUS_STRING_CODE_UNITS}
      || typeof subjectCollection.name !== 'string'
      || subjectCollection.name.length > ${MAX_TOKEN_PUBLISH_STATUS_STRING_CODE_UNITS})) {
      throw new Error('Token Publish Status encountered invalid collection metadata.');
    }
    const publishStatus = await subject.getPublishStatusAsync();
    if (!['UNPUBLISHED', 'CURRENT', 'CHANGED'].includes(publishStatus)) {
      throw new Error('Token Publish Status encountered an unsupported Figma status.');
    }
    const payload = {
      schemaVersion: 1,
      kind,
      resolution,
      query,
      collectionHint,
      collectionResolution,
      subject: { id: subject.id, name: subject.name, collection: subjectCollection },
      publishStatus,
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_TOKEN_PUBLISH_STATUS_SERIALIZED_CODE_UNITS}) {
      throw new Error('Token Publish Status serialized-size limit exceeded.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= MAX_TOKEN_PUBLISH_STATUS_STRING_CODE_UNITS
    && (empty || value.length > 0);
}

function validResolution(value, input, subject) {
  if (!['id', 'exact-name', 'tail-name', 'partial-name'].includes(value)) return false;
  if (value === 'id') return subject.id === input.query;
  if (value === 'exact-name') return subject.name === input.query;
  if (value === 'tail-name') return input.kind === 'variable'
    && subject.name !== input.query && subject.name.endsWith('/' + input.query);
  return subject.name !== input.query
    && (input.kind !== 'variable' || !subject.name.endsWith('/' + input.query))
    && subject.name.toLowerCase().includes(input.query.toLowerCase());
}

function validCollectionResolution(value, input, collection) {
  if (input.collection === null) return value === null;
  if (!['id', 'exact-name', 'partial-name'].includes(value)) return false;
  if (value === 'id') return collection.id === input.collection;
  if (value === 'exact-name') return collection.name === input.collection;
  return collection.name !== input.collection
    && collection.name.toLowerCase().includes(input.collection.toLowerCase());
}

function validPayload(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'kind', 'resolution', 'query', 'collectionHint', 'collectionResolution',
    'subject', 'publishStatus',
  ]) || value.schemaVersion !== 1 || value.kind !== input.kind
    || value.query !== input.query || value.collectionHint !== input.collection
    || !exactKeys(value.subject, ['id', 'name', 'collection'])
    || !boundedString(value.subject.id, { empty: false }) || !boundedString(value.subject.name)
    || !validResolution(value.resolution, input, value.subject)
    || !PUBLISH_STATUSES.has(value.publishStatus)) return false;
  if (input.kind === 'collection') {
    return value.subject.collection === null && value.collectionResolution === null;
  }
  return exactKeys(value.subject.collection, ['id', 'name'])
    && boundedString(value.subject.collection.id, { empty: false })
    && boundedString(value.subject.collection.name)
    && validCollectionResolution(value.collectionResolution, input, value.subject.collection);
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeTokenPublishStatus(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeTokenPublishStatus requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(tokenPublishStatusCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_TOKEN_PUBLISH_STATUS_SERIALIZED_CODE_UNITS) {
    throw new Error('Token Publish Status returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Token Publish Status returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Token Publish Status returned an invalid bounded result.');
  }
  return {
    stdout: safePrettyJson({
      id: payload.subject.id,
      name: payload.subject.name,
      publishStatus: payload.publishStatus,
    }),
    stderr: '',
    result: payload,
  };
}

export function tokenPublishStatusPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Token Publish Status routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-token-publish-status';
}

export async function executeTokenPublishStatusPlan(plan, adapters = {}) {
  if (tokenPublishStatusPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Publish Status.`);
  }
  return executeTokenPublishStatus(parseTokenPublishStatusRequest(plan.argv), adapters);
}
