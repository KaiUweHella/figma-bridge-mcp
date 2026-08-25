#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureMcpToolSession } from './lib/mcp-runtime-harness.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

function parseArgs(argv) {
  const options = {
    fileKey: null,
    nodeId: null,
    nodeName: null,
    iterations: 3,
    workload: 'all',
    output: null,
  };
  const allowed = new Set(['all', 'read', 'write', 'render', 'capture', 'background']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--file-key') options.fileKey = argv[++index];
    else if (token === '--node-id') options.nodeId = argv[++index];
    else if (token === '--node-name') options.nodeName = argv[++index];
    else if (token === '--iterations') options.iterations = Number(argv[++index]);
    else if (token === '--workload') options.workload = argv[++index];
    else if (token === '--output') options.output = argv[++index];
    else throw new Error(`Unknown MCP runtime option: ${token}`);
  }
  if (typeof options.fileKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(options.fileKey)) {
    throw new Error('--file-key is required and must be a bounded Figma file key');
  }
  if (typeof options.nodeId !== 'string' || !/^\d+:\d+$/.test(options.nodeId)) {
    throw new Error('--node-id is required and must be a canonical Figma node id');
  }
  if (typeof options.nodeName !== 'string' || !options.nodeName || options.nodeName.length > 512) {
    throw new Error('--node-name is required and must be bounded');
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1 || options.iterations > 10) {
    throw new Error('--iterations must be an integer from 1 to 10');
  }
  if (!allowed.has(options.workload)) throw new Error(`Unknown workload: ${options.workload}`);
  if (typeof options.output !== 'string' || !options.output) throw new Error('--output is required');
  options.output = resolve(options.output);
  if (!isAbsolute(options.output) || !(options.output === ROOT || options.output.startsWith(`${ROOT}/`))) {
    throw new Error('--output must resolve inside the current Workspace');
  }
  return options;
}

function renderProbe(iteration) {
  return `<Frame name="EFF-02 · Runtime probe ${iteration + 1}" w="480" flex="col" gap="12" p="24" fill="#F8FAFC" radius="16"><Text size="20" weight="700" color="#0F172A">MCP runtime probe</Text><Text size="14" color="#475569">Read · write · render · capture · background</Text><Frame name="Probe marker" w="48" h="48" fill="#2563EB" radius="12" /></Frame>`;
}

function compactResult(result) {
  const compactSample = (sample) => {
    const structured = sample.result?.structuredContent;
    return {
      ...sample,
      resultFacts: {
        text: sample.result?.content?.find((entry) => entry.type === 'text')?.text || '',
        ...(structured ? {
          structured: {
            executor: structured.executor || null,
            status: structured.status || null,
            roots: structured.roots || [],
            notices: structured.notices || [],
          },
        } : {}),
      },
      result: undefined,
    };
  };
  return {
    ...result,
    first: result.first ? compactSample(result.first) : null,
    warm: result.warm.map(compactSample),
  };
}

export async function measureCompleteMcpRuntime(options) {
  const assetRoot = resolve(dirname(options.output), 'EFF-02-assets');
  const renderHandles = [];
  const definitions = [
    {
      id: 'read.inspect', kind: 'read',
      request: { name: 'figma_inspect', arguments: { nodeId: options.nodeId, fileKey: options.fileKey } },
    },
    {
      id: 'write.rename-idempotent', kind: 'write',
      request: {
        name: 'figma_run',
        arguments: {
          args: ['node', 'rename', options.nodeId, options.nodeName],
          fileKey: options.fileKey,
          confirm: true,
          label: 'EFF-02 runtime budget write probe',
        },
      },
    },
    {
      id: 'render.semantic-frame', kind: 'render',
      request: ({ iteration }) => ({
        name: 'figma_render',
        arguments: {
          jsx: renderProbe(iteration),
          confirm: true,
          label: 'EFF-02 runtime budget render probe',
          fileKey: options.fileKey,
        },
      }),
      afterSample(sample) {
        const handle = sample.result?.structuredContent?.roots?.[0]?.handle;
        if (handle) renderHandles.push(handle);
      },
    },
    {
      id: 'capture.screenshot', kind: 'capture',
      request: { name: 'figma_screenshot', arguments: { nodeId: options.nodeId, scale: 0.5, fileKey: options.fileKey } },
    },
    {
      id: 'background.asset-export', kind: 'background-job',
      request: ({ iteration }) => ({
        name: 'figma_run',
        arguments: {
          args: ['export', 'assets', options.nodeId, '-o', resolve(assetRoot, `run-${iteration + 1}`), '--max', '10'],
          fileKey: options.fileKey,
          confirm: true,
          force: true,
          label: 'EFF-02 runtime budget background probe',
        },
      }),
    },
  ];
  const selected = definitions.filter((entry) => options.workload === 'all' || entry.kind === options.workload);
  const workloads = [];
  for (const definition of selected) {
    workloads.push(compactResult(await measureMcpToolSession({
      ...definition,
      serverPath: SERVER,
      cwd: ROOT,
      iterations: options.iterations,
      env: {
        FIGMA_WRITE_CONFIRM: '1',
        ASSET_EXPORT_WAIT_MS: '120000',
      },
    })));
  }
  return {
    schema: 'figma-bridge/complete-mcp-runtime-report',
    version: 1,
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    coverage: [
      'mcp-process-startup', 'mcp-ingress', 'write-confirmation', 'audit',
      'daemon-transport', 'plugin-queue', 'plugin-execution', 'mcp-envelope-bytes',
      'process-rss', 'read', 'write', 'render', 'capture', 'background-job',
    ],
    target: { fileKey: options.fileKey, nodeId: options.nodeId },
    renderHandles,
    workloads,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await measureCompleteMcpRuntime(options);
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
