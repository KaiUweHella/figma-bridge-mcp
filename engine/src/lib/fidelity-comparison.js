export const FIDELITY_COMPARISON_SCHEMA = 'figma-bridge/fidelity-comparisons/v1';

export const COMPARISON_ROLES = Object.freeze([
  'primary',
  'historical-cli',
  'community-mcp',
  'official-mcp',
]);

export const COMPARISON_ACCESS_LEVELS = Object.freeze([
  'executable',
  'source-audited',
  'docs-audited',
]);

export const COMPARISON_CAPABILITIES = Object.freeze([
  'supported',
  'partial',
  'unsupported',
  'unknown',
]);

export const COMPARISON_LIMITATION_CLASSES = Object.freeze([
  'none',
  'product',
  'access',
  'evidence',
]);

const SAFE_ID = /^[a-z][a-z0-9-]*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_CONFIGURATION = /(?:private[- ]?api|binary[- ]?patch|\byolo\b|chrome[- ]?devtools|\bcdp\b)/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function expectedDirectionCells(corpus) {
  const facts = new Map(corpus.facts.map((fact) => [fact.id, fact]));
  const cells = new Map();
  for (const workflow of corpus.workflows) {
    for (const factId of workflow.factIds) {
      const fact = facts.get(factId);
      for (const direction of workflow.directions) {
        const key = `${factId}:${direction}`;
        cells.set(key, { factId, direction, workflowId: workflow.id, target: fact.targets[direction] });
      }
    }
  }
  return cells;
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function auditIdentity(identity, label, errors) {
  if (!isRecord(identity)) {
    errors.push(`${label}: identity is required`);
    return;
  }
  for (const field of ['name', 'version', 'revision']) {
    if (typeof identity[field] !== 'string' || !identity[field].trim()) {
      errors.push(`${label}: identity.${field} is required`);
    }
  }
  if (!Array.isArray(identity.sources) || !identity.sources.length) {
    errors.push(`${label}: at least one immutable source is required`);
    return;
  }
  for (const [index, source] of identity.sources.entries()) {
    const sourceLabel = `${label}.identity.sources[${index}]`;
    if (!isRecord(source)
      || typeof source.url !== 'string' || !source.url.startsWith('https://')
      || typeof source.locator !== 'string' || !source.locator.trim()
      || !SHA256.test(String(source.digest || ''))) {
      errors.push(`${sourceLabel}: https URL, immutable locator and SHA-256 digest are required`);
    }
  }
}

function auditAssessment(assessment, implementation, expected, label, errors) {
  if (!isRecord(assessment)) {
    errors.push(`${label}: assessment must be an object`);
    return null;
  }
  const key = `${assessment.factId}:${assessment.direction}`;
  if (!expected.has(key)) errors.push(`${label}: unknown corpus cell ${key}`);
  if (!COMPARISON_CAPABILITIES.includes(assessment.capability)) {
    errors.push(`${label}: unknown capability ${String(assessment.capability)}`);
  }
  if (!COMPARISON_LIMITATION_CLASSES.includes(assessment.limitationClass)) {
    errors.push(`${label}: unknown limitation class ${String(assessment.limitationClass)}`);
  }
  if (assessment.limitationClass === 'none') {
    if (assessment.capability !== 'supported') {
      errors.push(`${label}: non-supported capability must name a limitation class`);
    }
    if (assessment.limitation !== null) errors.push(`${label}: no limitation must be null`);
  } else if (typeof assessment.limitation !== 'string' || !assessment.limitation.trim()) {
    errors.push(`${label}: the ${assessment.limitationClass} limitation needs an explanation`);
  }
  if (assessment.limitationClass === 'access' && implementation.access.status === 'available') {
    errors.push(`${label}: access limitation conflicts with available implementation access`);
  }
  if (assessment.capability === 'unsupported' && assessment.limitationClass !== 'product') {
    errors.push(`${label}: unsupported means a product limitation, not missing access or evidence`);
  }
  if (assessment.capability === 'unknown' && !['access', 'evidence'].includes(assessment.limitationClass)) {
    errors.push(`${label}: unknown capability must name an access or evidence limitation`);
  }
  if (!Array.isArray(assessment.evidence) || !assessment.evidence.length) {
    errors.push(`${label}: evidence is required`);
  } else {
    for (const [index, evidence] of assessment.evidence.entries()) {
      const evidenceLabel = `${label}.evidence[${index}]`;
      if (!isRecord(evidence)
        || typeof evidence.ref !== 'string' || !evidence.ref.trim()
        || typeof evidence.locator !== 'string' || !evidence.locator.trim()) {
        errors.push(`${evidenceLabel}: ref and locator are required`);
      }
      if (implementation.role === 'primary'
        && (!String(evidence.ref || '').match(/^(?:tests|engine\/tests)\//)
          || !String(evidence.locator || '').match(/^verification\.[a-z][a-z0-9-]*$/))) {
        errors.push(`${evidenceLabel}: primary evidence must bind a local test to one Evidence ID`);
      }
    }
  }
  return key;
}

export function auditFidelityComparisons(comparisons, corpus) {
  const errors = [];
  if (!isRecord(comparisons)) return deepFreeze({ ok: false, errors: ['comparisons must be an object'] });
  if (comparisons.schema !== FIDELITY_COMPARISON_SCHEMA) {
    errors.push(`schema must be ${FIDELITY_COMPARISON_SCHEMA}`);
  }
  if (comparisons.corpusId !== corpus?.id || comparisons.corpusVersion !== corpus?.version) {
    errors.push('comparison corpus identity must match the supplied corpus');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(comparisons.snapshotDate || ''))) {
    errors.push('snapshotDate must be YYYY-MM-DD');
  }

  const expected = expectedDirectionCells(corpus);
  const implementations = Array.isArray(comparisons.implementations) ? comparisons.implementations : [];
  const ids = new Set();
  const roles = new Set();
  for (const [index, implementation] of implementations.entries()) {
    const label = `implementations[${index}]`;
    if (!isRecord(implementation) || !SAFE_ID.test(String(implementation.id || ''))) {
      errors.push(`${label}: id must be kebab-case`);
      continue;
    }
    if (ids.has(implementation.id)) errors.push(`${label}: duplicate id ${implementation.id}`);
    ids.add(implementation.id);
    if (!COMPARISON_ROLES.includes(implementation.role)) {
      errors.push(`${label}: unknown role ${String(implementation.role)}`);
    } else {
      if (roles.has(implementation.role)) errors.push(`${label}: duplicate role ${implementation.role}`);
      roles.add(implementation.role);
    }
    auditIdentity(implementation.identity, label, errors);
    if (!isRecord(implementation.configuration)
      || typeof implementation.configuration.mode !== 'string'
      || typeof implementation.configuration.transport !== 'string'
      || !Array.isArray(implementation.configuration.enabledDisallowedMechanisms)) {
      errors.push(`${label}: exact mode, transport and disallowed-mechanism list are required`);
    } else {
      if (implementation.configuration.enabledDisallowedMechanisms.length) {
        errors.push(`${label}: disallowed comparison mechanisms must remain disabled`);
      }
      if (FORBIDDEN_CONFIGURATION.test(`${implementation.configuration.mode} ${implementation.configuration.transport}`)) {
        errors.push(`${label}: selected comparison configuration enables a forbidden mechanism`);
      }
    }
    if (!isRecord(implementation.access)
      || !COMPARISON_ACCESS_LEVELS.includes(implementation.access.level)
      || !['available', 'source-only', 'docs-only', 'unavailable-client'].includes(implementation.access.status)
      || typeof implementation.access.reason !== 'string' || !implementation.access.reason.trim()) {
      errors.push(`${label}: exact access level, status and reason are required`);
    }
    if (!nonEmptyStrings(implementation.securityAssumptions)) {
      errors.push(`${label}: security assumptions are required`);
    }
    if (!nonEmptyStrings(implementation.operatingConstraints)) {
      errors.push(`${label}: operating constraints are required`);
    }
    if (!isRecord(implementation.latency)
      || !['measured', 'not-measured'].includes(implementation.latency.status)
      || typeof implementation.latency.reason !== 'string' || !implementation.latency.reason.trim()) {
      errors.push(`${label}: latency status and reason are required`);
    }

    const seen = new Set();
    const assessments = Array.isArray(implementation.assessments) ? implementation.assessments : [];
    for (const [assessmentIndex, assessment] of assessments.entries()) {
      const key = auditAssessment(
        assessment,
        implementation,
        expected,
        `${label}.assessments[${assessmentIndex}]`,
        errors,
      );
      if (key && seen.has(key)) errors.push(`${label}: duplicate assessment ${key}`);
      if (key) seen.add(key);
    }
    for (const key of expected.keys()) {
      if (!seen.has(key)) errors.push(`${label}: missing assessment ${key}`);
    }
  }
  for (const role of COMPARISON_ROLES) {
    if (!roles.has(role)) errors.push(`required comparison role is missing: ${role}`);
  }

  if (!Array.isArray(comparisons.requirements) || !comparisons.requirements.length) {
    errors.push('at least one observed behavior must be translated into a Bridge requirement');
  } else {
    for (const [index, requirement] of comparisons.requirements.entries()) {
      const label = `requirements[${index}]`;
      if (!isRecord(requirement) || !SAFE_ID.test(String(requirement.id || ''))
        || !ids.has(requirement.observedIn)
        || !['existing', 'recorded'].includes(requirement.status)
        || !['public', 'private-local'].includes(requirement.tracker)
        || ![requirement.behavior, requirement.bridgeRequirement, requirement.ticket]
          .every((value) => typeof value === 'string' && value.trim())) {
        errors.push(`${label}: observed behavior needs an implementation, requirement and tracked ticket`);
      }
    }
  }

  return deepFreeze({
    ok: errors.length === 0,
    errors,
    summary: {
      implementations: implementations.length,
      expectedCellsPerImplementation: expected.size,
      assessedCells: implementations.reduce(
        (total, implementation) => total + (implementation.assessments?.length || 0),
        0,
      ),
      requirements: comparisons.requirements?.length || 0,
    },
  });
}

