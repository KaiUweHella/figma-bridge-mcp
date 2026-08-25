import { roundTripFidelityEvidenceRegistry } from './round-trip-fidelity-contract.js';

export const FIDELITY_CORPUS_SCHEMA = 'figma-bridge/fidelity-corpus/v1';
export const FIDELITY_RUN_SCHEMA = 'figma-bridge/fidelity-run/v1';
export const FIDELITY_DIMENSIONS = Object.freeze([
  'structural',
  'semantic',
  'visual',
  'operational',
]);
export const FIDELITY_OUTCOMES = Object.freeze([
  'exact',
  'normalized',
  'approximated',
  'unsupported',
  'silently-lost',
]);
export const FIDELITY_DIRECTIONS = Object.freeze([
  'code-to-figma',
  'figma-to-code',
]);
export const FIDELITY_EDITORS = Object.freeze([
  'figma',
  'figjam',
  'slides',
  'dev',
]);

const REQUIRED_FAMILIES = Object.freeze([
  'assets',
  'auto-layout',
  'components-variants',
  'constraints',
  'editor-context',
  'effects',
  'masks',
  'prototypes',
  'text',
  'variables-aliases',
]);
const OUTCOME_RANK = Object.freeze({
  exact: 4,
  normalized: 3,
  approximated: 2,
  unsupported: 1,
  'silently-lost': 0,
});
const SAFE_ID = /^[a-z][a-z0-9-]*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function pushUnique(errors, message) {
  if (!errors.includes(message)) errors.push(message);
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]/).includes('..')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function auditTarget(target, label, evidenceRegistry, errors) {
  if (!exactKeys(target, ['outcome', 'evidence'])) {
    errors.push(`${label}: target must contain only outcome and evidence`);
    return;
  }
  if (!FIDELITY_OUTCOMES.includes(target.outcome)) {
    errors.push(`${label}: unknown target outcome ${String(target.outcome)}`);
  }
  if (!Array.isArray(target.evidence) || target.evidence.length === 0) {
    errors.push(`${label}: at least one Evidence ID is required`);
    return;
  }
  if (new Set(target.evidence).size !== target.evidence.length) {
    errors.push(`${label}: Evidence IDs must be unique`);
  }
  for (const evidenceId of target.evidence) {
    if (!evidenceRegistry[evidenceId]) {
      errors.push(`${label}: unknown Evidence ID ${String(evidenceId)}`);
    }
  }
}

