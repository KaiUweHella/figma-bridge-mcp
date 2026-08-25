// Bounded paginated Style Consumer Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  encodeStyleConsumerCursor,
  parseStyleConsumerRequest,
  styleConsumerArgvFromRequest,
  styleConsumerPlanningArgvFromRequest,
} from './style-consumer-request.js';
import { STYLE_CONSUMERS_TYPED_READ } from '../lib/typed-read-operations.js';

export {
  styleConsumerArgvFromRequest,
  styleConsumerPlanningArgvFromRequest,
} from './style-consumer-request.js';

const STYLE_CONSUMER_APPLICATION_ID = 'style.consumers';
export const MAX_STYLE_CONSUMER_STYLE_CANDIDATES = 10_000;
export const MAX_STYLE_CONSUMER_CANDIDATES = 100_000;
export const MAX_STYLE_CONSUMER_SERIALIZED_CODE_UNITS = 250_000;
export const MAX_STYLE_CONSUMER_VALUES = 20_000;
export const MAX_STYLE_CONSUMER_DEPTH = 10;
export const MAX_STYLE_CONSUMER_CONTAINER_ENTRIES = 1024;
export const MAX_STYLE_CONSUMER_STRING_CODE_UNITS = 65_536;
const MAX_STYLE_CONSUMER_KEY_CODE_UNITS = 128;
const MAX_STYLE_CONSUMER_LABEL_CODE_UNITS = 1024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const INHERITED_STYLE_FIELDS = new Set([
  'fillStyleId', 'strokeStyleId', 'backgroundStyleId', 'textStyleId',
  'effectStyleId', 'gridStyleId',
]);
const NODE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function normalizedRequest(request) {
  return parseStyleConsumerRequest(styleConsumerArgvFromRequest(request));
}

export function styleConsumerCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.style)};
    const requestedType = ${JSON.stringify(input.type)};
    const after = ${JSON.stringify(input.after)};
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
      if (pool.length > ${MAX_STYLE_CONSUMER_STYLE_CANDIDATES}) {
        throw new Error('Style Consumer style-candidate limit exceeded. Use an exact style id.');
      }
      const exact = pool.filter((candidate) => candidate.name === query);
      const matches = exact.length
        ? exact
        : pool.filter((candidate) => candidate.name.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) {
        throw new Error('Style reference is ambiguous (' + matches.length + ' matches). Use an exact style id or name.');
      }
      if (matches.length === 0) throw new Error('Style not found in the targeted Figma document.');
      style = matches[0];
      resolution = exact.length ? 'exact-name' : 'partial-name';
    }
    if (typeof style.id !== 'string' || typeof style.key !== 'string'
      || typeof style.name !== 'string' || typeof style.remote !== 'boolean') {
      throw new Error('Style Consumer encountered incompatible publishable metadata.');
    }
    const nativeConsumers = await style.getStyleConsumersAsync();
    if (nativeConsumers.length > ${MAX_STYLE_CONSUMER_CANDIDATES}) {
      throw new Error('Style Consumer candidate limit exceeded.');
    }
    const allowedFields = new Set(${JSON.stringify([...INHERITED_STYLE_FIELDS])});
    const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const consumers = nativeConsumers.map((consumer) => {
      if (!consumer || !consumer.node || !Array.isArray(consumer.fields)
        || typeof consumer.node.id !== 'string' || typeof consumer.node.name !== 'string'
        || typeof consumer.node.type !== 'string'
        || consumer.node.id.length === 0
        || consumer.node.id.length > ${MAX_STYLE_CONSUMER_LABEL_CODE_UNITS}
        || consumer.node.name.length > ${MAX_STYLE_CONSUMER_LABEL_CODE_UNITS}) {
        throw new Error('Style Consumer encountered incompatible node metadata.');
      }
      const fields = [...consumer.fields].sort(compareText);
      if (fields.length === 0 || fields.length > allowedFields.size
        || new Set(fields).size !== fields.length
        || fields.some((field) => !allowedFields.has(field))) {
        throw new Error('Style Consumer encountered an incompatible inherited style field.');
      }
      return {
        node: { id: consumer.node.id, name: consumer.node.name, type: consumer.node.type },
        fields,
      };
    });
    const compare = (left, right) => compareText(left.node.id, right.node.id)
      || compareText(left.fields.join('\\u0000'), right.fields.join('\\u0000'));
    consumers.sort(compare);
    for (let index = 1; index < consumers.length; index++) {
      if (compare(consumers[index - 1], consumers[index]) === 0) {
        throw new Error('Style Consumer returned a duplicate node/field identity.');
      }
    }
    const anchorFor = (consumer) => consumer
      ? { nodeId: consumer.node.id, fields: consumer.fields }
      : null;
    let start = 0;
    if (after) {
      const anchorIndex = consumers.findIndex((consumer) => consumer.node.id === after.nodeId
        && consumer.fields.length === after.fields.length
        && consumer.fields.every((field, index) => field === after.fields[index]));
      if (anchorIndex === -1) throw new Error('Style Consumer cursor is stale. Restart without --cursor.');
      start = anchorIndex + 1;
    }
    const end = Math.min(consumers.length, start + ${input.limit});
    const page = consumers.slice(start, end);
    const omittedBefore = start;
    const omittedAfter = consumers.length - end;
    const payload = {
      schemaVersion: 1,
      resolution,
      query,
      requestedType,
      style: { id: style.id, key: style.key, name: style.name, type: style.type, remote: style.remote },
      scan: { api: 'getStyleConsumersAsync', complete: true, interruptible: false },
      cursorAnchor: after,
      total: consumers.length,
      returned: page.length,
      omitted: omittedBefore + omittedAfter,
      omittedBefore,
      omittedAfter,
      complete: omittedBefore === 0 && omittedAfter === 0,
      nextAnchor: omittedAfter > 0 ? anchorFor(page[page.length - 1]) : null,
      consumers: page,
    };

    let values = 0;
    const seen = new Set();
    const verify = (value, depth = 0) => {
      values++;
      if (values > ${MAX_STYLE_CONSUMER_VALUES}) throw new Error('Style Consumer value limit exceeded.');
      if (depth > ${MAX_STYLE_CONSUMER_DEPTH}) throw new Error('Style Consumer depth limit exceeded.');
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Style Consumer contains a non-finite number.');
        return;
      }
      if (typeof value === 'string') {
        if (value.length > ${MAX_STYLE_CONSUMER_STRING_CODE_UNITS}) {
          throw new Error('Style Consumer string limit exceeded.');
        }
        return;
      }
      if (!value || typeof value !== 'object') throw new Error('Style Consumer contains a non-JSON value.');
      if (seen.has(value)) throw new Error('Style Consumer contains a cycle.');
      seen.add(value);
      const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item])
        : Object.entries(value);
      if (entries.length > ${MAX_STYLE_CONSUMER_CONTAINER_ENTRIES}) {
        throw new Error('Style Consumer container limit exceeded.');
      }
      for (const [key, item] of entries) {
        if (key.length > ${MAX_STYLE_CONSUMER_KEY_CODE_UNITS}) {
          throw new Error('Style Consumer key limit exceeded.');
        }
        verify(item, depth + 1);
      }
      seen.delete(value);
    };
    verify(payload);
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_STYLE_CONSUMER_SERIALIZED_CODE_UNITS}) {
      throw new Error('Style Consumer serialized-size limit exceeded. Lower --limit.');
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
  return typeof value === 'string' && value.length <= MAX_STYLE_CONSUMER_LABEL_CODE_UNITS
    && (empty || value.length > 0);
}

