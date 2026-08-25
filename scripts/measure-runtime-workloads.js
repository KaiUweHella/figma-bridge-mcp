#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { planFigmaCommand } from '../src/capability-catalog.js';
import { evaluateFigmaWithMetadata } from '../src/engine.js';
import { executeInspectPlan } from '../engine/src/application/inspect-command.js';
import { executeStyleCatalogPlan } from '../engine/src/application/style-catalog-command.js';
import { executeStyleConsumerPlan } from '../engine/src/application/style-consumer-command.js';
import { runRuntimeWorkloadSeries } from './lib/runtime-workload-harness.js';

const DEFAULT_NODE_ID = '238:2951';
const DEFAULT_STYLE = 'Body/Caption';

function parseArgs(argv) {
  const options = {
    fileKey: null,
    nodeId: DEFAULT_NODE_ID,
    style: DEFAULT_STYLE,
    iterations: 3,
    workload: 'all',
  };
  const allowed = new Set(['all', 'inspect', 'style-catalog', 'style-consumer']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--file-key') options.fileKey = argv[++index];
    else if (token === '--node-id') options.nodeId = argv[++index];
    else if (token === '--style') options.style = argv[++index];
    else if (token === '--iterations') options.iterations = Number(argv[++index]);
    else if (token === '--workload') options.workload = argv[++index];
    else throw new Error(`Unknown runtime workload option: ${token}`);
  }
  if (typeof options.fileKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(options.fileKey)) {
    throw new Error('--file-key is required and must be a bounded Figma file key');
  }
  if (typeof options.nodeId !== 'string' || !/^\d+:\d+$/.test(options.nodeId)) {
    throw new Error('--node-id must be a canonical Figma node id');
  }
  if (typeof options.style !== 'string' || !options.style || options.style.length > 1024) {
    throw new Error('--style must be a non-empty bounded style reference');
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1 || options.iterations > 20) {
    throw new Error('--iterations must be an integer from 1 to 20');
  }
  if (!allowed.has(options.workload)) throw new Error(`Unknown workload: ${options.workload}`);
  return options;
}

function workload({ id, kind, argv, executePlan, options, timeoutMs }) {
  return {
    id,
    kind,
    plan: () => planFigmaCommand(argv, { fileKey: options.fileKey }),
    execute: (plan, { observe }) => executePlan(plan, {
      evaluate: async (code) => {
        const evaluated = await evaluateFigmaWithMetadata(code, {
          fileKey: options.fileKey,
          expectedEditor: 'figma',
          timeoutMs,
        });
        observe(evaluated.metadata || null);
        return evaluated.value;
      },
    }),
  };
}

export function runtimeWorkloadCorpus(options) {
  return [
    workload({
      id: 'read.inspect-node',
      kind: 'read',
      argv: ['inspect', options.nodeId, '--json'],
      executePlan: executeInspectPlan,
      options,
      timeoutMs: 30_000,
    }),
    workload({
      id: 'read.style-catalog',
      kind: 'read',
      argv: ['style', 'list', '--type', 'TEXT', '--limit', '100'],
      executePlan: executeStyleCatalogPlan,
      options,
      timeoutMs: 30_000,
    }),
    workload({
      id: 'read.style-consumer',
      kind: 'read',
      argv: ['style', 'consumers', '--type', 'TEXT', '--limit', '100', options.style],
      executePlan: executeStyleConsumerPlan,
      options,
      timeoutMs: 120_000,
    }),
  ];
}

export async function measureRuntimeWorkloads(options) {
  const selected = runtimeWorkloadCorpus(options).filter(
    (entry) => options.workload === 'all' || entry.id === `read.${options.workload}`,
  );
  const workloads = [];
  for (const entry of selected) {
    workloads.push(await runRuntimeWorkloadSeries(entry, { iterations: options.iterations }));
  }
  return {
    schema: 'figma-bridge/runtime-workload-report',
    version: 1,
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    coverage: {
      measured: ['command-planning', 'daemon-transport', 'plugin-queue', 'plugin-execution', 'application-projection', 'application-outcome-bytes', 'heap-delta'],
      pending: ['mcp-ingress-audit-confirmation', 'mcp-envelope-bytes', 'process-startup', 'write', 'render', 'capture', 'background-job', 'peak-rss'],
    },
    workloads,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = await measureRuntimeWorkloads(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
