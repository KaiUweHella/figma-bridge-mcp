// Plan-bound `motion stagger` Adapter over the shared Motion track transaction.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { expandStagger, normalizeSpec } from '../lib/motion-core.js';
import {
  motionStaggerArgvFromRequest,
  motionStaggerPlanningArgvFromRequest,
  parseMotionStaggerRequest,
} from './motion-stagger-request.js';
import { prepareNormalizedMotionTracks } from './motion-track-preparation.js';
import {
  executeMotionTrackMutation,
  motionTrackMutationCode,
} from './motion-track-mutation.js';

export { motionStaggerArgvFromRequest, motionStaggerPlanningArgvFromRequest } from './motion-stagger-request.js';

const APPLICATION_ID = 'motion.stagger';
const normalized = (request) => parseMotionStaggerRequest(motionStaggerArgvFromRequest(request));

function preparedMotionStagger(input) {
  const options = input.mode === 'preset'
    ? { preset: input.preset, dur: input.duration, ease: input.easing }
    : { field: input.field, from: input.from, to: input.to, dur: input.duration, ease: input.easing };
  return prepareNormalizedMotionTracks('stagger',
    normalizeSpec(expandStagger(input.nodeIds, options, input.step)));
}

export function motionStaggerCode(request) {
  return motionTrackMutationCode(preparedMotionStagger(normalized(request)));
}

export async function executeMotionStagger(request, adapters = {}) {
  const input = normalized(request);
  const payload = await executeMotionTrackMutation(preparedMotionStagger(input), adapters);
  return {
    stdout: `Staggered ${payload.nodes.length} node${payload.nodes.length === 1 ? '' : 's'} · ${payload.trackCount} track${payload.trackCount === 1 ? '' : 's'} · timeline ${payload.duration}s`,
    stderr: payload.warnings.join('\n'),
    code: 0,
    result: payload,
  };
}

export function motionStaggerPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Motion Stagger routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-motion-stagger';
}

export function executeMotionStaggerPlan(plan, adapters = {}) {
  if (motionStaggerPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Motion Stagger.');
  return executeMotionStagger(parseMotionStaggerRequest(plan.argv), adapters);
}