export function auditFidelityCorpus(corpus, {
  evidenceRegistry = roundTripFidelityEvidenceRegistry(),
} = {}) {
  const errors = [];
  if (!isRecord(corpus)) return deepFreeze({ ok: false, errors: ['corpus must be an object'] });
  if (corpus.schema !== FIDELITY_CORPUS_SCHEMA) errors.push(`schema must be ${FIDELITY_CORPUS_SCHEMA}`);
  if (!Number.isInteger(corpus.version) || corpus.version < 1) errors.push('version must be a positive integer');
  if (!SAFE_ID.test(String(corpus.id || ''))) errors.push('id must be kebab-case');
  if (corpus.license !== 'MIT') errors.push('corpus license must be MIT');

  const fixtures = Array.isArray(corpus.fixtures) ? corpus.fixtures : [];
  const fixtureIds = new Set();
  if (!fixtures.length) errors.push('at least one redistributable fixture is required');
  for (const [index, fixture] of fixtures.entries()) {
    const label = `fixtures[${index}]`;
    if (!isRecord(fixture) || !SAFE_ID.test(String(fixture.id || ''))) {
      errors.push(`${label}: id must be kebab-case`);
      continue;
    }
    if (fixtureIds.has(fixture.id)) errors.push(`${label}: duplicate fixture id ${fixture.id}`);
    fixtureIds.add(fixture.id);
    if (fixture.license !== corpus.license) errors.push(`${label}: license must match the corpus`);
    if (fixture.provenance !== 'authored-for-figma-bridge') {
      errors.push(`${label}: provenance must be authored-for-figma-bridge`);
    }
    if (!Array.isArray(fixture.paths) || !fixture.paths.length) {
      errors.push(`${label}: at least one fixture path is required`);
    } else {
      for (const path of fixture.paths) {
        if (!safeRelativePath(path)) errors.push(`${label}: unsafe fixture path ${String(path)}`);
      }
    }
  }

  const facts = Array.isArray(corpus.facts) ? corpus.facts : [];
  const factsById = new Map();
  const coveredFamilies = new Set();
  if (!facts.length) errors.push('at least one fidelity fact is required');
  for (const [index, fact] of facts.entries()) {
    const label = `facts[${index}]`;
    if (!isRecord(fact) || !SAFE_ID.test(String(fact.id || ''))) {
      errors.push(`${label}: id must be kebab-case`);
      continue;
    }
    if (factsById.has(fact.id)) errors.push(`${label}: duplicate fact id ${fact.id}`);
    factsById.set(fact.id, fact);
    if (!REQUIRED_FAMILIES.includes(fact.family)) errors.push(`${label}: unknown family ${String(fact.family)}`);
    else coveredFamilies.add(fact.family);
    if (!isRecord(fact.targets) || Object.keys(fact.targets).length === 0) {
      errors.push(`${label}: targets are required`);
      continue;
    }
    for (const [direction, dimensions] of Object.entries(fact.targets)) {
      if (!FIDELITY_DIRECTIONS.includes(direction)) {
        errors.push(`${label}: unknown direction ${direction}`);
        continue;
      }
      if (!isRecord(dimensions) || Object.keys(dimensions).length === 0) {
        errors.push(`${label}.${direction}: at least one dimension is required`);
        continue;
      }
      for (const [dimension, target] of Object.entries(dimensions)) {
        if (!FIDELITY_DIMENSIONS.includes(dimension)) {
          errors.push(`${label}.${direction}: unknown dimension ${dimension}`);
          continue;
        }
        auditTarget(target, `${label}.${direction}.${dimension}`, evidenceRegistry, errors);
        if (dimension === 'visual' && !target?.evidence?.includes('verification.pixel-comparison')) {
          errors.push(`${label}.${direction}.${dimension}: visual targets require verification.pixel-comparison`);
        }
        if (target?.outcome === 'unsupported' && !isRecord(fact.platformLimited)) {
          errors.push(`${label}.${direction}.${dimension}: unsupported targets must name a platform limit`);
        }
      }
    }
    if (fact.platformLimited !== null && fact.platformLimited !== undefined) {
      if (!exactKeys(fact.platformLimited, ['platform', 'reason', 'source'])) {
        errors.push(`${label}: platformLimited must contain only platform, reason and source`);
      } else if (![fact.platformLimited.platform, fact.platformLimited.reason, fact.platformLimited.source]
        .every((value) => typeof value === 'string' && value.trim())) {
        errors.push(`${label}: platform limit fields must be non-empty strings`);
      }
    }
  }
  for (const family of REQUIRED_FAMILIES) {
    if (!coveredFamilies.has(family)) errors.push(`required family is not covered: ${family}`);
  }

  const workflows = Array.isArray(corpus.workflows) ? corpus.workflows : [];
  const workflowIds = new Set();
  const coveredEditors = new Set();
  const usedFacts = new Set();
  if (!workflows.length) errors.push('at least one workflow is required');
  for (const [index, workflow] of workflows.entries()) {
    const label = `workflows[${index}]`;
    if (!isRecord(workflow) || !SAFE_ID.test(String(workflow.id || ''))) {
      errors.push(`${label}: id must be kebab-case`);
      continue;
    }
    if (workflowIds.has(workflow.id)) errors.push(`${label}: duplicate workflow id ${workflow.id}`);
    workflowIds.add(workflow.id);
    if (!fixtureIds.has(workflow.fixtureId)) errors.push(`${label}: unknown fixture ${String(workflow.fixtureId)}`);
    if (!Array.isArray(workflow.directions) || !workflow.directions.length
      || workflow.directions.some((direction) => !FIDELITY_DIRECTIONS.includes(direction))) {
      errors.push(`${label}: directions must use the closed fidelity direction vocabulary`);
    }
    if (!Array.isArray(workflow.editorTypes) || !workflow.editorTypes.length
      || workflow.editorTypes.some((editor) => !FIDELITY_EDITORS.includes(editor))) {
      errors.push(`${label}: editorTypes must use the closed editor vocabulary`);
    } else {
      for (const editor of workflow.editorTypes) coveredEditors.add(editor);
    }
    if (!Array.isArray(workflow.factIds) || !workflow.factIds.length) {
      errors.push(`${label}: factIds are required`);
      continue;
    }
    for (const factId of workflow.factIds) {
      const fact = factsById.get(factId);
      if (!fact) {
        errors.push(`${label}: unknown fact ${String(factId)}`);
        continue;
      }
      usedFacts.add(factId);
      for (const direction of workflow.directions || []) {
        if (!fact.targets?.[direction]) errors.push(`${label}: ${factId} has no ${direction} target`);
      }
    }
  }
  for (const editor of FIDELITY_EDITORS) {
    if (!coveredEditors.has(editor)) errors.push(`relevant editor type is not covered: ${editor}`);
  }
  for (const factId of factsById.keys()) {
    if (!usedFacts.has(factId)) errors.push(`fact is not assigned to a workflow: ${factId}`);
  }

  const profile = corpus.releaseProfile;
  if (!isRecord(profile) || !SAFE_ID.test(String(profile.id || ''))) {
    errors.push('releaseProfile.id must be kebab-case');
  } else {
    if (!isRecord(profile.minimumScores)) errors.push('releaseProfile.minimumScores are required');
    for (const dimension of FIDELITY_DIMENSIONS) {
      const threshold = profile.minimumScores?.[dimension];
      if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
        errors.push(`releaseProfile.minimumScores.${dimension} must be between 0 and 1`);
      }
    }
    if (profile.maxSilentLoss !== 0) errors.push('releaseProfile.maxSilentLoss must be zero');
    if (profile.maxMissingObservations !== 0) errors.push('releaseProfile.maxMissingObservations must be zero');
    if (profile.minimumEvidencePassRate !== 1) errors.push('releaseProfile.minimumEvidencePassRate must be one');
    if (typeof profile.maxVisualDiffPct !== 'number'
      || profile.maxVisualDiffPct < 0 || profile.maxVisualDiffPct > 100) {
      errors.push('releaseProfile.maxVisualDiffPct must be between 0 and 100');
    }
  }

  return deepFreeze({
    ok: errors.length === 0,
    errors,
    summary: {
      fixtures: fixtures.length,
      workflows: workflows.length,
      facts: facts.length,
      families: coveredFamilies.size,
      editorTypes: coveredEditors.size,
    },
  });
}

