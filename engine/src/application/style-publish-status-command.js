// Exact bounded local Style Publish Status Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseStylePublishStatusRequest,
  stylePublishStatusArgvFromRequest,
  stylePublishStatusPlanningArgvFromRequest,
} from './style-publish-status-request.js';

export {
  stylePublishStatusArgvFromRequest,
  stylePublishStatusPlanningArgvFromRequest,
} from './style-publish-status-request.js';

const STYLE_PUBLISH_STATUS_APPLICATION_ID = 'style.publish-status';
export const MAX_STYLE_PUBLISH_STATUS_CANDIDATES = 10_000;
export const MAX_STYLE_PUBLISH_STATUS_SERIALIZED_CODE_UNITS = 16_384;
const MAX_STYLE_PUBLISH_STATUS_LABEL_CODE_UNITS = 1_024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const PUBLISH_STATUSES = new Set(['UNPUBLISHED', 'CURRENT', 'CHANGED']);

function normalizedRequest(request) {
  return parseStylePublishStatusRequest(stylePublishStatusArgvFromRequest(request));
}

export function stylePublishStatusCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.style)};
    const requestedType = ${JSON.stringify(input.type)};
    const direct = await figma.getStyleByIdAsync(query);
    let style = direct && (!requestedType || direct.type === requestedType) ? direct : null;
    let resolution = 'id';
    if (!style) {
      const loaders = {
        PAINT: () => figma.getLocalPaintStylesAsync(),
        TEXT: () => figma.getLocalTextStylesAsync(),
        EFFECT: () => figma.getLocalEffectStylesAsync(),
        GRID: () => figma.getLocalGridStylesAsync(),
      };
      const lists = requestedType
        ? [await loaders[requestedType]()]
        : await Promise.all(Object.values(loaders).map((load) => load()));
      const pool = lists.flat();
      if (pool.length > ${MAX_STYLE_PUBLISH_STATUS_CANDIDATES}) {
        throw new Error('Style Publish Status candidate limit exceeded. Use an exact style id.');
      }
      const exact = pool.filter((candidate) => candidate.name === query);
      const matches = exact.length
        ? exact
        : pool.filter((candidate) => candidate.name.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) {
        throw new Error('Style reference is ambiguous (' + matches.length + ' matches). Use an exact style id, exact name, or --type.');
      }
      if (matches.length === 0) throw new Error('Style not found in the targeted Figma document.');
      style = matches[0];
      resolution = exact.length ? 'exact-name' : 'partial-name';
    }
    if (typeof style.id !== 'string' || typeof style.key !== 'string'
      || typeof style.name !== 'string' || typeof style.type !== 'string'
      || typeof style.remote !== 'boolean') {
      throw new Error('Style Publish Status encountered incompatible publishable metadata.');
    }
    const publishStatus = await style.getPublishStatusAsync();
    if (!['UNPUBLISHED', 'CURRENT', 'CHANGED'].includes(publishStatus)) {
      throw new Error('Style Publish Status encountered an unsupported Figma status.');
    }
    const payload = {
      schemaVersion: 1,
      resolution,
      query,
      requestedType,
      style: { id: style.id, key: style.key, name: style.name, type: style.type, remote: style.remote },
      publishStatus,
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_STYLE_PUBLISH_STATUS_SERIALIZED_CODE_UNITS}) {
      throw new Error('Style Publish Status serialized-size limit exceeded.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function boundedString(value, { empty = true } = {}) {
  return (
    typeof value === 'string' &&
    value.length <= MAX_STYLE_PUBLISH_STATUS_LABEL_CODE_UNITS &&
    (empty || value.length > 0)
  );
}

function validStyle(value, input, resolution) {
  return (
    exactKeys(value, ['id', 'key', 'name', 'type', 'remote']) &&
    boundedString(value.id, { empty: false }) &&
    boundedString(value.key) &&
    boundedString(value.name) &&
    STYLE_TYPES.has(value.type) &&
    typeof value.remote === 'boolean' &&
    (input.type === null || value.type === input.type) &&
    (resolution !== 'id' || value.id === input.style) &&
    (resolution !== 'exact-name' || value.name === input.style) &&
    (resolution !== 'partial-name' ||
      (value.name !== input.style && value.name.toLowerCase().includes(input.style.toLowerCase())))
  );
}

function validPayload(value, input) {
  return (
    exactKeys(value, [
      'schemaVersion',
      'resolution',
      'query',
      'requestedType',
      'style',
      'publishStatus',
    ]) &&
    value.schemaVersion === 1 &&
    ['id', 'exact-name', 'partial-name'].includes(value.resolution) &&
    value.query === input.style &&
    value.requestedType === input.type &&
    validStyle(value.style, input, value.resolution) &&
    PUBLISH_STATUSES.has(value.publishStatus)
  );
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeStylePublishStatus(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeStylePublishStatus requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(stylePublishStatusCode(input));
  if (
    typeof serialized !== 'string' ||
    serialized.length > MAX_STYLE_PUBLISH_STATUS_SERIALIZED_CODE_UNITS
  ) {
    throw new Error('Style Publish Status returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error('Style Publish Status returned invalid JSON.');
  }
  if (!validPayload(payload, input)) {
    throw new Error('Style Publish Status returned an invalid bounded result.');
  }
  const { schemaVersion, query: _query, requestedType: _requestedType, ...facts } = payload;
  return {
    stdout: safePrettyJson(facts),
    stderr: '',
    result: { schemaVersion, ...facts },
  };
}

export function stylePublishStatusPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError(
      'Style Publish Status routing requires a Command Plan created by the Capability Catalog.',
    );
  }
  return plan.allowed && plan.id === STYLE_PUBLISH_STATUS_APPLICATION_ID
    ? 'command-application'
    : 'not-style-publish-status';
}

export async function executeStylePublishStatusPlan(plan, adapters = {}) {
  if (stylePublishStatusPlanRoute(plan) !== 'command-application') {
    throw new Error(
      `Command Plan ${plan?.id || '(unknown)'} is not owned by the Style Publish Status Command Application.`,
    );
  }
  return executeStylePublishStatus(parseStylePublishStatusRequest(plan.argv), adapters);
}
