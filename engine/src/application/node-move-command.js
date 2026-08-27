// Value-returning Command Application for `node move`.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  MAX_NODE_MOVE_NODE_ID_CODE_UNITS,
  MAX_NODE_MOVE_PAGE_CODE_UNITS,
  NODE_MOVE_NODE_ID_PATTERN,
  nodeMoveArgvFromRequest,
  nodeMovePlanningArgvFromRequest,
  parseNodeMoveRequest,
} from './node-move-request.js';
import { MAX_ABSOLUTE_NODE_COORDINATE } from './node-coordinate.js';

export { nodeMoveArgvFromRequest, nodeMovePlanningArgvFromRequest } from './node-move-request.js';

const NODE_MOVE_APPLICATION_ID = 'node.move';
export const NODE_MOVE_VERIFY_EPSILON = 0.01;
export const MAX_NODE_MOVE_PAGES = 10_000;
export const MAX_NODE_MOVE_LABEL_CODE_UNITS = 512;

function normalizedRequest(request) {
  return parseNodeMoveRequest(nodeMoveArgvFromRequest(request));
}

export function nodeMoveRequestFromArgv(args) {
  return parseNodeMoveRequest(args);
}

export function nodeMovePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Node Move routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === NODE_MOVE_APPLICATION_ID
    ? 'command-application'
    : 'not-node-move';
}

