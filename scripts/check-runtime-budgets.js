#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { measureMcpDiscoveryBaseline } from './lib/mcp-runtime-harness.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

export const MCP_RUNTIME_BUDGETS = Object.freeze({
  processStartupP95Ms: 5_000,
  warmToolsListP95Ms: 1_000,
  maxEnvelopeBytes: 16 * 1024,
  minEnvelopeReserveBytes: 4 * 1024,
  maxEstimatedEnvelopeTokens: 5 * 1024,
  minEstimatedEnvelopeTokenReserve: 1024,
  maxPeakRssBytes: 512 * 1024 * 1024,
});

export function assertMcpRuntimeBudgets(report, budgets = MCP_RUNTIME_BUDGETS) {
  for (const metric of [
    'processStartupP95Ms',
    'warmToolsListP95Ms',
    'maxEnvelopeBytes',
    'maxPeakRssBytes',
  ]) {
    const limit = budgets[metric];
    const measured = report[metric];
    if (metric === 'maxPeakRssBytes' && measured === null) continue;
    assert.ok(
      Number.isFinite(measured) && measured <= limit,
      `${metric} (${measured}) must stay within the generous CI ceiling ${limit}`,
    );
  }
  const envelopeReserve = budgets.maxEnvelopeBytes - report.maxEnvelopeBytes;
  const requiredEnvelopeReserve = budgets.minEnvelopeReserveBytes ?? 0;
  assert.ok(
    envelopeReserve >= requiredEnvelopeReserve,
    `tools/list envelope reserve (${envelopeReserve} bytes) must retain at least `
      + `${requiredEnvelopeReserve} bytes below the ${budgets.maxEnvelopeBytes}-byte hard cap`,
  );
  // JSON-heavy tool metadata can tokenize more densely than prose. Three
  // UTF-8 bytes per token is deliberately conservative and tokenizer-agnostic.
  if (Number.isFinite(budgets.maxEstimatedEnvelopeTokens)) {
    const estimatedEnvelopeTokens = Math.ceil(report.maxEnvelopeBytes / 3);
    const estimatedTokenReserve = budgets.maxEstimatedEnvelopeTokens - estimatedEnvelopeTokens;
    const requiredTokenReserve = budgets.minEstimatedEnvelopeTokenReserve ?? 0;
    assert.ok(
      estimatedTokenReserve >= requiredTokenReserve,
      `tools/list estimated-token reserve (${estimatedTokenReserve}) must retain at least `
        + `${requiredTokenReserve} tokens below the ${budgets.maxEstimatedEnvelopeTokens}-token hard cap`,
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
