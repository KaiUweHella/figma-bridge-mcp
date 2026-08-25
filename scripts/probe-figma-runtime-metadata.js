#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { evaluateFigmaWithMetadata } from '../src/engine.js';
import {
  auditPublishableMetadataProbe,
  publishableMetadataProbeCode,
  validatePublishableMetadataProbe,
} from './lib/publishable-metadata-probe.js';

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--file-key'
      || !/^[A-Za-z0-9_-]{1,64}$/.test(argv[1] || '')) {
    throw new Error('Usage: node scripts/probe-figma-runtime-metadata.js --file-key FILE_KEY');
  }
  return { fileKey: argv[1] };
}

export async function probeFigmaRuntimeMetadata({ fileKey }) {
  const evaluated = await evaluateFigmaWithMetadata(publishableMetadataProbeCode(), {
    fileKey,
    expectedEditor: 'figma',
    timeoutMs: 120_000,
  });
  if (typeof evaluated.value !== 'string' || evaluated.value.length > 16_384) {
    throw new Error('Publishable metadata probe returned an invalid bounded report');
  }
  let probe;
  try { probe = JSON.parse(evaluated.value); }
  catch { throw new Error('Publishable metadata probe returned invalid JSON'); }
  if (!validatePublishableMetadataProbe(probe)) {
    throw new Error('Publishable metadata probe returned an invalid bounded report');
  }
  return {
    schema: 'figma-bridge/publishable-metadata-compatibility-report',
    version: 1,
    generatedAt: new Date().toISOString(),
    probe,
    audit: auditPublishableMetadataProbe(probe),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = await probeFigmaRuntimeMetadata(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.audit.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
