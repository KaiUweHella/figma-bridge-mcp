// Value-returning Node Discovery Command Application.
//
// Commander and MCP are adapters at this seam. The closed request, bounded
// current-page traversal and truthful text projection live in this Module.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_DISCOVERY_RESULTS,
  nodeDiscoveryArgvFromRequest,
  nodeDiscoveryPlanningArgvFromRequest,
  parseNodeDiscoveryRequest,
} from './node-discovery-request.js';

export {
  nodeDiscoveryArgvFromRequest,
  nodeDiscoveryPlanningArgvFromRequest,
} from './node-discovery-request.js';
export { MAX_NODE_DISCOVERY_RESULTS } from './node-discovery-request.js';

const NODE_DISCOVERY_APPLICATION_ID = 'find';
export const MAX_NODE_DISCOVERY_VISITS = 100_000;
export const MAX_NODE_DISCOVERY_NAME_CODE_UNITS = 512;
const MAX_NODE_DISCOVERY_ID_CODE_UNITS = 128;
const MAX_NODE_DISCOVERY_TYPE_CODE_UNITS = 64;

function normalizedRequest(request) {
  return parseNodeDiscoveryRequest(nodeDiscoveryArgvFromRequest(request));
}

export function nodeDiscoveryCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const MAX_VISITS = ${MAX_NODE_DISCOVERY_VISITS};
    const MAX_NAME = ${MAX_NODE_DISCOVERY_NAME_CODE_UNITS};
    const query = ${JSON.stringify(input.query.toLowerCase())};
    const typeFilter = ${input.type ? JSON.stringify(input.type) : 'null'};
    const resultLimit = ${input.limit};
    const page = figma.currentPage;
    if (!page) throw new Error('Current page is unavailable in the targeted Figma document.');
    if (typeof page.loadAsync === 'function') await page.loadAsync();

    const matches = [];
    const stack = [{ node: page, entered: false, nextChild: 0 }];
    let visitedNodes = 0;
    let traversalTruncated = false;
    while (stack.length > 0 && matches.length < resultLimit) {
      if (visitedNodes >= MAX_VISITS) {
        traversalTruncated = true;
        break;
      }
      const frame = stack[stack.length - 1];
      const node = frame.node;
      if (!frame.entered) {
        frame.entered = true;
        visitedNodes++;
        /* Figma throws from getters of nodes whose identity is stale mid-scan
           (observed after reparenting into an Instance Slot); skip them. */
        let nodeName = null;
        try { nodeName = node.name; } catch (error) { nodeName = null; }
        if (typeof nodeName === 'string' && nodeName.length > 0
          && nodeName.toLowerCase().includes(query)
          && (!typeFilter || node.type === typeFilter)) {
          if (typeof node.id !== 'string' || node.id.length < 1
            || node.id.length > ${MAX_NODE_DISCOVERY_ID_CODE_UNITS}
            || typeof node.type !== 'string' || node.type.length < 1
            || node.type.length > ${MAX_NODE_DISCOVERY_TYPE_CODE_UNITS}) {
            throw new Error('Node Discovery encountered invalid node identity facts.');
          }
          const nameTruncated = nodeName.length > MAX_NAME;
          matches.push({
            id: node.id,
            type: node.type,
            name: nameTruncated ? nodeName.slice(0, MAX_NAME - 1) + '…' : nodeName,
            nameTruncated,
          });
        }
      }
      if (matches.length >= resultLimit) break;
      if (node && Array.isArray(node.children) && frame.nextChild < node.children.length) {
        const child = node.children[frame.nextChild++];
        stack.push({ node: child, entered: false, nextChild: 0 });
      } else {
        stack.pop();
      }
    }
    return {
      schemaVersion: 1,
      matches,
      visitedNodes,
      limitReached: matches.length === resultLimit,
      traversalTruncated,
    };
  })()`;
}

function boundedString(value, maxCodeUnits) {
  if (typeof value !== 'string') return null;
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�');
  return safe.length > maxCodeUnits
    ? `${safe.slice(0, Math.max(0, maxCodeUnits - 1))}…`
    : safe;
}

function validResult(value, input) {
  return value && typeof value === 'object' && value.schemaVersion === 1
    && Array.isArray(value.matches) && value.matches.length <= input.limit
    && value.matches.length <= MAX_NODE_DISCOVERY_RESULTS
    && value.matches.every((match) => match && typeof match === 'object'
      && typeof match.id === 'string' && match.id.length > 0
      && match.id.length <= MAX_NODE_DISCOVERY_ID_CODE_UNITS
      && typeof match.type === 'string' && match.type.length > 0
      && match.type.length <= MAX_NODE_DISCOVERY_TYPE_CODE_UNITS
      && typeof match.name === 'string'
      && match.name.length <= MAX_NODE_DISCOVERY_NAME_CODE_UNITS
      && typeof match.nameTruncated === 'boolean')
    && Number.isSafeInteger(value.visitedNodes) && value.visitedNodes >= 1
    && value.visitedNodes <= MAX_NODE_DISCOVERY_VISITS
    && typeof value.limitReached === 'boolean'
    && (!value.limitReached || value.matches.length === input.limit)
    && typeof value.traversalTruncated === 'boolean';
}

export function formatNodeDiscoveryResult(result, request) {
  const input = normalizedRequest(request);
  if (!validResult(result, input)) {
    throw new Error('Node Discovery returned an invalid bounded result.');
  }
  const lines = result.matches.length > 0
    ? result.matches.map((match) => `${boundedString(match.id, MAX_NODE_DISCOVERY_ID_CODE_UNITS)} `
      + `[${boundedString(match.type, MAX_NODE_DISCOVERY_TYPE_CODE_UNITS)}] `
      + boundedString(match.name, MAX_NODE_DISCOVERY_NAME_CODE_UNITS))
    : [`No nodes found matching "${boundedString(input.query, 160)}"`];
  if (result.limitReached) {
    lines.push(`(result limit reached at ${input.limit} matches — re-run with --limit <n> up to ${MAX_NODE_DISCOVERY_RESULTS})`);
  }
  if (result.traversalTruncated) {
    lines.push(`(search truncated after ${MAX_NODE_DISCOVERY_VISITS} visited nodes — narrow the current-page query)`);
  }
  return lines.join('\n');
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeNodeDiscovery(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeNodeDiscovery requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const value = await adapters.evaluate(nodeDiscoveryCode(input));
  return {
    stdout: formatNodeDiscoveryResult(value, input),
    stderr: '',
    result: value,
  };
}

export function nodeDiscoveryPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Discovery routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === NODE_DISCOVERY_APPLICATION_ID
    ? 'command-application'
    : 'not-node-discovery';
}

export async function executeNodeDiscoveryPlan(plan, adapters = {}) {
  if (nodeDiscoveryPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Node Discovery Command Application.`);
  }
  return executeNodeDiscovery(parseNodeDiscoveryRequest(plan.argv), adapters);
}
