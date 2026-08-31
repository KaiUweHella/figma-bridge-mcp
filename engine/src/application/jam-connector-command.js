// Plan-bound, freshly verified and rollback-owned `jam connector` creation.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_NODE_REFERENCE_CODE_UNITS, NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  MAX_JAM_CONNECTOR_TEXT_CODE_UNITS,
  jamConnectorArgvFromRequest,
  parseJamConnectorRequest,
} from './jam-connector-request.js';

export {
  jamConnectorArgvFromRequest,
  jamConnectorPlanningArgvFromRequest,
} from './jam-connector-request.js';

const APPLICATION_ID = 'jam.connector';
export const MAX_JAM_CONNECTOR_PAGE_CHILDREN = 20_000;
export const MAX_JAM_CONNECTOR_SELECTION = 4_096;
export const MAX_JAM_CONNECTOR_SNAPSHOT_CODE_UNITS = 300_000;
export const MAX_JAM_CONNECTOR_RESULT_CODE_UNITS = 1_000_000;
const MAX_FAILURE_CODE_UNITS = 1_024;
const MAX_ANCESTORS = 128;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;

const normalized = (request) => parseJamConnectorRequest(jamConnectorArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function jamConnectorCode(request) {
  const input = normalized(request);
  return `(async () => {
    const schemaVersion = 1;
    const request = ${js(input)};
    const nodeIdPattern = ${NODE_REFERENCE_PATTERN};
    const clean = (value, maximum) => String(value).slice(0, maximum)
      .replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ');
    const failureText = (error, fallback) => clean(
      error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const validId = (value) => typeof value === 'string' && value.length > 0
      && value.length <= ${MAX_NODE_REFERENCE_CODE_UNITS} && nodeIdPattern.test(value);
    const same = (left, right) => left.length === right.length
      && left.every((value, index) => value === right[index]);
    const result = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_JAM_CONNECTOR_RESULT_CODE_UNITS}) {
        throw new Error('Jam Connector result exceeded its bounded response limit.');
      }
      return serialized;
    };
    const refused = (error) => result({
      schemaVersion, status: 'refused', outcome: 'no-mutation', attempted: 0,
      failure: failureText(error, 'Jam Connector preflight failed.'),
    });
    if (figma.editorType !== 'figjam') return refused('Jam Connector requires a FigJam board.');
    if (!figma.currentPage || typeof figma.createConnector !== 'function'
      || typeof figma.getNodeByIdAsync !== 'function' || typeof figma.loadFontAsync !== 'function') {
      return refused('Jam Connector requires the native FigJam API.');
    }
    const context = (page) => {
      if (!page || !validId(page.id) || !Array.isArray(page.children)
        || page.children.length > ${MAX_JAM_CONNECTOR_PAGE_CHILDREN}
        || !Array.isArray(page.selection) || page.selection.length > ${MAX_JAM_CONNECTOR_SELECTION}) {
        throw new Error('Jam Connector requires one bounded current page and selection.');
      }
      const childIds = page.children.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Jam Connector found an invalid page child.');
        return node.id;
      });
      const selectionIds = page.selection.map((node) => {
        if (!node || !validId(node.id)) throw new Error('Jam Connector found an invalid selection.');
        return node.id;
      });
      if (new Set(childIds).size !== childIds.length
        || new Set(selectionIds).size !== selectionIds.length) {
        throw new Error('Jam Connector requires unique page and selection identities.');
      }
      return { pageId: page.id, childIds, selectionIds };
    };
    const belongsToPage = (node, pageId) => {
      const visited = new Set();
      let current = node;
      for (let depth = 0; current && depth <= ${MAX_ANCESTORS}; depth++) {
        if (current.id === pageId) return true;
        if (!validId(current.id) || visited.has(current.id)) return false;
        visited.add(current.id);
        current = current.parent || null;
      }
      return false;
    };
    const target = (node, id, pageId) => {
      if (!node || node.id !== id || typeof node.type !== 'string'
        || node.type.length === 0 || node.type.length > 64 || !belongsToPage(node, pageId)) {
        throw new Error('Jam Connector requires both exact endpoints on the current page.');
      }
      return { id: node.id, type: node.type };
    };
    let page;
    let before;
    try {
      page = figma.currentPage;
      const current = context(page);
      const from = target(await figma.getNodeByIdAsync(request.fromId), request.fromId, current.pageId);
      const to = target(await figma.getNodeByIdAsync(request.toId), request.toId, current.pageId);
      const fresh = context(page);
      if (JSON.stringify(current) !== JSON.stringify(fresh)) {
        throw new Error('Jam Connector page changed during endpoint preflight.');
      }
      before = { context: current, from, to };
      if (JSON.stringify({ request, before }).length > ${MAX_JAM_CONNECTOR_SNAPSHOT_CODE_UNITS}) {
        throw new Error('Jam Connector preflight snapshot exceeded its bounded limit.');
      }
    } catch (error) { return refused(error); }
    const endpoint = (value) => {
      if (!value || !validId(value.endpointNodeId) || value.magnet !== 'AUTO') {
        throw new Error('Jam Connector returned an invalid native endpoint.');
      }
      return { endpointNodeId: value.endpointNodeId, magnet: value.magnet };
    };
    const nodeFact = (node, pageId, index) => {
      if (!node || node.type !== 'CONNECTOR' || !validId(node.id)
        || !node.parent || node.parent.id !== pageId
        || !node.text || typeof node.text.characters !== 'string'
        || node.text.characters.length > ${MAX_JAM_CONNECTOR_TEXT_CODE_UNITS}
        || !['ELBOWED', 'STRAIGHT'].includes(node.connectorLineType)
        || !Number.isSafeInteger(index) || index < 0) {
        throw new Error('Jam Connector found invalid bounded Connector facts.');
      }
      return {
        id: node.id, type: 'CONNECTOR', parentId: pageId, index,
        start: endpoint(node.connectorStart), end: endpoint(node.connectorEnd),
        line: node.connectorLineType, text: node.text.characters,
      };
    };
    const exactSuccess = (actual, node, from, to) => {
      const expectedChildren = [...before.context.childIds, node.id];
      return figma.currentPage && figma.currentPage.id === before.context.pageId
        && same(actual.childIds, expectedChildren)
        && same(actual.selectionIds, before.context.selectionIds)
        && node.index === before.context.childIds.length
        && node.start.endpointNodeId === request.fromId
        && node.end.endpointNodeId === request.toId
        && node.line === request.line && node.text === (request.text ?? '')
        && from.id === before.from.id && from.type === before.from.type
        && to.id === before.to.id && to.type === before.to.type;
    };

    let connector = null;
    let failure = '';
    try {
      connector = figma.createConnector();
      connector.connectorStart = { endpointNodeId: request.fromId, magnet: 'AUTO' };
      connector.connectorEnd = { endpointNodeId: request.toId, magnet: 'AUTO' };
      connector.connectorLineType = request.line;
      if (request.text !== null) {
        try { await figma.loadFontAsync({ family: 'Inter', style: 'Medium' }); } catch {}
        try {
          const font = connector.text && connector.text.fontName;
          if (font && font !== figma.mixed) await figma.loadFontAsync(font);
        } catch {}
        if (!figma.currentPage || figma.currentPage.id !== before.context.pageId) {
          throw new Error('Jam Connector current page changed during creation.');
        }
        connector.text.characters = request.text;
      }
    } catch (error) {
      failure = failureText(error, 'Jam Connector mutation failed.');
    }
    if (connector && validId(connector.id)) {
      try {
        const freshPage = await figma.getNodeByIdAsync(before.context.pageId);
        const fresh = await figma.getNodeByIdAsync(connector.id);
        const fromNode = await figma.getNodeByIdAsync(request.fromId);
        const toNode = await figma.getNodeByIdAsync(request.toId);
        const actual = context(freshPage);
        const node = nodeFact(fresh, before.context.pageId, actual.childIds.indexOf(connector.id));
        const from = target(fromNode, request.fromId, before.context.pageId);
        const to = target(toNode, request.toId, before.context.pageId);
        if (exactSuccess(actual, node, from, to)) {
          delete globalThis.__invCache;
          return result({
            schemaVersion, status: 'created', outcome: failure ? 'verified-after-error' : 'verified',
            attempted: 1, restored: 0, residueCount: 0, request, before,
            actual: { context: actual, node, from, to },
            warnings: failure
              ? ['Figma reported an error, but fresh FigJam readback verified the requested Connector.']
              : [],
          });
        }
        if (!failure) failure = 'Jam Connector postcondition was not satisfied.';
      } catch (error) {
        if (!failure) failure = failureText(error, 'Jam Connector verification failed.');
      }
    } else if (!failure) failure = 'Jam Connector factory returned no bounded identity.';

    if (!connector || !validId(connector.id)) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, residueCount: 0, failure,
      });
    }
    try {
      try { connector.remove(); } catch {}
      const restoredPage = await figma.getNodeByIdAsync(before.context.pageId);
      const fresh = await figma.getNodeByIdAsync(connector.id);
      const restoredContext = context(restoredPage);
      let residueCount = fresh || restoredContext.childIds.includes(connector.id) ? 1 : 0;
      if (!same(restoredContext.childIds, before.context.childIds)) residueCount += 1;
      if (!same(restoredContext.selectionIds, before.context.selectionIds)) residueCount += 1;
      if (residueCount === 0) delete globalThis.__invCache;
      return result({
        schemaVersion, status: 'failed',
        outcome: residueCount === 0 ? 'rolled-back' : 'partial-residue', attempted: 1,
        restored: residueCount === 0 ? 1 : 0, residueCount, failure,
      });
    } catch (error) {
      return result({
        schemaVersion, status: 'failed', outcome: 'verification-unavailable', attempted: 1,
        restored: 0, residueCount: 0,
        failure: failureText(error, failure || 'Jam Connector rollback verification failed.'),
      });
    }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function id(value) {
  return typeof value === 'string' && value.length > 0
    && value.length <= MAX_NODE_REFERENCE_CODE_UNITS && NODE_REFERENCE_PATTERN.test(value);
}
function ids(value, maximum) {
  return Array.isArray(value) && value.length <= maximum && value.every(id)
    && new Set(value).size === value.length;
}
function validContext(value) {
  return exact(value, ['pageId', 'childIds', 'selectionIds']) && id(value.pageId)
    && ids(value.childIds, MAX_JAM_CONNECTOR_PAGE_CHILDREN)
    && ids(value.selectionIds, MAX_JAM_CONNECTOR_SELECTION);
}
function validTarget(value, expected) {
  return exact(value, ['id', 'type']) && value.id === expected.id
    && typeof value.type === 'string' && value.type.length > 0 && value.type.length <= 64
    && (expected.type === undefined || value.type === expected.type);
}
function validEndpoint(value, expectedId) {
  return exact(value, ['endpointNodeId', 'magnet'])
    && value.endpointNodeId === expectedId && value.magnet === 'AUTO';
}
function validRequest(value, input) {
  return exact(value, ['fromId', 'toId', 'text', 'line'])
    && JSON.stringify(value) === JSON.stringify(input);
}
function validNode(value, input, before) {
  return exact(value, [
    'id', 'type', 'parentId', 'index', 'start', 'end', 'line', 'text',
  ]) && id(value.id) && value.type === 'CONNECTOR' && value.parentId === before.context.pageId
    && value.index === before.context.childIds.length
    && validEndpoint(value.start, input.fromId) && validEndpoint(value.end, input.toId)
    && value.line === input.line && value.text === (input.text ?? '');
}
function validRefusal(value) {
  return exact(value, ['schemaVersion', 'status', 'outcome', 'attempted', 'failure'])
    && value.schemaVersion === 1 && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && typeof value.failure === 'string' && value.failure.length > 0
    && value.failure.length <= MAX_FAILURE_CODE_UNITS;
}
function validSuccess(value, input) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount',
    'request', 'before', 'actual', 'warnings',
  ]) || value.schemaVersion !== 1 || value.status !== 'created'
    || !['verified', 'verified-after-error'].includes(value.outcome)
    || value.attempted !== 1 || value.restored !== 0 || value.residueCount !== 0
    || !validRequest(value.request, input)
    || !exact(value.before, ['context', 'from', 'to']) || !validContext(value.before.context)
    || !validTarget(value.before.from, { id: input.fromId })
    || !validTarget(value.before.to, { id: input.toId })
    || JSON.stringify({ request: value.request, before: value.before }).length
      > MAX_JAM_CONNECTOR_SNAPSHOT_CODE_UNITS
    || !exact(value.actual, ['context', 'node', 'from', 'to'])
    || !validContext(value.actual.context) || !validNode(value.actual.node, input, value.before)
    || !validTarget(value.actual.from, value.before.from)
    || !validTarget(value.actual.to, value.before.to)
    || !Array.isArray(value.warnings) || value.warnings.length > 1
    || value.warnings.some((warning) => typeof warning !== 'string'
      || warning.length === 0 || warning.length > MAX_FAILURE_CODE_UNITS)) return false;
  const expectedChildren = [...value.before.context.childIds, value.actual.node.id];
  return value.actual.context.pageId === value.before.context.pageId
    && sameIds(value.actual.context.childIds, expectedChildren)
    && sameIds(value.actual.context.selectionIds, value.before.context.selectionIds)
    && (value.outcome === 'verified-after-error'
      ? value.warnings.length === 1 : value.warnings.length === 0);
}
function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function validFailure(value) {
  if (!exact(value, [
    'schemaVersion', 'status', 'outcome', 'attempted', 'restored', 'residueCount', 'failure',
  ]) || value.schemaVersion !== 1 || value.status !== 'failed'
    || !['rolled-back', 'partial-residue', 'verification-unavailable'].includes(value.outcome)
    || value.attempted !== 1 || ![0, 1].includes(value.restored)
    || !Number.isSafeInteger(value.residueCount) || value.residueCount < 0 || value.residueCount > 3
    || typeof value.failure !== 'string' || value.failure.length === 0
    || value.failure.length > MAX_FAILURE_CODE_UNITS) return false;
  if (value.outcome === 'rolled-back') return value.restored === 1 && value.residueCount === 0;
  if (value.outcome === 'partial-residue') return value.restored === 0 && value.residueCount > 0;
  return value.restored === 0;
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' });
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
function safeText(value) { return String(value).replace(UNSAFE_TEXT_CONTROLS, ' '); }

export function formatJamConnectorResult(result) {
  return `✓ Connector ${safeText(result.actual.node.id)}`;
}

export async function executeJamConnector(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Jam Connector requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(jamConnectorCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_JAM_CONNECTOR_RESULT_CODE_UNITS) {
    throw invalid('Jam Connector returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw invalid('Jam Connector returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw invalid('Jam Connector returned an invalid bounded result.');
    throw mutationError(`Jam Connector made no mutation: ${payload.failure}`, 'no-mutation', {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw invalid('Jam Connector returned an invalid bounded result.');
    throw mutationError(`Jam Connector failed with ${payload.outcome}: ${payload.failure}`,
      payload.outcome, {
        version: 1, outcome: payload.outcome, attempted: 1,
        restored: payload.restored, residueCount: payload.residueCount,
      });
  }
  if (!validSuccess(payload, input)) throw invalid('Jam Connector returned an invalid bounded result.');
  return {
    stdout: formatJamConnectorResult(payload),
    stderr: payload.warnings.map((warning) => `⚠ ${warning}`).join('\n'),
    result: payload,
  };
}

export function jamConnectorPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Jam Connector routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-jam-connector';
}

export function executeJamConnectorPlan(plan, adapters = {}) {
  if (jamConnectorPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Jam Connector.');
  }
  return executeJamConnector(parseJamConnectorRequest(plan.argv), adapters);
}
