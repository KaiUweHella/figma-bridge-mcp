import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

function duration(startedAt) {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function lines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

function traceEvents(path, offset) {
  return lines(path).slice(offset).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function rssBytes(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      return match ? Number(match[1]) * 1024 : null;
    }
    if (process.platform === 'darwin') {
      const value = execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 1000,
      }).trim();
      return /^\d+$/.test(value) ? Number(value) * 1024 : null;
    }
  } catch {}
  return null;
}

function startRssSampler(pid, intervalMs = 100) {
  let peak = rssBytes(pid);
  const sample = () => {
    const value = rssBytes(pid);
    if (value !== null) peak = peak === null ? value : Math.max(peak, value);
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return {
    sample,
    stop() {
      clearInterval(timer);
      sample();
      return peak;
    },
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function summarizeMcpSamples(samples) {
  const metrics = [
    'callMs', 'handlerMs', 'clientOutsideHandlerMs', 'mcpOutsideDaemonMs',
    'daemonOutsidePluginMs', 'pluginQueueMs', 'pluginExecutionMs',
    'envelopeBytes', 'peakRssBytes', 'adapterPeakRssBytes',
    'compatibilityChildPeakRssBytes', 'auditEntriesDelta',
  ];
  return Object.fromEntries(metrics.map((metric) => {
    const values = samples.map((sample) => sample[metric]).filter(Number.isFinite);
    return [metric, values.length ? {
      min: Math.min(...values),
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: Math.max(...values),
    } : null];
  }));
}

function summed(events, project) {
  return Math.round(events.reduce((total, event) => total + Math.max(0, project(event) || 0), 0) * 1000) / 1000;
}

function sampleSegments({ callMs, handlerMs, daemonEvents }) {
  const pluginQueueMs = summed(daemonEvents, (event) => (
    event.pluginExecutionTiming?.queuedMs
    ?? Math.max(0, (event.pluginExecutionTiming?.totalMs || 0) - (event.pluginExecutionTiming?.executionMs || 0))
  ));
  const pluginExecutionMs = summed(daemonEvents, (event) => event.pluginExecutionTiming?.executionMs || 0);
  const daemonElapsedMs = summed(daemonEvents, (event) => event.elapsedMs || 0);
  const pluginTotalMs = pluginQueueMs + pluginExecutionMs;
  const daemonOutsidePluginMs = Math.max(0, Math.round((daemonElapsedMs - pluginTotalMs) * 1000) / 1000);
  const mcpOutsideDaemonMs = Math.max(0, Math.round((handlerMs - daemonElapsedMs) * 1000) / 1000);
  const clientOutsideHandlerMs = Math.max(0, Math.round((callMs - handlerMs) * 1000) / 1000);
  const candidates = {
    clientOutsideHandlerMs,
    mcpOutsideDaemonMs,
    daemonOutsidePluginMs,
    pluginQueueMs,
    pluginExecutionMs,
  };
  const dominantSegment = Object.entries(candidates)
    .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
  return {
    clientOutsideHandlerMs,
    mcpOutsideDaemonMs,
    daemonOutsidePluginMs,
    pluginQueueMs,
    pluginExecutionMs,
    dominantSegment,
  };
}

/** Measure one real MCP process and repeated calls for one workload. */
export async function measureMcpToolSession({
  id,
  kind,
  serverPath,
  cwd,
  iterations = 3,
  request,
  afterSample = null,
  env = {},
}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20) {
    throw new TypeError('MCP runtime iterations must be 1-20');
  }
  const privateDir = mkdtempSync(join(tmpdir(), 'figma-bridge-mcp-runtime-'));
  const tracePath = join(privateDir, 'runtime.jsonl');
  const auditPath = join(privateDir, 'audit.jsonl');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      ...env,
      FIGMA_BRIDGE_RUNTIME_TRACE_PATH: tracePath,
      AUDIT_LOG_PATH: auditPath,
    },
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length);
  });
  const client = new Client({ name: 'figma-bridge-runtime-harness', version: '1.0.0' });
  const connectStartedAt = performance.now();
  let sampler = null;
  let peakRssBytes = null;
  try {
    await client.connect(transport);
    const processStartupMs = duration(connectStartedAt);
    sampler = startRssSampler(transport.pid);
    const samples = [];
    for (let iteration = 0; iteration < iterations; iteration++) {
      const traceOffset = lines(tracePath).length;
      const auditOffset = lines(auditPath).length;
      const call = typeof request === 'function'
        ? await request({ iteration, samples })
        : request;
      const callStartedAt = performance.now();
      const result = await client.callTool(call);
      const callMs = duration(callStartedAt);
      sampler.sample();
      const events = traceEvents(tracePath, traceOffset);
      const handler = [...events].reverse().find((event) => event.kind === 'mcp-tool');
      const daemonEvents = events.filter((event) => event.kind === 'daemon-execution');
      const handlerMs = Number.isFinite(handler?.elapsedMs) ? handler.elapsedMs : callMs;
      const adapterRss = events.map((event) => event.processRssBytes).filter(Number.isFinite);
      const compatibilityRss = events
        .filter((event) => event.pid !== transport.pid)
        .map((event) => event.processRssBytes)
        .filter(Number.isFinite);
      const sample = {
        iteration,
        phase: iteration === 0 ? 'first-process-call' : 'warm-process-call',
        callMs,
        handlerMs,
        ...sampleSegments({ callMs, handlerMs, daemonEvents }),
        envelopeBytes: bytes(result),
        tracedEnvelopeBytes: handler?.envelopeBytes ?? null,
        daemonCalls: daemonEvents.length,
        daemonActions: daemonEvents.map((event) => event.action),
        adapterProcesses: [...new Set(daemonEvents.map((event) => (
          event.pid === transport.pid ? 'mcp-process' : 'compatibility-child'
        )))],
        auditEntriesDelta: Math.max(0, lines(auditPath).length - auditOffset),
        peakRssBytes: rssBytes(transport.pid),
        adapterPeakRssBytes: adapterRss.length ? Math.max(...adapterRss) : null,
        compatibilityChildPeakRssBytes: compatibilityRss.length ? Math.max(...compatibilityRss) : null,
        result,
      };
      if (sample.tracedEnvelopeBytes !== null && sample.tracedEnvelopeBytes !== sample.envelopeBytes) {
        throw new Error(`${id}: traced/client MCP envelope bytes disagree`);
      }
      if (result?.isError === true) {
        throw new Error(`${id}: ${result.content?.[0]?.text || 'MCP tool returned an error'}`);
      }
      if (afterSample) await afterSample(sample, { iteration, samples });
      samples.push(sample);
    }
    peakRssBytes = sampler.stop();
    sampler = null;
    return {
      id,
      kind,
      processStartupMs,
      processPid: transport.pid,
      peakRssBytes,
      first: samples[0],
      warm: samples.slice(1),
      summary: summarizeMcpSamples(samples),
    };
  } catch (error) {
    if (stderr.trim()) error.message += `\nMCP stderr: ${stderr.trim()}`;
    throw error;
  } finally {
    if (sampler) peakRssBytes = sampler.stop();
    await client.close().catch(() => {});
    rmSync(privateDir, { recursive: true, force: true });
  }
}

