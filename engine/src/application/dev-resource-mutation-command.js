// Preflighted, readback-verified, rollback-owned Dev Resource mutations.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NODE_REFERENCE_PATTERN,
} from './node-reference.js';
import {
  DEV_RESOURCE_MUTATION_ACTIONS,
  devResourceMutationArgvFromRequest,
  devResourceMutationPlanningArgvFromRequest,
  MAX_DEV_RESOURCE_MUTATION_NAME_CODE_UNITS,
  MAX_DEV_RESOURCE_MUTATION_URL_CODE_UNITS,
  parseDevResourceMutationRequest,
} from './dev-resource-mutation-request.js';

export {
  devResourceMutationArgvFromRequest,
  devResourceMutationPlanningArgvFromRequest,
} from './dev-resource-mutation-request.js';

const APPLICATION_IDS = new Set(DEV_RESOURCE_MUTATION_ACTIONS.map((action) => `dev.${action}`));
export const MAX_DEV_RESOURCE_MUTATION_ITEMS = 4_096;
export const MAX_DEV_RESOURCE_MUTATION_RESULT_CODE_UNITS = 128_000;
const MAX_NODE_NAME_CODE_UNITS = 1_024;
const MAX_NODE_TYPE_CODE_UNITS = 64;
const MAX_FAILURE_CODE_UNITS = 1_024;
const normalized = (request) => parseDevResourceMutationRequest(
  devResourceMutationArgvFromRequest(request),
);
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

