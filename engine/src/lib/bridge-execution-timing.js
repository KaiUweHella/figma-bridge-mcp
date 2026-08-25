export const BRIDGE_EXECUTION_TIMING_SCHEMA = 'figma-bridge/bridge-execution-timing';
export const BRIDGE_EXECUTION_TIMING_VERSION = 1;
export const MAX_BRIDGE_EXECUTION_TIMING_MS = 130_000;

function duration(start, end) {
  return Math.max(0, Math.min(MAX_BRIDGE_EXECUTION_TIMING_MS, Math.round(end - start)));
}

export function createBridgeExecutionTiming({
  requestStartedAt,
  laneQueuedAt,
  laneStartedAt,
  pluginStartedAt,
  pluginFinishedAt,
  preResponseAt,
}) {
  const requestPreparationMs = duration(requestStartedAt, laneQueuedAt);
  const writeLaneQueueMs = duration(laneQueuedAt, laneStartedAt);
  const pluginRoundTripMs = duration(pluginStartedAt, pluginFinishedAt);
  const preResponseMs = duration(requestStartedAt, preResponseAt);
  const attributed = requestPreparationMs + writeLaneQueueMs + pluginRoundTripMs;
  return Object.freeze({
    schema: BRIDGE_EXECUTION_TIMING_SCHEMA,
    version: BRIDGE_EXECUTION_TIMING_VERSION,
    requestPreparationMs,
    writeLaneQueueMs,
    pluginRoundTripMs,
    daemonOtherMs: Math.max(0, Math.min(MAX_BRIDGE_EXECUTION_TIMING_MS, preResponseMs - attributed)),
    preResponseMs,
  });
}
