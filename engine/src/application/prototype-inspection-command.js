// Exact bounded Prototype Inspection Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parsePrototypeInspectionRequest,
  prototypeInspectionArgvFromRequest,
  prototypeInspectionPlanningArgvFromRequest,
} from './prototype-inspection-request.js';

export {
  prototypeInspectionArgvFromRequest,
  prototypeInspectionPlanningArgvFromRequest,
} from './prototype-inspection-request.js';

const PROTOTYPE_INSPECTION_APPLICATION_ID = 'prototype.inspect';
// Returning the canonical JSON string keeps the outer Plugin protocol below
// 5 MB even when JSON escaping expands every retained code unit.
export const MAX_PROTOTYPE_INSPECTION_SERIALIZED_CODE_UNITS = 500_000;
export const MAX_PROTOTYPE_INSPECTION_DEPTH = 32;
export const MAX_PROTOTYPE_INSPECTION_CONTAINER_ENTRIES = 1024;
export const MAX_PROTOTYPE_INSPECTION_VALUES = 50_000;
export const MAX_PROTOTYPE_INSPECTION_STRING_CODE_UNITS = 65_536;
const MAX_PROTOTYPE_INSPECTION_KEY_CODE_UNITS = 128;

function normalizedRequest(request) {
  return parsePrototypeInspectionRequest(prototypeInspectionArgvFromRequest(request));
}

export function prototypeInspectionCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const node = await figma.getNodeByIdAsync(${JSON.stringify(input.nodeId)});
    if (!node) throw new Error('Node not found in the targeted Figma document: ${input.nodeId}');
    if (typeof node.setReactionsAsync !== 'function') {
      throw new Error(node.type + ' does not support prototype reactions');
    }
    const reactions = node.reactions || [];
    if (!Array.isArray(reactions)) throw new Error('Prototype Inspection received invalid reactions.');
    for (const reaction of reactions) {
      if (!reaction || typeof reaction !== 'object'
        || !Object.prototype.hasOwnProperty.call(reaction, 'trigger')
        || (reaction.actions !== undefined && !Array.isArray(reaction.actions))) {
        throw new Error('Prototype Inspection received an invalid reaction.');
      }
    }

    let values = 0;
    const seen = new Set();
    const verify = (value, depth = 0) => {
      values++;
      if (values > ${MAX_PROTOTYPE_INSPECTION_VALUES}) {
        throw new Error('Prototype Inspection value limit exceeded.');
      }
      if (depth > ${MAX_PROTOTYPE_INSPECTION_DEPTH}) {
        throw new Error('Prototype Inspection depth limit exceeded.');
      }
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Prototype Inspection contains a non-finite number.');
        return;
      }
      if (typeof value === 'string') {
        if (value.length > ${MAX_PROTOTYPE_INSPECTION_STRING_CODE_UNITS}) {
          throw new Error('Prototype Inspection string limit exceeded.');
        }
        return;
      }
      if (typeof value !== 'object') {
        throw new Error('Prototype Inspection contains a non-JSON value.');
      }
      if (seen.has(value)) throw new Error('Prototype Inspection contains a cycle.');
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.length > ${MAX_PROTOTYPE_INSPECTION_CONTAINER_ENTRIES}) {
          throw new Error('Prototype Inspection array limit exceeded.');
        }
        for (const item of value) verify(item, depth + 1);
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error('Prototype Inspection contains a non-plain object.');
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new Error('Prototype Inspection contains symbol properties.');
        }
        const keys = Object.keys(value);
        if (keys.length > ${MAX_PROTOTYPE_INSPECTION_CONTAINER_ENTRIES}) {
          throw new Error('Prototype Inspection object limit exceeded.');
        }
        for (const key of keys) {
          if (key.length > ${MAX_PROTOTYPE_INSPECTION_KEY_CODE_UNITS}) {
            throw new Error('Prototype Inspection key limit exceeded.');
          }
          verify(value[key], depth + 1);
        }
      }
      seen.delete(value);
    };

    const payload = {
      schemaVersion: 1,
      id: node.id,
      name: node.name,
      type: node.type,
      reactions,
    };
    verify(payload);
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_PROTOTYPE_INSPECTION_SERIALIZED_CODE_UNITS}) {
      throw new Error('Prototype Inspection serialized-size limit exceeded.');
    }
    return serialized;
  })()`;
}

function boundedJsonValue(value, depth, state) {
  state.values++;
  if (state.values > MAX_PROTOTYPE_INSPECTION_VALUES
    || depth > MAX_PROTOTYPE_INSPECTION_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    return value.length <= MAX_PROTOTYPE_INSPECTION_STRING_CODE_UNITS;
  }
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.length <= MAX_PROTOTYPE_INSPECTION_CONTAINER_ENTRIES
      && value.every((item) => boundedJsonValue(item, depth + 1, state));
  }
  const keys = Object.keys(value);
  return Object.getPrototypeOf(value) === Object.prototype
    && keys.length <= MAX_PROTOTYPE_INSPECTION_CONTAINER_ENTRIES
    && keys.every((key) => key.length <= MAX_PROTOTYPE_INSPECTION_KEY_CODE_UNITS
      && boundedJsonValue(value[key], depth + 1, state));
}

function validPayload(value, input) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'id,name,reactions,schemaVersion,type') return false;
  if (value.schemaVersion !== 1 || value.id !== input.nodeId
    || typeof value.name !== 'string' || typeof value.type !== 'string' || !value.type
    || !Array.isArray(value.reactions)) return false;
  for (const reaction of value.reactions) {
    if (!reaction || typeof reaction !== 'object' || Array.isArray(reaction)
      || !Object.hasOwn(reaction, 'trigger')
      || (reaction.actions !== undefined && !Array.isArray(reaction.actions))) return false;
  }
  return boundedJsonValue(value, 0, { values: 0 });
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executePrototypeInspection(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executePrototypeInspection requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(prototypeInspectionCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_PROTOTYPE_INSPECTION_SERIALIZED_CODE_UNITS) {
    throw new Error('Prototype Inspection returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error('Prototype Inspection returned an invalid bounded result.');
  }
  if (!validPayload(payload, input)) {
    throw new Error('Prototype Inspection returned an invalid bounded result.');
  }
  const { schemaVersion: _schemaVersion, ...legacyProjection } = payload;
  return {
    stdout: safePrettyJson(legacyProjection),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    result: payload,
  };
}

export function prototypeInspectionPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Prototype Inspection routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === PROTOTYPE_INSPECTION_APPLICATION_ID
    ? 'command-application'
    : 'not-prototype-inspection';
}

export async function executePrototypeInspectionPlan(plan, adapters = {}) {
  if (prototypeInspectionPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Prototype Inspection Command Application.`);
  }
  return executePrototypeInspection(parsePrototypeInspectionRequest(plan.argv), adapters);
}
