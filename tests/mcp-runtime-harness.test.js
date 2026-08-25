import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMcpRuntimeBudgets } from '../scripts/check-runtime-budgets.js';
import {
  measureMcpToolSession,
  summarizeMcpSamples,
} from '../scripts/lib/mcp-runtime-harness.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

test('MCP runtime summaries retain first/warm segment distributions', () => {
  const samples = [1, 2, 3].map((factor) => ({
    callMs: factor * 10,
    handlerMs: factor * 8,
    clientOutsideHandlerMs: factor * 2,
    mcpOutsideDaemonMs: factor,
    daemonOutsidePluginMs: factor * 2,
    pluginQueueMs: factor,
    pluginExecutionMs: factor * 4,
    envelopeBytes: factor * 100,
    peakRssBytes: factor * 1000,
    auditEntriesDelta: 1,
  }));
  const summary = summarizeMcpSamples(samples);
  assert.deepEqual(summary.callMs, { min: 10, p50: 20, p95: 30, max: 30 });
  assert.deepEqual(summary.pluginExecutionMs, { min: 4, p50: 8, p95: 12, max: 12 });
  assert.deepEqual(summary.auditEntriesDelta, { min: 1, p50: 1, p95: 1, max: 1 });
});

test('runtime budget policy combines generous absolutes with a warm/startup ratio', () => {
  const accepted = {
    processStartupP95Ms: 100,
    warmToolsListP95Ms: 200,
    maxEnvelopeBytes: 10_000,
    maxPeakRssBytes: 100_000_000,
  };
  assert.equal(assertMcpRuntimeBudgets(accepted), accepted);
  assert.throws(() => assertMcpRuntimeBudgets({ ...accepted, warmToolsListP95Ms: 301 }, {
    processStartupP95Ms: 5_000,
    warmToolsListP95Ms: 1_000,
    maxEnvelopeBytes: 512 * 1024,
    maxPeakRssBytes: 512 * 1024 * 1024,
  }), /3× startup/);
});

test('real STDIO measurement agrees on exact MCP envelope bytes without Figma', async () => {
  const report = await measureMcpToolSession({
    id: 'offline.reference',
    kind: 'read',
    serverPath: SERVER,
    cwd: ROOT,
    iterations: 2,
    request: { name: 'figma_reference', arguments: { name: 'capabilities' } },
  });
  assert.ok(report.processStartupMs > 0);
  assert.equal(report.first.envelopeBytes, report.first.tracedEnvelopeBytes);
  assert.equal(report.warm[0].envelopeBytes, report.warm[0].tracedEnvelopeBytes);
  assert.equal(report.first.daemonCalls, 0);
  assert.equal(report.first.auditEntriesDelta, 0);
});
