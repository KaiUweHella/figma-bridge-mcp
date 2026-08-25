// Bounded, preflighted Style Apply Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseStyleApplyRequest,
  styleApplyArgvFromRequest,
  styleApplyPlanningArgvFromRequest,
} from './style-apply-request.js';

export { styleApplyArgvFromRequest, styleApplyPlanningArgvFromRequest } from './style-apply-request.js';

const STYLE_APPLY_APPLICATION_ID = 'style.apply';
export const MAX_STYLE_APPLY_STYLE_CANDIDATES = 10_000;
export const MAX_STYLE_APPLY_SERIALIZED_CODE_UNITS = 128_000;
const MAX_STYLE_APPLY_LABEL_CODE_UNITS = 1_024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
const NODE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const FIELD_POLICY = Object.freeze({
  fill: { type: 'PAINT', method: 'setFillStyleIdAsync', property: 'fillStyleId' },
  stroke: { type: 'PAINT', method: 'setStrokeStyleIdAsync', property: 'strokeStyleId' },
  text: { type: 'TEXT', method: 'setTextStyleIdAsync', property: 'textStyleId' },
  effect: { type: 'EFFECT', method: 'setEffectStyleIdAsync', property: 'effectStyleId' },
  grid: { type: 'GRID', method: 'setGridStyleIdAsync', property: 'gridStyleId' },
});

function normalizedRequest(request) {
  return parseStyleApplyRequest(styleApplyArgvFromRequest(request));
}

