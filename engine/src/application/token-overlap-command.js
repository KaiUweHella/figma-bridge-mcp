// Bounded Token Overlap Facts Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseTokenOverlapRequest,
  tokenOverlapArgvFromRequest,
  tokenOverlapPlanningArgvFromRequest,
} from './token-overlap-request.js';

export { tokenOverlapArgvFromRequest, tokenOverlapPlanningArgvFromRequest } from './token-overlap-request.js';

const APPLICATION_ID = 'tokens.overlap';
const MAX_COLLECTION_CANDIDATES = 10_000;
const MAX_TARGET_VARIABLES = 100_000;
const MAX_STRING = 512;
export const MAX_TOKEN_OVERLAP_SERIALIZED_CODE_UNITS = 2_000_000;

function normalizedRequest(request) {
  return parseTokenOverlapRequest(tokenOverlapArgvFromRequest(request));
}

export function tokenOverlapCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const queries = ${JSON.stringify(input.queries)};
    const limit = ${input.limit};
    const validText = (value, empty = true) => typeof value === 'string'
      && value.length <= ${MAX_STRING} && (empty || value.length > 0);
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    if (!Array.isArray(collections) || collections.length > ${MAX_COLLECTION_CANDIDATES}
      || collections.some((collection) => !collection || !validText(collection.id, false)
        || !validText(collection.name) || collection.remote
        || !Array.isArray(collection.variableIds)
        || collection.variableIds.length > ${MAX_TARGET_VARIABLES}
        || collection.variableIds.some((id) => !validText(id, false))
        || new Set(collection.variableIds).size !== collection.variableIds.length)
      || new Set(collections.map((collection) => collection.id)).size !== collections.length) {
      throw new Error('Token Overlap encountered invalid Collection metadata.');
    }
    const resolved = queries.map((query) => {
      const folded = query.toLocaleLowerCase('en-US');
      const byId = collections.filter((collection) => collection.id === query);
      const exact = collections.filter((collection) =>
        collection.name.toLocaleLowerCase('en-US') === folded);
      const partial = collections.filter((collection) =>
        collection.name.toLocaleLowerCase('en-US').includes(folded));
      const matches = byId.length ? byId : exact.length ? exact : partial;
      if (!matches.length) throw new Error('Token Overlap Collection not found.');
      if (matches.length > 1) throw new Error('Token Overlap Collection query is ambiguous.');
      return { query, collection: matches[0] };
    });
    if (new Set(resolved.map((item) => item.collection.id)).size !== resolved.length) {
      throw new Error('Token Overlap queries resolve to the same Collection.');
    }
    const membershipTotal = resolved.reduce((total, item) =>
      total + item.collection.variableIds.length, 0);
    if (membershipTotal > ${MAX_TARGET_VARIABLES}) {
      throw new Error('Token Overlap selected Variable membership limit exceeded.');
    }
    const memberships = resolved.flatMap((item, collectionIndex) =>
      item.collection.variableIds.map((id) => ({ id, collectionIndex })));
    if (new Set(memberships.map((item) => item.id)).size !== memberships.length) {
      throw new Error('Token Overlap encountered cross-Collection Variable identity reuse.');
    }
    const variables = [];
    for (let start = 0; start < memberships.length; start += 64) {
      variables.push(...await Promise.all(memberships.slice(start, start + 64)
        .map((item) => figma.variables.getVariableByIdAsync(item.id))));
    }
    const counts = resolved.map(() => new Map());
    for (let index = 0; index < memberships.length; index++) {
      const membership = memberships[index];
      const variable = variables[index];
      const owner = resolved[membership.collectionIndex].collection;
      if (!variable || variable.id !== membership.id || variable.remote
        || variable.variableCollectionId !== owner.id || !validText(variable.name, false)) {
        throw new Error('Token Overlap could not load exact Variable membership.');
      }
      const map = counts[membership.collectionIndex];
      map.set(variable.name, (map.get(variable.name) || 0) + 1);
    }
    const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const union = [...new Set(counts.flatMap((map) => [...map.keys()]))].sort(compare);
    const common = union.filter((name) => counts.every((map) => map.get(name) === 1));
    const list = (items) => {
      const projected = items.slice(0, limit);
      return { total: items.length, returned: projected.length,
        omitted: items.length - projected.length, complete: projected.length === items.length,
        items: projected };
    };
    const perCollection = resolved.map((item, index) => {
      const map = counts[index];
      const names = [...map.keys()].sort(compare);
      const only = names.filter((name) => counts.every((other, otherIndex) =>
        otherIndex === index || !other.has(name)));
      const missing = union.filter((name) => !map.has(name));
      const ambiguous = names.filter((name) => map.get(name) > 1)
        .map((name) => ({ name, count: map.get(name) }));
      return {
        collection: item.collection.name, total: names.length,
        variableCount: item.collection.variableIds.length,
        duplicateNameCount: ambiguous.reduce((total, entry) => total + entry.count - 1, 0),
        only_here: list(only), missing_here: list(missing), ambiguous_here: list(ambiguous),
      };
    });
    const commonCore = list(common);
    const complete = commonCore.complete && perCollection.every((row) =>
      row.only_here.complete && row.missing_here.complete && row.ambiguous_here.complete);
    const payload = {
      schemaVersion: 1, limit, complete,
      resolved: resolved.map((item) => ({
        query: item.query, id: item.collection.id, name: item.collection.name,
      })),
      collections: resolved.map((item) => item.collection.name),
      commonCore, perCollection,
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_TOKEN_OVERLAP_SERIALIZED_CODE_UNITS}) {
      throw new Error('Token Overlap result exceeded the serialized-size limit. Lower --limit.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function text(value, empty = true) {
  return typeof value === 'string' && value.length <= MAX_STRING && (empty || value.length > 0);
}
function sortedUniqueText(values) {
  return Array.isArray(values) && values.every((item) => text(item, false))
    && values.every((item, index) => index === 0 || values[index - 1] < item);
}
function validList(value, limit, itemValidator = null) {
  return exactKeys(value, ['total', 'returned', 'omitted', 'complete', 'items'])
    && Number.isSafeInteger(value.total) && value.total >= 0
    && Number.isSafeInteger(value.returned) && value.returned >= 0 && value.returned <= limit
    && Number.isSafeInteger(value.omitted) && value.omitted >= 0
    && value.total === value.returned + value.omitted
    && value.complete === (value.omitted === 0)
    && (value.omitted === 0 || value.returned === limit)
    && Array.isArray(value.items) && value.items.length === value.returned
    && (itemValidator ? itemValidator(value.items) : sortedUniqueText(value.items));
}
function validAmbiguous(values) {
  return values.every((item, index) => exactKeys(item, ['name', 'count'])
    && text(item.name, false) && Number.isSafeInteger(item.count) && item.count >= 2
    && (index === 0 || values[index - 1].name < item.name));
}
function validPayload(value, input) {
  if (!exactKeys(value, ['schemaVersion', 'limit', 'complete', 'resolved',
    'collections', 'commonCore', 'perCollection'])
    || value.schemaVersion !== 1 || value.limit !== input.limit
    || !Array.isArray(value.resolved) || value.resolved.length !== input.queries.length
    || !Array.isArray(value.collections) || value.collections.length !== input.queries.length
    || !Array.isArray(value.perCollection) || value.perCollection.length !== input.queries.length
    || !validList(value.commonCore, input.limit)) return false;
  const ids = new Set();
  let allComplete = value.commonCore.complete;
  const ambiguousNames = new Set();
  for (let index = 0; index < input.queries.length; index++) {
    const resolved = value.resolved[index];
    const row = value.perCollection[index];
    if (!exactKeys(resolved, ['query', 'id', 'name'])
      || resolved.query !== input.queries[index] || !text(resolved.id, false)
      || !text(resolved.name) || ids.has(resolved.id)
      || value.collections[index] !== resolved.name
      || !exactKeys(row, ['collection', 'total', 'variableCount', 'duplicateNameCount',
        'only_here', 'missing_here', 'ambiguous_here'])
      || row.collection !== resolved.name
      || !Number.isSafeInteger(row.total) || row.total < 0 || row.total > MAX_TARGET_VARIABLES
      || !Number.isSafeInteger(row.variableCount) || row.variableCount < row.total
      || row.variableCount > MAX_TARGET_VARIABLES
      || !Number.isSafeInteger(row.duplicateNameCount) || row.duplicateNameCount < 0
      || row.variableCount !== row.total + row.duplicateNameCount
      || !validList(row.only_here, input.limit)
      || !validList(row.missing_here, input.limit)
      || !validList(row.ambiguous_here, input.limit, validAmbiguous)
      || row.only_here.items.some((name) => row.missing_here.items.includes(name))) return false;
    ids.add(resolved.id);
    for (const item of row.ambiguous_here.items) ambiguousNames.add(item.name);
    if (row.ambiguous_here.complete
      && row.duplicateNameCount !== row.ambiguous_here.items.reduce((total, item) =>
        total + item.count - 1, 0)) return false;
    allComplete = allComplete && row.only_here.complete
      && row.missing_here.complete && row.ambiguous_here.complete;
  }
  return value.complete === allComplete
    && value.commonCore.items.every((name) => !ambiguousNames.has(name));
}

function safeText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '�');
}
function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
function publicProjection(payload) {
  return {
    schemaVersion: payload.schemaVersion, limit: payload.limit, complete: payload.complete,
    collections: payload.collections, commonCore: payload.commonCore,
    perCollection: payload.perCollection,
  };
}
function omissionLine(list) {
  return list.complete ? null : `    (${list.omitted} more omitted — raise --limit)`;
}

