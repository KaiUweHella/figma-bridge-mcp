import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { INSTRUCTIONS, TOOLS } from '../src/server.js';
import { planFigmaCommand } from '../src/capability-catalog.js';
import { serializeSpecModel } from '../engine/src/lib/spec-format.js';
import { assetPolicyPluginSource } from '../engine/src/lib/asset-policy.js';
import { inspectNodeCode } from '../engine/src/application/inspect-command.js';
import { screenshotCode } from '../engine/src/application/screenshot-command.js';

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

// Conservative model-oriented estimate: split words/punctuation, then charge
// one token per four characters inside long fragments. It is deterministic,
// dependency-free and intentionally overestimates common BPE tokenizers.
export function estimateModelTokens(text) {
  const fragments = String(text).match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  return fragments.reduce((sum, fragment) => sum + Math.max(1, Math.ceil(fragment.length / 4)), 0);
}

function batchTimings(operation, { batches = 25, iterations = 1000 } = {}) {
  const values = [];
  for (let batch = 0; batch < batches; batch++) {
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) operation(iteration);
    values.push(performance.now() - start);
  }
  return { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), iterations };
}

export function measureArchitectureBudgets() {
  const metadata = INSTRUCTIONS + JSON.stringify(TOOLS);
  const model = {
    schemaVersion: 1,
    capture: { phase: 'all', requestedDepth: 12, actualDepth: 12, payloadComplete: true },
    frames: Array.from({ length: 40 }, (_, index) => ({
      t: 'FRAME', n: `Card ${index}`, id: `1:${index}`, w: 320, h: 180,
      kids: [{ t: 'TEXT', n: 'Title', txt: { chars: `Plant ${index}` }, s: 'S1' }],
    })),
    styles: { S1: { font: 'Inter Semibold', fs: 18, color: '#102018' } },
  };
  const pretty = serializeSpecModel(model, 'json');
  const yaml = serializeSpecModel(model, 'yaml');
  return {
    metadata: { chars: metadata.length, estimatedTokens: estimateModelTokens(metadata) },
    spec: {
      yamlChars: yaml.length,
      prettyChars: pretty.length,
      yamlEstimatedTokens: estimateModelTokens(yaml),
      ratio: yaml.length / pretty.length,
    },
    pluginPayload: {
      assetPolicyChars: assetPolicyPluginSource().length,
      inspectChars: inspectNodeCode('1:2').length,
      screenshotChars: screenshotCode({ nodeId: '1:2', scale: 0.5, maxDimension: 2000, measure: false }).length,
    },
    latency: {
      commandPlan: batchTimings(() => planFigmaCommand(['export', 'code-spec', '1:2'], { fileKey: 'FILE' })),
      // YAML is intentionally human-readable and its serializer is heavier
      // than JSON.stringify; measure 100 complete projections per batch so
      // the architecture check stays fast while still catching regressions.
      yamlProjection: batchTimings(() => serializeSpecModel(model, 'yaml'), { iterations: 100 }),
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(measureArchitectureBudgets(), null, 2) + '\n');
}
