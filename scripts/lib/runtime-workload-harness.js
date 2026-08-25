import { performance } from 'node:perf_hooks';

function finiteDuration(value) {
  return Math.max(0, Math.round(Number(value) * 1000) / 1000);
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? null), 'utf8');
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarizeRuntimeSamples(samples) {
  const metrics = ['planningMs', 'executionMs', 'totalMs', 'outcomeBytes', 'heapDeltaBytes'];
  return Object.fromEntries(metrics.map((metric) => {
    const values = samples.map((sample) => sample[metric]);
    return [metric, {
      min: Math.min(...values),
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: Math.max(...values),
    }];
  }));
}

/**
 * Measure one in-process Command Application without changing its public
 * output. The evaluator may attach validated Plugin timing through `observe`.
 */
export async function measureRuntimeWorkload({
  id,
  kind,
  plan,
  execute,
  now = () => performance.now(),
  heapUsed = () => process.memoryUsage().heapUsed,
}) {
  if (typeof id !== 'string' || !id || typeof kind !== 'string' || !kind) {
    throw new TypeError('Runtime workload requires id and kind');
  }
  if (typeof plan !== 'function' || typeof execute !== 'function') {
    throw new TypeError('Runtime workload requires plan() and execute()');
  }
  let pluginExecutionTiming = null;
  let bridgeExecutionTiming = null;
  const observe = (metadata) => {
    pluginExecutionTiming = metadata?.pluginExecutionTiming && typeof metadata.pluginExecutionTiming === 'object'
      ? metadata.pluginExecutionTiming : null;
    bridgeExecutionTiming = metadata?.bridgeExecutionTiming && typeof metadata.bridgeExecutionTiming === 'object'
      ? metadata.bridgeExecutionTiming : null;
  };
  const heapBefore = heapUsed();
  const startedAt = now();
  const commandPlan = plan();
  const plannedAt = now();
  const outcome = await execute(commandPlan, { observe });
  const finishedAt = now();
  const heapAfter = heapUsed();
  const planningMs = finiteDuration(plannedAt - startedAt);
  const executionMs = finiteDuration(finishedAt - plannedAt);
  const totalMs = finiteDuration(finishedAt - startedAt);
  const outcomeBytes = byteLength({
    stdout: outcome?.stdout ?? '',
    stderr: outcome?.stderr ?? '',
    result: outcome?.result ?? null,
  });
  const pluginTotal = Number.isSafeInteger(pluginExecutionTiming?.totalMs)
    ? pluginExecutionTiming.totalMs : null;
  return Object.freeze({
    schema: 'figma-bridge/runtime-workload-sample',
    version: 1,
    id,
    kind,
    planningMs,
    executionMs,
    totalMs,
    outcomeBytes,
    heapDeltaBytes: heapAfter - heapBefore,
    pluginExecutionTiming,
    bridgeExecutionTiming,
    bridgeOutsidePluginMs: pluginTotal === null
      ? null
      : finiteDuration(Math.max(0, executionMs - pluginTotal)),
    clientOutsideDaemonMs: Number.isSafeInteger(bridgeExecutionTiming?.preResponseMs)
      ? finiteDuration(Math.max(0, executionMs - bridgeExecutionTiming.preResponseMs))
      : null,
  });
}

export async function runRuntimeWorkloadSeries(workload, { iterations = 3 } = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20) {
    throw new TypeError('Runtime workload iterations must be 1-20');
  }
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    samples.push(await measureRuntimeWorkload(workload));
  }
  return Object.freeze({
    id: workload.id,
    kind: workload.kind,
    first: samples[0],
    warm: samples.slice(1),
    summary: summarizeRuntimeSamples(samples),
  });
}