export function styleApplyCommandCode(request) {
  const input = normalizedRequest(request);
  const policy = FIELD_POLICY[input.field];
  return `(async () => {
    const query = ${JSON.stringify(input.style)};
    const nodeIds = ${JSON.stringify(input.nodeIds)};
    const expectedType = ${JSON.stringify(policy.type)};
    const method = ${JSON.stringify(policy.method)};
    const property = ${JSON.stringify(policy.property)};
    const direct = await figma.getStyleByIdAsync(query);
    let style = direct && direct.type === expectedType ? direct : null;
    let resolution = 'id';
    if (!style) {
      const loaders = {
        PAINT: () => figma.getLocalPaintStylesAsync(),
        TEXT: () => figma.getLocalTextStylesAsync(),
        EFFECT: () => figma.getLocalEffectStylesAsync(),
        GRID: () => figma.getLocalGridStylesAsync(),
      };
      const pool = await loaders[expectedType]();
      if (pool.length > ${MAX_STYLE_APPLY_STYLE_CANDIDATES}) {
        throw new Error('Style Apply candidate limit exceeded. Use an exact style id.');
      }
      const exact = pool.filter((candidate) => candidate.name === query);
      const matches = exact.length
        ? exact
        : pool.filter((candidate) => candidate.name.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) {
        throw new Error('Style reference is ambiguous (' + matches.length + ' matches). Use an exact style id or name.');
      }
      if (matches.length === 0) throw new Error('Style not found in the required ' + expectedType + ' family.');
      style = matches[0];
      resolution = exact.length ? 'exact-name' : 'partial-name';
    }
    if (typeof style.id !== 'string' || typeof style.key !== 'string'
      || typeof style.name !== 'string' || typeof style.remote !== 'boolean') {
      throw new Error('Style Apply encountered incompatible publishable metadata.');
    }

    // Complete every predictable lookup and capability check before the first write.
    const targets = [];
    for (const id of nodeIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new Error('Node not found: ' + id);
      if (typeof node.id !== 'string' || typeof node.name !== 'string'
        || typeof node.type !== 'string' || typeof node[method] !== 'function') {
        throw new Error('Node does not support ' + ${JSON.stringify(input.field)} + ' styles: ' + id);
      }
      targets.push({ node, previousStyleId: node[property] });
    }

    const styleIdentity = {
      id: style.id, key: style.key, name: style.name, type: style.type, remote: style.remote,
    };
    const nodeIdentity = (node) => ({ id: node.id, name: node.name, type: node.type });
    const applied = [];
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      try {
        await target.node[method](style.id);
        applied.push(target);
      } catch {
        const residue = [nodeIdentity(target.node)];
        let restored = 0;
        for (let rollback = applied.length - 1; rollback >= 0; rollback--) {
          const prior = applied[rollback];
          if (typeof prior.previousStyleId !== 'string') {
            residue.push(nodeIdentity(prior.node));
            continue;
          }
          try { await prior.node[method](prior.previousStyleId); restored++; }
          catch { residue.push(nodeIdentity(prior.node)); }
        }
        const uniqueResidue = [...new Map(residue.map((node) => [node.id, node])).values()];
        const failed = {
          schemaVersion: 1, status: 'failed', resolution, query,
          requestedType: expectedType, style: styleIdentity,
          field: ${JSON.stringify(input.field)}, total: targets.length,
          attempted: index + 1, confirmedApplied: applied.length, restored,
          residue: uniqueResidue,
        };
        const serializedFailure = JSON.stringify(failed);
        if (serializedFailure.length > ${MAX_STYLE_APPLY_SERIALIZED_CODE_UNITS}) {
          throw new Error('Style Apply failure evidence exceeded the result limit.');
        }
        return serializedFailure;
      }
    }
    const complete = {
      schemaVersion: 1, status: 'applied', resolution, query,
      requestedType: expectedType, style: styleIdentity,
      field: ${JSON.stringify(input.field)}, total: targets.length,
      applied: targets.map(({ node }) => nodeIdentity(node)), residue: [],
    };
    const serialized = JSON.stringify(complete);
    if (serialized.length > ${MAX_STYLE_APPLY_SERIALIZED_CODE_UNITS}) {
      throw new Error('Style Apply result exceeded the bounded result limit.');
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
  return typeof value === 'string' && value.length <= MAX_STYLE_APPLY_LABEL_CODE_UNITS
    && (empty || value.length > 0);
}

function validNode(value, expectedId = null) {
  return exactKeys(value, ['id', 'name', 'type'])
    && boundedString(value.id, { empty: false })
    && boundedString(value.name)
    && NODE_TYPE_PATTERN.test(value.type)
    && (expectedId === null || value.id === expectedId);
}

function validCommon(value, input) {
  const expectedType = FIELD_POLICY[input.field].type;
  return value.schemaVersion === 1
    && ['id', 'exact-name', 'partial-name'].includes(value.resolution)
    && value.query === input.style && value.requestedType === expectedType
    && exactKeys(value.style, ['id', 'key', 'name', 'type', 'remote'])
    && boundedString(value.style.id, { empty: false }) && boundedString(value.style.key)
    && boundedString(value.style.name) && STYLE_TYPES.has(value.style.type)
    && value.style.type === expectedType && typeof value.style.remote === 'boolean'
    && (value.resolution !== 'id' || value.style.id === input.style)
    && (value.resolution !== 'exact-name' || value.style.name === input.style)
    && (value.resolution !== 'partial-name' || (
      value.style.name !== input.style
      && value.style.name.toLowerCase().includes(input.style.toLowerCase())
    ))
    && value.field === input.field && value.total === input.nodeIds.length;
}

function validSuccess(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'requestedType', 'style',
    'field', 'total', 'applied', 'residue',
  ]) && value.status === 'applied' && validCommon(value, input)
    && Array.isArray(value.applied) && value.applied.length === input.nodeIds.length
    && value.applied.every((node, index) => validNode(node, input.nodeIds[index]))
    && Array.isArray(value.residue) && value.residue.length === 0;
}

function validFailure(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'requestedType', 'style',
    'field', 'total', 'attempted', 'confirmedApplied', 'restored', 'residue',
  ]) && value.status === 'failed' && validCommon(value, input)
    && Number.isInteger(value.attempted) && value.attempted >= 1 && value.attempted <= input.nodeIds.length
    && Number.isInteger(value.confirmedApplied) && value.confirmedApplied >= 0
    && value.confirmedApplied < value.attempted
    && Number.isInteger(value.restored) && value.restored >= 0 && value.restored <= value.confirmedApplied
    && Array.isArray(value.residue) && value.residue.length >= 1
    && value.residue.length <= value.attempted
    && value.residue.every((node) => validNode(node) && input.nodeIds.includes(node.id))
    && new Set(value.residue.map(({ id }) => id)).size === value.residue.length;
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeStyleApply(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeStyleApply requires evaluate(code)');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(styleApplyCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_STYLE_APPLY_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Apply returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Style Apply returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw new Error('Style Apply returned an invalid bounded result.');
    const error = new Error(
      `Style Apply failed after ${payload.attempted}/${payload.total} attempts; `
      + `${payload.restored} prior change(s) restored and ${payload.residue.length} node(s) may retain residue.`,
    );
    error.kind = 'execution';
    error.phase = 'plugin-execution';
    error.outcome = 'unknown-after-dispatch';
    error.dispatchState = 'failed';
    error.mutationReport = {
      version: 1, outcome: 'partial-residue', attempted: payload.attempted,
      confirmedApplied: payload.confirmedApplied, restored: payload.restored,
      residueCount: payload.residue.length,
    };
    throw error;
  }
  if (!validSuccess(payload, input)) throw new Error('Style Apply returned an invalid bounded result.');
  const { schemaVersion, query: _query, requestedType: _requestedType, status: _status, ...facts } = payload;
  return { stdout: safePrettyJson(facts), stderr: '', result: { schemaVersion, status: 'applied', ...facts } };
}

export function styleApplyPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Style Apply routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === STYLE_APPLY_APPLICATION_ID
    ? 'command-application' : 'not-style-apply';
}

export async function executeStyleApplyPlan(plan, adapters = {}) {
  if (styleApplyPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Style Apply Command Application.`);
  }
  return executeStyleApply(parseStyleApplyRequest(plan.argv), adapters);
}
