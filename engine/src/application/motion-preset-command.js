// Plan-bound `motion preset` Adapter over the shared Motion track transaction.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { normalizeSpec, presetTracks } from '../lib/motion-core.js';
import {
  motionPresetArgvFromRequest,
  motionPresetPlanningArgvFromRequest,
  parseMotionPresetRequest,
} from './motion-preset-request.js';
import { prepareNormalizedMotionTracks } from './motion-track-preparation.js';
import {
  executeMotionTrackMutation,
  motionTrackMutationCode,
  safeMotionText,
} from './motion-track-mutation.js';

export { motionPresetArgvFromRequest, motionPresetPlanningArgvFromRequest } from './motion-preset-request.js';

const APPLICATION_ID = 'motion.preset';
const normalized = (request) => parseMotionPresetRequest(motionPresetArgvFromRequest(request));

function preparedMotionPreset(input) {
  const tracks = presetTracks(input.preset, {
    dur: input.duration,
    at: input.offset,
    ease: input.easing,
  }).map((track) => ({ node: input.nodeId, field: track.field, keys: track.keys }));
  return prepareNormalizedMotionTracks('preset', normalizeSpec({ tracks }));
}

export function motionPresetCode(request) {
  return motionTrackMutationCode(preparedMotionPreset(normalized(request)));
}

export async function executeMotionPreset(request, adapters = {}) {
  const input = normalized(request);
  const payload = await executeMotionTrackMutation(preparedMotionPreset(input), adapters);
  const node = payload.nodes[0];
  const via = node.descended ? ` (via "${safeMotionText(node.fromName)}")` : '';
  return {
    stdout: `Applied preset "${safeMotionText(input.preset)}" to ${safeMotionText(node.id)}  ${safeMotionText(node.name)}${via} → ${node.fields.map(safeMotionText).join(', ')} · timeline ${payload.duration}s`,
    stderr: payload.warnings.join('\n'),
    code: 0,
    result: payload,
  };
}

export function motionPresetPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Motion Preset routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-motion-preset';
}

export function executeMotionPresetPlan(plan, adapters = {}) {
  if (motionPresetPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Motion Preset.');
  return executeMotionPreset(parseMotionPresetRequest(plan.argv), adapters);
}
