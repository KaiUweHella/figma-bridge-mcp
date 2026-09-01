// Workspace-prepared `motion apply` Adapter over the shared track transaction.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  motionApplyArgvFromRequest,
  motionApplyPlanningArgvFromRequest,
  parseMotionApplyRequest,
} from './motion-apply-request.js';
import { parseMotionApplySource } from './motion-apply-source.js';
import {
  executeMotionTrackMutation,
  motionTrackMutationCode,
} from './motion-track-mutation.js';

export { motionApplyArgvFromRequest, motionApplyPlanningArgvFromRequest } from './motion-apply-request.js';

const APPLICATION_ID = 'motion.apply';
const PREPARED = new WeakSet();

export function motionApplyPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) throw new TypeError('Motion Apply routing requires a Command Plan.');
  return plan.allowed && plan.id === APPLICATION_ID ? 'command-application' : 'not-motion-apply';
}

export function prepareMotionApplyPlan(plan, { workspaceIO } = {}) {
  if (motionApplyPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by Motion Apply.`);
  }
  const request = parseMotionApplyRequest(plan.argv);
  let text;
  if (request.sourceKind === 'inline') text = request.source;
  else {
    if (!workspaceIO || typeof workspaceIO.readText !== 'function') {
      throw new TypeError('Motion Apply file input requires an authorized WorkspaceIO capability.');
    }
    text = workspaceIO.readText(request.source, {
      role: 'motion-file', maxBytes: workspaceIO.limits?.jsonBytes,
    });
  }
  const source = parseMotionApplySource(text, { limits: workspaceIO?.limits });
  const prepared = Object.freeze({ request, tracks: source.prepared });
  PREPARED.add(prepared);
  return prepared;
}

export function motionApplyCode(prepared) {
  if (!PREPARED.has(prepared)) throw new TypeError('Motion Apply requires authentic prepared input.');
  return motionTrackMutationCode(prepared.tracks);
}

export async function executePreparedMotionApply(prepared, adapters = {}) {
  if (!PREPARED.has(prepared)) throw new TypeError('Motion Apply requires authentic prepared input.');
  const payload = await executeMotionTrackMutation(prepared.tracks, adapters);
  return {
    stdout: `Animated ${payload.nodes.length} node${payload.nodes.length === 1 ? '' : 's'} · ${payload.trackCount} track${payload.trackCount === 1 ? '' : 's'} · timeline ${payload.duration}s`,
    stderr: payload.warnings.join('\n'),
    code: 0,
    result: payload,
  };
}

export function executeMotionApplyPlan(plan, adapters = {}) {
  return executePreparedMotionApply(prepareMotionApplyPlan(plan, adapters), adapters);
}