function validAnchor(value) {
  return exactKeys(value, ['nodeId', 'fields'])
    && boundedString(value.nodeId, { empty: false })
    && Array.isArray(value.fields) && value.fields.length > 0
    && value.fields.length <= INHERITED_STYLE_FIELDS.size
    && value.fields.every((field) => INHERITED_STYLE_FIELDS.has(field))
    && new Set(value.fields).size === value.fields.length
    && value.fields.every((field, index) => index === 0 || value.fields[index - 1] < field);
}

function sameAnchor(left, right) {
  if (left === null || right === null) return left === right;
  return validAnchor(left) && validAnchor(right)
    && left.nodeId === right.nodeId && left.fields.length === right.fields.length
    && left.fields.every((field, index) => field === right.fields[index]);
}

function validStyle(value, input, resolution) {
  return exactKeys(value, ['id', 'key', 'name', 'type', 'remote'])
    && boundedString(value.id, { empty: false }) && boundedString(value.key)
    && boundedString(value.name) && STYLE_TYPES.has(value.type)
    && typeof value.remote === 'boolean'
    && (input.type === null || value.type === input.type)
    && (resolution !== 'id' || value.id === input.style)
    && (resolution !== 'exact-name' || value.name === input.style)
    && (resolution !== 'partial-name' || (
      value.name !== input.style
      && value.name.toLowerCase().includes(input.style.toLowerCase())
    ));
}

function validConsumer(value) {
  return exactKeys(value, ['node', 'fields'])
    && exactKeys(value.node, ['id', 'name', 'type'])
    && boundedString(value.node.id, { empty: false })
    && boundedString(value.node.name)
    && typeof value.node.type === 'string' && NODE_TYPE_PATTERN.test(value.node.type)
    && Array.isArray(value.fields) && value.fields.length > 0
    && value.fields.length <= INHERITED_STYLE_FIELDS.size
    && value.fields.every((field) => INHERITED_STYLE_FIELDS.has(field))
    && new Set(value.fields).size === value.fields.length
    && value.fields.every((field, index) => index === 0 || value.fields[index - 1] < field);
}