function expectedCells(corpus) {
  const factsById = new Map(corpus.facts.map((fact) => [fact.id, fact]));
  const cells = [];
  for (const workflow of corpus.workflows) {
    for (const factId of workflow.factIds) {
      const fact = factsById.get(factId);
      for (const direction of workflow.directions) {
        for (const [dimension, target] of Object.entries(fact.targets[direction])) {
          cells.push({
            key: [workflow.id, factId, direction, dimension].join(':'),
            workflowId: workflow.id,
            factId,
            family: fact.family,
            direction,
            dimension,
            target,
            platformLimited: fact.platformLimited || null,
          });
        }
      }
    }
  }
  return cells;
}

function evidenceProblems(observation, target, maxVisualDiffPct) {
  const problems = [];
  if (!Array.isArray(observation.evidence) || !observation.evidence.length) {
    return ['observation has no evidence'];
  }
  const byId = new Map();
  for (const evidence of observation.evidence) {
    if (!isRecord(evidence) || typeof evidence.id !== 'string') {
      problems.push('observation contains malformed evidence');
      continue;
    }
    if (byId.has(evidence.id)) problems.push(`duplicate evidence ${evidence.id}`);
    byId.set(evidence.id, evidence);
    if (evidence.status !== 'pass') problems.push(`${evidence.id} did not pass`);
    if (!safeRelativePath(evidence.artifact)) problems.push(`${evidence.id} has an unsafe artifact path`);
    if (!SHA256.test(String(evidence.digest || ''))) problems.push(`${evidence.id} has no reproducible sha256 digest`);
    if (evidence.id === 'verification.pixel-comparison') {
      const diffPct = evidence.metrics?.diffPct;
      if (typeof diffPct !== 'number' || diffPct < 0 || diffPct > 100) {
        problems.push('pixel comparison needs a diffPct metric between 0 and 100');
      } else if (diffPct > maxVisualDiffPct) {
        problems.push(`pixel diff ${diffPct}% exceeds ${maxVisualDiffPct}%`);
      }
    }
  }
  for (const evidenceId of target.evidence) {
    if (!byId.has(evidenceId)) problems.push(`missing required evidence ${evidenceId}`);
  }
  return problems;
}

