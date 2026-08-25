// Closed, content-free timing evidence emitted by the Figma Plugin main
// thread. This contract is generated into plugin/code.js so the producer and
// daemon validator cannot silently drift apart.

// BEGIN PLUGIN EXECUTION TIMING RUNTIME
export const PLUGIN_EXECUTION_TIMING_SCHEMA = 'figma-bridge/plugin-execution-timing';
export const PLUGIN_EXECUTION_TIMING_VERSION = 1;
export const MAX_PLUGIN_EXECUTION_TIMING_MS = 130_000;

const PLUGIN_EXECUTION_TIMING_FIELDS = Object.freeze([
  'schema',
  'version',
  'queuedMs',
  'executionMs',
  'totalMs',
]);

function pluginExecutionDuration(start, end) {
  return Math.max(0, Math.min(MAX_PLUGIN_EXECUTION_TIMING_MS, Math.round(end - start)));
}

export function createPluginExecutionTiming({ queuedAt, startedAt, finishedAt }) {
  const queuedMs = pluginExecutionDuration(queuedAt, startedAt);
  const executionMs = pluginExecutionDuration(startedAt, finishedAt);
  return Object.freeze({
    schema: PLUGIN_EXECUTION_TIMING_SCHEMA,
    version: PLUGIN_EXECUTION_TIMING_VERSION,
    queuedMs,
    executionMs,
    totalMs: Math.min(MAX_PLUGIN_EXECUTION_TIMING_MS, queuedMs + executionMs),
  });
}

export function pluginExecutionTimingValidationError(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Plugin execution timing must be an object';
  }
  const keys = Object.keys(value).sort();
  const expected = [...PLUGIN_EXECUTION_TIMING_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return 'Plugin execution timing contains unknown or missing fields';
  }
  if (value.schema !== PLUGIN_EXECUTION_TIMING_SCHEMA
      || value.version !== PLUGIN_EXECUTION_TIMING_VERSION) {
    return 'Plugin execution timing schema/version is unsupported';
  }
  for (const field of ['queuedMs', 'executionMs', 'totalMs']) {
    if (!Number.isSafeInteger(value[field])
        || value[field] < 0
        || value[field] > MAX_PLUGIN_EXECUTION_TIMING_MS) {
      return `Plugin execution timing ${field} must be a bounded integer`;
    }
  }
  const expectedTotal = Math.min(
    MAX_PLUGIN_EXECUTION_TIMING_MS,
    value.queuedMs + value.executionMs,
  );
  if (value.totalMs !== expectedTotal) {
    return 'Plugin execution timing total does not match its segments';
  }
  return null;
}

export function parsePluginExecutionTiming(value) {
  if (pluginExecutionTimingValidationError(value)) return null;
  return Object.freeze({
    schema: value.schema,
    version: value.version,
    queuedMs: value.queuedMs,
    executionMs: value.executionMs,
    totalMs: value.totalMs,
  });
}
// END PLUGIN EXECUTION TIMING RUNTIME
