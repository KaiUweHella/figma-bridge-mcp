// Bounded compact Style Catalog Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  encodeStyleCatalogCursor,
  parseStyleCatalogRequest,
  styleCatalogArgvFromRequest,
  styleCatalogPlanningArgvFromRequest,
} from './style-catalog-request.js';

export {
  styleCatalogArgvFromRequest,
  styleCatalogPlanningArgvFromRequest,
} from './style-catalog-request.js';

const STYLE_CATALOG_APPLICATION_ID = 'style.list';
export const MAX_STYLE_CATALOG_CANDIDATES = 10_000;
export const MAX_STYLE_CATALOG_SERIALIZED_CODE_UNITS = 200_000;
export const MAX_STYLE_CATALOG_VALUES = 10_000;
export const MAX_STYLE_CATALOG_DEPTH = 8;
export const MAX_STYLE_CATALOG_CONTAINER_ENTRIES = 1024;
export const MAX_STYLE_CATALOG_STRING_CODE_UNITS = 65_536;
const MAX_STYLE_CATALOG_KEY_CODE_UNITS = 128;
const MAX_STYLE_CATALOG_LABEL_CODE_UNITS = 1024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);

function normalizedRequest(request) {
  return parseStyleCatalogRequest(styleCatalogArgvFromRequest(request));
}

