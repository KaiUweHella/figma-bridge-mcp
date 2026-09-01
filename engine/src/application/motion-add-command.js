// Plan-bound, freshly verified and rollback-owned `motion add` Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { mapField, normalizeSpec, parseKeys } from '../lib/motion-core.js';
import {
  motionAddArgvFromRequest,
  motionAddPlanningArgvFromRequest,
  parseMotionAddRequest,
} from './motion-add-request.js';

export { motionAddArgvFromRequest, motionAddPlanningArgvFromRequest } from './motion-add-request.js';

export const MAX_MOTION_ADD_CHILDREN = 256;
export const MAX_MOTION_ADD_TIMELINES = 256;
export const MAX_MOTION_ADD_PAINTS = 256;
export const MAX_MOTION_ADD_SNAPSHOT_CODE_UNITS = 1_750_000;
export const MAX_MOTION_ADD_RESULT_CODE_UNITS = 64_000;
const MAX_ID_CODE_UNITS = 512;
const MAX_NAME_CODE_UNITS = 4_096;
const MAX_FAILURE_CODE_UNITS = 1_024;
const APPLICATION_ID = 'motion.add';
const normalized = (request) => parseMotionAddRequest(motionAddArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu;

function nativeTrack(input) {
  const mapped = mapField(input.field);
  let track;
  if (input.mode === 'keys') {
    track = { keyframes: parseKeys(input.keys, mapped.valueType) };
  } else {
    const normalizedSpec = normalizeSpec({ tracks: [{
      node: input.nodeId,
      field: input.field,
      keys: [
        { t: input.offset, v: input.from },
        { t: input.offset + input.duration, v: input.to, ease: input.easing },
      ],
    }] });
    const entry = normalizedSpec.byNode[input.nodeId][mapped.name];
    track = mapped.valueType === 'COLOR' ? entry[mapped.index] : entry;
  }
  return {
    field: mapped.valueType === 'COLOR'
      ? { type: 'INDEXED_ITEM', collection: mapped.name, index: mapped.index }
      : { type: 'PROPERTY', name: mapped.name },
    track,
    keyframeCount: track.keyframes.length,
    timelineEnd: input.mode === 'keys' ? input.duration : input.offset + input.duration,
  };
}

export function motionAddCode(request) {
  const input = normalized(request);
  const prepared = nativeTrack(input);
  return `(async () => {
    const request = ${js(input)};
    const prepared = ${js(prepared)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const text = (value, label, maximum, empty = true) => { if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length)) throw new Error(label + ' is invalid.'); return value; };
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_MOTION_ADD_RESULT_CODE_UNITS}) throw new Error('Motion Add result exceeded its bounded response limit.'); return serialized; };
    const copy = (value, label) => { const serialized = JSON.stringify(value); if (typeof serialized !== 'string' || serialized.length > ${MAX_MOTION_ADD_SNAPSHOT_CODE_UNITS}) throw new Error(label + ' exceeded its bounded snapshot limit.'); const result = JSON.parse(serialized); if (JSON.stringify(result) !== serialized) throw new Error(label + ' is not exact JSON.'); return result; };
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const failureText = (error, fallback) => clean(error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const nodeFact = (node, descended, fromName) => ({ requestedId: request.nodeId, id: text(node.id, 'Motion node id', ${MAX_ID_CODE_UNITS}, false), name: text(node.name, 'Motion node name', ${MAX_NAME_CODE_UNITS}), descended, fromName });
    const resolve = async () => {
      if (figma.editorType !== 'figma') throw new Error('Motion Add requires Figma Design.');
      if (!figma.motion || typeof figma.motion !== 'object') throw new Error('Motion API is not enabled for this Figma account.');
      if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Motion Add requires the asynchronous node API.');
      const requested = await figma.getNodeByIdAsync(request.nodeId);
      if (!requested) throw new Error('Motion target was not found.');
      let node = requested; let descended = false; let fromName = null;
      const topLevel = requested.parent && requested.parent.type === 'PAGE';
      const container = ['FRAME','COMPONENT','COMPONENT_SET','GROUP','SECTION','INSTANCE'].includes(requested.type);
      if (topLevel && container) {
        if (!Array.isArray(requested.children)) throw new Error('Motion target children are invalid.');
        if (requested.children.length === 0) throw new Error('Top-level Motion target has no children.');
        if (requested.children.length > 1) {
          if (requested.children.length > ${MAX_MOTION_ADD_CHILDREN}) throw new Error('Top-level Motion target has too many children.');
          const choices = requested.children.map((child) => text(child.id, 'Motion child id', ${MAX_ID_CODE_UNITS}, false) + ' ' + text(child.name, 'Motion child name', ${MAX_NAME_CODE_UNITS}));
          throw new Error('Top-level Motion target is ambiguous; choose one child by id: ' + choices.join(', '));
        }
        node = requested.children[0]; descended = true; fromName = text(requested.name, 'Motion source name', ${MAX_NAME_CODE_UNITS});
      }
      text(node.id, 'Motion node id', ${MAX_ID_CODE_UNITS}, false);
      text(node.name, 'Motion node name', ${MAX_NAME_CODE_UNITS});
      if (typeof node.applyManualKeyframeTrack !== 'function' || typeof node.removeManualKeyframeTrack !== 'function'
        || !('manualKeyframeTracks' in node)) throw new Error('Motion target does not support reversible manual tracks.');
      if (prepared.field.type === 'INDEXED_ITEM') {
        const paints = node[prepared.field.collection];
        if (!Array.isArray(paints) || paints.length > ${MAX_MOTION_ADD_PAINTS}) throw new Error('Motion paint inventory is unavailable or excessive.');
        const paint = paints[prepared.field.index];
        if (!paint || paint.type !== 'SOLID') throw new Error('Motion color track requires an existing solid paint at the requested index.');
      }
      return { node, descended, fromName };
    };
    const manualTracks = (node) => {
      const snapshot = copy(node.manualKeyframeTracks, 'Motion manual tracks');
      if (!record(snapshot)) throw new Error('Motion manual track facts are invalid.');
      return snapshot;
    };
    const timelines = (node) => {
      if (!Array.isArray(node.timelines) || node.timelines.length > ${MAX_MOTION_ADD_TIMELINES}) throw new Error('Motion timelines exceeded their bounded limit.');
      const result = node.timelines.map((timeline) => {
        if (!record(timeline) || typeof timeline.id !== 'string' || !timeline.id.length || timeline.id.length > ${MAX_ID_CODE_UNITS}
          || !Number.isFinite(timeline.duration) || timeline.duration < 0) throw new Error('Motion timeline facts are invalid.');
        return { id: timeline.id, duration: timeline.duration };
      });
      if (new Set(result.map((timeline) => timeline.id)).size !== result.length) throw new Error('Motion timeline identities are duplicated.');
      return result;
    };
    const targetBinding = (snapshot) => {
      if (prepared.field.type === 'PROPERTY') return Object.hasOwn(snapshot, prepared.field.name)
        ? { exists: true, binding: copy(snapshot[prepared.field.name], 'Existing Motion track') }
        : { exists: false, binding: null };
      const collection = snapshot[prepared.field.collection];
      const index = String(prepared.field.index);
      return record(collection) && Object.hasOwn(collection, index)
        ? { exists: true, binding: copy(collection[index], 'Existing Motion paint track') }
        : { exists: false, binding: null };
    };
    const expectedTracks = (snapshot) => {
      const expected = copy(snapshot, 'Expected Motion tracks');
      if (prepared.field.type === 'PROPERTY') expected[prepared.field.name] = copy(prepared.track, 'Requested Motion track');
      else {
        const collection = prepared.field.collection;
        if (!record(expected[collection])) expected[collection] = {};
        expected[collection][String(prepared.field.index)] = copy(prepared.track, 'Requested Motion paint track');
      }
      return expected;
    };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: failureText(error, 'Motion Add preflight failed') });
    const failed = (outcome, restored, error, residue) => bounded({ schemaVersion: 1, status: 'failed', outcome, attempted: 1, restored, residue, failure: failureText(error, 'Motion Add postcondition failed') });
    const success = (outcome, attempted, target, replaced, afterTimelines, mutationError) => bounded({
      schemaVersion: 1, status: 'applied', outcome, attempted,
      node: nodeFact(target.node, target.descended, target.fromName), field: request.field,
      duration: prepared.timelineEnd, keyframeCount: prepared.keyframeCount, replaced,
      timelineDuration: afterTimelines[0]?.duration ?? null, residue: [],
      warnings: mutationError ? ['A native Motion mutation reported an error, but fresh readback proved the complete requested state.'] : [],
    });

    let target; let beforeTracks; let beforeTimelines; let beforeBinding; let expected; let expectedTimelines;
    try {
      target = await resolve();
      beforeTracks = manualTracks(target.node);
      beforeTimelines = timelines(target.node);
      beforeBinding = targetBinding(beforeTracks);
      expected = expectedTracks(beforeTracks);
      expectedTimelines = beforeTimelines.map((timeline, index) => index === 0 && timeline.duration < prepared.timelineEnd
        ? { ...timeline, duration: prepared.timelineEnd } : timeline);
      if (beforeTimelines[0] && beforeTimelines[0].duration < prepared.timelineEnd
        && typeof target.node.setTimelineDuration !== 'function') throw new Error('Motion target cannot extend its timeline.');
    } catch (error) { return refusal(error); }
    const trackChanged = !beforeBinding.exists || !same(beforeBinding.binding, prepared.track);
    const timelineChanged = !same(beforeTimelines, expectedTimelines);
    if (!trackChanged && !timelineChanged) return success('no-op', 0, target, false, beforeTimelines, null);

    let trackAttempted = false; let timelineAttempted = false; let mutationError = null;
    try {
      if (trackChanged) { trackAttempted = true; target.node.applyManualKeyframeTrack(prepared.field, prepared.track); }
      if (timelineChanged) {
        timelineAttempted = true;
        target.node.setTimelineDuration(beforeTimelines[0].id, prepared.timelineEnd);
      }
    } catch (error) { mutationError = error; }
    const fresh = async () => {
      const node = await figma.getNodeByIdAsync(target.node.id);
      if (!node) throw new Error('Fresh Motion Add target is unavailable.');
      return { node, tracks: manualTracks(node), timelines: timelines(node) };
    };
    let after = null;
    try {
      after = await fresh();
      if (same(after.tracks, expected) && same(after.timelines, expectedTimelines)) {
        delete globalThis.__invCache;
        return success(mutationError ? 'verified-after-error' : 'verified', 1, target,
          beforeBinding.exists && trackChanged, after.timelines, mutationError);
      }
    } catch (error) { mutationError ||= error; }
    if (after && same(after.tracks, beforeTracks) && same(after.timelines, beforeTimelines)) return failed('unchanged', 0, mutationError, ['motion-state']);

    let rollbackError = null;
    try {
      const node = await figma.getNodeByIdAsync(target.node.id);
      if (!node) throw new Error('Motion Add rollback target is unavailable.');
      if (trackAttempted) {
        try {
          if (beforeBinding.exists) node.applyManualKeyframeTrack(prepared.field, beforeBinding.binding);
          else node.removeManualKeyframeTrack(prepared.field);
        } catch (error) { rollbackError ||= error; }
      }
      if (timelineAttempted) {
        try {
          if (typeof node.setTimelineDuration !== 'function') throw new Error('Motion timeline rollback is unavailable.');
          node.setTimelineDuration(beforeTimelines[0].id, beforeTimelines[0].duration);
        } catch (error) { rollbackError ||= error; }
      }
    } catch (error) { rollbackError = error; }
    try {
      const restored = await fresh();
      if (same(restored.tracks, beforeTracks) && same(restored.timelines, beforeTimelines)) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, mutationError || rollbackError, []);
      }
      const residue = [];
      if (!same(restored.tracks, beforeTracks)) residue.push('manual-track-state');
      if (!same(restored.timelines, beforeTimelines)) residue.push('timeline-state');
      return failed('partial-residue', 0, mutationError || rollbackError, residue);
    } catch (error) { return failed('verification-unavailable', 0, mutationError || rollbackError || error, []); }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function text(value, maximum, empty = true) { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0); }
function validNode(value, input) {
  return exact(value, ['requestedId','id','name','descended','fromName'])
    && value.requestedId === input.nodeId && text(value.id, MAX_ID_CODE_UNITS, false)
    && text(value.name, MAX_NAME_CODE_UNITS) && typeof value.descended === 'boolean'
    && (value.fromName === null || text(value.fromName, MAX_NAME_CODE_UNITS))
    && (value.descended ? value.fromName !== null && value.id !== input.nodeId : value.fromName === null && value.id === input.nodeId);
}
function validSuccess(value, input, prepared) {
  const valid = exact(value, ['schemaVersion','status','outcome','attempted','node','field','duration','keyframeCount','replaced','timelineDuration','residue','warnings'])
    && value.schemaVersion === 1 && value.status === 'applied'
    && ['verified','verified-after-error','no-op'].includes(value.outcome) && [0,1].includes(value.attempted)
    && validNode(value.node, input) && value.field === input.field && value.duration === prepared.timelineEnd
    && value.keyframeCount === prepared.keyframeCount && typeof value.replaced === 'boolean'
    && (value.timelineDuration === null || Number.isFinite(value.timelineDuration) && value.timelineDuration >= prepared.timelineEnd)
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings) && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
  if (!valid) return false;
  return value.outcome === 'no-op' ? value.attempted === 0 && value.replaced === false : value.attempted === 1;
}
function validRefusal(value) {
  return exact(value, ['schemaVersion','status','outcome','attempted','failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.outcome === 'no-mutation'
    && value.attempted === 0 && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}
function validFailure(value) {
  return exact(value, ['schemaVersion','status','outcome','attempted','restored','residue','failure'])
    && value.schemaVersion === 1 && value.status === 'failed'
    && ['unchanged','rolled-back','partial-residue','verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0,1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 2
    && value.residue.every((item) => ['motion-state','manual-track-state','timeline-state'].includes(item))
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false)
    && (value.outcome !== 'rolled-back' || value.restored === 1 && value.residue.length === 0)
    && (value.outcome !== 'unchanged' || value.restored === 0 && value.residue.length === 1 && value.residue[0] === 'motion-state')
    && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0)
    && (value.outcome !== 'verification-unavailable' || value.restored === 0 && value.residue.length === 0);
}
function pluginResultError(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function safeText(value) { return String(value).replace(UNSAFE_TEXT, ' '); }

export async function executeMotionAdd(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Motion Add requires a Figma evaluate adapter.');
  const input = normalized(request);
  const prepared = nativeTrack(input);
  const serialized = await adapters.evaluate(motionAddCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_MOTION_ADD_RESULT_CODE_UNITS) throw pluginResultError('Motion Add returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Motion Add returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Motion Add returned an invalid bounded result.');
    throw mutationError(`Motion Add made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw pluginResultError('Motion Add returned an invalid bounded result.');
    throw mutationError(`Motion Add failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length });
  }
  if (!validSuccess(payload, input, prepared)) throw pluginResultError('Motion Add returned an invalid bounded result.');
  const via = payload.node.descended ? ` (via "${safeText(payload.node.fromName)}")` : '';
  return {
    stdout: `Animated ${safeText(payload.node.id)}  ${safeText(payload.node.name)}${via} → ${safeText(payload.field)} · timeline ${payload.duration}s`,
    stderr: payload.warnings.join('\n'),
    code: 0,
    result: payload,
  };
}

export function motionAddPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Motion Add routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-motion-add';
}

export function executeMotionAddPlan(plan, adapters = {}) {
  if (motionAddPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Motion Add.');
  return executeMotionAdd(parseMotionAddRequest(plan.argv), adapters);
}
