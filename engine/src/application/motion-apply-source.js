// Bounded validation and normalization for `motion apply` JSON sources.

import { mapEasing, mapField, normalizeSpec } from '../lib/motion-core.js';
import { parseBoundedJson } from '../lib/workspace-io.js';
import { NODE_REFERENCE_PATTERN } from './node-reference.js';
import { prepareNormalizedMotionTracks } from './motion-track-preparation.js';
import {
  MAX_MOTION_TRACK_KEYFRAMES,
  MAX_MOTION_TRACK_NODES,
  MAX_MOTION_TRACK_PAINTS,
  MAX_MOTION_TRACKS,
  prepareMotionTrackMutation,
} from './motion-track-mutation.js';

function sourceError(message) { return new Error(`Invalid Motion Apply source: ${message}.`); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, required, optional = []) {
  return record(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function finiteGraph(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteGraph);
  return record(value) && Object.values(value).every(finiteGraph);
}

/**
 * @param {string} text
 * @param {{limits?: typeof import('../lib/workspace-io.js').DEFAULT_WORKSPACE_LIMITS}} [options]
 */
export function parseMotionApplySource(text, { limits } = {}) {
  if (typeof text !== 'string') throw new TypeError('Motion Apply source must be text.');
  let source;
  try { source = parseBoundedJson(text, { role: 'motion-file', limits }); }
  catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('WORKSPACE_')) {
      throw sourceError(error.message);
    }
    throw sourceError('source must be valid bounded JSON');
  }
  if (!exact(source, ['tracks'], ['duration']) || !Array.isArray(source.tracks)
    || source.tracks.length === 0 || source.tracks.length > MAX_MOTION_TRACKS) {
    throw sourceError(`root must contain 1-${MAX_MOTION_TRACKS} tracks and optional duration`);
  }
  if (source.duration !== undefined && (!Number.isFinite(source.duration) || source.duration < 0
    || source.duration > Number.MAX_SAFE_INTEGER)) throw sourceError('duration must be a finite non-negative number');
  const targets = new Set();
  const identities = new Set();
  for (const track of source.tracks) {
    if (!exact(track, ['node','field','keys']) || typeof track.node !== 'string'
      || !NODE_REFERENCE_PATTERN.test(track.node) || typeof track.field !== 'string') {
      throw sourceError('every track requires an exact node id, field, and keys array');
    }
    targets.add(track.node);
    if (targets.size > MAX_MOTION_TRACK_NODES) throw sourceError(`target count exceeds ${MAX_MOTION_TRACK_NODES}`);
    let mapped;
    try { mapped = mapField(track.field); }
    catch { throw sourceError('track field is unsupported'); }
    if (mapped.valueType === 'COLOR' && mapped.index >= MAX_MOTION_TRACK_PAINTS) {
      throw sourceError('paint index exceeds the bounded Motion paint inventory');
    }
    const identity = mapped.valueType === 'COLOR'
      ? `${track.node}:${mapped.name}:${mapped.index}` : `${track.node}:${mapped.name}`;
    if (identities.has(identity)) throw sourceError('a target field may appear only once');
    identities.add(identity);
    if (!Array.isArray(track.keys) || track.keys.length === 0
      || track.keys.length > MAX_MOTION_TRACK_KEYFRAMES) {
      throw sourceError(`every track requires 1-${MAX_MOTION_TRACK_KEYFRAMES} keys`);
    }
    for (const key of track.keys) {
      if (!exact(key, ['t','v'], ['ease']) || !Number.isFinite(key.t) || key.t < 0
        || key.t > Number.MAX_SAFE_INTEGER || !finiteGraph(key.v)) {
        throw sourceError('every key requires a finite non-negative t and JSON-safe v');
      }
      if (key.ease !== undefined) {
        if (typeof key.ease !== 'string') throw sourceError('key easing must be a string');
        try { mapEasing(key.ease); }
        catch { throw sourceError('key easing is unsupported'); }
      }
    }
  }
  let normalized;
  try { normalized = normalizeSpec(source); }
  catch { throw sourceError('source could not be normalized'); }
  const prepared = prepareMotionTrackMutation(prepareNormalizedMotionTracks('apply', normalized));
  if (!finiteGraph(prepared)) throw sourceError('normalized tracks contain a non-finite native value');
  return Object.freeze({
    canonical: JSON.stringify(source),
    prepared,
  });
}