export async function executeTokenOverlap(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeTokenOverlap requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(tokenOverlapCommandCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_TOKEN_OVERLAP_SERIALIZED_CODE_UNITS) {
    throw new Error('Token Overlap returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Token Overlap returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Token Overlap returned an invalid bounded result.');
  }
  if (input.json) return { stdout: safePrettyJson(publicProjection(payload)), stderr: '', result: payload };
  const lines = [
    `Comparing ${payload.collections.length} collections: ${payload.collections.map(safeText).join(', ')}`,
    '',
    `Common core — ${payload.commonCore.total} tokens (switch cleanly across all):`,
    payload.commonCore.items.length ? `  ${payload.commonCore.items.map(safeText).join(', ')}`
      : '  (none — no shared unambiguous token names)',
  ];
  const commonOmission = omissionLine(payload.commonCore);
  if (commonOmission) lines.push(commonOmission);
  lines.push('');
  for (const row of payload.perCollection) {
    lines.push(`${safeText(row.collection)} (${row.total} distinct names, ${row.variableCount} variables)`);
    if (row.ambiguous_here.total) {
      lines.push(`  ambiguous here (${row.ambiguous_here.total}):`);
      lines.push(`    ${row.ambiguous_here.items.map((item) => `${safeText(item.name)} ×${item.count}`).join(', ')}`);
      const omitted = omissionLine(row.ambiguous_here); if (omitted) lines.push(omitted);
    }
    if (row.only_here.total) {
      lines.push(`  only here (${row.only_here.total}):`);
      lines.push(`    ${row.only_here.items.map(safeText).join(', ')}`);
      const omitted = omissionLine(row.only_here); if (omitted) lines.push(omitted);
    }
    if (row.missing_here.total) {
      lines.push(`  missing here (${row.missing_here.total}) — won't switch INTO this collection:`);
      lines.push(`    ${row.missing_here.items.map(safeText).join(', ')}`);
      const omitted = omissionLine(row.missing_here); if (omitted) lines.push(omitted);
    }
    lines.push('');
  }
  lines.push('Tip: design with the common-core tokens for cleanest theme switching.');
  return { stdout: lines.join('\n'), stderr: payload.complete ? ''
    : 'One or more name lists were truncated; raise --limit for complete facts.', result: payload };
}

export function tokenOverlapPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Token Overlap routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-token-overlap';
}

export async function executeTokenOverlapPlan(plan, adapters = {}) {
  if (tokenOverlapPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Token Overlap.`);
  }
  return executeTokenOverlap(parseTokenOverlapRequest(plan.argv), adapters);
}