export function devResourceMutationCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_DEV_RESOURCE_MUTATION_RESULT_CODE_UNITS}) {
        throw new Error('Dev Resource Mutation result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const boundedId = (value, label) => {
      if (typeof value !== 'string' || value.length === 0
        || value.length > ${MAX_NODE_REFERENCE_CODE_UNITS}) {
        throw new Error('Dev Resource Mutation returned an invalid ' + label + '.');
      }
      return clean(value, ${MAX_NODE_REFERENCE_CODE_UNITS});
    };
    const nodeFact = (node) => ({
      id: boundedId(node.id, 'target node id'),
      name: clean(String(node.name || ''), ${MAX_NODE_NAME_CODE_UNITS}),
      type: clean(String(node.type || ''), ${MAX_NODE_TYPE_CODE_UNITS}),
    });
    const resourceFact = (value) => {
      if (!value || typeof value.name !== 'string'
        || value.name.length > ${MAX_DEV_RESOURCE_MUTATION_NAME_CODE_UNITS}
        || typeof value.url !== 'string' || value.url.length === 0
        || value.url.length > ${MAX_DEV_RESOURCE_MUTATION_URL_CODE_UNITS}) {
        throw new Error('Dev Resource Mutation returned invalid resource facts.');
      }
      return {
        name: clean(value.name, ${MAX_DEV_RESOURCE_MUTATION_NAME_CODE_UNITS}),
        url: clean(value.url, ${MAX_DEV_RESOURCE_MUTATION_URL_CODE_UNITS}),
        nodeId: boundedId(value.nodeId, 'resource node id'),
        inheritedNodeId: value.inheritedNodeId === undefined
          ? null
          : boundedId(value.inheritedNodeId, 'inherited node id'),
      };
    };
    const facts = async (node) => {
      const values = await node.getDevResourcesAsync();
      if (!Array.isArray(values) || values.length > ${MAX_DEV_RESOURCE_MUTATION_ITEMS}) {
        throw new Error('Dev Resource Mutation inventory exceeded its bounded item limit.');
      }
      const result = values.map(resourceFact);
      if (new Set(result.map((value) => value.url)).size !== result.length) {
        throw new Error('Dev Resource URLs must be unique on the target node.');
      }
      return result;
    };
    const key = (value) => JSON.stringify([
      value.url, value.name, value.nodeId, value.inheritedNodeId,
    ]);
    const sameCollection = (left, right) => {
      if (left.length !== right.length) return false;
      const leftKeys = [...left].map(key).sort();
      const rightKeys = [...right].map(key).sort();
      return leftKeys.every((value, index) => value === rightKeys[index]);
    };
    const refusal = (error) => bounded({
      schemaVersion: 1,
      status: 'refused',
      action: request.action,
      outcome: 'no-mutation',
      attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), ${MAX_FAILURE_CODE_UNITS}),
    });
    const success = (status, node, resource, values, mutationError) => bounded({
      schemaVersion: 1,
      status,
      action: request.action,
      outcome: mutationError ? 'verified-after-error' : 'verified',
      node: nodeFact(node),
      resource,
      count: values.length,
      attempted: 1,
      residue: [],
      warnings: mutationError
        ? ['The native mutation reported an error, but fresh readback proved the exact requested state.']
        : [],
    });

    let node;
    let before;
    let current = null;
    try {
      node = await figma.getNodeByIdAsync(request.nodeId);
      if (!node || typeof node.getDevResourcesAsync !== 'function') {
        throw new Error('Dev Resource Mutation requires an exact node that supports dev resources.');
      }
      if (request.action === 'edit') {
        if (typeof node.editDevResourceAsync !== 'function') {
          throw new Error('Target node does not support editing dev resources.');
        }
      } else if (typeof node.addDevResourceAsync !== 'function'
        || typeof node.deleteDevResourceAsync !== 'function') {
        throw new Error('Target node does not support reversible dev resource mutations.');
      }
      before = await facts(node);
      const lookupUrl = request.action === 'edit' ? request.currentUrl : request.url;
      current = before.find((value) => value.url === lookupUrl) || null;
      if (request.action === 'link' && current) {
        throw new Error('A dev resource with the requested URL already exists.');
      }
      if (request.action !== 'link' && !current) {
        throw new Error('The requested dev resource does not exist on the target node.');
      }
      if (current?.inheritedNodeId) {
        throw new Error('Inherited dev resources must be changed on their owning main node.');
      }
      if (request.action === 'edit' && request.newUrl !== request.currentUrl
        && before.some((value) => value.url === request.newUrl)) {
        throw new Error('A dev resource with the new URL already exists.');
      }
    } catch (error) {
      return refusal(error);
    }

    let mutationError = null;
    try {
      if (request.action === 'link') {
        await node.addDevResourceAsync(request.url, request.name || '');
      } else if (request.action === 'unlink') {
        await node.deleteDevResourceAsync(request.url);
      } else {
        await node.editDevResourceAsync(request.currentUrl, {
          url: request.newUrl,
          ...(request.name === null ? {} : { name: request.name }),
        });
      }
    } catch (error) {
      mutationError = error;
    }

    const fresh = async () => {
      const value = await figma.getNodeByIdAsync(request.nodeId);
      if (!value || typeof value.getDevResourcesAsync !== 'function') {
        throw new Error('Fresh Dev Resource verification is unavailable.');
      }
      return { node: value, values: await facts(value) };
    };
    const desired = (after) => {
      if (request.action === 'link') {
        const resource = after.find((value) => value.url === request.url) || null;
        const siblings = before.every((value) => after.some((candidate) => key(candidate) === key(value)));
        return resource && resource.inheritedNodeId === null
          && resource.nodeId === request.nodeId
          && (request.name === null || resource.name === request.name)
          && after.length === before.length + 1 && siblings ? resource : null;
      }
      if (request.action === 'unlink') {
        const expected = before.filter((value) => value.url !== request.url);
        return sameCollection(after, expected) ? current : null;
      }
      const expectedResource = {
        ...current,
        url: request.newUrl,
        ...(request.name === null ? {} : { name: request.name }),
      };
      const expected = before
        .filter((value) => value.url !== request.currentUrl)
        .concat(expectedResource);
      return sameCollection(after, expected)
        ? after.find((value) => value.url === request.newUrl) || null
        : null;
    };

    let after = null;
    try {
      after = await fresh();
      const resource = desired(after.values);
      if (resource) {
        return success(({ link: 'linked', unlink: 'unlinked', edit: 'edited' })[request.action],
          after.node, resource, after.values, mutationError);
      }
    } catch (error) {
      mutationError ||= error;
    }

    const unchanged = after && sameCollection(after.values, before);
    if (unchanged) {
      return bounded({
        schemaVersion: 1,
        status: 'failed',
        action: request.action,
        outcome: 'unchanged',
        attempted: 1,
        restored: 0,
        residue: ['dev-resource-state'],
        failure: clean(mutationError?.message || 'fresh mutation postcondition failed', ${MAX_FAILURE_CODE_UNITS}),
      });
    }

    try {
      if (request.action === 'link') {
        await node.deleteDevResourceAsync(request.url);
      } else if (request.action === 'unlink') {
        await node.addDevResourceAsync(current.url, current.name);
      } else {
        await node.editDevResourceAsync(request.newUrl, {
          url: request.currentUrl,
          name: current.name,
        });
      }
    } catch {}
    try {
      const restored = await fresh();
      if (sameCollection(restored.values, before)) {
        return bounded({
          schemaVersion: 1,
          status: 'failed',
          action: request.action,
          outcome: 'rolled-back',
          attempted: 1,
          restored: 1,
          residue: [],
          failure: clean(mutationError?.message || 'fresh mutation postcondition failed', ${MAX_FAILURE_CODE_UNITS}),
        });
      }
      return bounded({
        schemaVersion: 1,
        status: 'failed',
        action: request.action,
        outcome: 'partial-residue',
        attempted: 1,
        restored: 0,
        residue: ['dev-resource-state'],
        failure: clean(mutationError?.message || 'fresh mutation postcondition failed', ${MAX_FAILURE_CODE_UNITS}),
      });
    } catch (error) {
      return bounded({
        schemaVersion: 1,
        status: 'failed',
        action: request.action,
        outcome: 'verification-unavailable',
        attempted: 1,
        restored: 0,
        residue: [],
        failure: clean(mutationError?.message || error?.message || 'fresh verification unavailable', ${MAX_FAILURE_CODE_UNITS}),
      });
    }
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function text(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function validNodeId(value) {
  return text(value, MAX_NODE_REFERENCE_CODE_UNITS, false) && NODE_REFERENCE_PATTERN.test(value);
}

function validNode(value, input) {
  return exact(value, ['id', 'name', 'type'])
    && value.id === input.nodeId && validNodeId(value.id)
    && text(value.name, MAX_NODE_NAME_CODE_UNITS)
    && text(value.type, MAX_NODE_TYPE_CODE_UNITS, false);
}

function validResource(value) {
  return exact(value, ['name', 'url', 'nodeId', 'inheritedNodeId'])
    && text(value.name, MAX_DEV_RESOURCE_MUTATION_NAME_CODE_UNITS)
    && text(value.url, MAX_DEV_RESOURCE_MUTATION_URL_CODE_UNITS, false)
    && validNodeId(value.nodeId)
    && (value.inheritedNodeId === null || validNodeId(value.inheritedNodeId));
}

function validSuccess(value, input) {
  const expectedStatus = { link: 'linked', unlink: 'unlinked', edit: 'edited' }[input.action];
  const expectedUrl = input.action === 'edit' ? input.newUrl : input.url;
  return exact(value, [
    'schemaVersion', 'status', 'action', 'outcome', 'node', 'resource', 'count',
    'attempted', 'residue', 'warnings',
  ])
    && value.schemaVersion === 1 && value.status === expectedStatus
    && value.action === input.action
    && ['verified', 'verified-after-error'].includes(value.outcome)
    && validNode(value.node, input) && validResource(value.resource)
    && value.resource.url === expectedUrl
    && (input.action !== 'link' || input.name === null || value.resource.name === input.name)
    && (input.action !== 'edit' || input.name === null || value.resource.name === input.name)
    && Number.isInteger(value.count) && value.count >= 0
    && value.count <= MAX_DEV_RESOURCE_MUTATION_ITEMS
    && value.attempted === 1
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings)
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
}

