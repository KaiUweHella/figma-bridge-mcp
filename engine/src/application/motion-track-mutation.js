// Shared bounded transaction for prepared Motion manual-track mutations.

export const MAX_MOTION_TRACK_NODES = 128;
export const MAX_MOTION_TRACKS = 512;
export const MAX_MOTION_TRACK_KEYFRAMES = 256;
export const MAX_MOTION_TRACK_CHILDREN = 256;
export const MAX_MOTION_TRACK_TIMELINES = 256;
export const MAX_MOTION_TRACK_PAINTS = 256;
export const MAX_MOTION_TRACK_SNAPSHOT_CODE_UNITS = 1_750_000;
export const MAX_MOTION_TRACK_RESULT_CODE_UNITS = 128_000;
const MAX_ID_CODE_UNITS = 512;
const MAX_NAME_CODE_UNITS = 4_096;
const MAX_FIELD_CODE_UNITS = 256;
const MAX_FAILURE_CODE_UNITS = 1_024;
const ACTIONS = new Set(['add', 'preset', 'stagger', 'apply']);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu;
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function text(value, maximum, empty = true) { return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0); }
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : record(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
}
function same(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

function validJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_NAME_CODE_UNITS;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => validJsonValue(entry, seen))
    : Object.keys(value).every((key) => text(key, MAX_NAME_CODE_UNITS, false)
      && validJsonValue(value[key], seen));
  seen.delete(value);
  return valid;
}

function normalizePrepared(value) {
  if (!exact(value, ['action','duration','nodes']) || !ACTIONS.has(value.action)
    || !Number.isFinite(value.duration) || value.duration < 0
    || !Array.isArray(value.nodes) || value.nodes.length === 0
    || value.nodes.length > MAX_MOTION_TRACK_NODES) {
    throw new TypeError('Prepared Motion track mutation is invalid.');
  }
  let trackCount = 0;
  const nodes = value.nodes.map((node) => {
    if (!exact(node, ['requestedId','tracks']) || !text(node.requestedId, MAX_ID_CODE_UNITS, false)
      || !Array.isArray(node.tracks) || node.tracks.length === 0) {
      throw new TypeError('Prepared Motion track node is invalid.');
    }
    const identities = new Set();
    const tracks = node.tracks.map((entry) => {
      if (!exact(entry, ['label','field','binding']) || !text(entry.label, MAX_FIELD_CODE_UNITS, false)
        || !record(entry.field) || !record(entry.binding)
        || !Array.isArray(entry.binding.keyframes) || entry.binding.keyframes.length === 0
        || entry.binding.keyframes.length > MAX_MOTION_TRACK_KEYFRAMES
        || !validJsonValue(entry.binding)) throw new TypeError('Prepared Motion track is invalid.');
      let identity;
      let field;
      if (exact(entry.field, ['type','name']) && entry.field.type === 'PROPERTY'
        && text(entry.field.name, MAX_FIELD_CODE_UNITS, false)) {
        identity = `property:${entry.field.name}`;
        field = { type: 'PROPERTY', name: entry.field.name };
      } else if (exact(entry.field, ['type','collection','index'])
        && entry.field.type === 'INDEXED_ITEM' && ['fills','strokes'].includes(entry.field.collection)
        && Number.isInteger(entry.field.index) && entry.field.index >= 0
        && entry.field.index < MAX_MOTION_TRACK_PAINTS) {
        identity = `${entry.field.collection}:${entry.field.index}`;
        field = { type: 'INDEXED_ITEM', collection: entry.field.collection, index: entry.field.index };
      } else throw new TypeError('Prepared Motion track field is invalid.');
      if (identities.has(identity)) throw new TypeError('Prepared Motion track fields are duplicated.');
      identities.add(identity);
      trackCount += 1;
      if (trackCount > MAX_MOTION_TRACKS) throw new TypeError('Prepared Motion track count is excessive.');
      return { label: entry.label, field, binding: canonical(entry.binding) };
    });
    return { requestedId: node.requestedId, tracks };
  });
  if (new Set(nodes.map((node) => node.requestedId)).size !== nodes.length) {
    throw new TypeError('Prepared Motion target identities are duplicated.');
  }
  const prepared = { action: value.action, duration: value.duration, nodes };
  const serialized = JSON.stringify(prepared);
  if (serialized.length > MAX_MOTION_TRACK_SNAPSHOT_CODE_UNITS) {
    throw new TypeError('Prepared Motion track mutation is excessive.');
  }
  return Object.freeze({ prepared, trackCount });
}

