// Maintainer-only runtime trace used by the private acceptance corpus.
//
// The trace is opt-in through FIGMA_BRIDGE_RUNTIME_TRACE_PATH and deliberately
// content-free: callers provide only durations, byte counts, action names and
// process ids. Trace failures never affect a Figma operation.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const RUNTIME_TRACE_SCHEMA = 'figma-bridge/runtime-trace-event';

export function runtimeTraceEnabled() {
  return Boolean(process.env.FIGMA_BRIDGE_RUNTIME_TRACE_PATH);
}

export function runtimeNow() {
  return performance.now();
}

export function runtimeDuration(startedAt) {
  return Math.max(0, Math.round((runtimeNow() - startedAt) * 1000) / 1000);
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function timingReceipt(value) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => /(?:Ms|version)$/.test(key) && finiteNumber(entry) !== null)
    .map(([key, entry]) => [key, entry]));
}

export function recordRuntimeTrace(event) {
  const tracePath = process.env.FIGMA_BRIDGE_RUNTIME_TRACE_PATH;
  if (!tracePath || !event || typeof event !== 'object') return;
  const record = {
    schema: RUNTIME_TRACE_SCHEMA,
    version: 1,
    at: new Date().toISOString(),
    pid: process.pid,
    processRssBytes: process.memoryUsage().rss,
    kind: String(event.kind || 'unknown'),
    ...(event.toolName ? { toolName: String(event.toolName) } : {}),
    ...(event.action ? { action: String(event.action) } : {}),
    ...(finiteNumber(event.elapsedMs) !== null ? { elapsedMs: event.elapsedMs } : {}),
    ...(finiteNumber(event.requestBytes) !== null ? { requestBytes: event.requestBytes } : {}),
    ...(finiteNumber(event.responseBytes) !== null ? { responseBytes: event.responseBytes } : {}),
    ...(finiteNumber(event.envelopeBytes) !== null ? { envelopeBytes: event.envelopeBytes } : {}),
    ...(event.ok === false ? { ok: false } : { ok: true }),
    ...(timingReceipt(event.pluginExecutionTiming)
      ? { pluginExecutionTiming: timingReceipt(event.pluginExecutionTiming) }
      : {}),
    ...(timingReceipt(event.bridgeExecutionTiming)
      ? { bridgeExecutionTiming: timingReceipt(event.bridgeExecutionTiming) }
      : {}),
  };
  let descriptor;
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true, mode: 0o700 });
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(
      tracePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow,
      0o600,
    );
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, null, 'utf8');
  } catch {
    // Acceptance instrumentation must never change dispatch or retry safety.
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}
