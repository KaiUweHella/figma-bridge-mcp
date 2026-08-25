#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditFidelityCorpus,
  formatFidelityScore,
  scoreFidelityRun,
} from '../engine/src/lib/fidelity-corpus.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_PATH = resolve(ROOT, 'evals/fidelity/v1/corpus.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  if (argv.length === 0) return { runPath: null };
  if (argv.length === 2 && argv[0] === '--run') return { runPath: resolve(ROOT, argv[1]) };
  throw new Error('Usage: node scripts/validate-fidelity-corpus.js [--run <run.json>]');
}

try {
  const { runPath } = parseArgs(process.argv.slice(2));
  const corpus = readJson(CORPUS_PATH);
  const audit = auditFidelityCorpus(corpus);
  if (!audit.ok) throw new Error(`Fidelity corpus invalid:\n- ${audit.errors.join('\n- ')}`);
  const missingFixtures = corpus.fixtures
    .flatMap((fixture) => fixture.paths)
    .filter((path) => !existsSync(resolve(ROOT, path)));
  if (missingFixtures.length) {
    throw new Error(`Fidelity corpus fixtures are missing:\n- ${missingFixtures.join('\n- ')}`);
  }
  if (!runPath) {
    process.stdout.write(
      `Fidelity corpus valid: v${corpus.version}, ${audit.summary.workflows} workflows, `
      + `${audit.summary.facts} facts, ${audit.summary.families} families, `
      + `${audit.summary.editorTypes} editor types.\n`,
    );
  } else {
    const report = scoreFidelityRun(corpus, readJson(runPath));
    process.stdout.write(`${formatFidelityScore(report)}\n`);
    if (!report.release) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