function compareConsumer(left, right) {
  const leftFields = left.fields.join('\u0000');
  const rightFields = right.fields.join('\u0000');
  return left.node.id < right.node.id ? -1 : left.node.id > right.node.id ? 1
    : leftFields < rightFields ? -1 : leftFields > rightFields ? 1 : 0;
}

function validPayload(value, input) {
  const keys = [
    'schemaVersion', 'resolution', 'query', 'requestedType', 'style', 'scan',
    'cursorAnchor', 'total', 'returned', 'omitted', 'omittedBefore',
    'omittedAfter', 'complete', 'nextAnchor', 'consumers',
  ];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1
    || !['id', 'exact-name', 'partial-name'].includes(value.resolution)
    || value.query !== input.style || value.requestedType !== input.type
    || !validStyle(value.style, input, value.resolution)
    || !exactKeys(value.scan, ['api', 'complete', 'interruptible'])
    || value.scan.api !== 'getStyleConsumersAsync'
    || value.scan.complete !== true || value.scan.interruptible !== false
    || !sameAnchor(value.cursorAnchor, input.after)
    || !Number.isInteger(value.total) || value.total < 0
    || value.total > MAX_STYLE_CONSUMER_CANDIDATES
    || !Number.isInteger(value.returned) || value.returned < 0 || value.returned > input.limit
    || !Number.isInteger(value.omittedBefore) || value.omittedBefore < 0
    || !Number.isInteger(value.omittedAfter) || value.omittedAfter < 0
    || value.omitted !== value.omittedBefore + value.omittedAfter
    || value.total !== value.returned + value.omitted
    || value.complete !== (value.omitted === 0)
    || (value.omittedBefore === 0) !== (input.after === null)
    || !Array.isArray(value.consumers) || value.consumers.length !== value.returned
    || !value.consumers.every(validConsumer)) return false;
  if (value.consumers.some((consumer, index) => index > 0
    && compareConsumer(value.consumers[index - 1], consumer) >= 0)) return false;
  if (input.after && value.consumers.length > 0) {
    const first = value.consumers[0];
    const afterConsumer = { node: { id: input.after.nodeId }, fields: input.after.fields };
    if (compareConsumer(afterConsumer, first) >= 0) return false;
  }
  if (value.omittedAfter > 0) {
    const last = value.consumers[value.consumers.length - 1];
    if (!last || !sameAnchor(value.nextAnchor, {
      nodeId: last.node.id, fields: last.fields,
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

export async function executeStyleConsumer(request, adapters = {}) {
  if (typeof adapters.typedRead !== 'function' && typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeStyleConsumer requires typedRead(operation, request, fallbackCode) or evaluate(code)');
  }
  const input = normalizedRequest(request);
  const fallbackCode = styleConsumerCode(input);
  const typedRequest = { style: input.style, type: input.type, limit: input.limit, after: input.after };
  const serialized = typeof adapters.typedRead === 'function'
    ? await adapters.typedRead(STYLE_CONSUMERS_TYPED_READ, typedRequest, fallbackCode)
    : await adapters.evaluate(fallbackCode);
  if (typeof serialized !== 'string'
    || serialized.length > MAX_STYLE_CONSUMER_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Consumer returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Style Consumer returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Style Consumer returned an invalid bounded result.');
  }
  const next = payload.nextAnchor
    ? encodeStyleConsumerCursor(input.style, input.type, payload.nextAnchor)
    : null;
  const {
    schemaVersion, query: _query, requestedType: _requestedType,
    cursorAnchor: _cursorAnchor, nextAnchor: _nextAnchor, ...facts
  } = payload;
  const publicFacts = { ...facts, next };
  const result = { schemaVersion, ...publicFacts };
  const stdout = safePrettyJson(publicFacts);
  if (stdout.length > MAX_STYLE_CONSUMER_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Consumer returned an invalid bounded result.');
  }
  return { stdout, stderr: '', result };
}

export function styleConsumerPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Style Consumer routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === STYLE_CONSUMER_APPLICATION_ID
    && plan.execution.pluginDispatch === 'typed-read'
    ? 'command-application' : 'not-style-consumer';
}

export async function executeStyleConsumerPlan(plan, adapters = {}) {
  if (styleConsumerPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Style Consumer Command Application.`);
  }
  return executeStyleConsumer(parseStyleConsumerRequest(plan.argv), adapters);
}
