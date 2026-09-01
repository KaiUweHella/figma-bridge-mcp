// Plan-bound, freshly verified and rollback-owned `motion style` Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  motionStyleArgvFromRequest,
  motionStylePlanningArgvFromRequest,
  parseMotionStyleRequest,
} from './motion-style-request.js';

export { motionStyleArgvFromRequest, motionStylePlanningArgvFromRequest } from './motion-style-request.js';

export const MAX_MOTION_STYLE_CATALOG_ITEMS = 512;
export const MAX_MOTION_STYLE_APPLIED_ITEMS = 256;
export const MAX_MOTION_STYLE_TIMELINES = 256;
export const MAX_MOTION_STYLE_CHILDREN = 256;
export const MAX_MOTION_STYLE_SNAPSHOT_CODE_UNITS = 1_750_000;
export const MAX_MOTION_STYLE_RESULT_CODE_UNITS = 64_000;
const MAX_ID_CODE_UNITS = 512;
const MAX_NAME_CODE_UNITS = 4_096;
const MAX_FAILURE_CODE_UNITS = 1_024;
const APPLICATION_ID = 'motion.style';
const normalized = (request) => parseMotionStyleRequest(motionStyleArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu;

export function motionStyleCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const text = (value, label, maximum, empty = true) => { if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length)) throw new Error(label + ' is invalid.'); return value; };
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_MOTION_STYLE_RESULT_CODE_UNITS}) throw new Error('Motion Style result exceeded its bounded response limit.'); return serialized; };
    const copy = (value, label) => { const serialized = JSON.stringify(value); if (typeof serialized !== 'string' || serialized.length > ${MAX_MOTION_STYLE_SNAPSHOT_CODE_UNITS}) throw new Error(label + ' exceeded its bounded snapshot limit.'); return JSON.parse(serialized); };
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const sameStyles = (left, right) => left.length === right.length
      && [...left].sort((a, b) => a.id.localeCompare(b.id)).every((style, index) => same(style, [...right].sort((a, b) => a.id.localeCompare(b.id))[index]));
    const failureText = (error, fallback) => clean(error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const nodeFact = (node, descended, fromName) => ({ requestedId: request.nodeId, id: text(node.id, 'Motion node id', ${MAX_ID_CODE_UNITS}, false), name: text(node.name, 'Motion node name', ${MAX_NAME_CODE_UNITS}), descended, fromName });
    const resolve = async () => {
      if (figma.editorType !== 'figma') throw new Error('Motion Style requires Figma Design.');
      if (!figma.motion || typeof figma.motion.figmaAnimationStyles !== 'function') throw new Error('Motion API is not enabled for this Figma account.');
      if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Motion Style requires the asynchronous node API.');
      const requested = await figma.getNodeByIdAsync(request.nodeId);
      if (!requested) throw new Error('Motion target was not found.');
      let node = requested; let descended = false; let fromName = null;
      const topLevel = requested.parent && requested.parent.type === 'PAGE';
      const container = ['FRAME','COMPONENT','COMPONENT_SET','GROUP','SECTION','INSTANCE'].includes(requested.type);
      if (topLevel && container) {
        if (!Array.isArray(requested.children)) throw new Error('Motion target children are invalid.');
        if (requested.children.length === 0) throw new Error('Top-level Motion target has no children.');
        if (requested.children.length > 1) {
          if (requested.children.length > ${MAX_MOTION_STYLE_CHILDREN}) throw new Error('Top-level Motion target has too many children.');
          const choices = requested.children.map((child) => text(child.id, 'Motion child id', ${MAX_ID_CODE_UNITS}, false) + ' ' + text(child.name, 'Motion child name', ${MAX_NAME_CODE_UNITS}));
          throw new Error('Top-level Motion target is ambiguous; choose one child by id: ' + choices.join(', '));
        }
        node = requested.children[0]; descended = true; fromName = text(requested.name, 'Motion source name', ${MAX_NAME_CODE_UNITS});
      }
      if (typeof node.applyAnimationStyle !== 'function' || typeof node.removeAnimationStyle !== 'function') throw new Error('Motion target does not support reversible animation styles.');
      return { node, descended, fromName };
    };
    const catalog = () => {
      const native = figma.motion.figmaAnimationStyles();
      if (!Array.isArray(native) || native.length > ${MAX_MOTION_STYLE_CATALOG_ITEMS}) throw new Error('Motion style catalog exceeded its bounded limit.');
      const result = native.map((style) => {
        if (!record(style)) throw new Error('Motion style definition is invalid.');
        return { styleId: text(style.styleId, 'Motion style id', ${MAX_ID_CODE_UNITS}, false), name: text(style.name, 'Motion style name', ${MAX_NAME_CODE_UNITS}, false) };
      });
      if (new Set(result.map((style) => style.styleId)).size !== result.length) throw new Error('Motion style identities are duplicated.');
      return result;
    };
    const appliedStyles = (node) => {
      if (!Array.isArray(node.animationStyles) || node.animationStyles.length > ${MAX_MOTION_STYLE_APPLIED_ITEMS}) throw new Error('Applied Motion styles exceeded their bounded limit.');
      const snapshot = copy(node.animationStyles, 'Applied Motion styles');
      if (snapshot.some((style) => !record(style) || typeof style.id !== 'string' || !style.id.length || style.id.length > ${MAX_ID_CODE_UNITS}
        || typeof style.styleId !== 'string' || !style.styleId.length || style.styleId.length > ${MAX_ID_CODE_UNITS}
        || typeof style.name !== 'string' || !style.name.length || style.name.length > ${MAX_NAME_CODE_UNITS})
        || new Set(snapshot.map((style) => style.id)).size !== snapshot.length) throw new Error('Applied Motion style facts are invalid.');
      return snapshot;
    };
    const timelines = (node) => {
      if (!Array.isArray(node.timelines) || node.timelines.length > ${MAX_MOTION_STYLE_TIMELINES}) throw new Error('Motion timelines exceeded their bounded limit.');
      const result = node.timelines.map((timeline) => {
        if (!record(timeline) || typeof timeline.id !== 'string' || !timeline.id.length || timeline.id.length > ${MAX_ID_CODE_UNITS}
          || !Number.isFinite(timeline.duration) || timeline.duration < 0) throw new Error('Motion timeline facts are invalid.');
        return { id: timeline.id, duration: timeline.duration };
      });
      if (new Set(result.map((timeline) => timeline.id)).size !== result.length) throw new Error('Motion timeline identities are duplicated.');
      return result;
    };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: failureText(error, 'Motion Style preflight failed') });
    const failed = (outcome, restored, error, residue) => bounded({ schemaVersion: 1, status: 'failed', outcome, attempted: 1, restored, residue, failure: failureText(error, 'Motion Style postcondition failed') });
    const success = (target, selected, kind, applied, afterStyles, afterTimelines, mutationError) => bounded({
      schemaVersion: 1, status: 'applied', outcome: mutationError ? 'verified-after-error' : 'verified', attempted: 1,
      node: nodeFact(target.node, target.descended, target.fromName),
      match: { styleId: selected.styleId, name: selected.name, kind }, appliedId: applied.id,
      duration: request.duration, offset: request.offset, timing: request.timing,
      styleCount: afterStyles.length, timelineDuration: afterTimelines[0]?.duration ?? null,
      residue: [], warnings: mutationError ? ['A native Motion mutation reported an error, but fresh readback proved the complete requested state.'] : [],
    });

    let target; let beforeStyles; let beforeTimelines; let selected; let matchKind;
    try {
      target = await resolve();
      const styles = catalog();
      const query = request.name.toLowerCase();
      selected = styles.find((style) => {
        const name = style.name.toLowerCase();
        return name === query || name.endsWith('.' + query) || name.includes(query);
      });
      if (!selected) throw new Error('No Motion style matches "' + clean(request.name, ${MAX_NAME_CODE_UNITS}) + '".');
      const selectedName = selected.name.toLowerCase();
      matchKind = selectedName === query ? 'exact' : selectedName.endsWith('.' + query) ? 'suffix' : 'contains';
      beforeStyles = appliedStyles(target.node);
      beforeTimelines = timelines(target.node);
      const end = request.offset + request.duration;
      if (beforeTimelines[0] && beforeTimelines[0].duration < end && typeof target.node.setTimelineDuration !== 'function') throw new Error('Motion target cannot extend its timeline.');
    } catch (error) { return refusal(error); }

    const config = { duration: request.duration, timelineOffset: request.offset, props: request.timing === null ? {} : { timing: request.timing } };
    const expectedTimelines = beforeTimelines.map((timeline, index) => index === 0 && timeline.duration < request.offset + request.duration
      ? { ...timeline, duration: request.offset + request.duration } : timeline);
    let appliedId = null; let timelineAttempted = false; let mutationError = null;
    try {
      appliedId = target.node.applyAnimationStyle(selected.styleId, config);
      if (typeof appliedId !== 'string' || !appliedId.length || appliedId.length > ${MAX_ID_CODE_UNITS}) throw new Error('Native Motion Style returned an invalid applied identity.');
      if (beforeTimelines[0] && beforeTimelines[0].duration < request.offset + request.duration) {
        timelineAttempted = true;
        target.node.setTimelineDuration(beforeTimelines[0].id, request.offset + request.duration);
      }
    } catch (error) { mutationError = error; }

    const fresh = async () => {
      const node = await figma.getNodeByIdAsync(target.node.id);
      if (!node) throw new Error('Fresh Motion Style target is unavailable.');
      return { node, styles: appliedStyles(node), timelines: timelines(node) };
    };
    let after = null; let newStyles = [];
    try {
      after = await fresh();
      const beforeIds = new Set(beforeStyles.map((style) => style.id));
      newStyles = after.styles.filter((style) => !beforeIds.has(style.id));
      const siblings = after.styles.filter((style) => beforeIds.has(style.id));
      const applied = newStyles.length === 1 ? newStyles[0] : null;
      const configured = applied && applied.styleId === selected.styleId && applied.name === selected.name
        && applied.duration === request.duration && applied.timelineOffset === request.offset
        && (request.timing === null || applied.props?.timing === request.timing)
        && (appliedId === null || applied.id === appliedId);
      if (configured && sameStyles(siblings, beforeStyles) && same(after.timelines, expectedTimelines)) {
        delete globalThis.__invCache;
        return success(target, selected, matchKind, applied, after.styles, after.timelines, mutationError);
      }
    } catch (error) { mutationError ||= error; }
    if (after && sameStyles(after.styles, beforeStyles) && same(after.timelines, beforeTimelines)) return failed('unchanged', 0, mutationError, ['motion-style-state']);

    const attributedId = appliedId || (newStyles.length === 1 ? newStyles[0].id : null);
    let rollbackError = null;
    try {
      const node = await figma.getNodeByIdAsync(target.node.id);
      if (!node) throw new Error('Motion Style rollback target is unavailable.');
      if (attributedId) node.removeAnimationStyle(attributedId);
      if (beforeTimelines[0] && (timelineAttempted || after && !same(after.timelines, beforeTimelines))) {
        if (typeof node.setTimelineDuration !== 'function') throw new Error('Motion timeline rollback is unavailable.');
        node.setTimelineDuration(beforeTimelines[0].id, beforeTimelines[0].duration);
      }
    } catch (error) { rollbackError = error; }
    try {
      const restored = await fresh();
      if (sameStyles(restored.styles, beforeStyles) && same(restored.timelines, beforeTimelines)) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, mutationError || rollbackError, []);
      }
      const residue = [];
      if (!sameStyles(restored.styles, beforeStyles)) residue.push('animation-style-state');
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
function validSuccess(value, input) {
  const query = input.name.toLowerCase();
  const matchedName = record(value?.match) && typeof value.match.name === 'string' ? value.match.name.toLowerCase() : '';
  const expectedKind = matchedName === query ? 'exact' : matchedName.endsWith('.' + query) ? 'suffix' : matchedName.includes(query) ? 'contains' : null;
  return exact(value, ['schemaVersion','status','outcome','attempted','node','match','appliedId','duration','offset','timing','styleCount','timelineDuration','residue','warnings'])
    && value.schemaVersion === 1 && value.status === 'applied'
    && ['verified','verified-after-error'].includes(value.outcome) && value.attempted === 1
    && validNode(value.node, input)
    && exact(value.match, ['styleId','name','kind']) && text(value.match.styleId, MAX_ID_CODE_UNITS, false)
    && text(value.match.name, MAX_NAME_CODE_UNITS, false) && value.match.kind === expectedKind
    && text(value.appliedId, MAX_ID_CODE_UNITS, false)
    && value.duration === input.duration && value.offset === input.offset && value.timing === input.timing
    && Number.isInteger(value.styleCount) && value.styleCount > 0 && value.styleCount <= MAX_MOTION_STYLE_APPLIED_ITEMS
    && (value.timelineDuration === null || Number.isFinite(value.timelineDuration) && value.timelineDuration >= input.offset + input.duration)
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings) && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
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
    && value.residue.every((item) => ['motion-style-state','animation-style-state','timeline-state'].includes(item))
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false)
    && (value.outcome !== 'rolled-back' || value.restored === 1 && value.residue.length === 0)
    && (value.outcome !== 'unchanged' || value.restored === 0 && value.residue.length === 1 && value.residue[0] === 'motion-style-state')
    && (value.outcome !== 'partial-residue' || value.restored === 0 && value.residue.length > 0)
    && (value.outcome !== 'verification-unavailable' || value.restored === 0 && value.residue.length === 0);
}
function pluginResultError(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function safeText(value) { return String(value).replace(UNSAFE_TEXT, ' '); }

export async function executeMotionStyle(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Motion Style requires a Figma evaluate adapter.');
  const input = normalized(request);
  const serialized = await adapters.evaluate(motionStyleCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_MOTION_STYLE_RESULT_CODE_UNITS) throw pluginResultError('Motion Style returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Motion Style returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload)) throw pluginResultError('Motion Style returned an invalid bounded result.');
    throw mutationError(`Motion Style made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload)) throw pluginResultError('Motion Style returned an invalid bounded result.');
    throw mutationError(`Motion Style failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length });
  }
  if (!validSuccess(payload, input)) throw pluginResultError('Motion Style returned an invalid bounded result.');
  const short = payload.match.name.replace(/^motion\.preset_name\./, '');
  const via = payload.node.descended ? ` (via "${safeText(payload.node.fromName)}")` : '';
  return { stdout: `Applied style "${safeText(short)}" to ${safeText(payload.node.name)}${via}`, stderr: payload.warnings.join('\n'), code: 0, result: payload };
}

export function motionStylePlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Motion Style routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-motion-style';
}

export function executeMotionStylePlan(plan, adapters = {}) {
  if (motionStylePlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Motion Style.');
  return executeMotionStyle(parseMotionStyleRequest(plan.argv), adapters);
}
