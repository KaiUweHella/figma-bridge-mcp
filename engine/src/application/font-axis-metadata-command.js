// Bounded, readback-verified metadata-only variable-font axis Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { FONT_AXIS_METADATA_KEY } from '../lib/font-introspection.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import {
  FONT_AXIS_METADATA_ACTIONS,
  fontAxisMetadataArgvFromRequest,
  fontAxisMetadataPlanningArgvFromRequest,
  MAX_FONT_AXIS_COUNT,
  MAX_FONT_AXIS_INDEX,
  parseFontAxisMetadataRequest,
} from './font-axis-metadata-request.js';

export { fontAxisMetadataArgvFromRequest, fontAxisMetadataPlanningArgvFromRequest } from './font-axis-metadata-request.js';
export const MAX_FONT_AXIS_METADATA_RANGES = 1_024;
export const MAX_FONT_AXIS_METADATA_CODE_UNITS = 90_000;
export const MAX_FONT_AXIS_METADATA_RESULT_CODE_UNITS = 256_000;
const NOTE = 'Stored intent only; Figma glyph rendering was not changed.';
const APPLICATION_IDS = new Set(FONT_AXIS_METADATA_ACTIONS.map((action) => `font.${action}`));
const METADATA_ERRORS = Object.freeze([
  'Axis metadata is not valid JSON.',
  'Axis metadata has an unsupported schema.',
  'Axis metadata contains an invalid range.',
  'Axis metadata contains an invalid axis.',
  'Axis metadata contains an empty axis tuple.',
  'Axis metadata exceeds its bounded size.',
  'Axis metadata exceeds its bounded range count.',
]);
const normalized = (request) => parseFontAxisMetadataRequest(fontAxisMetadataArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function fontAxisMetadataCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)}; const metadataKey = ${js(FONT_AXIS_METADATA_KEY)}; const note = ${js(NOTE)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_FONT_AXIS_METADATA_RESULT_CODE_UNITS}) throw new Error('Font Axis Metadata result exceeded its bounded response limit.'); return serialized; };
    const read = (raw) => {
      if (typeof raw !== 'string' || raw.length > ${MAX_FONT_AXIS_METADATA_CODE_UNITS}) return { schemaVersion: 1, ranges: [], error: 'Axis metadata exceeds its bounded size.' };
      if (!raw) return { schemaVersion: 1, ranges: [] };
      let parsed; try { parsed = JSON.parse(raw); } catch { return { schemaVersion: 1, ranges: [], error: 'Axis metadata is not valid JSON.' }; }
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.ranges)) return { schemaVersion: 1, ranges: [], error: 'Axis metadata has an unsupported schema.' };
      if (parsed.ranges.length > ${MAX_FONT_AXIS_METADATA_RANGES}) return { schemaVersion: 1, ranges: [], error: 'Axis metadata exceeds its bounded range count.' };
      const ranges = [];
      for (const range of parsed.ranges) {
        if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end > ${MAX_FONT_AXIS_INDEX} || !range.axes || typeof range.axes !== 'object' || Array.isArray(range.axes)) return { schemaVersion: 1, ranges: [], error: 'Axis metadata contains an invalid range.' };
        const entries = Object.entries(range.axes); if (!entries.length) return { schemaVersion: 1, ranges: [], error: 'Axis metadata contains an empty axis tuple.' }; if (entries.length > ${MAX_FONT_AXIS_COUNT}) return { schemaVersion: 1, ranges: [], error: 'Axis metadata contains an invalid axis.' };
        const axes = {}; for (const [tag, value] of entries) { if (!/^[A-Za-z0-9]{4}$/.test(tag) || !Number.isFinite(value)) return { schemaVersion: 1, ranges: [], error: 'Axis metadata contains an invalid axis.' }; axes[tag] = value; }
        ranges.push({ start: range.start, end: range.end, axes });
      }
      ranges.sort((left, right) => left.start - right.start || left.end - right.end);
      if (new Set(ranges.map((range) => range.start + ':' + range.end)).size !== ranges.length) return { schemaVersion: 1, ranges: [], error: 'Axis metadata contains an invalid range.' };
      return { schemaVersion: 1, ranges };
    };
    const nodeFacts = (node) => { if (!node || node.type !== 'TEXT' || typeof node.id !== 'string' || !node.id.length || node.id.length > 512 || typeof node.name !== 'string' || node.name.length > 1024 || typeof node.characters !== 'string' || node.characters.length > ${MAX_FONT_AXIS_INDEX} || typeof node.getPluginData !== 'function') throw new Error('Font Axis Metadata requires one bounded TEXT node.'); return { id: clean(node.id, 512), name: clean(node.name, 1024) }; };
    const rangeFor = (node) => { const start = request.start == null ? 0 : request.start; const end = request.end == null ? node.characters.length : request.end; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > node.characters.length) throw new Error('Font axis metadata range is outside the target text.'); return { start, end }; };
    if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Figma node lookup is unavailable.');
    const node = await figma.getNodeByIdAsync(request.nodeId); const identity = nodeFacts(node); const beforeRaw = node.getPluginData(metadataKey); const before = read(beforeRaw);
    if (request.action === 'axes') return bounded({ ...identity, source: 'plugin-data', appliedToFont: false, ...before });
    const refusal = (failure) => bounded({ schemaVersion: 1, status: 'refused', action: request.action, outcome: 'no-mutation', attempted: 0, failure: clean(failure, 1024) });
    if (typeof node.setPluginData !== 'function') return refusal('Target TEXT node does not support Plugin Data writes.');
    let range = null; let desiredRaw = ''; let result;
    if (request.action === 'remember-axes') {
      if (before.error) return refusal(before.error + ' Clear it with font forget-axes before writing new metadata.');
      range = rangeFor(node); const ranges = before.ranges.filter((item) => item.start !== range.start || item.end !== range.end); ranges.push({ ...range, axes: request.axes }); ranges.sort((left, right) => left.start - right.start || left.end - right.end);
      if (ranges.length > ${MAX_FONT_AXIS_METADATA_RANGES}) return refusal('Axis metadata exceeds its bounded range count.');
      desiredRaw = JSON.stringify({ schemaVersion: 1, ranges }); if (desiredRaw.length > ${MAX_FONT_AXIS_METADATA_CODE_UNITS}) return refusal('Axis metadata exceeds the Figma Plugin Data bound.');
      result = { ...identity, range, axes: request.axes, source: 'plugin-data', appliedToFont: false, note };
    } else if (request.start == null && request.end == null) {
      desiredRaw = ''; result = { ...identity, cleared: before.error ? null : before.ranges.length, all: true, source: 'plugin-data', appliedToFont: false };
    } else {
      if (before.error) return refusal(before.error + ' Omit --start/--end to clear all corrupted metadata.');
      range = rangeFor(node); const ranges = before.ranges.filter((item) => item.start !== range.start || item.end !== range.end); desiredRaw = ranges.length ? JSON.stringify({ schemaVersion: 1, ranges }) : '';
      result = { ...identity, range, cleared: before.ranges.length - ranges.length, all: false, source: 'plugin-data', appliedToFont: false };
    }
    if (beforeRaw === desiredRaw) return bounded({ schemaVersion: 1, status: 'unchanged', action: request.action, outcome: 'no-mutation', attempted: 0, result, residueCount: 0, warnings: [] });
    let mutationError = null; try { node.setPluginData(metadataKey, desiredRaw); } catch (error) { mutationError = error; }
    try { const fresh = await figma.getNodeByIdAsync(request.nodeId); const freshIdentity = nodeFacts(fresh); if (freshIdentity.id === identity.id && freshIdentity.name === identity.name && fresh.getPluginData(metadataKey) === desiredRaw) return bounded({ schemaVersion: 1, status: 'applied', action: request.action, outcome: mutationError ? 'verified-after-error' : 'verified', attempted: 1, result, residueCount: 0, warnings: mutationError ? ['The Plugin Data setter reported an error, but fresh readback proved the complete requested metadata.'] : [] }); } catch (error) { mutationError ||= error; }
    try { node.setPluginData(metadataKey, beforeRaw); } catch {}
    try { const restored = await figma.getNodeByIdAsync(request.nodeId); const restoredIdentity = nodeFacts(restored); const residue = restoredIdentity.id === identity.id && restoredIdentity.name === identity.name && restored.getPluginData(metadataKey) === beforeRaw ? 0 : 1; return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: residue ? 'partial-residue' : 'rolled-back', attempted: 1, restored: residue ? 0 : 1, residueCount: residue, failure: clean(mutationError && mutationError.message ? mutationError.message : String(mutationError || 'Fresh metadata postcondition failed.'), 1024) }); } catch (error) { return bounded({ schemaVersion: 1, status: 'failed', action: request.action, outcome: 'verification-unavailable', attempted: 1, restored: 0, residueCount: 1, failure: clean(mutationError && mutationError.message ? mutationError.message : String(mutationError || error), 1024) }); }
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, maximum, empty = true) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_FONT_AXIS_INDEX;
function validAxes(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length >= 1 && Object.keys(value).length <= MAX_FONT_AXIS_COUNT && Object.entries(value).every(([tag, number]) => /^[A-Za-z0-9]{4}$/.test(tag) && Number.isFinite(number)); }
function validRange(value) { return exact(value, ['start','end','axes']) && safeInteger(value.start) && safeInteger(value.end) && value.end >= value.start && validAxes(value.axes); }
function rangeMatches(value,input) { return exact(value,['start','end']) && safeInteger(value.start) && safeInteger(value.end) && value.end >= value.start && (input.start === null || value.start === input.start) && (input.end === null || value.end === input.end); }
function validIdentity(value, input) { return value.id === input.nodeId && text(value.id,512,false) && NODE_REFERENCE_PATTERN.test(value.id) && text(value.name,1024); }
function validResult(value, input) {
  if (!value || !validIdentity(value,input) || value.source !== 'plugin-data' || value.appliedToFont !== false) return false;
  if (input.action === 'axes') {
    const withError = Object.hasOwn(value,'error'); return exact(value,withError ? ['id','name','source','appliedToFont','schemaVersion','ranges','error'] : ['id','name','source','appliedToFont','schemaVersion','ranges']) && value.schemaVersion === 1 && Array.isArray(value.ranges) && value.ranges.length <= MAX_FONT_AXIS_METADATA_RANGES && value.ranges.every(validRange) && new Set(value.ranges.map((range) => `${range.start}:${range.end}`)).size === value.ranges.length && (!withError || METADATA_ERRORS.includes(value.error) && value.ranges.length === 0);
  }
  if (input.action === 'remember-axes') return exact(value,['id','name','range','axes','source','appliedToFont','note']) && rangeMatches(value.range,input) && validAxes(value.axes) && JSON.stringify(value.axes) === JSON.stringify(input.axes) && value.note === NOTE;
  const all = value.all === true; return exact(value,all ? ['id','name','cleared','all','source','appliedToFont'] : ['id','name','range','cleared','all','source','appliedToFont']) && typeof value.all === 'boolean' && (value.cleared === null || safeInteger(value.cleared) && value.cleared <= MAX_FONT_AXIS_METADATA_RANGES) && (all ? input.start === null && input.end === null : rangeMatches(value.range,input));
}
function validSuccess(value,input) { const unchanged = value?.status === 'unchanged'; return exact(value,['schemaVersion','status','action','outcome','attempted','result','residueCount','warnings']) && value.schemaVersion === 1 && ['unchanged','applied'].includes(value.status) && value.action === input.action && validResult(value.result,input) && value.residueCount === 0 && Array.isArray(value.warnings) && value.warnings.length <= 1 && value.warnings.every((item) => text(item,1024,false)) && (unchanged ? value.outcome === 'no-mutation' && value.attempted === 0 && value.warnings.length === 0 : ['verified','verified-after-error'].includes(value.outcome) && value.attempted === 1 && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)); }
function validRefusal(value,input) { return exact(value,['schemaVersion','status','action','outcome','attempted','failure']) && value.schemaVersion === 1 && value.status === 'refused' && value.action === input.action && value.outcome === 'no-mutation' && value.attempted === 0 && text(value.failure,1024,false); }
function validFailure(value,input) { return exact(value,['schemaVersion','status','action','outcome','attempted','restored','residueCount','failure']) && value.schemaVersion === 1 && value.status === 'failed' && value.action === input.action && ['rolled-back','partial-residue','verification-unavailable'].includes(value.outcome) && value.attempted === 1 && value.restored === (value.outcome === 'rolled-back' ? 1 : 0) && value.residueCount === (value.outcome === 'rolled-back' ? 0 : 1) && text(value.failure,1024,false); }
function invalid(message) { const error = new Error(message); Object.assign(error,{kind:'plugin-result',phase:'plugin-response',outcome:'unknown-after-dispatch',dispatchState:'failed'}); return error; }
function mutationError(message,outcome,report) { const error = new Error(message); Object.assign(error,{kind:'execution',phase:'plugin-execution',outcome:'unknown-after-dispatch',dispatchState:'failed',mutationOutcome:outcome,mutationReport:report}); return error; }
function safe(value) { return JSON.stringify(value,null,2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,(character)=>`\\u${character.charCodeAt(0).toString(16).padStart(4,'0')}`); }

