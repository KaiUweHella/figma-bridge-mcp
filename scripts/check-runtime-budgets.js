#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { measureMcpDiscoveryBaseline } from './lib/mcp-runtime-harness.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

export const MCP_RUNTIME_BUDGETS = Object.freeze({
  processStartupP95Ms: 5_000,
  warmToolsListP95Ms: 1_000,
  maxEnvelopeBytes: 512 * 1024,
  maxPeakRssBytes: 512 * 1024 * 1024,
});

export function assertMcpRuntimeBudgets(report, budgets = MCP_RUNTIME_BUDGETS) {
  for (const [metric, limit] of Object.entries(budgets)) {
    const measured = report[metric];
    if (metric === 'maxPeakRssBytes' && measured === null) continue;
    assert.ok(
      Number.isFinite(measured) && measured <= limit,
      `${metric} (${measured}) must stay within the generous CI ceiling ${limit}`,
    );
  }
  const relativeWarmLimit = Math.max(250, report.processStartupP95Ms * 3);
  assert.ok(
    report.warmToolsListP95Ms <= relativeWarmLimit,
    `warm tools/list p95 (${report.warmToolsListP95Ms}ms) must stay below `
      + `max(250ms, 3× startup p95 = ${relativeWarmLimit}ms)`,
  );
  return report;
}

export async function checkRuntimeBudgets() {
  return assertMcpRuntimeBudgets(await measureMcpDiscoveryBaseline({
    serverPath: SERVER,
    cwd: ROOT,
    sessions: 3,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(`${JSON.stringify(await checkRuntimeBudgets(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
