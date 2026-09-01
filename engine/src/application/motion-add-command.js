// Plan-bound `motion add` Adapter over the shared Motion track transaction.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { mapField, normalizeSpec, parseKeys } from '../lib/motion-core.js';
import {
  motionAddArgvFromRequest,
  motionAddPlanningArgvFromRequest,
  parseMotionAddRequest,
} from './motion-add-request.js';
import {
  executeMotionTrackMutation,
  motionTrackMutationCode,
  safeMotionText,
} from './motion-track-mutation.js';

export { motionAddArgvFromRequest, motionAddPlanningArgvFromRequest } from './motion-add-request.js';

const APPLICATION_ID = 'motion.add';
const normalized = (request) => parseMotionAddRequest(motionAddArgvFromRequest(request));

function preparedMotionAdd(input) {
  const mapped = mapField(input.field);
  let binding;
  if (input.mode === 'keys') {
    binding = { keyframes: parseKeys(input.keys, mapped.valueType) };
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
    binding = mapped.valueType === 'COLOR' ? entry[mapped.index] : entry;
  }
  return {
    action: 'add',
    duration: input.mode === 'keys' ? input.duration : input.offset + input.duration,
    nodes: [{
      requestedId: input.nodeId,
      tracks: [{
        label: input.field,
        field: mapped.valueType === 'COLOR'
          ? { type: 'INDEXED_ITEM', collection: mapped.name, index: mapped.index }
          : { type: 'PROPERTY', name: mapped.name },
        binding,
      }],
    }],
  };
}

export function motionAddCode(request) {
  return motionTrackMutationCode(preparedMotionAdd(normalized(request)));
}

export async function executeMotionAdd(request, adapters = {}) {
  const input = normalized(request);
  const prepared = preparedMotionAdd(input);
  const payload = await executeMotionTrackMutation(prepared, adapters);
  const node = payload.nodes[0];
  const result = {
    schemaVersion: payload.schemaVersion,
    status: payload.status,
    outcome: payload.outcome,
    attempted: payload.attempted,
    node: {
      requestedId: node.requestedId,
      id: node.id,
      name: node.name,
      descended: node.descended,
      fromName: node.fromName,
    },
    field: input.field,
    duration: payload.duration,
    keyframeCount: prepared.nodes[0].tracks[0].binding.keyframes.length,
    replaced: node.replacedCount === 1,
    timelineDuration: node.timelineDuration,
    residue: payload.residue,
    warnings: payload.warnings,
  };
  const via = node.descended ? ` (via "${safeMotionText(node.fromName)}")` : '';
  return {
    stdout: `Animated ${safeMotionText(node.id)}  ${safeMotionText(node.name)}${via} → ${safeMotionText(input.field)} · timeline ${payload.duration}s`,
    stderr: payload.warnings.join('\n'),
    code: 0,
    result,
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
