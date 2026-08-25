#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditFidelityComparisons } from '../engine/src/lib/fidelity-comparison.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(join(root, 'evals/fidelity/v1/corpus.json'), 'utf8'));
const comparisons = JSON.parse(
  readFileSync(join(root, 'evals/fidelity/v1/comparison-baselines.json'), 'utf8'),
);
const audit = auditFidelityComparisons(comparisons, corpus);

if (!audit.ok) {
  console.error(audit.errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Fidelity comparisons valid: ${audit.summary.implementations} implementations, `
      + `${audit.summary.assessedCells} assessed direction cells, `
      + `${audit.summary.requirements} translated requirements.`,
  );
}