export async function executeNodeMovePlan(plan, adapters = {}) {
  if (nodeMovePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Node Move.`);
  }
  return executeNodeMove(nodeMoveRequestFromArgv(plan.argv), adapters);
}

export function nodeMoveCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const nodeId = ${JSON.stringify(input.nodeId)};
    const requestedX = ${JSON.stringify(input.x)};
    const requestedY = ${JSON.stringify(input.y)};
    const pageQuery = ${JSON.stringify(input.page)};
    const clean = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) throw new Error('Node not found: ' + nodeId);
    if (!('x' in node) || !('y' in node)) {
      throw new Error('Node has no position: ' + clean(node.type, 64));
    }

    let targetPage = null;
    if (pageQuery !== null) {
      const pages = figma.root && figma.root.children;
      if (!Array.isArray(pages) || pages.length > ${MAX_NODE_MOVE_PAGES}) {
        throw new Error('Figma page catalog exceeds the bounded Node Move contract');
      }
      const exactId = pages.filter((page) => page && page.id === pageQuery);
      const exactName = pages.filter((page) => page && page.name === pageQuery);
      let matches = exactId.length ? exactId : exactName;
      if (!matches.length) {
        const query = pageQuery.toLowerCase();
        matches = pages.filter((page) => page && typeof page.name === 'string'
          && page.name.toLowerCase().includes(query));
      }
      if (matches.length > 1) throw new Error('Ambiguous page name: ' + clean(pageQuery, ${MAX_NODE_MOVE_PAGE_CODE_UNITS}));
      targetPage = matches[0] || null;
      if (!targetPage) throw new Error('Page not found: ' + clean(pageQuery, ${MAX_NODE_MOVE_PAGE_CODE_UNITS}));
      if (typeof targetPage.loadAsync !== 'function' || typeof targetPage.appendChild !== 'function') {
        throw new Error('Target page cannot contain nodes');
      }
      await targetPage.loadAsync();
    }

    if (targetPage) {
      if (!node.parent || node.parent.id !== targetPage.id) targetPage.appendChild(node);
      node.x = requestedX;
      node.y = requestedY;
    } else {
      const before = node.absoluteBoundingBox;
      if (before && Number.isFinite(before.x) && Number.isFinite(before.y)) {
        node.x = node.x + (requestedX - before.x);
        node.y = node.y + (requestedY - before.y);
      } else {
        node.x = requestedX;
        node.y = requestedY;
      }
    }

    const bounds = node.absoluteBoundingBox;
    const actualX = bounds && Number.isFinite(bounds.x) ? bounds.x : node.x;
    const actualY = bounds && Number.isFinite(bounds.y) ? bounds.y : node.y;
    if (!Number.isFinite(actualX) || !Number.isFinite(actualY)
      || Math.abs(actualX - requestedX) > ${NODE_MOVE_VERIFY_EPSILON}
      || Math.abs(actualY - requestedY) > ${NODE_MOVE_VERIFY_EPSILON}) {
      throw new Error('Node Move did not reach the requested absolute canvas position');
    }
    return {
      schemaVersion: 1,
      status: 'moved',
      node: {
        id: clean(node.id, ${MAX_NODE_MOVE_NODE_ID_CODE_UNITS}),
        name: clean(node.name, ${MAX_NODE_MOVE_LABEL_CODE_UNITS}),
        type: clean(node.type, 64),
      },
      requested: { x: requestedX, y: requestedY, coordinateSpace: 'absolute-canvas' },
      actual: { x: actualX, y: actualY, coordinateSpace: 'absolute-canvas' },
      page: targetPage ? {
        id: clean(targetPage.id, ${MAX_NODE_MOVE_NODE_ID_CODE_UNITS}),
        name: clean(targetPage.name, ${MAX_NODE_MOVE_LABEL_CODE_UNITS}),
      } : null,
    };
  })()`;
}

function validCoordinate(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'coordinateSpace,x,y'
    && Number.isFinite(value.x) && Number.isFinite(value.y)
    && Math.abs(value.x) <= MAX_ABSOLUTE_NODE_COORDINATE
    && Math.abs(value.y) <= MAX_ABSOLUTE_NODE_COORDINATE
    && value.coordinateSpace === 'absolute-canvas';
}

function validIdentity(value, withType = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = withType ? 'id,name,type' : 'id,name';
  return Object.keys(value).sort().join(',') === expected
    && typeof value.id === 'string' && value.id.length > 0
    && value.id.length <= MAX_NODE_MOVE_NODE_ID_CODE_UNITS
    && NODE_MOVE_NODE_ID_PATTERN.test(value.id)
    && typeof value.name === 'string' && value.name.length <= MAX_NODE_MOVE_LABEL_CODE_UNITS
    && (!withType || (typeof value.type === 'string' && value.type.length > 0 && value.type.length <= 64));
}

export function validateNodeMoveResult(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'actual,node,page,requested,schemaVersion,status'
    || value.schemaVersion !== 1 || value.status !== 'moved'
    || !validIdentity(value.node, true)
    || !validCoordinate(value.requested) || !validCoordinate(value.actual)
    || (value.page !== null && !validIdentity(value.page))) {
    throw new Error('Node Move returned an invalid bounded result.');
  }
  if (expected.nodeId !== undefined && value.node.id !== expected.nodeId) {
    throw new Error('Node Move returned a result for a different node.');
  }
  if (expected.x !== undefined && (Math.abs(value.requested.x - expected.x) > NODE_MOVE_VERIFY_EPSILON
    || Math.abs(value.actual.x - expected.x) > NODE_MOVE_VERIFY_EPSILON)) {
    throw new Error('Node Move returned a mismatched X coordinate.');
  }
  if (expected.y !== undefined && (Math.abs(value.requested.y - expected.y) > NODE_MOVE_VERIFY_EPSILON
    || Math.abs(value.actual.y - expected.y) > NODE_MOVE_VERIFY_EPSILON)) {
    throw new Error('Node Move returned a mismatched Y coordinate.');
  }
  if (expected.page && !value.page) {
    throw new Error('Node Move did not return its resolved target page.');
  }
  if (!expected.page && value.page !== null) {
    throw new Error('Node Move returned an unexpected target page.');
  }
  return value;
}

export async function executeNodeMove(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Node Move command requires a Figma evaluate adapter.');
  }
  const input = normalizedRequest(request);
  const value = await adapters.evaluate(nodeMoveCode(input));
  try {
    return validateNodeMoveResult(value, input);
  } catch (error) {
    error.kind = 'plugin-result';
    error.phase = 'plugin-response';
    error.outcome = 'unknown-after-dispatch';
    throw error;
  }
}

export function formatNodeMoveResult(result) {
  const value = validateNodeMoveResult(result);
  const page = value.page ? ` on page ${JSON.stringify(value.page.name)}` : '';
  return `Moved ${JSON.stringify(value.node.name)} (${value.node.id}) to ${value.actual.x}, ${value.actual.y}${page}`;
}