export function motionTrackMutationCode(value) {
  const { prepared, trackCount } = normalizePrepared(value);
  return `(async () => {
    const request = ${js(prepared)};
    const requestedTrackCount = ${trackCount};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const text = (value, label, maximum, empty = true) => { if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length)) throw new Error(label + ' is invalid.'); return value; };
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_MOTION_TRACK_RESULT_CODE_UNITS}) throw new Error('Motion track result exceeded its bounded response limit.'); return serialized; };
    let copiedCodeUnits = 0;
    const copy = (value, label) => { const serialized = JSON.stringify(value); copiedCodeUnits += typeof serialized === 'string' ? serialized.length : 0; if (typeof serialized !== 'string' || serialized.length > ${MAX_MOTION_TRACK_SNAPSHOT_CODE_UNITS} || copiedCodeUnits > ${MAX_MOTION_TRACK_SNAPSHOT_CODE_UNITS * 8}) throw new Error(label + ' exceeded the bounded transaction snapshot limit.'); const result = JSON.parse(serialized); if (JSON.stringify(result) !== serialized) throw new Error(label + ' is not exact JSON.'); return result; };
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const failureText = (error, fallback) => clean(error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const nodeFact = (target, afterTimelines) => ({
      requestedId: target.requestedId,
      id: text(target.node.id, 'Motion node id', ${MAX_ID_CODE_UNITS}, false),
      name: text(target.node.name, 'Motion node name', ${MAX_NAME_CODE_UNITS}),
      descended: target.descended,
      fromName: target.fromName,
      fields: target.requestedTracks.map((track) => track.label),
      replacedCount: target.replacedCount,
      timelineDuration: afterTimelines[0]?.duration ?? null,
    });
    const resolve = async (requestedId) => {
      const requested = await figma.getNodeByIdAsync(requestedId);
      if (!requested) throw new Error('Motion target was not found.');
      let node = requested; let descended = false; let fromName = null;
      const topLevel = requested.parent && requested.parent.type === 'PAGE';
      const container = ['FRAME','COMPONENT','COMPONENT_SET','GROUP','SECTION','INSTANCE'].includes(requested.type);
      if (topLevel && container) {
        if (!Array.isArray(requested.children)) throw new Error('Motion target children are invalid.');
        if (requested.children.length === 0) throw new Error('Top-level Motion target has no children.');
        if (requested.children.length > 1) {
          if (requested.children.length > ${MAX_MOTION_TRACK_CHILDREN}) throw new Error('Top-level Motion target has too many children.');
          const choices = requested.children.map((child) => text(child.id, 'Motion child id', ${MAX_ID_CODE_UNITS}, false) + ' ' + text(child.name, 'Motion child name', ${MAX_NAME_CODE_UNITS}));
          throw new Error('Top-level Motion target is ambiguous; choose one child by id: ' + choices.join(', '));
        }
        node = requested.children[0]; descended = true; fromName = text(requested.name, 'Motion source name', ${MAX_NAME_CODE_UNITS});
      }
      text(node.id, 'Motion node id', ${MAX_ID_CODE_UNITS}, false);
      text(node.name, 'Motion node name', ${MAX_NAME_CODE_UNITS});
      if (typeof node.applyManualKeyframeTrack !== 'function' || typeof node.removeManualKeyframeTrack !== 'function'
        || !('manualKeyframeTracks' in node)) throw new Error('Motion target does not support reversible manual tracks.');
      return { requestedId, node, descended, fromName };
    };
    const manualTracks = (node) => {
      const snapshot = copy(node.manualKeyframeTracks, 'Motion manual tracks');
      if (!record(snapshot)) throw new Error('Motion manual track facts are invalid.');
      return snapshot;
    };
    const timelines = (node) => {
      if (!Array.isArray(node.timelines) || node.timelines.length > ${MAX_MOTION_TRACK_TIMELINES}) throw new Error('Motion timelines exceeded their bounded limit.');
      const result = node.timelines.map((timeline) => {
        if (!record(timeline) || typeof timeline.id !== 'string' || !timeline.id.length || timeline.id.length > ${MAX_ID_CODE_UNITS}
          || !Number.isFinite(timeline.duration) || timeline.duration < 0) throw new Error('Motion timeline facts are invalid.');
        return { id: timeline.id, duration: timeline.duration };
      });
      if (new Set(result.map((timeline) => timeline.id)).size !== result.length) throw new Error('Motion timeline identities are duplicated.');
      return result;
    };
    const binding = (snapshot, field) => {
      if (field.type === 'PROPERTY') return Object.hasOwn(snapshot, field.name)
        ? { exists: true, value: copy(snapshot[field.name], 'Existing Motion track') }
        : { exists: false, value: null };
      const collection = snapshot[field.collection]; const index = String(field.index);
      return record(collection) && Object.hasOwn(collection, index)
        ? { exists: true, value: copy(collection[index], 'Existing Motion paint track') }
        : { exists: false, value: null };
    };
    const assign = (snapshot, field, value) => {
      if (field.type === 'PROPERTY') snapshot[field.name] = copy(value, 'Requested Motion track');
      else {
        if (!record(snapshot[field.collection])) snapshot[field.collection] = {};
        snapshot[field.collection][String(field.index)] = copy(value, 'Requested Motion paint track');
      }
    };
    const refusal = (error) => bounded({ schemaVersion: 1, action: request.action, status: 'refused', outcome: 'no-mutation', attempted: 0, failure: failureText(error, 'Motion track preflight failed') });
    const failed = (outcome, restored, error, residue) => bounded({ schemaVersion: 1, action: request.action, status: 'failed', outcome, attempted: 1, restored, residue, failure: failureText(error, 'Motion track postcondition failed') });
    const success = (outcome, attempted, targets, after, mutationError) => bounded({
      schemaVersion: 1, action: request.action, status: 'applied', outcome, attempted,
      duration: request.duration, trackCount: requestedTrackCount,
      nodes: targets.map((target, index) => nodeFact(target, after[index].timelines)),
      residue: [], warnings: mutationError ? ['A native Motion mutation reported an error, but fresh readback proved the complete requested state.'] : [],
    });

    if (figma.editorType !== 'figma') return refusal(new Error('Motion tracks require Figma Design.'));
    if (!figma.motion || typeof figma.motion !== 'object') return refusal(new Error('Motion API is not enabled for this Figma account.'));
    if (typeof figma.getNodeByIdAsync !== 'function') return refusal(new Error('Motion tracks require the asynchronous node API.'));
    const targets = [];
    try {
      for (const requested of request.nodes) {
        const target = await resolve(requested.requestedId);
        target.requestedTracks = requested.tracks;
        target.beforeTracks = manualTracks(target.node);
        target.beforeTimelines = timelines(target.node);
        target.expectedTracks = copy(target.beforeTracks, 'Expected Motion tracks');
        target.beforeBindings = [];
        target.changedTracks = [];
        target.replacedCount = 0;
        for (const track of requested.tracks) {
          if (track.field.type === 'INDEXED_ITEM') {
            const paints = target.node[track.field.collection];
            if (!Array.isArray(paints) || paints.length > ${MAX_MOTION_TRACK_PAINTS}) throw new Error('Motion paint inventory is unavailable or excessive.');
            const paint = paints[track.field.index];
            if (!paint || paint.type !== 'SOLID') throw new Error('Motion color track requires an existing solid paint at the requested index.');
          }
          const before = binding(target.beforeTracks, track.field);
          target.beforeBindings.push(before);
          assign(target.expectedTracks, track.field, track.binding);
          const changed = !before.exists || !same(before.value, track.binding);
          target.changedTracks.push(changed);
          if (changed && before.exists) target.replacedCount += 1;
        }
        target.expectedTimelines = target.beforeTimelines.map((timeline, index) => index === 0 && timeline.duration < request.duration
          ? { ...timeline, duration: request.duration } : timeline);
        target.timelineChanged = !same(target.beforeTimelines, target.expectedTimelines);
        if (target.timelineChanged && typeof target.node.setTimelineDuration !== 'function') throw new Error('Motion target cannot extend its timeline.');
        targets.push(target);
      }
      if (new Set(targets.map((target) => target.node.id)).size !== targets.length) throw new Error('Motion requests resolve to the same target more than once.');
    } catch (error) { return refusal(error); }
    const hasMutation = targets.some((target) => target.timelineChanged || target.changedTracks.some(Boolean));
    const beforeFacts = targets.map((target) => ({ tracks: target.beforeTracks, timelines: target.beforeTimelines }));
    if (!hasMutation) return success('no-op', 0, targets, beforeFacts, null);

    const journal = []; let mutationError = null;
    outer: for (const target of targets) {
      for (let index = 0; index < target.requestedTracks.length; index++) {
        if (!target.changedTracks[index]) continue;
        const track = target.requestedTracks[index];
        journal.push({ kind: 'track', nodeId: target.node.id, field: track.field, before: target.beforeBindings[index] });
        try { target.node.applyManualKeyframeTrack(track.field, track.binding); }
        catch (error) { mutationError = error; break outer; }
      }
      if (target.timelineChanged) {
        journal.push({ kind: 'timeline', nodeId: target.node.id, timelineId: target.beforeTimelines[0].id, duration: target.beforeTimelines[0].duration });
        try { target.node.setTimelineDuration(target.beforeTimelines[0].id, request.duration); }
        catch (error) { mutationError = error; break; }
      }
    }
    const fresh = async () => {
      const result = [];
      for (const target of targets) {
        const node = await figma.getNodeByIdAsync(target.node.id);
        if (!node) throw new Error('Fresh Motion target is unavailable.');
        result.push({ node, tracks: manualTracks(node), timelines: timelines(node) });
      }
      return result;
    };
    let after = null;
    try {
      after = await fresh();
      const complete = targets.every((target, index) => same(after[index].tracks, target.expectedTracks)
        && same(after[index].timelines, target.expectedTimelines));
      if (complete) {
        delete globalThis.__invCache;
        return success(mutationError ? 'verified-after-error' : 'verified', 1, targets, after, mutationError);
      }
    } catch (error) { mutationError ||= error; }
    if (after && targets.every((target, index) => same(after[index].tracks, target.beforeTracks)
      && same(after[index].timelines, target.beforeTimelines))) return failed('unchanged', 0, mutationError, ['motion-state']);

    let rollbackError = null;
    const rollbackNodes = new Map();
    for (const entry of [...journal].reverse()) {
      let node = rollbackNodes.get(entry.nodeId);
      if (!rollbackNodes.has(entry.nodeId)) {
        try { node = await figma.getNodeByIdAsync(entry.nodeId); }
        catch (error) { rollbackError ||= error; node = null; }
        rollbackNodes.set(entry.nodeId, node || null);
      }
      if (!node) { rollbackError ||= new Error('Motion rollback target is unavailable.'); continue; }
      try {
        if (entry.kind === 'timeline') {
          if (typeof node.setTimelineDuration !== 'function') throw new Error('Motion timeline rollback is unavailable.');
          node.setTimelineDuration(entry.timelineId, entry.duration);
        } else if (entry.before.exists) node.applyManualKeyframeTrack(entry.field, entry.before.value);
        else node.removeManualKeyframeTrack(entry.field);
      } catch (error) { rollbackError ||= error; }
    }
    try {
      const restored = await fresh();
      if (targets.every((target, index) => same(restored[index].tracks, target.beforeTracks)
        && same(restored[index].timelines, target.beforeTimelines))) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, mutationError || rollbackError, []);
      }
      const residue = [];
      if (targets.some((target, index) => !same(restored[index].tracks, target.beforeTracks))) residue.push('manual-track-state');
      if (targets.some((target, index) => !same(restored[index].timelines, target.beforeTimelines))) residue.push('timeline-state');
      return failed('partial-residue', 0, mutationError || rollbackError, residue);
    } catch (error) { return failed('verification-unavailable', 0, mutationError || rollbackError || error, []); }
  })()`;
}

