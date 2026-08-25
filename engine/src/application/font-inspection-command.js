// Exact bounded Font Inspection Command Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { TYPOGRAPHY_VARIABLE_FIELDS, fontInspectCode } from '../lib/font-introspection.js';
import {
  fontInspectionArgvFromRequest,
  fontInspectionPlanningArgvFromRequest,
  parseFontInspectionRequest,
} from './font-inspection-request.js';

export {
  fontInspectionArgvFromRequest,
  fontInspectionPlanningArgvFromRequest,
} from './font-inspection-request.js';

const FONT_INSPECTION_APPLICATION_ID = 'font.inspect';
export const MAX_FONT_INSPECTION_CHARACTERS = 1_000_000;
export const MAX_FONT_INSPECTION_SEGMENTS = 20_000;
export const MAX_FONT_INSPECTION_FACTS = 100_000;
export const MAX_FONT_INSPECTION_STRING_CODE_UNITS = 65_536;
export const MAX_FONT_INSPECTION_SERIALIZED_CODE_UNITS = 4_000_000;
const MAX_FONT_INSPECTION_LABEL_CODE_UNITS = 1_024;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const OPEN_TYPE_TAG_PATTERN = /^[A-Za-z0-9]{4}$/;
const AXIS_METADATA_ERRORS = new Set([
  'Axis metadata is not valid JSON.',
  'Axis metadata has an unsupported schema.',
  'Axis metadata contains an invalid range.',
  'Axis metadata contains an invalid axis.',
  'Axis metadata contains an empty axis tuple.',
]);
const TYPOGRAPHY_FIELDS = new Set(Object.keys(TYPOGRAPHY_VARIABLE_FIELDS));

function normalizedRequest(request) {
  return parseFontInspectionRequest(fontInspectionArgvFromRequest(request));
}