export function scoreFidelityRun(corpus, run) {
  const corpusAudit = auditFidelityCorpus(corpus);
  const errors = [...corpusAudit.errors];
  if (!isRecord(run)) {
    return deepFreeze({ ok: false, release: false, errors: [...errors, 'run must be an object'] });
  }
  if (run.schema !== FIDELITY_RUN_SCHEMA) errors.push(`run.schema must be ${FIDELITY_RUN_SCHEMA}`);
  if (run.corpusId !== corpus.id || run.corpusVersion !== corpus.version) {
    errors.push('run corpus identity does not match the scored corpus');
  }
  if (!isRecord(run.implementation)
    || !['name', 'version', 'configuration'].every((key) => Object.hasOwn(run.implementation, key))
    || typeof run.implementation.name !== 'string'
    || typeof run.implementation.version !== 'string'
    || !isRecord(run.implementation.configuration)) {
    errors.push('run implementation must name an exact version and configuration');
  }

  const cells = corpusAudit.ok ? expectedCells(corpus) : [];
  const expectedByKey = new Map(cells.map((cell) => [cell.key, cell]));
  const observedByKey = new Map();
  for (const [index, observation] of (Array.isArray(run.observations) ? run.observations : []).entries()) {
    if (!isRecord(observation)) {
      errors.push(`observations[${index}] must be an object`);
      continue;
    }
    const key = [observation.workflowId, observation.factId, observation.direction, observation.dimension].join(':');
    if (!expectedByKey.has(key)) {
      errors.push(`observations[${index}] is outside the corpus: ${key}`);
      continue;
    }
    if (observedByKey.has(key)) errors.push(`duplicate observation: ${key}`);
    else observedByKey.set(key, observation);
    if (!FIDELITY_OUTCOMES.includes(observation.outcome)) {
      errors.push(`observations[${index}] has unknown outcome ${String(observation.outcome)}`);
    }
  }

  const dimensions = Object.fromEntries(FIDELITY_DIMENSIONS.map((dimension) => [dimension, {
    score: 0,
    passed: 0,
    total: 0,
    outcomes: Object.fromEntries(FIDELITY_OUTCOMES.map((outcome) => [outcome, 0])),
  }]));
  const findings = [];
  const platformLimited = [];
  let evidenceTotal = 0;
  let evidencePassed = 0;
  let missingObservations = 0;
  let silentLoss = 0;

  for (const cell of cells) {
    const bucket = dimensions[cell.dimension];
    bucket.total += 1;
    if (cell.platformLimited) platformLimited.push({
      workflowId: cell.workflowId,
      factId: cell.factId,
      direction: cell.direction,
      dimension: cell.dimension,
      ...cell.platformLimited,
    });
    const observation = observedByKey.get(cell.key);
    if (!observation) {
      missingObservations += 1;
      findings.push({ key: cell.key, code: 'missing-observation', message: 'Required observation is missing.' });
      continue;
    }
    if (FIDELITY_OUTCOMES.includes(observation.outcome)) {
      bucket.outcomes[observation.outcome] += 1;
      if (observation.outcome === 'silently-lost') silentLoss += 1;
    }
    const problems = evidenceProblems(observation, cell.target, corpus.releaseProfile.maxVisualDiffPct);
    evidenceTotal += cell.target.evidence.length;
    evidencePassed += Math.max(0, cell.target.evidence.length - problems.filter((problem) => problem.startsWith('missing required evidence') || problem.includes('did not pass') || problem.includes('reproducible')).length);
    const meetsOutcome = OUTCOME_RANK[observation.outcome] >= OUTCOME_RANK[cell.target.outcome]
      && observation.outcome !== 'silently-lost';
    if (meetsOutcome && problems.length === 0) bucket.passed += 1;
    else findings.push({
      key: cell.key,
      code: observation.outcome === 'silently-lost' ? 'silent-loss' : 'target-missed',
      message: [
        `Expected ${cell.target.outcome}; observed ${String(observation.outcome)}.`,
        ...problems,
      ].join(' '),
    });
  }

  for (const dimension of FIDELITY_DIMENSIONS) {
    const bucket = dimensions[dimension];
    bucket.score = bucket.total ? bucket.passed / bucket.total : 0;
  }
  const evidencePassRate = evidenceTotal ? evidencePassed / evidenceTotal : 0;
  const profile = corpus.releaseProfile;
  const thresholdFailures = [];
  for (const dimension of FIDELITY_DIMENSIONS) {
    if (dimensions[dimension].score < profile.minimumScores[dimension]) {
      thresholdFailures.push(`${dimension} score ${dimensions[dimension].score.toFixed(4)} is below ${profile.minimumScores[dimension].toFixed(4)}`);
    }
  }
  if (silentLoss > profile.maxSilentLoss) thresholdFailures.push(`silent loss count ${silentLoss} exceeds ${profile.maxSilentLoss}`);
  if (missingObservations > profile.maxMissingObservations) {
    thresholdFailures.push(`missing observation count ${missingObservations} exceeds ${profile.maxMissingObservations}`);
  }
  if (evidencePassRate < profile.minimumEvidencePassRate) {
    thresholdFailures.push(`evidence pass rate ${evidencePassRate.toFixed(4)} is below ${profile.minimumEvidencePassRate.toFixed(4)}`);
  }
  const release = errors.length === 0 && thresholdFailures.length === 0 && findings.length === 0;
  return deepFreeze({
    ok: errors.length === 0,
    release,
    corpus: { id: corpus.id, version: corpus.version, profile: profile.id },
    implementation: run.implementation || null,
    dimensions,
    evidence: { passed: evidencePassed, total: evidenceTotal, passRate: evidencePassRate },
    silentLoss,
    missingObservations,
    platformLimited,
    findings,
    thresholdFailures,
    errors,
  });
}

export function formatFidelityScore(report) {
  const lines = [
    `${report.release ? 'RELEASE PASS' : 'RELEASE FAIL'} · ${report.corpus?.id || 'unknown'} v${report.corpus?.version || '?'}`,
  ];
  for (const dimension of FIDELITY_DIMENSIONS) {
    const result = report.dimensions?.[dimension];
    if (result) lines.push(`${dimension}: ${(result.score * 100).toFixed(2)}% (${result.passed}/${result.total})`);
  }
  lines.push(`evidence: ${report.evidence?.passed || 0}/${report.evidence?.total || 0}`);
  lines.push(`silent loss: ${report.silentLoss || 0} · missing: ${report.missingObservations || 0}`);
  if (report.platformLimited?.length) {
    lines.push('', 'Platform-limited facts:');
    for (const item of report.platformLimited) {
      lines.push(`- ${item.factId} (${item.platform}): ${item.reason}`);
    }
  }
  if (report.thresholdFailures?.length || report.errors?.length) {
    lines.push('', 'Failures:');
    for (const message of [...(report.errors || []), ...(report.thresholdFailures || [])]) lines.push(`- ${message}`);
  }
  return lines.join('\n');
}
