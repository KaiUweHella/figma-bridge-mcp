// Bounded Dev Resource inspection behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  devResourceReadArgvFromRequest,
  devResourceReadPlanningArgvFromRequest,
  parseDevResourceReadRequest,
} from './dev-resource-read-request.js';

export {
  devResourceReadArgvFromRequest,
  devResourceReadPlanningArgvFromRequest,
} from './dev-resource-read-request.js';

const APPLICATION_ID = 'dev.list';
export const MAX_DEV_RESOURCE_READ_ITEMS = 4_096;
export const MAX_DEV_RESOURCE_READ_RESULT_CODE_UNITS = 2_000_000;
export const MAX_DEV_RESOURCE_NAME_CODE_UNITS = 1_024;
export const MAX_DEV_RESOURCE_URL_CODE_UNITS = 8_192;
const MAX_NODE_NAME_CODE_UNITS = 1_024;
const MAX_NODE_TYPE_CODE_UNITS = 64;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;
const normalized = (request) => parseDevResourceReadRequest(devResourceReadArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function devResourceReadCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const boundedId = (value, label) => {
      if (typeof value !== 'string' || value.length === 0
        || value.length > ${MAX_NODE_REFERENCE_CODE_UNITS}) {
        throw new Error('Dev Resource Read returned an invalid ' + label + '.');
      }
      return clean(value, ${MAX_NODE_REFERENCE_CODE_UNITS});
    };
    const target = request.nodeId
      ? await figma.getNodeByIdAsync(request.nodeId)
      : figma.currentPage.selection[0];
    if (!target) throw new Error(request.nodeId
      ? 'Dev Resource Read target was not found in the targeted Figma document.'
      : 'Dev Resource Read requires one selected node when nodeId is omitted.');
    if (typeof target.getDevResourcesAsync !== 'function') {
      throw new Error('Target node does not support dev resources.');
    }
    const values = await target.getDevResourcesAsync();
    if (!Array.isArray(values) || values.length > ${MAX_DEV_RESOURCE_READ_ITEMS}) {
      throw new Error('Dev Resource Read inventory exceeded its bounded item limit.');
    }
    const resources = values.map((value) => {
      if (!value || typeof value.name !== 'string' || value.name.length > ${MAX_DEV_RESOURCE_NAME_CODE_UNITS}
        || typeof value.url !== 'string' || value.url.length === 0
        || value.url.length > ${MAX_DEV_RESOURCE_URL_CODE_UNITS}) {
        throw new Error('Dev Resource Read returned invalid resource facts.');
      }
      return {
        name: clean(value.name, ${MAX_DEV_RESOURCE_NAME_CODE_UNITS}),
        url: clean(value.url, ${MAX_DEV_RESOURCE_URL_CODE_UNITS}),
        nodeId: boundedId(value.nodeId, 'resource node id'),
        inheritedNodeId: value.inheritedNodeId === undefined
          ? null
          : boundedId(value.inheritedNodeId, 'inherited node id'),
      };
    });
    const result = {
      schemaVersion: 1,
      source: request.nodeId ? 'node' : 'selection',
      node: {
        id: boundedId(target.id, 'target node id'),
        name: clean(String(target.name || ''), ${MAX_NODE_NAME_CODE_UNITS}),
        type: clean(String(target.type || ''), ${MAX_NODE_TYPE_CODE_UNITS}),
      },
      resources,
    };
    const serialized = JSON.stringify(result);
    if (serialized.length > ${MAX_DEV_RESOURCE_READ_RESULT_CODE_UNITS}) {
      throw new Error('Dev Resource Read result exceeded its bounded response limit.');
    }
    return serialized;
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function validNodeId(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}

function validPayload(value, input) {
  return exact(value, ['schemaVersion', 'source', 'node', 'resources'])
    && value.schemaVersion === 1
    && value.source === (input.nodeId ? 'node' : 'selection')
    && exact(value.node, ['id', 'name', 'type'])
    && validNodeId(value.node.id)
    && (!input.nodeId || value.node.id === input.nodeId)
    && text(value.node.name, MAX_NODE_NAME_CODE_UNITS)
    && text(value.node.type, MAX_NODE_TYPE_CODE_UNITS, false)
    && Array.isArray(value.resources)
    && value.resources.length <= MAX_DEV_RESOURCE_READ_ITEMS
    && value.resources.every((resource) => exact(
      resource, ['name', 'url', 'nodeId', 'inheritedNodeId'],
    )
      && text(resource.name, MAX_DEV_RESOURCE_NAME_CODE_UNITS)
      && text(resource.url, MAX_DEV_RESOURCE_URL_CODE_UNITS, false)
      && validNodeId(resource.nodeId)
      && (resource.inheritedNodeId === null || validNodeId(resource.inheritedNodeId)));
}

function safeText(value) {
  return String(value).replace(UNSAFE_TEXT_CONTROLS, ' ');
}

export function formatDevResourceReadResult(payload) {
  const lines = [`${safeText(payload.node.name)} (${payload.node.id})`];
  if (payload.resources.length === 0) {
    lines.push('  (no dev resources)');
    return lines.join('\n');
  }
  payload.resources.forEach((resource, index) => {
    lines.push(`  ${index + 1}. ${safeText(resource.name || '(unnamed)')}`);
    lines.push(`     ${safeText(resource.url)}`);
  });
  return lines.join('\n');
}

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution',
    phase: 'plugin-response',
    outcome: 'unknown-after-dispatch',
    dispatchState: 'failed',
  });
  return error;
}

export async function executeDevResourceRead(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Dev Resource Read requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(devResourceReadCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_DEV_RESOURCE_READ_RESULT_CODE_UNITS) {
    throw invalid('Dev Resource Read returned an invalid bounded result.');
  }
  let result;
  try {
    result = JSON.parse(serialized);
  } catch {
    throw invalid('Dev Resource Read returned invalid JSON.');
  }
  if (!validPayload(result, input)) {
    throw invalid('Dev Resource Read returned an invalid bounded result.');
  }
  return {
    stdout: formatDevResourceReadResult(result),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    result,
  };
}

export function devResourceReadPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Dev Resource Read routing requires a Command Plan.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-dev-resource-read';
}

export function executeDevResourceReadPlan(plan, adapters = {}) {
  if (devResourceReadPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Dev Resource Read.');
  }
  return executeDevResourceRead(parseDevResourceReadRequest(plan.argv), adapters);
}