function validNode(value, requested, duration) {
  return exact(value, ['requestedId','id','name','descended','fromName','fields','replacedCount','timelineDuration'])
    && value.requestedId === requested.requestedId && text(value.id, MAX_ID_CODE_UNITS, false)
    && text(value.name, MAX_NAME_CODE_UNITS) && typeof value.descended === 'boolean'
    && (value.fromName === null || text(value.fromName, MAX_NAME_CODE_UNITS))
    && (value.descended ? value.fromName !== null && value.id !== requested.requestedId : value.fromName === null && value.id === requested.requestedId)
    && Array.isArray(value.fields) && same(value.fields, requested.tracks.map((track) => track.label))
    && Number.isInteger(value.replacedCount) && value.replacedCount >= 0
    && value.replacedCount <= requested.tracks.length
    && (value.timelineDuration === null || Number.isFinite(value.timelineDuration) && value.timelineDuration >= duration);
}
function validSuccess(value, prepared, trackCount) {
  const valid = exact(value, ['schemaVersion','action','status','outcome','attempted','duration','trackCount','nodes','residue','warnings'])
    && value.schemaVersion === 1 && value.action === prepared.action && value.status === 'applied'
    && ['verified','verified-after-error','no-op'].includes(value.outcome) && [0,1].includes(value.attempted)
    && value.duration === prepared.duration && value.trackCount === trackCount
    && Array.isArray(value.nodes) && value.nodes.length === prepared.nodes.length
    && value.nodes.every((node, index) => validNode(node, prepared.nodes[index], prepared.duration))
    && new Set(value.nodes.map((node) => node.id)).size === value.nodes.length
    && Array.isArray(value.residue) && value.residue.length === 0
    && Array.isArray(value.warnings) && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0)
    && value.warnings.every((warning) => text(warning, MAX_FAILURE_CODE_UNITS, false));
  return valid && (value.outcome === 'no-op' ? value.attempted === 0 : value.attempted === 1);
}
function validRefusal(value, prepared) {
  return exact(value, ['schemaVersion','action','status','outcome','attempted','failure'])
    && value.schemaVersion === 1 && value.action === prepared.action && value.status === 'refused'
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}
function validFailure(value, prepared) {
  return exact(value, ['schemaVersion','action','status','outcome','attempted','restored','residue','failure'])
    && value.schemaVersion === 1 && value.action === prepared.action && value.status === 'failed'
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

export async function executeMotionTrackMutation(value, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Motion track mutation requires a Figma evaluate adapter.');
  const { prepared, trackCount } = normalizePrepared(value);
  const serialized = await adapters.evaluate(motionTrackMutationCode(prepared));
  if (typeof serialized !== 'string' || serialized.length > MAX_MOTION_TRACK_RESULT_CODE_UNITS) throw pluginResultError('Motion track mutation returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Motion track mutation returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, prepared)) throw pluginResultError('Motion track mutation returned an invalid bounded result.');
    throw mutationError(`Motion ${prepared.action} made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, prepared)) throw pluginResultError('Motion track mutation returned an invalid bounded result.');
    throw mutationError(`Motion ${prepared.action} failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length });
  }
  if (!validSuccess(payload, prepared, trackCount)) throw pluginResultError('Motion track mutation returned an invalid bounded result.');
  return payload;
}

export function safeMotionText(value) {
  return String(value).replace(UNSAFE_TEXT, ' ');
}