export function fontInspectionCode(request) {
  const input = normalizedRequest(request);
  const capture = fontInspectCode({
    ...input,
    bounds: {
      maxCharacters: MAX_FONT_INSPECTION_CHARACTERS,
      maxSegments: MAX_FONT_INSPECTION_SEGMENTS,
      maxFacts: MAX_FONT_INSPECTION_FACTS,
      maxString: MAX_FONT_INSPECTION_STRING_CODE_UNITS,
    },
  });
  return `(async () => {
    const captured = await ${capture};
    const payload = { schemaVersion: 1, ...captured };
    const serialized = JSON.stringify(payload);
    if (serialized.length > ${MAX_FONT_INSPECTION_SERIALIZED_CODE_UNITS}) {
      throw new Error('Font Inspection serialized-size limit exceeded.');
    }
    return serialized;
  })()`;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function boundedString(value, limit = MAX_FONT_INSPECTION_STRING_CODE_UNITS) {
  return typeof value === 'string' && value.length <= limit;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeIndex(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validVariable(value) {
  return exactKeys(value, ['id', 'name'])
    && boundedString(value.id, MAX_FONT_INSPECTION_LABEL_CODE_UNITS)
    && value.id.length > 0
    && (value.name === null || boundedString(value.name, MAX_FONT_INSPECTION_LABEL_CODE_UNITS));
}

function validBoundVariables(value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  state.facts += entries.length;
  return state.facts <= MAX_FONT_INSPECTION_FACTS
    && entries.every(([field, variable]) => TYPOGRAPHY_FIELDS.has(field)
      && validVariable(variable));
}

function validFeatures(value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  state.facts += entries.length;
  return state.facts <= MAX_FONT_INSPECTION_FACTS
    && entries.every(([tag, enabled]) => OPEN_TYPE_TAG_PATTERN.test(tag)
      && typeof enabled === 'boolean');
}

function validSegment(value, input, state) {
  const keys = [
    'start', 'end', 'characters', 'fontName', 'fontSize', 'fontWeight',
    'enabledOpenTypeFeatures', 'boundVariables',
    ...(input.allOpenType ? ['openTypeFeatures'] : []),
  ];
  if (!exactKeys(value, keys)
    || !safeIndex(value.start) || !safeIndex(value.end) || value.end < value.start
    || !boundedString(value.characters, MAX_FONT_INSPECTION_CHARACTERS)
    || !exactKeys(value.fontName, ['family', 'style'])
    || !boundedString(value.fontName.family, MAX_FONT_INSPECTION_LABEL_CODE_UNITS)
    || !boundedString(value.fontName.style, MAX_FONT_INSPECTION_LABEL_CODE_UNITS)
    || !finiteNumber(value.fontSize) || !finiteNumber(value.fontWeight)
    || !Array.isArray(value.enabledOpenTypeFeatures)
    || !value.enabledOpenTypeFeatures.every((tag) => OPEN_TYPE_TAG_PATTERN.test(tag))
    || new Set(value.enabledOpenTypeFeatures).size !== value.enabledOpenTypeFeatures.length
    || [...value.enabledOpenTypeFeatures].sort().some(
      (tag, index) => tag !== value.enabledOpenTypeFeatures[index],
    )
    || !validBoundVariables(value.boundVariables, state)) return false;
  state.facts += value.enabledOpenTypeFeatures.length;
  if (state.facts > MAX_FONT_INSPECTION_FACTS) return false;
  if (!input.allOpenType) return true;
  if (!validFeatures(value.openTypeFeatures, state)) return false;
  const enabled = Object.keys(value.openTypeFeatures)
    .filter((tag) => value.openTypeFeatures[tag] === true).sort();
  return enabled.length === value.enabledOpenTypeFeatures.length
    && enabled.every((tag, index) => tag === value.enabledOpenTypeFeatures[index]);
}

function validAxisMetadata(value, state) {
  const withError = value && Object.hasOwn(value, 'error');
  if (!exactKeys(value, [
    'schemaVersion', 'ranges', 'source', 'appliedToFont', ...(withError ? ['error'] : []),
  ]) || value.schemaVersion !== 1 || value.source !== 'plugin-data'
    || value.appliedToFont !== false || !Array.isArray(value.ranges)
    || value.ranges.length > MAX_FONT_INSPECTION_SEGMENTS
    || (withError && !AXIS_METADATA_ERRORS.has(value.error))) return false;
  for (const range of value.ranges) {
    if (!exactKeys(range, ['start', 'end', 'axes'])
      || !safeIndex(range.start) || !safeIndex(range.end) || range.end < range.start
      || !range.axes || typeof range.axes !== 'object' || Array.isArray(range.axes)) return false;
    const axes = Object.entries(range.axes);
    state.facts += axes.length;
    if (state.facts > MAX_FONT_INSPECTION_FACTS || axes.length === 0
      || !axes.every(([tag, axisValue]) => OPEN_TYPE_TAG_PATTERN.test(tag)
        && finiteNumber(axisValue))) return false;
  }
  return !withError || value.ranges.length === 0;
}

function validApiLimits(value) {
  return exactKeys(value, ['exactVariationAxes', 'fontWeight', 'openTypeFeatures'])
    && value.exactVariationAxes === false
    && value.fontWeight === 'read-only Figma value; not a general variation-axis tuple'
    && value.openTypeFeatures === 'read-only';
}

function validPayload(value, input) {
  if (!exactKeys(value, [
    'schemaVersion', 'id', 'name', 'characters', 'range', 'segments',
    'axisMetadata', 'apiLimits',
  ]) || value.schemaVersion !== 1
    || !boundedString(value.id, MAX_FONT_INSPECTION_LABEL_CODE_UNITS)
    || !NODE_ID_PATTERN.test(value.id)
    || !boundedString(value.name, MAX_FONT_INSPECTION_LABEL_CODE_UNITS)
    || !boundedString(value.characters, MAX_FONT_INSPECTION_CHARACTERS)
    || !exactKeys(value.range, ['start', 'end'])
    || !safeIndex(value.range.start) || !safeIndex(value.range.end)
    || value.range.end < value.range.start || value.range.end > value.characters.length
    || !Array.isArray(value.segments)
    || value.segments.length > MAX_FONT_INSPECTION_SEGMENTS
    || !validApiLimits(value.apiLimits)) return false;

  const expectedStart = input.start === null ? 0 : input.start;
  const expectedEnd = input.end === null ? value.characters.length : input.end;
  if (value.range.start !== expectedStart || value.range.end !== expectedEnd) return false;

  const state = { facts: 0 };
  let cursor = value.range.start;
  const characterParts = [];
  for (const segment of value.segments) {
    if (!validSegment(segment, input, state) || segment.start !== cursor
      || segment.end > value.range.end || segment.characters.length !== segment.end - segment.start) {
      return false;
    }
    cursor = segment.end;
    characterParts.push(segment.characters);
  }
  if (cursor !== value.range.end
    || characterParts.join('') !== value.characters.slice(value.range.start, value.range.end)) return false;
  return validAxisMetadata(value.axisMetadata, state);
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export async function executeFontInspection(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeFontInspection requires evaluate(code)');
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(fontInspectionCode(input));
  if (typeof serialized !== 'string'
    || serialized.length > MAX_FONT_INSPECTION_SERIALIZED_CODE_UNITS) {
    throw new Error('Font Inspection returned an invalid bounded result.');
  }
  let payload;
  try { payload = JSON.parse(serialized); }
  catch { throw new Error('Font Inspection returned invalid JSON.'); }
  if (!validPayload(payload, input)) {
    throw new Error('Font Inspection returned an invalid bounded result.');
  }
  const { schemaVersion: _schemaVersion, ...projection } = payload;
  return { stdout: safePrettyJson(projection), stderr: '', result: payload };
}

export function fontInspectionPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Font Inspection routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === FONT_INSPECTION_APPLICATION_ID
    ? 'command-application' : 'not-font-inspection';
}

export async function executeFontInspectionPlan(plan, adapters = {}) {
  if (fontInspectionPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Font Inspection Command Application.`);
  }
  return executeFontInspection(parseFontInspectionRequest(plan.argv), adapters);
}
