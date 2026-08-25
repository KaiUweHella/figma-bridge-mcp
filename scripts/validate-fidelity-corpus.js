#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditFidelityCorpus,
  formatFidelityScore,
  formatFidelityWorkflowScore,
  scoreFidelityRun,
  scoreFidelityWorkflowRun,
} from '../engine/src/lib/fidelity-corpus.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_PATH = resolve(ROOT, 'evals/fidelity/v1/corpus.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  if (argv.length === 0) return { runPath: null, workflowId: null };
  if (argv.length === 2 && argv[0] === '--run') {
    return { runPath: resolve(ROOT, argv[1]), workflowId: null };
  }
  if (argv.length === 4 && argv[0] === '--workflow' && argv[2] === '--run') {
    return { workflowId: argv[1], runPath: resolve(ROOT, argv[3]) };
  }
  throw new Error(
    'Usage: node scripts/validate-fidelity-corpus.js [--run <run.json> | --workflow <id> --run <run.json>]',
  );
}

function verifyArtifacts(run) {
  const checked = new Map();
  for (const observation of run.observations || []) {
    for (const evidence of observation.evidence || []) {
      if (!evidence?.artifact || !evidence?.digest) continue;
      if (checked.has(evidence.artifact)) {
        if (checked.get(evidence.artifact) !== evidence.digest) {
          throw new Error(`Fidelity evidence digest mismatch: ${evidence.artifact}`);
        }
        continue;
      }
      const candidate = resolve(ROOT, evidence.artifact);
      if (!existsSync(candidate)) throw new Error(`Fidelity evidence artifact is missing: ${evidence.artifact}`);
      const canonical = realpathSync(candidate);
      const rel = relative(ROOT, canonical);
      if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
        throw new Error(`Fidelity evidence artifact escapes the repository: ${evidence.artifact}`);
      }
      const digest = `sha256:${createHash('sha256').update(readFileSync(canonical)).digest('hex')}`;
      checked.set(evidence.artifact, digest);
      if (digest !== evidence.digest) {
        throw new Error(`Fidelity evidence digest mismatch: ${evidence.artifact}`);
      }
    }
  }
  return checked.size;
}

try {
  const { runPath, workflowId } = parseArgs(process.argv.slice(2));
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
    const run = readJson(runPath);
    const artifactCount = verifyArtifacts(run);
    const report = workflowId
      ? scoreFidelityWorkflowRun(corpus, workflowId, run)
      : scoreFidelityRun(corpus, run);
    process.stdout.write(`${workflowId ? formatFidelityWorkflowScore(report) : formatFidelityScore(report)}\n`);
    process.stdout.write(`verified artifacts: ${artifactCount}\n`);
    if (workflowId ? !report.accepted : !report.release) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
