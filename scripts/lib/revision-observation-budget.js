export const REVISION_OBSERVATION_COLD_BUDGET = Object.freeze({
  minimumPageCount: 25,
  minimumNodeCount: 25_000,
  maximumPageElapsedMs: 250,
  maximumPageToDocumentRatio: 0.5,
});

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function validSample(sample, scope) {
  return sample
    && sample.scope === scope
    && sample.stable === true
    && typeof sample.pluginVersion === 'string'
    && /^\d+\.\d+\.\d+$/.test(sample.pluginVersion)
    && finitePositive(sample.elapsedMs);
}

export function assessRevisionObservationColdBudget({ page, document, documentFacts } = {}) {
  const findings = [];
  if (!validSample(page, 'page')) findings.push('page sample is not a stable bounded cold observation');
  if (!validSample(document, 'document')) {
    findings.push('document sample is not a stable bounded cold observation');
  }
  if (page?.pluginVersion && document?.pluginVersion
    && page.pluginVersion !== document.pluginVersion) {
    findings.push('page and document samples use different Plugin builds');
  }
  const pageCount = documentFacts?.pageCount;
  const nodeCount = documentFacts?.nodeCount;
  if (!Number.isSafeInteger(pageCount)
    || pageCount < REVISION_OBSERVATION_COLD_BUDGET.minimumPageCount) {
    findings.push('fixture does not meet the qualified large-document Page count');
  }
  if (!Number.isSafeInteger(nodeCount)
    || nodeCount < REVISION_OBSERVATION_COLD_BUDGET.minimumNodeCount) {
    findings.push('fixture does not meet the qualified large-document node count');
  }

  const ratio = finitePositive(page?.elapsedMs) && finitePositive(document?.elapsedMs)
    ? page.elapsedMs / document.elapsedMs
    : null;
  if (finitePositive(page?.elapsedMs)
    && page.elapsedMs > REVISION_OBSERVATION_COLD_BUDGET.maximumPageElapsedMs) {
    findings.push('cold Page observation exceeds its absolute latency budget');
  }
  if (ratio !== null
    && ratio > REVISION_OBSERVATION_COLD_BUDGET.maximumPageToDocumentRatio) {
    findings.push('cold Page observation exceeds its relative Document latency budget');
  }

  return Object.freeze({
    passed: findings.length === 0,
    findings: Object.freeze(findings),
    metrics: Object.freeze({
      pageElapsedMs: finitePositive(page?.elapsedMs) ? page.elapsedMs : null,
      documentElapsedMs: finitePositive(document?.elapsedMs) ? document.elapsedMs : null,
      pageToDocumentRatio: ratio,
      pageCount: Number.isSafeInteger(pageCount) ? pageCount : null,
      nodeCount: Number.isSafeInteger(nodeCount) ? nodeCount : null,
    }),
  });
}