function validRefusal(value, input) {
  return exact(value, ['schemaVersion', 'status', 'action', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.action === input.action && value.outcome === 'no-mutation'
    && value.attempted === 0 && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}

function validFailure(value, input) {
  return exact(value, [
    'schemaVersion', 'status', 'action', 'outcome', 'attempted', 'restored',
    'residue', 'failure',
  ])
    && value.schemaVersion === 1 && value.status === 'failed'
    && value.action === input.action
    && ['unchanged', 'rolled-back', 'partial-residue', 'verification-unavailable']
      .includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 1
    && value.residue.every((entry) => entry === 'dev-resource-state')
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false)
    && (value.outcome !== 'rolled-back' || value.restored === 1 && value.residue.length === 0)
    && (!['unchanged', 'partial-residue'].includes(value.outcome)
      || value.restored === 0 && value.residue.length === 1)
    && (value.outcome !== 'verification-unavailable'
      || value.restored === 0 && value.residue.length === 0);
}

function pluginResultError(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch',
  });
  return error;
}

function mutationError(message, outcome, report) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch',
    dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report,
  });
  return error;
}

function safeText(value) {
  return String(value).replace(UNSAFE_TEXT_CONTROLS, ' ');
}

export function formatDevResourceMutationResult(result) {
  if (result.action === 'link') {
    return `Linked: ${safeText(result.node.name)} (${result.node.id}) → ${safeText(result.resource.url)}\n  Total dev resources: ${result.count}`;
  }
  if (result.action === 'unlink') {
    return `Unlinked from ${safeText(result.node.name)} (${result.node.id})\n  Remaining dev resources: ${result.count}`;
  }
  return `Edited dev resource on ${safeText(result.node.name)} (${result.node.id})`;
}

export async function executeDevResourceMutation(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Dev Resource Mutation requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(devResourceMutationCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_DEV_RESOURCE_MUTATION_RESULT_CODE_UNITS) {
    throw pluginResultError('Dev Resource Mutation returned an invalid bounded result.');
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw pluginResultError('Dev Resource Mutation returned invalid JSON.');
  }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, input)) {
      throw pluginResultError('Dev Resource Mutation returned an invalid bounded result.');
    }
    throw mutationError(`Dev Resource Mutation made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw pluginResultError('Dev Resource Mutation returned an invalid bounded result.');
    }
    throw mutationError(
      `Dev Resource Mutation failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome,
      {
        version: 1,
        outcome: payload.outcome,
        attempted: 1,
        restored: payload.restored,
        residueCount: payload.outcome === 'verification-unavailable'
          ? 1 : payload.residue.length,
      },
    );
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Dev Resource Mutation returned an invalid bounded result.');
  }
  return {
    stdout: formatDevResourceMutationResult(payload),
    stderr: payload.warnings.join('\n'),
    result: payload,
  };
}

export function devResourceMutationPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Dev Resource Mutation routing requires a Command Plan.');
  }
  return plan.allowed && APPLICATION_IDS.has(plan.id)
    ? 'command-application' : 'not-dev-resource-mutation';
}

export function executeDevResourceMutationPlan(plan, adapters = {}) {
  if (devResourceMutationPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Dev Resource Mutation.');
  }
  return executeDevResourceMutation(parseDevResourceMutationRequest(plan.argv), adapters);
}
