// Bounded Measurement inspection behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  measurementReadArgvFromRequest,
  measurementReadPlanningArgvFromRequest,
  parseMeasurementReadRequest,
} from './measurement-read-request.js';
import {
  MAX_MEASUREMENT_ID_CODE_UNITS,
  MAX_MEASUREMENT_TEXT_CODE_UNITS,
} from './measurement-mutation-request.js';

export { measurementReadArgvFromRequest, measurementReadPlanningArgvFromRequest } from './measurement-read-request.js';
export const MAX_MEASUREMENT_READ_ITEMS = 10_000;
export const MAX_MEASUREMENT_READ_RESULT_CODE_UNITS = 2_000_000;
const MAX_NODE_NAME_CODE_UNITS = 1_024;
const APPLICATION_ID = 'measure.list';
const normalized = (request) => parseMeasurementReadRequest(measurementReadArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function measurementReadCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (value) => { const serialized = JSON.stringify(value); if (serialized.length > ${MAX_MEASUREMENT_READ_RESULT_CODE_UNITS}) throw new Error('Measurement Read result exceeded its bounded response limit.'); return serialized; };
    const offset = (value) => { if (value && value.type === 'OUTER' && Number.isFinite(value.fixed)) return { type: 'OUTER', fixed: value.fixed }; if (value && value.type === 'INNER' && Number.isFinite(value.relative) && value.relative >= 0 && value.relative <= 1) return { type: 'INNER', relative: value.relative }; throw new Error('Measurement returned invalid offset facts.'); };
    const endpoint = (value) => { if (!value || !value.node || typeof value.node.id !== 'string' || !value.node.id.length || value.node.id.length > ${MAX_MEASUREMENT_ID_CODE_UNITS} || !['TOP','RIGHT','BOTTOM','LEFT'].includes(value.side)) throw new Error('Measurement returned invalid endpoint facts.'); return { node: { id: clean(value.node.id, ${MAX_MEASUREMENT_ID_CODE_UNITS}), name: clean(String(value.node.name || ''), ${MAX_NODE_NAME_CODE_UNITS}), type: clean(String(value.node.type || ''), 64) }, side: value.side }; };
    const fact = (value) => { if (!value || typeof value.id !== 'string' || !value.id.length || value.id.length > ${MAX_MEASUREMENT_ID_CODE_UNITS}) throw new Error('Measurement returned an invalid id.'); const freeText = typeof value.freeText === 'string' ? value.freeText : ''; if (freeText.length > ${MAX_MEASUREMENT_TEXT_CODE_UNITS}) throw new Error('Measurement text exceeds its bound.'); return { id: clean(value.id, ${MAX_MEASUREMENT_ID_CODE_UNITS}), start: endpoint(value.start), end: endpoint(value.end), offset: offset(value.offset), freeText }; };
    const page = figma.currentPage;
    if (!page || page.type !== 'PAGE' || typeof page.getMeasurements !== 'function' || typeof page.getMeasurementsForNode !== 'function') throw new Error('Measurement Read requires a compatible current Page.');
    let values;
    if (request.nodeId) {
      const node = await figma.getNodeByIdAsync(request.nodeId);
      if (!node || !('x' in node)) throw new Error('Scene node was not found in the targeted Figma document.');
      values = page.getMeasurementsForNode(node);
    } else values = page.getMeasurements();
    if (!Array.isArray(values) || values.length > ${MAX_MEASUREMENT_READ_ITEMS}) throw new Error('Measurement inventory exceeded its bounded item limit.');
    const result = values.map(fact);
    if (new Set(result.map((item) => item.id)).size !== result.length) throw new Error('Measurement ids must be unique.');
    return bounded(result);
  })()`;
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
const text = (value, maximum, empty = true) => typeof value === 'string'
  && value.length <= maximum && (empty || value.length > 0);
function validOffset(value) {
  return exact(value, value?.type === 'OUTER' ? ['type', 'fixed'] : ['type', 'relative'])
    && (value.type === 'OUTER' ? Number.isFinite(value.fixed)
      : value.type === 'INNER' && Number.isFinite(value.relative)
        && value.relative >= 0 && value.relative <= 1);
}
function validEndpoint(value) {
  return exact(value, ['node', 'side'])
    && exact(value.node, ['id', 'name', 'type'])
    && text(value.node.id, MAX_MEASUREMENT_ID_CODE_UNITS, false)
    && NODE_REFERENCE_PATTERN.test(value.node.id)
    && text(value.node.name, MAX_NODE_NAME_CODE_UNITS)
    && text(value.node.type, 64, false)
    && ['TOP', 'RIGHT', 'BOTTOM', 'LEFT'].includes(value.side);
}
function validMeasurement(value) {
  return exact(value, ['id', 'start', 'end', 'offset', 'freeText'])
    && text(value.id, MAX_MEASUREMENT_ID_CODE_UNITS, false)
    && validEndpoint(value.start) && validEndpoint(value.end)
    && validOffset(value.offset) && text(value.freeText, MAX_MEASUREMENT_TEXT_CODE_UNITS);
}
function invalid(message) {
  const error = new Error(message);
  Object.assign(error, {
    kind: 'execution', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed',
  });
  return error;
}
function safe(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function executeMeasurementRead(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('Measurement Read requires a Figma evaluate adapter.');
  }
  const input = normalized(request);
  const serialized = await adapters.evaluate(measurementReadCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_MEASUREMENT_READ_RESULT_CODE_UNITS) {
    throw invalid('Measurement Read returned an invalid bounded result.');
  }
  let result;
  try { result = JSON.parse(serialized); } catch { throw invalid('Measurement Read returned invalid JSON.'); }
  if (!Array.isArray(result) || result.length > MAX_MEASUREMENT_READ_ITEMS
    || !result.every(validMeasurement)
    || new Set(result.map((item) => item.id)).size !== result.length) {
    throw invalid('Measurement Read returned an invalid bounded result.');
  }
  return { stdout: safe(result), stderr: input.warning ? `⚠ ${input.warning}` : '', result };
}

export function measurementReadPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Measurement Read routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-measurement-read';
}

export function executeMeasurementReadPlan(plan, adapters = {}) {
  if (measurementReadPlanRoute(plan) !== 'command-application') {
    throw new Error('Command Plan is not owned by Measurement Read.');
  }
  return executeMeasurementRead(parseMeasurementReadRequest(plan.argv), adapters);
}