/** Stable offline gate: real process startup plus repeated tools/list. */
export async function measureMcpDiscoveryBaseline({ serverPath, cwd, sessions = 3 }) {
  const results = [];
  for (let index = 0; index < sessions; index++) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'figma-bridge-runtime-budget', version: '1.0.0' });
    const startedAt = performance.now();
    let sampler;
    try {
      await client.connect(transport);
      const processStartupMs = duration(startedAt);
      sampler = startRssSampler(transport.pid);
      const calls = [];
      for (let iteration = 0; iteration < 3; iteration++) {
        const callStartedAt = performance.now();
        const response = await client.listTools();
        calls.push({
          callMs: duration(callStartedAt),
          envelopeBytes: bytes(response),
          toolCount: response.tools.length,
        });
      }
      results.push({
        processStartupMs,
        first: calls[0],
        warm: calls.slice(1),
        peakRssBytes: sampler.stop(),
      });
      sampler = null;
    } finally {
      if (sampler) sampler.stop();
      await client.close().catch(() => {});
    }
  }
  const starts = results.map((result) => result.processStartupMs);
  const warmCalls = results.flatMap((result) => result.warm.map((call) => call.callMs));
  const rssSamples = results.map((result) => result.peakRssBytes).filter(Number.isFinite);
  return {
    sessions: results,
    processStartupP95Ms: percentile(starts, 0.95),
    warmToolsListP95Ms: percentile(warmCalls, 0.95),
    maxEnvelopeBytes: Math.max(...results.flatMap((result) => [result.first, ...result.warm].map((call) => call.envelopeBytes))),
    rssSamplingAvailable: rssSamples.length > 0,
    maxPeakRssBytes: rssSamples.length ? Math.max(...rssSamples) : null,
  };
}
