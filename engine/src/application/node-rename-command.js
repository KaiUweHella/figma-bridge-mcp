// Plan-bound, readback-verified and rollback-owned `node rename` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_RENAME_NAME_CODE_UNITS,
  MAX_NODE_RENAME_NODE_ID_CODE_UNITS,
  nodeRenameArgvFromRequest,
  nodeRenamePlanningArgvFromRequest,
  parseNodeRenameRequest,
} from './node-rename-request.js';

export {
  nodeRenameArgvFromRequest,
  nodeRenamePlanningArgvFromRequest,
} from './node-rename-request.js';

const APPLICATION_ID = 'node.rename';
export const MAX_NODE_RENAME_RESULT_CODE_UNITS = 16_384;

function normalizedRequest(request) {
  return parseNodeRenameRequest(nodeRenameArgvFromRequest(request));
}

function jsValue(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function nodeRenameCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const nodeId = ${jsValue(input.nodeId)};
    const requestedName = ${jsValue(input.name)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_NODE_RENAME_RESULT_CODE_UNITS}) {
        throw new Error('Node Rename result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const identity = (node) => ({
      id: clean(node.id, ${MAX_NODE_RENAME_NODE_ID_CODE_UNITS}),
      type: clean(node.type, 64),
    });
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let node;
    let previousName;
    try {
      node = await figma.getNodeByIdAsync(nodeId);
      if (!node || typeof node.id !== 'string' || typeof node.type !== 'string'
        || typeof node.name !== 'string') {
        throw new Error('Node Rename requires an exact named node.');
      }
      previousName = node.name;
    } catch (error) {
      return refusal(error);
    }
    if (previousName === requestedName) {
      return bounded({
        schemaVersion: 1, status: 'renamed', node: identity(node),
        oldName: requestedName,
        name: requestedName, attempted: 0, residue: [],
      });
    }

    let failure = 'Node Rename could not freshly verify the requested name.';
    try {
      try { node.name = requestedName; }
      catch (error) {
        failure = clean(error && error.message ? error.message : String(error), 1024);
      }
      const verified = await figma.getNodeByIdAsync(nodeId);
      if (verified && verified.name === requestedName) {
        delete globalThis.__invCache;
        return bounded({
          schemaVersion: 1, status: 'renamed', node: identity(verified),
          oldName: clean(previousName, ${MAX_NODE_RENAME_NAME_CODE_UNITS}),
          name: requestedName, attempted: 1, residue: [],
        });
      }
    } catch (error) {
      failure = clean(error && error.message ? error.message : String(error), 1024);
    }

    try {
      const rollbackTarget = await figma.getNodeByIdAsync(nodeId);
      if (!rollbackTarget) throw new Error('Node Rename rollback target is unavailable.');
      try { rollbackTarget.name = previousName; } catch {}
      const restored = await figma.getNodeByIdAsync(nodeId);
      if (!restored) throw new Error('Node Rename rollback verification is unavailable.');
      const restoredExactly = restored.name === previousName;
      if (restoredExactly) delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1, status: 'failed',
        outcome: restoredExactly ? 'rolled-back' : 'partial-residue',
        attempted: 1, restored: restoredExactly ? 1 : 0,
        node: identity(restored),
        currentName: clean(restored.name, ${MAX_NODE_RENAME_NAME_CODE_UNITS}),
        failure, residue: restoredExactly ? [] : [{
          id: clean(restored.id, ${MAX_NODE_RENAME_NODE_ID_CODE_UNITS}),
          name: clean(restored.name, ${MAX_NODE_RENAME_NAME_CODE_UNITS}),
        }],
      });
    } catch {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        attempted: 1, restored: 0, node: identity(node), currentName: '',
        failure, residue: [],
      });
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validString(value, maximum, empty = true) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
}

function validNode(value, input) {
  return exactKeys(value, ['id', 'type'])
    && value.id === input.nodeId && validString(value.id, MAX_NODE_RENAME_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id) && validString(value.type, 64, false);
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'node', 'oldName', 'name', 'attempted', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'renamed'
    && validNode(value.node, input)
    && validString(value.oldName, MAX_NODE_RENAME_NAME_CODE_UNITS)
    && value.name === input.name && [0, 1].includes(value.attempted)
    && (value.attempted !== 0 || value.oldName === input.name)
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && validString(value.failure, 1_024, false);
}

function validFailure(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'node',
    'currentName', 'failure', 'residue',
  ]) && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored)
    && validNode(value.node, input)
    && validString(value.currentName, MAX_NODE_RENAME_NAME_CODE_UNITS)
    && validString(value.failure, 1_024, false)
    && Array.isArray(value.residue) && value.residue.length <= 1
    && (value.outcome === 'rolled-back'
      ? value.restored === 1 && value.residue.length === 0
      : value.restored === 0)
    && (value.outcome === 'partial-residue'
      ? value.residue.length === 1 && exactKeys(value.residue[0], ['id', 'name'])
        && value.residue[0].id === input.nodeId
        && validString(value.residue[0].name, MAX_NODE_RENAME_NAME_CODE_UNITS)
      : value.residue.length === 0);
}

function mutationError(message, outcome, report) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string,dispatchState?:string,mutationOutcome?:unknown,mutationReport?:unknown}} */
  const error = new Error(message);
  error.kind = 'execution';
  error.phase = 'plugin-execution';
  error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed';
  error.mutationOutcome = outcome;
  error.mutationReport = report;
  return error;
}

function pluginResultError(message) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */
  const error = new Error(message);
  error.kind = 'plugin-result';
  error.phase = 'plugin-response';
  error.outcome = 'unknown-after-dispatch';
  return error;
}

export function formatNodeRenameResult(result) {
  const safeJson = (value) => JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return result.attempted === 0
    ? `Kept ${safeJson(result.name)} (${result.node.id}); name already matched`
    : `Renamed ${safeJson(result.oldName)} → ${safeJson(result.name)} (${result.node.id})`;
}

export async function executeNodeRename(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Node Rename requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(nodeRenameCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_RENAME_RESULT_CODE_UNITS) {
    throw pluginResultError('Node Rename returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw pluginResultError('Node Rename returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Node Rename returned an invalid bounded result.');
    throw mutationError(`Node Rename made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) {
      throw pluginResultError('Node Rename returned an invalid bounded result.');
    }
    const message = payload.outcome === 'rolled-back'
      ? `Node Rename failed and restored the previous name: ${payload.failure}`
      : `Node Rename failed; the node name could not be fully restored: ${payload.failure}`;
    throw mutationError(message, payload.outcome, {
      version: 1, outcome: payload.outcome, attempted: 1,
      restored: payload.restored, residueCount: payload.residue.length,
    });
  }
  if (!validSuccess(payload, input)) {
    throw pluginResultError('Node Rename returned an invalid bounded result.');
  }
  return { stdout: formatNodeRenameResult(payload), stderr: '', result: payload };
}

export function nodeRenamePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Rename routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? 'command-application' : 'not-node-rename';
}

export async function executeNodeRenamePlan(plan, adapters = {}) {
  if (nodeRenamePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Rename.`);
  }
  return executeNodeRename(parseNodeRenameRequest(plan.argv), adapters);
}