export function styleCatalogCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const requestedType = ${JSON.stringify(input.type)};
    const after = ${JSON.stringify(input.after)};
    const loaders = {
      PAINT: () => figma.getLocalPaintStylesAsync(),
      TEXT: () => figma.getLocalTextStylesAsync(),
      EFFECT: () => figma.getLocalEffectStylesAsync(),
      GRID: () => figma.getLocalGridStylesAsync(),
    };
    const lists = requestedType
      ? [await loaders[requestedType]()]
      : await Promise.all(Object.values(loaders).map((load) => load()));
    const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const compare = (left, right) => compareText(left.type, right.type)
      || compareText(left.name, right.name) || compareText(left.id, right.id);
    const catalog = lists.flat().sort(compare);
    if (catalog.length > ${MAX_STYLE_CATALOG_CANDIDATES}) {
      throw new Error('Style Catalog candidate limit exceeded. Narrow with --type.');
    }
    let start = 0;
    if (after) {
      const anchorIndex = catalog.findIndex((style) => style.type === after.type
        && style.name === after.name && style.id === after.id);
      if (anchorIndex === -1) throw new Error('Style Catalog cursor is stale. Restart without --cursor.');
      start = anchorIndex + 1;
    }
    const end = Math.min(catalog.length, start + ${input.limit});
    const styles = catalog.slice(start, end).map((style) => {
      if (typeof style.id !== 'string' || typeof style.key !== 'string'
        || typeof style.name !== 'string' || typeof style.remote !== 'boolean') {
        throw new Error('Style Catalog encountered incompatible publishable metadata.');
      }
      return {
        id: style.id,
        key: style.key,
        name: style.name,
        type: style.type,
        remote: style.remote,
      };
    });
    const anchor = (style) => style
      ? { type: style.type, name: style.name, id: style.id }
      : null;
    const omittedBefore = start;
    const omittedAfter = catalog.length - end;
    const payload = {
      schemaVersion: 1,
      scope: requestedType || 'ALL',
      cursorAnchor: after,
      total: catalog.length,
      returned: styles.length,
      omitted: omittedBefore + omittedAfter,
      omittedBefore,
      omittedAfter,
      complete: omittedBefore === 0 && omittedAfter === 0,
      nextAnchor: omittedAfter > 0 ? anchor(styles[styles.length - 1]) : null,
      styles,
    };

    let values = 0;
    const seen = new Set();
    const verify = (value, depth = 0) => {
      values++;
      if (values > ${MAX_STYLE_CATALOG_VALUES}) throw new Error('Style Catalog value limit exceeded.');
      if (depth > ${MAX_STYLE_CATALOG_DEPTH}) throw new Error('Style Catalog depth limit exceeded.');
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Style Catalog contains a non-finite number.');
        return;
      }
      if (typeof value === 'string') {
        if (value.length > ${MAX_STYLE_CATALOG_STRING_CODE_UNITS}) {
          throw new Error('Style Catalog string limit exceeded.');
        }
        return;
      }
      if (!value || typeof value !== 'object') throw new Error('Style Catalog contains a non-JSON value.');
      if (seen.has(value)) throw new Error('Style Catalog contains a cycle.');
      seen.add(value);
      const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item])
        : Object.entries(value);
      if (entries.length > ${MAX_STYLE_CATALOG_CONTAINER_ENTRIES}) {
        throw new Error('Style Catalog container limit exceeded.');
      }
      for (const [key, item] of entries) {
        if (key.length > ${MAX_STYLE_CATALOG_KEY_CODE_UNITS}) {
          throw new Error('Style Catalog key limit exceeded.');
        }
        verify(item, depth + 1);
      }
      seen.delete(value);
    };
    verify(payload);
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_STYLE_CATALOG_SERIALIZED_CODE_UNITS}) {
      throw new Error('Style Catalog serialized-size limit exceeded. Lower --limit.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function boundedString(value, { empty = true } = {}) {
  return typeof value === 'string'
    && value.length <= MAX_STYLE_CATALOG_LABEL_CODE_UNITS
    && (empty || value.length > 0);
}

function validAnchor(value) {
  return exactKeys(value, ['type', 'name', 'id'])
    && STYLE_TYPES.has(value.type)
    && boundedString(value.name)
    && boundedString(value.id, { empty: false });
}

function sameAnchor(left, right) {
  if (left === null || right === null) return left === right;
  return validAnchor(left) && validAnchor(right)
    && left.type === right.type && left.name === right.name && left.id === right.id;
}

function compareItem(left, right) {
  return left.type < right.type ? -1 : left.type > right.type ? 1
    : left.name < right.name ? -1 : left.name > right.name ? 1
      : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validPayload(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'scope', 'cursorAnchor', 'total', 'returned', 'omitted',
    'omittedBefore', 'omittedAfter', 'complete', 'nextAnchor', 'styles',
  ]) || value.schemaVersion !== 1 || value.scope !== (input.type || 'ALL')
    || !sameAnchor(value.cursorAnchor, input.after)
    || !Number.isInteger(value.total) || value.total < 0
    || value.total > MAX_STYLE_CATALOG_CANDIDATES
    || !Number.isInteger(value.returned) || value.returned < 0
    || value.returned > input.limit
    || !Number.isInteger(value.omittedBefore) || value.omittedBefore < 0
    || !Number.isInteger(value.omittedAfter) || value.omittedAfter < 0
    || value.omitted !== value.omittedBefore + value.omittedAfter
    || value.total !== value.returned + value.omitted
    || value.complete !== (value.omitted === 0)
    || value.omittedBefore === 0 !== (input.after === null)
    || !Array.isArray(value.styles) || value.styles.length !== value.returned) return false;

  if (!value.styles.every((style) => exactKeys(style, ['id', 'key', 'name', 'type', 'remote'])
    && boundedString(style.id, { empty: false }) && boundedString(style.key)
    && boundedString(style.name) && STYLE_TYPES.has(style.type)
    && (input.type === null || style.type === input.type)
    && typeof style.remote === 'boolean')) return false;
  if (value.styles.some((style, index) => index > 0
    && compareItem(value.styles[index - 1], style) >= 0)) return false;
  if (new Set(value.styles.map((style) => style.id)).size !== value.styles.length) return false;
  if (input.after && value.styles.length > 0 && compareItem(input.after, value.styles[0]) >= 0) return false;
  if (value.omittedAfter > 0) {
    const last = value.styles[value.styles.length - 1];
    if (!last || !sameAnchor(value.nextAnchor, {
      type: last.type, name: last.name, id: last.id,
    })) return false;
  } else if (value.nextAnchor !== null) return false;
  return true;
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeStyleCatalog(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeStyleCatalog requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(styleCatalogCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_STYLE_CATALOG_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Catalog returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Style Catalog returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Style Catalog returned an invalid bounded result.');
  }
  const next = payload.nextAnchor
    ? encodeStyleCatalogCursor(input.type, payload.nextAnchor)
    : null;
  const {
    schemaVersion, cursorAnchor: _cursorAnchor, nextAnchor: _nextAnchor, ...facts
  } = payload;
  const publicFacts = { ...facts, next };
  const result = { schemaVersion, ...publicFacts };
  const stdout = safePrettyJson(publicFacts);
  if (stdout.length > MAX_STYLE_CATALOG_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Catalog returned an invalid bounded result.');
  }
  return { stdout, stderr: '', result };
}

export function styleCatalogPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Style Catalog routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === STYLE_CATALOG_APPLICATION_ID
    ? 'command-application' : 'not-style-catalog';
}

export async function executeStyleCatalogPlan(plan, adapters = {}) {
  if (styleCatalogPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Style Catalog Command Application.`);
  }
  return executeStyleCatalog(parseStyleCatalogRequest(plan.argv), adapters);
}
