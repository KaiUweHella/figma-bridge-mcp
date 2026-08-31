// Plan-bound, readback-verified and rollback-owned `node resize` mutation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_NODE_RESIZE_NODE_ID_CODE_UNITS,
  nodeResizeArgvFromRequest,
  nodeResizePlanningArgvFromRequest,
  parseNodeResizeRequest,
} from './node-resize-request.js';

export { nodeResizeArgvFromRequest, nodeResizePlanningArgvFromRequest } from './node-resize-request.js';

const APPLICATION_ID = 'node.resize';
export const MAX_NODE_RESIZE_RESULT_CODE_UNITS = 16_384;
export const MAX_NODE_RESIZE_NAME_CODE_UNITS = 1_024;
export const NODE_RESIZE_VERIFY_EPSILON = 0.01;

function normalizedRequest(request) {
  return parseNodeResizeRequest(nodeResizeArgvFromRequest(request));
}

export function nodeResizeCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const nodeId = ${JSON.stringify(input.nodeId)};
    const requested = ${JSON.stringify({ width: input.width, height: input.height })};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_NODE_RESIZE_RESULT_CODE_UNITS}) {
        throw new Error('Node Resize result exceeded the bounded response limit.');
      }
      return serialized;
    };
    const facts = (node) => ({
      width: node.width, height: node.height,
      sizingHorizontal: node.layoutSizingHorizontal,
      sizingVertical: node.layoutSizingVertical,
    });
    const validFacts = (value) => value && Number.isFinite(value.width)
      && Number.isFinite(value.height) && value.width >= 0 && value.height >= 0
      && ['FIXED', 'HUG', 'FILL'].includes(value.sizingHorizontal)
      && ['FIXED', 'HUG', 'FILL'].includes(value.sizingVertical);
    const close = (left, right) => Math.abs(left - right) <= ${NODE_RESIZE_VERIFY_EPSILON};
    const axisMatches = (intent, axis, before, after) => {
      const sizing = axis === 'width' ? 'sizingHorizontal' : 'sizingVertical';
      if (intent === 'fill' || intent === 'hug') return after[sizing] === intent.toUpperCase();
      if (intent === 'keep') return after[sizing] === before[sizing] && close(after[axis], before[axis]);
      return after[sizing] === 'FIXED' && close(after[axis], intent);
    };
    const refusal = (error) => bounded({
      schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: clean(error && error.message ? error.message : String(error), 1024),
    });

    let node;
    let before;
    try {
      node = await figma.getNodeByIdAsync(nodeId);
      if (!node || typeof node.resize !== 'function' || typeof node.id !== 'string'
        || typeof node.type !== 'string' || typeof node.name !== 'string') {
        throw new Error('Node Resize requires an exact resizable canvas node.');
      }
      before = facts(node);
      if (!validFacts(before)) throw new Error('Node Resize encountered invalid preflight geometry.');
      if (typeof requested.width === 'number' && requested.width < 0.01) {
        throw new Error('Node Resize width must be at least 0.01.');
      }
      if (typeof requested.height === 'number'
        && requested.height < (node.type === 'LINE' ? 0 : 0.01)) {
        throw new Error('Node Resize height is below the native minimum.');
      }
      if ((requested.width === 'hug' || requested.height === 'hug')
        && node.type !== 'TEXT' && (!('layoutMode' in node) || node.layoutMode === 'NONE')) {
        throw new Error('Node Resize HUG requires a Text node or Auto Layout container.');
      }
      if ((requested.width === 'fill' || requested.height === 'fill')
        && (!node.parent || !('layoutMode' in node.parent) || node.parent.layoutMode === 'NONE')) {
        throw new Error('Node Resize FILL requires an Auto Layout parent.');
      }
    } catch (error) { return refusal(error); }

    if (requested.width === 'keep' && requested.height === 'keep') {
      return bounded({
        schemaVersion: 1, status: 'resized',
        node: { id: clean(node.id, ${MAX_NODE_RESIZE_NODE_ID_CODE_UNITS}), name: clean(node.name, ${MAX_NODE_RESIZE_NAME_CODE_UNITS}), type: clean(node.type, 64) },
        requested, before, actual: before, attempted: 0, residue: [],
      });
    }

    let failure = 'Node Resize could not freshly verify the complete requested state.';
    try {
      const apply = (intent, axis) => {
        if (intent === 'keep') return;
        const sizing = axis === 'width' ? 'layoutSizingHorizontal' : 'layoutSizingVertical';
        if (intent === 'fill' || intent === 'hug') { node[sizing] = intent.toUpperCase(); return; }
        node[sizing] = 'FIXED';
        if (axis === 'width') node.resize(intent, node.height);
        else node.resize(node.width, intent);
      };
      try { apply(requested.width, 'width'); apply(requested.height, 'height'); }
      catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }
      const verified = await figma.getNodeByIdAsync(nodeId);
      const actual = verified ? facts(verified) : null;
      if (verified && validFacts(actual)
        && axisMatches(requested.width, 'width', before, actual)
        && axisMatches(requested.height, 'height', before, actual)) {
        delete globalThis.__invCache;
        return bounded({
          schemaVersion: 1, status: 'resized',
          node: { id: clean(verified.id, ${MAX_NODE_RESIZE_NODE_ID_CODE_UNITS}), name: clean(verified.name, ${MAX_NODE_RESIZE_NAME_CODE_UNITS}), type: clean(verified.type, 64) },
          requested, before, actual, attempted: 1, residue: [],
        });
      }
    } catch (error) { failure = clean(error && error.message ? error.message : String(error), 1024); }

    try {
      const rollback = await figma.getNodeByIdAsync(nodeId);
      if (!rollback) throw new Error('Node Resize rollback target is unavailable.');
      try { rollback.layoutSizingHorizontal = 'FIXED'; } catch {}
      try { rollback.layoutSizingVertical = 'FIXED'; } catch {}
      try { rollback.resize(before.width, before.height); } catch {}
      try { rollback.layoutSizingHorizontal = before.sizingHorizontal; } catch {}
      try { rollback.layoutSizingVertical = before.sizingVertical; } catch {}
      const restoredNode = await figma.getNodeByIdAsync(nodeId);
      if (!restoredNode) throw new Error('Node Resize rollback verification is unavailable.');
      const actual = facts(restoredNode);
      const restored = validFacts(actual)
        && actual.sizingHorizontal === before.sizingHorizontal
        && actual.sizingVertical === before.sizingVertical
        && close(actual.width, before.width) && close(actual.height, before.height);
      if (restored) delete globalThis.__invCache;
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: restored ? 'rolled-back' : 'partial-residue',
        attempted: 1, restored: restored ? 1 : 0,
        node: { id: clean(restoredNode.id, ${MAX_NODE_RESIZE_NODE_ID_CODE_UNITS}), name: clean(restoredNode.name, ${MAX_NODE_RESIZE_NAME_CODE_UNITS}), type: clean(restoredNode.type, 64) },
        requested, before, actual, failure, residue: restored ? [] : [{
          id: clean(restoredNode.id, ${MAX_NODE_RESIZE_NODE_ID_CODE_UNITS}), ...actual,
        }],
      });
    } catch {
      return bounded({
        schemaVersion: 1, status: 'failed', outcome: 'verification-unavailable',
        attempted: 1, restored: 0,
        node: { id: clean(node.id, ${MAX_NODE_RESIZE_NODE_ID_CODE_UNITS}), name: clean(node.name, ${MAX_NODE_RESIZE_NAME_CODE_UNITS}), type: clean(node.type, 64) },
        requested, before, actual: null, failure, residue: [],
      });
    }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function validString(value, max, empty = true) {
  return typeof value === 'string' && value.length <= max && (empty || value.length > 0);
}
function validNode(value, input) {
  return exactKeys(value, ['id', 'name', 'type']) && value.id === input.nodeId
    && validString(value.id, MAX_NODE_RESIZE_NODE_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.id)
    && validString(value.name, MAX_NODE_RESIZE_NAME_CODE_UNITS)
    && validString(value.type, 64, false);
}
function validDimension(value) {
  return ['keep', 'fill', 'hug'].includes(value)
    || (Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NODE_COORDINATE);
}
function validRequested(value, input) {
  return exactKeys(value, ['width', 'height']) && value.width === input.width
    && value.height === input.height && validDimension(value.width) && validDimension(value.height);
}
function validFacts(value) {
  return exactKeys(value, ['width', 'height', 'sizingHorizontal', 'sizingVertical'])
    && Number.isFinite(value.width) && value.width >= 0 && value.width <= MAX_ABSOLUTE_NODE_COORDINATE
    && Number.isFinite(value.height) && value.height >= 0 && value.height <= MAX_ABSOLUTE_NODE_COORDINATE
    && ['FIXED', 'HUG', 'FILL'].includes(value.sizingHorizontal)
    && ['FIXED', 'HUG', 'FILL'].includes(value.sizingVertical);
}
function close(left, right) {
  return Math.abs(left - right) <= NODE_RESIZE_VERIFY_EPSILON;
}
function axisMatches(intent, axis, before, actual) {
  const sizing = axis === 'width' ? 'sizingHorizontal' : 'sizingVertical';
  if (intent === 'fill' || intent === 'hug') return actual[sizing] === intent.toUpperCase();
  if (intent === 'keep') return actual[sizing] === before[sizing] && close(actual[axis], before[axis]);
  return actual[sizing] === 'FIXED' && close(actual[axis], intent);
}
function sameFacts(left, right) {
  return left.sizingHorizontal === right.sizingHorizontal
    && left.sizingVertical === right.sizingVertical
    && close(left.width, right.width) && close(left.height, right.height);
}
function validResidue(value, input) {
  return exactKeys(value, ['id', 'width', 'height', 'sizingHorizontal', 'sizingVertical'])
    && value.id === input.nodeId
    && validFacts({
      width: value.width, height: value.height,
      sizingHorizontal: value.sizingHorizontal, sizingVertical: value.sizingVertical,
    });
}
function validSuccess(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'node', 'requested', 'before', 'actual', 'attempted', 'residue'])
    && value.schemaVersion === 1 && value.status === 'resized' && validNode(value.node, input)
    && validRequested(value.requested, input) && validFacts(value.before) && validFacts(value.actual)
    && [0, 1].includes(value.attempted)
    && (value.attempted !== 0 || (input.width === 'keep' && input.height === 'keep'))
    && axisMatches(input.width, 'width', value.before, value.actual)
    && axisMatches(input.height, 'height', value.before, value.actual)
    && Array.isArray(value.residue) && value.residue.length === 0;
}
function validRefusal(value) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation'
    && value.attempted === 0 && validString(value.failure, 1_024, false);
}
function validFailure(value, input) {
  return exactKeys(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'node', 'requested', 'before', 'actual', 'failure', 'residue'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0, 1].includes(value.restored) && validNode(value.node, input)
    && validRequested(value.requested, input) && validFacts(value.before)
    && (value.actual === null || validFacts(value.actual)) && validString(value.failure, 1_024, false)
    && Array.isArray(value.residue) && value.residue.length <= 1
    && (value.outcome === 'rolled-back'
      ? value.restored === 1 && value.residue.length === 0 && validFacts(value.actual)
        && sameFacts(value.before, value.actual)
      : value.restored === 0)
    && (value.outcome === 'partial-residue'
      ? value.residue.length === 1 && validResidue(value.residue[0], input)
        && validFacts(value.actual)
        && value.residue[0].width === value.actual.width
        && value.residue[0].height === value.actual.height
        && value.residue[0].sizingHorizontal === value.actual.sizingHorizontal
        && value.residue[0].sizingVertical === value.actual.sizingVertical
      : value.residue.length === 0)
    && (value.outcome !== 'verification-unavailable' || value.actual === null);
}

