// Plan-bound, freshly verified `motion clear` Application.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { mapField } from '../lib/motion-core.js';
import {
  motionClearArgvFromRequest,
  motionClearPlanningArgvFromRequest,
  parseMotionClearRequest,
} from './motion-clear-request.js';

export { motionClearArgvFromRequest, motionClearPlanningArgvFromRequest } from './motion-clear-request.js';

export const MAX_MOTION_CLEAR_ITEMS = 256;
export const MAX_MOTION_CLEAR_CHILDREN = 256;
export const MAX_MOTION_CLEAR_SNAPSHOT_CODE_UNITS = 1_750_000;
export const MAX_MOTION_CLEAR_RESULT_CODE_UNITS = 64_000;
const MAX_ID_CODE_UNITS = 512;
const MAX_NAME_CODE_UNITS = 4_096;
const MAX_FIELD_CODE_UNITS = 256;
const MAX_FAILURE_CODE_UNITS = 1_024;
const APPLICATION_ID = 'motion.clear';
const normalized = (request) => parseMotionClearRequest(motionClearArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu;

function keyframeField(input) {
  if (input.mode !== 'field') return null;
  const field = mapField(input.field);
  return field.valueType === 'COLOR'
    ? { type: 'INDEXED_ITEM', collection: field.name, index: field.index }
    : { type: 'PROPERTY', name: field.name };
}

export function motionClearCode(request) {
  const input = normalized(request);
  const requestedField = keyframeField(input);
  return `(async () => {
    const request = ${js(input)};
    const requestedField = ${js(requestedField)};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const bounded = (payload) => { const serialized = JSON.stringify(payload); if (serialized.length > ${MAX_MOTION_CLEAR_RESULT_CODE_UNITS}) throw new Error('Motion Clear result exceeded its bounded response limit.'); return serialized; };
    const failureText = (error, fallback) => clean(error && error.message ? error.message : fallback, ${MAX_FAILURE_CODE_UNITS});
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const copy = (value, label) => {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== 'string' || serialized.length > ${MAX_MOTION_CLEAR_SNAPSHOT_CODE_UNITS}) throw new Error(label + ' exceeded its bounded snapshot limit.');
      const result = JSON.parse(serialized);
      if (JSON.stringify(result) !== serialized) throw new Error(label + ' is not exact JSON.');
      return result;
    };
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const nodeFact = (node, descended, fromName) => ({
      requestedId: request.nodeId,
      id: clean(node.id, ${MAX_ID_CODE_UNITS}),
      name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
      descended,
      fromName,
    });
    const resolve = async () => {
      if (figma.editorType !== 'figma') throw new Error('Motion Clear requires Figma Design.');
      if (!figma.motion || typeof figma.motion !== 'object') throw new Error('Motion API is not enabled for this Figma account.');
      if (typeof figma.getNodeByIdAsync !== 'function') throw new Error('Motion Clear requires the asynchronous node API.');
      const requested = await figma.getNodeByIdAsync(request.nodeId);
      if (!requested) throw new Error('Motion target was not found.');
      let node = requested; let descended = false; let fromName = null;
      const topLevel = requested.parent && requested.parent.type === 'PAGE';
      const container = ['FRAME','COMPONENT','COMPONENT_SET','GROUP','SECTION','INSTANCE'].includes(requested.type);
      if (topLevel && container) {
        if (!Array.isArray(requested.children)) throw new Error('Motion target children are invalid.');
        if (requested.children.length === 0) throw new Error('Top-level Motion target "' + clean(requested.name, ${MAX_NAME_CODE_UNITS}) + '" has no children.');
        if (requested.children.length > 1) {
          if (requested.children.length > ${MAX_MOTION_CLEAR_CHILDREN}) throw new Error('Top-level Motion target has too many children.');
          const choices = requested.children.map((child) => {
            if (typeof child.id !== 'string' || !child.id.length || child.id.length > ${MAX_ID_CODE_UNITS}
              || typeof child.name !== 'string' || child.name.length > ${MAX_NAME_CODE_UNITS}) throw new Error('Top-level Motion child identity is invalid.');
            return clean(child.id, ${MAX_ID_CODE_UNITS}) + ' ' + clean(child.name, ${MAX_NAME_CODE_UNITS});
          });
          throw new Error('Top-level Motion target is ambiguous; choose one child by id: ' + choices.join(', '));
        }
        node = requested.children[0]; descended = true;
        fromName = clean(requested.name, ${MAX_NAME_CODE_UNITS});
      }
      if (typeof node.id !== 'string' || !node.id.length || node.id.length > ${MAX_ID_CODE_UNITS}
        || typeof node.name !== 'string' || node.name.length > ${MAX_NAME_CODE_UNITS}) throw new Error('Motion target identity is invalid.');
      return { node, descended, fromName };
    };
    const binding = (value, label) => {
      if (!record(value) || !Array.isArray(value.keyframes)) throw new Error(label + ' is not rollback-safe.');
      return value;
    };
    const boundedField = (value, label) => {
      if (typeof value !== 'string' || !value.length || value.length > ${MAX_FIELD_CODE_UNITS}) throw new Error(label + ' is invalid.');
      return value;
    };
    const trackTarget = (snapshot, field) => {
      if (field.type === 'PROPERTY') {
        if (!Object.hasOwn(snapshot, field.name)) return null;
        return { field, binding: binding(snapshot[field.name], 'Motion property track'), path: [field.name] };
      }
      const collection = snapshot[field.collection];
      const index = String(field.index);
      if (!record(collection) || !Object.hasOwn(collection, index)) return null;
      return { field, binding: binding(collection[index], 'Motion paint track'), path: [field.collection, index] };
    };
    const tracks = (node) => {
      if (!('manualKeyframeTracks' in node) || typeof node.removeManualKeyframeTrack !== 'function'
        || typeof node.applyManualKeyframeTrack !== 'function') throw new Error('Motion target does not support reversible manual tracks.');
      const snapshot = copy(node.manualKeyframeTracks, 'Motion manual tracks');
      if (!record(snapshot)) throw new Error('Motion manual tracks are invalid.');
      const targets = [];
      if (request.mode === 'field') {
        const target = trackTarget(snapshot, requestedField);
        if (target) targets.push(target);
      } else {
        const push = (field, value, path, label) => {
          targets.push({ field, binding: binding(value, label), path });
          if (targets.length > ${MAX_MOTION_CLEAR_ITEMS}) throw new Error('Motion manual track inventory exceeded its bounded limit.');
        };
        for (const name of Object.keys(snapshot)) {
          boundedField(name, 'Motion manual track field');
          if (name === 'fills' || name === 'strokes') {
            const values = snapshot[name];
            if (!record(values)) throw new Error('Motion paint tracks are invalid.');
            for (const index of Object.keys(values)) {
              if (!/^(0|[1-9]\\d*)$/.test(index) || Number(index) > Number.MAX_SAFE_INTEGER) throw new Error('Motion paint track index is invalid.');
              const value = values[index];
              if (record(value) && Object.hasOwn(value, 'properties')) {
                if (Object.keys(value).length !== 1 || !record(value.properties)) throw new Error('Motion paint property tracks are invalid.');
                for (const propertyId of Object.keys(value.properties)) {
                  boundedField(propertyId, 'Motion paint property id');
                  push({ type: 'INDEXED_ITEM', collection: name, index: Number(index), propertyId },
                    value.properties[propertyId], [name, index, 'properties', propertyId], 'Motion paint property track');
                }
              } else {
                push({ type: 'INDEXED_ITEM', collection: name, index: Number(index) },
                  value, [name, index], 'Motion paint track');
              }
            }
          } else if (name === 'effects') {
            const values = snapshot.effects;
            if (!record(values)) throw new Error('Motion effect tracks are invalid.');
            for (const index of Object.keys(values)) {
              if (!/^(0|[1-9]\\d*)$/.test(index) || Number(index) > Number.MAX_SAFE_INTEGER
                || !record(values[index])) throw new Error('Motion effect track index is invalid.');
              for (const fieldName of Object.keys(values[index])) {
                boundedField(fieldName, 'Motion effect field');
                if (fieldName === 'properties') {
                  if (!record(values[index].properties)) throw new Error('Motion effect property tracks are invalid.');
                  for (const propertyId of Object.keys(values[index].properties)) {
                    boundedField(propertyId, 'Motion effect property id');
                    push({ type: 'INDEXED_ITEM', collection: 'effects', index: Number(index), propertyId },
                      values[index].properties[propertyId], ['effects', index, 'properties', propertyId], 'Motion effect property track');
                  }
                } else {
                  push({ type: 'INDEXED_ITEM', collection: 'effects', index: Number(index), field: fieldName },
                    values[index][fieldName], ['effects', index, fieldName], 'Motion effect track');
                }
              }
            }
          } else {
            push({ type: 'PROPERTY', name }, snapshot[name], [name], 'Motion property track');
          }
        }
      }
      return { snapshot, targets };
    };
    const styles = (node) => {
      if (!Array.isArray(node.animationStyles) || node.animationStyles.length > ${MAX_MOTION_CLEAR_ITEMS}
        || typeof node.removeAnimationStyle !== 'function') throw new Error('Motion target does not expose a bounded animation-style inventory.');
      const snapshot = copy(node.animationStyles, 'Motion animation styles');
      if (!Array.isArray(snapshot) || snapshot.some((style) => !record(style)
        || typeof style.id !== 'string' || !style.id.length || style.id.length > ${MAX_ID_CODE_UNITS})
        || new Set(snapshot.map((style) => style.id)).size !== snapshot.length) throw new Error('Motion animation style facts are invalid.');
      return { snapshot };
    };
    const expectedTracks = (before) => {
      const expected = copy(before.snapshot, 'Motion expected tracks');
      for (const target of before.targets) {
        const parents = [];
        let value = expected;
        for (let index = 0; index < target.path.length - 1; index++) {
          parents.push({ value, key: target.path[index] });
          value = value[target.path[index]];
        }
        delete value[target.path[target.path.length - 1]];
        for (let index = parents.length - 1; index >= 0; index--) {
          const child = parents[index].value[parents[index].key];
          if (record(child) && Object.keys(child).length === 0) delete parents[index].value[parents[index].key];
        }
      }
      return expected;
    };
    const refusal = (error) => bounded({ schemaVersion: 1, status: 'refused', mode: request.mode, outcome: 'no-mutation', attempted: 0, failure: failureText(error, 'Motion Clear preflight failed') });
    const failed = (outcome, restored, error, residue) => bounded({ schemaVersion: 1, status: 'failed', mode: request.mode, outcome, attempted: 1, restored, residue, failure: failureText(error, 'Motion Clear postcondition failed') });
    const success = (outcome, attempted, target, cleared, beforeCount, afterCount, mutationError) => bounded({
      schemaVersion: 1, status: 'cleared', mode: request.mode, outcome, attempted,
      node: nodeFact(target.node, target.descended, target.fromName), cleared, beforeCount, afterCount,
      residue: [], warnings: mutationError ? ['The native clear reported an error, but fresh readback proved the requested state.'] : [],
    });

    let target; let before;
    try {
      target = await resolve();
      before = request.mode === 'styles' ? styles(target.node) : tracks(target.node);
    } catch (error) { return refusal(error); }
    const beforeCount = request.mode === 'styles' ? before.snapshot.length : before.targets.length;
    if (beforeCount === 0) return success('no-op', 0, target, 0, 0, 0, null);
    const expected = request.mode === 'styles' ? [] : expectedTracks(before);
    let mutationError = null;
    if (request.mode === 'styles') {
      for (const style of before.snapshot) {
        try { target.node.removeAnimationStyle(style.id); }
        catch (error) { mutationError = error; break; }
      }
    } else {
      for (const entry of before.targets) {
        try { target.node.removeManualKeyframeTrack(entry.field); }
        catch (error) { mutationError = error; break; }
      }
    }
    const fresh = async () => {
      const node = await figma.getNodeByIdAsync(target.node.id);
      if (!node) throw new Error('Fresh Motion Clear target is unavailable.');
      return request.mode === 'styles' ? styles(node) : tracks(node);
    };
    let after = null;
    try {
      after = await fresh();
      if (same(after.snapshot, expected)) {
        delete globalThis.__invCache;
        return success(mutationError ? 'verified-after-error' : 'verified', 1, target,
          beforeCount, beforeCount, 0, mutationError);
      }
    } catch (error) { mutationError ||= error; }
    if (after && same(after.snapshot, before.snapshot)) return failed('unchanged', 0, mutationError, ['motion-state']);
    if (request.mode === 'styles') return failed(after ? 'partial-residue' : 'verification-unavailable', 0, mutationError, after ? ['animation-style-state'] : []);
    let rollbackError = null;
    try {
      const rollbackNode = await figma.getNodeByIdAsync(target.node.id);
      if (!rollbackNode || typeof rollbackNode.applyManualKeyframeTrack !== 'function') throw new Error('Motion track rollback target is unavailable.');
      for (const entry of [...before.targets].reverse()) {
        try { rollbackNode.applyManualKeyframeTrack(entry.field, entry.binding); }
        catch (error) { rollbackError ||= error; }
      }
    } catch (error) { rollbackError ||= error; }
    try {
      const restored = await fresh();
      if (same(restored.snapshot, before.snapshot)) {
        delete globalThis.__invCache;
        return failed('rolled-back', 1, mutationError || rollbackError, []);
      }
      return failed('partial-residue', 0, mutationError || rollbackError, ['manual-track-state']);
    } catch (error) {
      return failed('verification-unavailable', 0, mutationError || rollbackError || error, []);
    }
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
    && (value.descended
      ? value.fromName !== null && value.id !== input.nodeId
      : value.fromName === null && value.id === input.nodeId);
}
function validSuccess(value, input) {
  if (!exact(value, ['schemaVersion','status','mode','outcome','attempted','node','cleared','beforeCount','afterCount','residue','warnings'])
    || value.schemaVersion !== 1 || value.status !== 'cleared' || value.mode !== input.mode
    || !['verified','verified-after-error','no-op'].includes(value.outcome)
    || ![0,1].includes(value.attempted) || !validNode(value.node, input)
    || !Number.isInteger(value.cleared) || value.cleared < 0 || value.cleared > MAX_MOTION_CLEAR_ITEMS
    || !Number.isInteger(value.beforeCount) || value.beforeCount < 0 || value.beforeCount > MAX_MOTION_CLEAR_ITEMS
    || !Number.isInteger(value.afterCount) || value.afterCount < 0 || value.afterCount > MAX_MOTION_CLEAR_ITEMS
    || value.beforeCount - value.cleared !== value.afterCount
    || (input.mode === 'field' && value.beforeCount > 1)
    || !Array.isArray(value.residue) || value.residue.length
    || !Array.isArray(value.warnings) || value.warnings.some((warning) => !text(warning, MAX_FAILURE_CODE_UNITS, false))) return false;
  if (value.outcome === 'no-op') return value.attempted === 0 && value.cleared === 0 && value.beforeCount === value.afterCount && value.warnings.length === 0;
  return value.attempted === 1 && value.cleared === value.beforeCount && value.afterCount === 0
    && value.warnings.length === (value.outcome === 'verified-after-error' ? 1 : 0);
}
function validRefusal(value, input) {
  return exact(value, ['schemaVersion','status','mode','outcome','attempted','failure'])
    && value.schemaVersion === 1 && value.status === 'refused' && value.mode === input.mode
    && value.outcome === 'no-mutation' && value.attempted === 0
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false);
}
function validFailure(value, input) {
  const valid = exact(value, ['schemaVersion','status','mode','outcome','attempted','restored','residue','failure'])
    && value.schemaVersion === 1 && value.status === 'failed' && value.mode === input.mode
    && ['unchanged','rolled-back','partial-residue','verification-unavailable'].includes(value.outcome)
    && value.attempted === 1 && [0,1].includes(value.restored)
    && Array.isArray(value.residue) && value.residue.length <= 1
    && value.residue.every((item) => ['motion-state','animation-style-state','manual-track-state'].includes(item))
    && text(value.failure, MAX_FAILURE_CODE_UNITS, false)
    && (value.outcome !== 'rolled-back' || input.mode !== 'styles' && value.restored === 1 && value.residue.length === 0)
    && (!['unchanged','partial-residue'].includes(value.outcome) || value.restored === 0 && value.residue.length === 1)
    && (value.outcome !== 'verification-unavailable' || value.restored === 0 && value.residue.length === 0);
  if (!valid) return false;
  if (value.outcome === 'unchanged') return value.residue[0] === 'motion-state';
  if (value.outcome === 'partial-residue') {
    return value.residue[0] === (input.mode === 'styles' ? 'animation-style-state' : 'manual-track-state');
  }
  return true;
}
function pluginResultError(message) { const error = new Error(message); Object.assign(error, { kind: 'plugin-result', phase: 'plugin-response', outcome: 'unknown-after-dispatch' }); return error; }
function mutationError(message, outcome, report) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-execution', outcome: 'unknown-after-dispatch', dispatchState: 'failed', mutationOutcome: outcome, mutationReport: report }); return error; }
function safeText(value) { return String(value).replace(UNSAFE_TEXT, ' '); }

export async function executeMotionClear(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Motion Clear requires a Figma evaluate adapter.');
  const input = normalized(request);
  const serialized = await adapters.evaluate(motionClearCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_MOTION_CLEAR_RESULT_CODE_UNITS) throw pluginResultError('Motion Clear returned an invalid bounded result.');
  let payload; try { payload = JSON.parse(serialized); } catch { throw pluginResultError('Motion Clear returned invalid JSON.'); }
  if (payload?.status === 'refused') {
    if (!validRefusal(payload, input)) throw pluginResultError('Motion Clear returned an invalid bounded result.');
    throw mutationError(`Motion Clear made no mutation: ${payload.failure}`, 'no-mutation', { version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0 });
  }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, input)) throw pluginResultError('Motion Clear returned an invalid bounded result.');
    throw mutationError(`Motion Clear failed with ${payload.outcome}: ${payload.failure}`, payload.outcome, { version: 1, outcome: payload.outcome, attempted: 1, restored: payload.restored, residueCount: payload.outcome === 'verification-unavailable' ? 1 : payload.residue.length });
  }
  if (!validSuccess(payload, input)) throw pluginResultError('Motion Clear returned an invalid bounded result.');
  const what = input.mode === 'styles' ? 'styles' : input.mode === 'field' ? `field ${input.field}` : 'all tracks';
  return {
    stdout: `Cleared ${what} on ${safeText(payload.node.name)}`,
    stderr: payload.warnings.join('\n'),
    code: 0,
    result: payload,
  };
}

export function motionClearPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Motion Clear routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-motion-clear';
}

export function executeMotionClearPlan(plan, adapters = {}) {
  if (motionClearPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Motion Clear.');
  return executeMotionClear(parseMotionClearRequest(plan.argv), adapters);
}
