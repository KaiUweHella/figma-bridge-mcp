// Plan-bound Command Application for hierarchy-verified Node deletion.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_DELETE_TARGETS,
  nodeDeleteArgvFromRequest,
  nodeDeletePlanningArgvFromRequest,
  parseNodeDeleteRequest,
} from './node-delete-request.js';
import { MAX_NODE_REFERENCE_CODE_UNITS, NODE_REFERENCE_PATTERN } from './node-reference.js';

export {
  nodeDeleteArgvFromRequest,
  nodeDeletePlanningArgvFromRequest,
} from './node-delete-request.js';

const NODE_DELETE_APPLICATION_ID = 'node.delete';
export const MAX_NODE_DELETE_ANCESTOR_DEPTH = 512;

function normalizedRequest(request) {
  return parseNodeDeleteRequest(nodeDeleteArgvFromRequest(request));
}

export function nodeDeleteRequestFromArgv(args) {
  return parseNodeDeleteRequest(args);
}

export function nodeDeleteCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const ids = ${JSON.stringify(input.nodeIds)};
    const cleanId = (value) => typeof value === 'string' ? value.slice(0, ${MAX_NODE_REFERENCE_CODE_UNITS}) : '';
    const childIds = (parent) => {
      try {
        return parent && Array.isArray(parent.children)
          ? parent.children.map((child) => child && child.id)
          : null;
      } catch {
        return null;
      }
    };
    const attachmentFor = (node) => {
      const seen = new Set();
      let current = node;
      let immediateParent = null;
      for (let depth = 0; depth <= ${MAX_NODE_DELETE_ANCESTOR_DEPTH}; depth++) {
        if (!current) return { attached: false, parent: immediateParent, depth: -1 };
        if (seen.has(current)) throw new Error('Node Delete ancestry contains a cycle.');
        seen.add(current);
        if (current.type === 'DOCUMENT') {
          return { attached: true, parent: immediateParent, depth };
        }
        let parent = null;
        try { parent = current.parent || null; } catch {}
        if (current === node) immediateParent = parent;
        const members = childIds(parent);
        if (!Array.isArray(members) || !members.includes(current.id)) {
          return { attached: false, parent: immediateParent, depth: -1 };
        }
        current = parent;
      }
      throw new Error('Node Delete ancestry exceeds its bounded depth.');
    };

    // Resolve and classify every target before the first write. A direct
    // handle is attached only when its observed parent still lists its id.
    const records = [];
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      const node = await figma.getNodeByIdAsync(id);
      if (!node) {
        records.push({ index, id, node: null, parent: null, parentId: null, attached: false, depth: -1 });
        continue;
      }
      const attachment = attachmentFor(node);
      const parent = attachment.parent;
      const attached = attachment.attached;
      if (attached && typeof node.remove !== 'function') {
        throw new Error('Node Delete target cannot be removed: ' + cleanId(id));
      }
      records.push({
        index,
        id,
        node,
        parent,
        parentId: parent ? cleanId(parent.id) : null,
        attached,
        depth: attachment.depth,
      });
    }

    const targets = records.map((record) => ({
      id: cleanId(record.id),
      status: record.node ? 'already-detached' : 'not-found',
      parentId: record.parentId,
    }));
    let removed = 0;
    const attached = records.filter((record) => record.attached)
      .sort((left, right) => right.depth - left.depth || left.index - right.index);
    for (const record of attached) {
      try {
        record.node.remove();
      } catch {
        throw new Error('Node Delete failed after ' + removed
          + ' confirmed removal(s); target may remain: ' + cleanId(record.id));
      }
      const currentMembers = childIds(record.parent);
      if (!Array.isArray(currentMembers)) {
        throw new Error('Node Delete could not verify the target after ' + removed
          + ' confirmed removal(s); target outcome is unknown: ' + cleanId(record.id));
      }
      if (currentMembers.includes(record.id)) {
        throw new Error('Node Delete could not verify removal after ' + removed
          + ' confirmed removal(s) because the former parent still contains the target: '
          + cleanId(record.id));
      }
      targets[record.index] = {
        id: cleanId(record.id), status: 'removed', parentId: record.parentId,
      };
      removed += 1;
    }
    if (removed > 0) delete globalThis.__invCache;
    return {
      schemaVersion: 1,
      status: 'completed',
      removed,
      alreadyDetached: targets.filter((target) => target.status === 'already-detached').length,
      notFound: targets.filter((target) => target.status === 'not-found').length,
      targets,
    };
  })()`;
}

function validTarget(value, expectedId) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'id,parentId,status'
    && value.id === expectedId
    && value.id.length <= MAX_NODE_REFERENCE_CODE_UNITS
    && NODE_REFERENCE_PATTERN.test(value.id)
    && ['removed', 'already-detached', 'not-found'].includes(value.status)
    && (value.parentId === null || (typeof value.parentId === 'string'
      && value.parentId.length <= MAX_NODE_REFERENCE_CODE_UNITS
      && NODE_REFERENCE_PATTERN.test(value.parentId)))
    && (value.status !== 'not-found' || value.parentId === null);
}

export function validateNodeDeleteResult(value, expected = {}) {
  const expectedIds = expected.nodeIds || [];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'alreadyDetached,notFound,removed,schemaVersion,status,targets'
    || value.schemaVersion !== 1 || value.status !== 'completed'
    || !Array.isArray(value.targets) || value.targets.length !== expectedIds.length
    || value.targets.length > MAX_NODE_DELETE_TARGETS
    || !Number.isSafeInteger(value.removed) || value.removed < 0
    || !Number.isSafeInteger(value.alreadyDetached) || value.alreadyDetached < 0
    || !Number.isSafeInteger(value.notFound) || value.notFound < 0
    || value.removed + value.alreadyDetached + value.notFound !== value.targets.length
    || value.targets.some((target, index) => !validTarget(target, expectedIds[index]))
    || value.removed !== value.targets.filter((target) => target.status === 'removed').length
    || value.alreadyDetached !== value.targets.filter((target) => target.status === 'already-detached').length
    || value.notFound !== value.targets.filter((target) => target.status === 'not-found').length) {
    throw new Error('Node Delete returned an invalid bounded result.');
  }
  return value;
}

export function formatNodeDeleteResult(result) {
  const value = validateNodeDeleteResult(result, { nodeIds: result?.targets?.map((target) => target.id) || [] });
  const lines = [
    `Removed ${value.removed} node(s); ${value.alreadyDetached} already detached; ${value.notFound} not found.`,
  ];
  for (const target of value.targets) {
    const parent = target.parentId ? ` (observed parent ${target.parentId})` : '';
    lines.push(`  ${target.id}: ${target.status}${parent}`);
  }
  return lines.join('\n');
}

export async function executeNodeDelete(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Node Delete command requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const value = await adapters.evaluate(nodeDeleteCode(input));
  try {
    return validateNodeDeleteResult(value, input);
  } catch (cause) {
    const error = new Error('Node Delete returned an invalid bounded result.', { cause });
    error.kind = 'plugin-result';
    error.phase = 'plugin-response';
    error.outcome = 'unknown-after-dispatch';
    throw error;
  }
}

export function nodeDeletePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Delete routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === NODE_DELETE_APPLICATION_ID
    ? 'command-application'
    : 'not-node-delete';
}

export async function executeNodeDeletePlan(plan, adapters = {}) {
  if (nodeDeletePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Delete.`);
  }
  return executeNodeDelete(nodeDeleteRequestFromArgv(plan.argv), adapters);
}
