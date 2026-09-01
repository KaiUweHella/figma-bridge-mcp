// Conditional safe-read / rollback-owned Motion Timeline Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  motionTimelineArgvFromRequest,
  motionTimelinePlanningArgvFromRequest,
  parseMotionTimelineRequest,
} from './motion-timeline-request.js';

export { motionTimelineArgvFromRequest, motionTimelinePlanningArgvFromRequest } from './motion-timeline-request.js';

export const MAX_MOTION_TIMELINES = 256;
export const MAX_MOTION_TIMELINE_CHILDREN = 256;
export const MAX_MOTION_TIMELINE_RESULT_CODE_UNITS = 160_000;
const MAX_ID_CODE_UNITS = 512;
const MAX_NAME_CODE_UNITS = 4_096;
const APPLICATION_ID = 'motion.timeline';
const normalized = (request) => parseMotionTimelineRequest(motionTimelineArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu;

export function motionTimelineCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_MOTION_TIMELINE_RESULT_CODE_UNITS}) throw new Error('Motion Timeline result exceeded its bounded response limit.'); return serialized; };
    const text = (value, label, maximum, empty = true) => { if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length)) throw new Error(label + ' is invalid.'); return value; };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const timelinesOf = (node, label) => {
      const native = node.timelines === undefined ? [] : node.timelines;
      if (!Array.isArray(native) || native.length > ${MAX_MOTION_TIMELINES}) throw new Error(label + ' is invalid or excessive.');
      const timelines = native.map((timeline) => {
        if (!timeline || typeof timeline !== 'object' || !Number.isFinite(timeline.duration) || timeline.duration < 0) throw new Error(label + ' contains an invalid timeline.');
        return { id: text(timeline.id, label + ' id', ${MAX_ID_CODE_UNITS}, false), duration: timeline.duration };
      });
      if (new Set(timelines.map((timeline) => timeline.id)).size !== timelines.length) throw new Error(label + ' contains duplicate identities.');
      return timelines;
    };
    const refusal = (code, nodeName = null, children = []) => bounded({ schemaVersion: 1, status: 'refused', action: 'timeline', outcome: 'no-mutation', attempted: 0, code, nodeName, children });
    const failed = (outcome, error, residue = []) => bounded({ schemaVersion: 1, status: 'failed', action: 'timeline', outcome, attempted: 1, restored: outcome === 'rolled-back' ? 1 : 0, residue, failure: text(error && error.message ? error.message : String(error), 'Motion Timeline failure', 1024, false) });
    const success = (status, outcome, attempted, data, warnings = []) => bounded({ schemaVersion: 1, status, action: 'timeline', outcome, attempted, data, residue: [], warnings });
    let mutationAttempted = false;
    try {
      if (figma.editorType !== 'figma') return refusal('WRONG_EDITOR');
      if (!figma.motion || typeof figma.motion !== 'object') return refusal('MOTION_DISABLED');
      if (typeof figma.getNodeByIdAsync !== 'function') return refusal('INVALID_RUNTIME');
      const requested = await figma.getNodeByIdAsync(request.nodeId);
      if (!requested) return refusal('NOT_FOUND');
      let node = requested; let descended = false; let fromName = null;
      const topLevel = requested.parent && requested.parent.type === 'PAGE';
      const container = ['FRAME','COMPONENT','COMPONENT_SET','GROUP','SECTION','INSTANCE'].includes(requested.type);
      if (topLevel && container) {
        if (!Array.isArray(requested.children)) return refusal('INVALID_RUNTIME');
        if (requested.children.length === 0) return refusal('TOPLEVEL_EMPTY', text(requested.name, 'Motion target name', ${MAX_NAME_CODE_UNITS}));
        if (requested.children.length > 1) {
          if (requested.children.length > ${MAX_MOTION_TIMELINE_CHILDREN}) return refusal('TOO_MANY_CHILDREN', text(requested.name, 'Motion target name', ${MAX_NAME_CODE_UNITS}));
          const children = requested.children.map((child) => ({ id: text(child.id, 'Motion child id', ${MAX_ID_CODE_UNITS}, false), name: text(child.name, 'Motion child name', ${MAX_NAME_CODE_UNITS}) }));
          return refusal('TOPLEVEL_MULTI', text(requested.name, 'Motion target name', ${MAX_NAME_CODE_UNITS}), children);
        }
        node = requested.children[0]; descended = true; fromName = text(requested.name, 'Motion source name', ${MAX_NAME_CODE_UNITS});
      }
      const before = timelinesOf(node, 'Motion Timeline snapshot');
      const base = {
        requestedNodeId: request.nodeId,
        nodeId: text(node.id, 'Motion node id', ${MAX_ID_CODE_UNITS}, false),
        nodeName: text(node.name, 'Motion node name', ${MAX_NAME_CODE_UNITS}),
        descended,
        fromName,
      };
      if (request.duration === null) return success('read', 'verified', 0, { ...base, previousDuration: null, timelines: before });
      if (!before.length) return refusal('NO_TIMELINE', base.nodeName);
      if (typeof node.setTimelineDuration !== 'function') return refusal('INVALID_RUNTIME', base.nodeName);
      const timelineId = before[0].id; const previousDuration = before[0].duration;
      if (previousDuration === request.duration) return success('updated', 'no-op', 0, { ...base, previousDuration, timelines: before });
      let mutationError = null; let freshTimelines = null;
      mutationAttempted = true;
      try { node.setTimelineDuration(timelineId, request.duration); } catch (error) { mutationError = error; }
      try {
        const fresh = await figma.getNodeByIdAsync(base.nodeId); if (!fresh) throw new Error('Fresh Motion Timeline target is unavailable.');
        freshTimelines = timelinesOf(fresh, 'Fresh Motion Timeline');
        const expected = before.map((timeline, index) => index === 0 ? { ...timeline, duration: request.duration } : timeline);
        if (!same(freshTimelines, expected)) throw new Error('Fresh Motion Timeline does not match the requested duration.');
        return success('updated', mutationError ? 'verified-after-error' : 'verified', 1, { ...base, previousDuration, timelines: freshTimelines }, mutationError ? ['The native timeline setter reported an error, but fresh readback proved the requested duration.'] : []);
      } catch (error) { mutationError ||= error; }
      if (freshTimelines && same(freshTimelines, before)) return failed('unchanged', mutationError);
      let rollbackError = null;
      try { node.setTimelineDuration(timelineId, previousDuration); } catch (error) { rollbackError = error; }
      try {
        const restoredNode = await figma.getNodeByIdAsync(base.nodeId); if (!restoredNode) throw new Error('Restored Motion Timeline target is unavailable.');
        const restored = timelinesOf(restoredNode, 'Restored Motion Timeline');
        if (!same(restored, before)) throw rollbackError || new Error('Motion Timeline rollback could not be verified.');
        return failed('rolled-back', mutationError);
      } catch (error) {
        return failed(freshTimelines ? 'partial-residue' : 'verification-unavailable', mutationError || rollbackError || error, [timelineId]);
      }
    } catch (error) {
      if (request.duration === null || !mutationAttempted) return refusal('INVALID_RUNTIME');
      return failed('verification-unavailable', error, [request.nodeId]);
    }
  })()`;
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function text(value, maximum, empty = true) { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0); }
function validTimeline(value) { return exact(value, ['id', 'duration']) && text(value.id, MAX_ID_CODE_UNITS, false) && Number.isFinite(value.duration) && value.duration >= 0; }
function validChildren(value) { return Array.isArray(value) && value.length <= MAX_MOTION_TIMELINE_CHILDREN && value.every((child) => exact(child, ['id', 'name']) && text(child.id, MAX_ID_CODE_UNITS, false) && text(child.name, MAX_NAME_CODE_UNITS)); }
function validData(value, input) {
  if (!exact(value, ['requestedNodeId','nodeId','nodeName','descended','fromName','previousDuration','timelines'])
    || value.requestedNodeId !== input.nodeId || !text(value.nodeId, MAX_ID_CODE_UNITS, false)
    || !text(value.nodeName, MAX_NAME_CODE_UNITS) || typeof value.descended !== 'boolean'
    || (value.fromName !== null && !text(value.fromName, MAX_NAME_CODE_UNITS))
    || (value.descended ? value.fromName === null : value.fromName !== null)
    || !Array.isArray(value.timelines) || value.timelines.length > MAX_MOTION_TIMELINES
    || !value.timelines.every(validTimeline)
    || new Set(value.timelines.map((timeline) => timeline.id)).size !== value.timelines.length) return false;
  if (input.duration === null) return value.previousDuration === null;
  return Number.isFinite(value.previousDuration) && value.previousDuration >= 0
    && value.timelines.length > 0 && value.timelines[0].duration === input.duration;
}
function validRefusal(value, input) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','code','nodeName','children'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.action === 'timeline'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && ['WRONG_EDITOR','MOTION_DISABLED','INVALID_RUNTIME','NOT_FOUND','TOPLEVEL_EMPTY','TOPLEVEL_MULTI','TOO_MANY_CHILDREN','NO_TIMELINE'].includes(value.code)
    && (value.nodeName === null || text(value.nodeName, MAX_NAME_CODE_UNITS)) && validChildren(value.children)
    && (input.duration === null || value.outcome === 'no-mutation');
}
function validFailure(value) {
  return exact(value, ['schemaVersion','status','action','outcome','attempted','restored','residue','failure'])
    && value.schemaVersion === 1 && value.status === 'failed' && value.action === 'timeline'
    && ['unchanged','rolled-back','partial-residue','verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && value.restored === (value.outcome === 'rolled-back' ? 1 : 0)
    && Array.isArray(value.residue) && value.residue.length <= MAX_MOTION_TIMELINES
    && value.residue.every((item) => text(item, MAX_ID_CODE_UNITS, false))
    && text(value.failure, 1024, false)
    && (value.outcome === 'rolled-back' || value.outcome === 'unchanged' ? value.residue.length === 0 : true);
}
function validSuccess(value, input) {
  if (!exact(value, ['schemaVersion','status','action','outcome','attempted','data','residue','warnings'])
    || value.schemaVersion !== 1 || value.action !== 'timeline'
    || !['read','updated'].includes(value.status) || !['verified','verified-after-error','no-op'].includes(value.outcome)
    || ![0,1].includes(value.attempted) || !validData(value.data, input)
    || !Array.isArray(value.residue) || value.residue.length
    || !Array.isArray(value.warnings) || value.warnings.some((warning) => !text(warning, 1024, false))) return false;
  if (input.duration === null) return value.status === 'read' && value.outcome === 'verified' && value.attempted === 0;
  return value.status === 'updated' && (value.outcome === 'no-op' ? value.attempted === 0 : value.attempted === 1);
}
function safeText(value) { return String(value).replace(UNSAFE_TEXT, ' '); }
function refusalMessage(payload, input) {
  if (payload.code === 'WRONG_EDITOR') return 'Motion Timeline requires Figma Design.';
  if (payload.code === 'MOTION_DISABLED') return 'Motion API is not enabled for this Figma account.';
  if (payload.code === 'INVALID_RUNTIME') return 'Motion Timeline returned invalid or excessive native facts.';
  if (payload.code === 'NOT_FOUND') return `Motion node "${safeText(input.nodeId)}" was not found.`;
  if (payload.code === 'NO_TIMELINE') return `Motion node "${safeText(payload.nodeName)}" has no timeline to update.`;
  if (payload.code === 'TOPLEVEL_EMPTY') return `"${safeText(payload.nodeName)}" is a top-level frame with no children.`;
  if (payload.code === 'TOO_MANY_CHILDREN') return `"${safeText(payload.nodeName)}" has too many children for bounded Motion resolution.`;
  return `"${safeText(payload.nodeName)}" is a top-level frame; choose one child by id:\n` + payload.children.map((child) => `  ${safeText(child.id)}  ${safeText(child.name)}`).join('\n');
}
function commandError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' }); return error; }

export async function executeMotionTimeline(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Motion Timeline requires a Figma evaluate adapter.');
  const input = normalized(request);
  const serialized = await adapters.evaluate(motionTimelineCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_MOTION_TIMELINE_RESULT_CODE_UNITS) throw invalid('Motion Timeline returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw invalid('Motion Timeline returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, input)) throw invalid('Motion Timeline returned an invalid bounded result.');
    const message = refusalMessage(payload, input);
    if (input.duration === null) throw new Error(message);
    throw commandError(`Motion Timeline made no mutation: ${message}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (input.duration === null || !validFailure(payload)) throw invalid('Motion Timeline returned an invalid bounded result.');
    throw commandError(`Motion Timeline failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length });
  }
  if (!validSuccess(payload, input)) throw invalid('Motion Timeline returned an invalid bounded result.');
  const timeline = payload.data.timelines[0] || null;
  const stdout = input.duration === null ? `Timeline: ${timeline ? `${timeline.duration}s` : 'none'}` : `Timeline set to ${timeline.duration}s`;
  return { stdout, stderr: payload.warnings.join('\n'), code: 0, result: payload };
}

export function motionTimelinePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Motion Timeline routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-motion-timeline';
}

export function executeMotionTimelinePlan(plan, adapters = {}) {
  if (motionTimelinePlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Motion Timeline.');
  return executeMotionTimeline(parseMotionTimelineRequest(plan.argv), adapters);
}