export async function executeFontAxisMetadata(request,adapters={}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Font Axis Metadata requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(fontAxisMetadataCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_FONT_AXIS_METADATA_RESULT_CODE_UNITS) throw invalid('Font Axis Metadata returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Font Axis Metadata returned invalid JSON.'); }
  if (input.action === 'axes') { if (!validResult(payload,input)) throw invalid('Font Axis Metadata returned an invalid bounded result.'); return {stdout:safe(payload),stderr:input.warning ? `⚠ ${input.warning}` : '',code:0,result:payload}; }
  if (payload?.status === 'refused') { if (!validRefusal(payload,input)) throw invalid('Font Axis Metadata returned an invalid bounded result.'); throw mutationError(`Font Axis Metadata made no mutation: ${payload.failure}`,'no-mutation',{version:1,outcome:'no-mutation',attempted:0,restored:0,residueCount:0}); }
  if (payload?.status === 'failed') { if (!validFailure(payload,input)) throw invalid('Font Axis Metadata returned an invalid bounded result.'); throw mutationError(`Font Axis Metadata failed with ${payload.outcome}: ${payload.failure}`,payload.outcome,{version:1,outcome:payload.outcome,attempted:1,restored:payload.restored,residueCount:payload.residueCount}); }
  if (!validSuccess(payload,input)) throw invalid('Font Axis Metadata returned an invalid bounded result.');
  const prefix = input.action === 'remember-axes' ? '✓ Variable-font axis intent stored as plugin metadata.\n' : '✓ Variable-font axis metadata removed.\n';
  return {stdout:prefix + safe(payload.result),stderr:input.warning ? `⚠ ${input.warning}` : '',code:0,result:payload};
}
export function fontAxisMetadataPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Font Axis Metadata routing requires a Command Plan.'); return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-font-axis-metadata'; }
export function executeFontAxisMetadataPlan(plan,adapters={}) { if (fontAxisMetadataPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Font Axis Metadata.'); return executeFontAxisMetadata(parseFontAxisMetadataRequest(plan.argv),adapters); }