function mutationError(message, outcome, report) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string,dispatchState?:string,mutationOutcome?:unknown,mutationReport?:unknown}} */
  const error = new Error(message);
  error.kind = 'execution'; error.phase = 'plugin-execution'; error.outcome = 'unknown-after-dispatch';
  error.dispatchState = 'failed'; error.mutationOutcome = outcome; error.mutationReport = report;
  return error;
}
function pluginResultError(message) {
  /** @type {Error & {kind?:string,phase?:string,outcome?:string}} */
  const error = new Error(message);
  error.kind = 'plugin-result'; error.phase = 'plugin-response'; error.outcome = 'unknown-after-dispatch';
  return error;
}

export function formatNodeResizeResult(result) {
  const name = JSON.stringify(result.node.name).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `Resized ${name} (${result.node.id}) to ${result.actual.width}×${result.actual.height} (${result.actual.sizingHorizontal}/${result.actual.sizingVertical})`;
}

export async function executeNodeResize(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Node Resize requires a Figma evaluate adapter.');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(nodeResizeCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_NODE_RESIZE_RESULT_CODE_UNITS) {
    throw pluginResultError('Node Resize returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Node Resize returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Node Resize returned an invalid bounded result.');
    throw mutationError(`Node Resize made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw pluginResultError('Node Resize returned an invalid bounded result.');
    throw mutationError(payload.outcome === 'rolled-back'
      ? `Node Resize failed and restored the previous geometry: ${payload.failure}`
      : `Node Resize failed; the previous geometry could not be fully restored: ${payload.failure}`,
    payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.residue.length });
  }
  if (!validSuccess(payload, input)) throw pluginResultError('Node Resize returned an invalid bounded result.');
  return { stdout: formatNodeResizeResult(payload), stderr: '', result: payload };
}

export function nodeResizePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Node Resize routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-node-resize';
}
export async function executeNodeResizePlan(plan, adapters = {}) {
  if (nodeResizePlanRoute(plan) !== 'command-application') throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Resize.`);
  return executeNodeResize(parseNodeResizeRequest(plan.argv), adapters);
}
