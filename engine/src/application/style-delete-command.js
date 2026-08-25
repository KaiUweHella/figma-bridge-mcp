// Bounded, non-retrying local Style Delete Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  parseStyleDeleteRequest,
  styleDeleteArgvFromRequest,
  styleDeletePlanningArgvFromRequest,
} from './style-delete-request.js';

export { styleDeleteArgvFromRequest, styleDeletePlanningArgvFromRequest } from './style-delete-request.js';

const STYLE_DELETE_APPLICATION_ID = 'style.delete';
export const MAX_STYLE_DELETE_CANDIDATES = 10_000;
export const MAX_STYLE_DELETE_SERIALIZED_CODE_UNITS = 16_384;
const MAX_STYLE_DELETE_LABEL_CODE_UNITS = 1_024;
const STYLE_TYPES = new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']);

const normalizedRequest = (request) => parseStyleDeleteRequest(styleDeleteArgvFromRequest(request));

export function styleDeleteCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const query = ${JSON.stringify(input.style)};
    const requestedType = ${JSON.stringify(input.type)};
    const direct = await figma.getStyleByIdAsync(query);
    let style = direct && (!requestedType || direct.type === requestedType) ? direct : null;
    let resolution = 'id';
    if (!style) {
      const loaders = {
        PAINT: () => figma.getLocalPaintStylesAsync(), TEXT: () => figma.getLocalTextStylesAsync(),
        EFFECT: () => figma.getLocalEffectStylesAsync(), GRID: () => figma.getLocalGridStylesAsync(),
      };
      const families = requestedType ? [requestedType] : ['PAINT', 'TEXT', 'EFFECT', 'GRID'];
      const pool = (await Promise.all(families.map((type) => loaders[type]()))).flat();
      if (pool.length > ${MAX_STYLE_DELETE_CANDIDATES}) {
        throw new Error('Style Delete candidate limit exceeded. Use an exact style id.');
      }
      const exact = pool.filter((candidate) => candidate.name === query);
      const matches = exact.length ? exact
        : pool.filter((candidate) => candidate.name.toLowerCase().includes(query.toLowerCase()));
      if (matches.length > 1) throw new Error('Style reference is ambiguous (' + matches.length + ' matches).');
      if (matches.length === 0) throw new Error('Style not found in the targeted Figma document.');
      style = matches[0];
      resolution = exact.length ? 'exact-name' : 'partial-name';
    }
    if (typeof style.id !== 'string' || typeof style.key !== 'string'
      || typeof style.name !== 'string' || typeof style.type !== 'string'
      || typeof style.remote !== 'boolean' || typeof style.remove !== 'function') {
      throw new Error('Style Delete encountered incompatible local Style metadata.');
    }
    if (style.remote) throw new Error('Remote styles cannot be deleted.');
    const identity = { id: style.id, key: style.key, name: style.name, type: style.type, remote: false };
    try {
      style.remove();
    } catch {
      return JSON.stringify({
        schemaVersion: 1, status: 'failed', resolution, query, requestedType,
        style: identity, residue: [identity],
      });
    }
    return JSON.stringify({
      schemaVersion: 1, status: 'deleted', resolution, query, requestedType,
      style: identity, residue: [],
    });
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function bounded(value, empty = true) {
  return typeof value === 'string' && value.length <= MAX_STYLE_DELETE_LABEL_CODE_UNITS
    && (empty || value.length > 0);
}
function validStyle(value, input, resolution) {
  return exactKeys(value, ['id', 'key', 'name', 'type', 'remote'])
    && bounded(value.id, false) && bounded(value.key) && bounded(value.name)
    && STYLE_TYPES.has(value.type) && value.remote === false
    && (!input.type || value.type === input.type)
    && (resolution !== 'id' || value.id === input.style)
    && (resolution !== 'exact-name' || value.name === input.style)
    && (resolution !== 'partial-name' || (value.name !== input.style
      && value.name.toLowerCase().includes(input.style.toLowerCase())));
}
function validPayload(value, input) {
  return exactKeys(value, [
    'schemaVersion', 'status', 'resolution', 'query', 'requestedType', 'style', 'residue',
  ]) && value.schemaVersion === 1 && ['deleted', 'failed'].includes(value.status)
    && ['id', 'exact-name', 'partial-name'].includes(value.resolution)
    && value.query === input.style && value.requestedType === input.type
    && validStyle(value.style, input, value.resolution) && Array.isArray(value.residue)
    && (value.status === 'deleted' ? value.residue.length === 0
      : value.residue.length === 1 && validStyle(value.residue[0], input, value.resolution));
}

export async function executeStyleDelete(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('executeStyleDelete requires evaluate(code)');
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(styleDeleteCommandCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_STYLE_DELETE_SERIALIZED_CODE_UNITS) {
    throw new Error('Style Delete returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw new Error('Style Delete returned invalid JSON.'); }
  if (!validPayload(payload, input)) throw new Error('Style Delete returned an invalid bounded result.');
  if (payload.status === 'failed') {
    const error = new Error('Style Delete failed during removal; the targeted Style may remain.');
    error.kind = 'execution'; error.phase = 'plugin-execution';
    error.outcome = 'unknown-after-dispatch'; error.dispatchState = 'failed';
    error.mutationOutcome = 'partial-residue';
    error.styleMutationReport = { version: 1, outcome: 'partial-residue', residueCount: 1 };
    throw error;
  }
  const facts = { resolution: payload.resolution, style: payload.style, residue: [] };
  return { stdout: JSON.stringify(facts, null, 2), stderr: '', result: { schemaVersion: 1, status: 'deleted', ...facts } };
}

export function styleDeletePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Style Delete routing requires a Command Plan created by the Capability Catalog.');
  return plan.allowed && plan.id === STYLE_DELETE_APPLICATION_ID ? 'command-application' : 'not-style-delete';
}
export async function executeStyleDeletePlan(plan, adapters = {}) {
  if (styleDeletePlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Style Delete Command Application.`);
  }
  return executeStyleDelete(parseStyleDeleteRequest(plan.argv), adapters);
}
