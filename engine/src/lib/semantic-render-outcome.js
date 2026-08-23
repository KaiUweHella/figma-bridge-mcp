// Closed, versioned result contract for the simple Semantic Render Command.
//
// The Plugin response is an untrusted post-dispatch boundary. This module is
// the only place where that response becomes an Application value. Adapters
// may format or serialize the returned Outcome, but must never reinterpret the
// raw Plugin object themselves.

import { parseStructuredMutationReport } from './daemon-error-envelope.js';
import { toYaml } from './yaml.js';
import { VARIABLE_SCOPES_BY_TYPE } from './variable-scope-policy.js';

export const SEMANTIC_RENDER_OUTCOME_SCHEMA = 1;
export const SEMANTIC_RENDER_OUTCOME_KIND = 'figma-bridge/semantic-render-outcome';
export const MAX_SEMANTIC_RENDER_OUTCOME_BYTES = 128 * 1024;
export const MAX_SEMANTIC_RENDER_OUTCOME_DEPTH = 8;
export const MAX_SEMANTIC_RENDER_COLLECTION_ITEMS = 2_048;
export const MAX_SEMANTIC_RENDER_ARRAY_ITEMS = 100;
export const MAX_SEMANTIC_RENDER_STRING_CODE_POINTS = 512;
export const MAX_SEMANTIC_RENDER_HANDLE_BYTES = 1_024;

const MAX_COUNT = 1_000_000;
const MAX_DIMENSION = 1_000_000;
const MAX_STRUCTURAL_MISMATCHES = 20;
const NODE_ID = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const TOP_LEVEL_FIELDS = new Set([
  'id', 'name', 'executor', 'width', 'height', 'overflow', 'structuralReport',
  'unresolved', 'createdVariables', 'createdTextStyles', 'scopeQuestions',
  'variableReport', 'textStyleReport', 'fallbackAnnotationReport',
  'mutationOutcome', 'mutationReport',
]);
const STRUCTURAL_FIELDS = new Set(['version', 'passed', 'summary', 'mismatchCount', 'mismatches']);
const STRUCTURAL_SUMMARY_FIELDS = new Set([
  'nodes', 'grids', 'autoLayouts', 'freeLayouts', 'instances', 'absoluteNodes',
]);
const STRUCTURAL_MISMATCH_FIELDS = new Set(['path', 'fact', 'expected', 'actual']);
const SCOPE_QUESTION_FIELDS = new Set([
  'name', 'collection', 'resolvedType', 'status', 'currentScopes', 'allowedScopes', 'question',
]);
const VARIABLE_REPORT_FIELDS = new Set([
  'references', 'reused', 'created', 'bound', 'ambiguous', 'unsupported',
]);
const TEXT_STYLE_REPORT_FIELDS = new Set(['references', 'reused', 'created', 'bound']);
const FALLBACK_REPORT_FIELDS = new Set(['requested', 'applied', 'deduplicated', 'unsupported']);
const COMPLETED_MUTATION_FIELDS = new Set([
  'version', 'outcome', 'created', 'removed', 'residueCount', 'residue', 'residueTruncated',
]);
const EXECUTORS = Object.freeze({
  'structured-v1': Object.freeze({ kind: 'structured', version: 1 }),
  'generated-eval-compatibility': Object.freeze({ kind: 'generated-eval-compatibility', version: 1 }),
});
const FAILURE_KINDS = new Set([
  'authentication', 'validation', 'targeting', 'plugin-unavailable', 'plugin-capability',
  'plugin-protocol', 'plugin-timeout', 'plugin-result', 'timeout', 'execution',
  'unavailable', 'request',
]);
const FAILURE_PHASES = new Set([
  'request-authentication', 'request-validation', 'target-resolution', 'plugin-dispatch',
  'plugin-execution', 'plugin-response', 'daemon-response', 'daemon-request',
  'client-authentication',
]);
const FAILURE_OUTCOMES = new Set(['not-dispatched', 'unknown-after-dispatch']);
const DISPATCH_STATES = new Set(['not-dispatched', 'failed', 'unknown']);
const OUTCOMES = new WeakSet();

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function resultError(message) {
  return Object.assign(new Error(message), {
    kind: 'plugin-result',
    phase: 'plugin-response',
    outcome: 'unknown-after-dispatch',
    dispatchState: 'unknown',
  });
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw resultError(`Semantic Render returned unknown ${label} field(s): ${unknown.slice(0, 5).join(', ')}.`);
  }
}

function assertBoundedGraph(value, label = 'Plugin result') {
  const ancestors = new WeakSet();
  let collectionItems = 0;
  const visit = (item, depth) => {
    if (depth > MAX_SEMANTIC_RENDER_OUTCOME_DEPTH) {
      throw resultError(`Semantic Render returned a ${label} beyond the nesting limit.`);
    }
    if (typeof item === 'string') {
      if (Array.from(item).length > MAX_SEMANTIC_RENDER_STRING_CODE_POINTS) {
        throw resultError(`Semantic Render returned a ${label} string beyond the length limit.`);
      }
      return;
    }
    if (item === null || ['boolean', 'number', 'undefined'].includes(typeof item)) return;
    if (typeof item !== 'object') throw resultError(`Semantic Render returned an invalid ${label} value.`);
    if (ancestors.has(item)) throw resultError(`Semantic Render returned a cyclic ${label}.`);
    ancestors.add(item);
    const entries = Array.isArray(item) ? item : Object.values(item);
    if (entries.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
      throw resultError(`Semantic Render returned a ${label} collection beyond the item limit.`);
    }
    collectionItems += entries.length;
    if (collectionItems > MAX_SEMANTIC_RENDER_COLLECTION_ITEMS) {
      throw resultError(`Semantic Render returned a ${label} beyond the total collection limit.`);
    }
    for (const entry of entries) visit(entry, depth + 1);
    ancestors.delete(item);
  };
  visit(value, 0);
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { throw resultError(`Semantic Render returned an unserializable ${label}.`); }
  if (bytes > MAX_SEMANTIC_RENDER_OUTCOME_BYTES) {
    throw resultError(`Semantic Render returned a ${label} beyond the total byte limit.`);
  }
}

function finiteCount(value, label, max = MAX_COUNT) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw resultError(`Semantic Render returned an invalid ${label}.`);
  }
  return value;
}

function finiteNumber(value, label, max = MAX_DIMENSION) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw resultError(`Semantic Render returned an invalid ${label}.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value || Array.from(value).length > MAX_SEMANTIC_RENDER_STRING_CODE_POINTS) {
    throw resultError(`Semantic Render returned an invalid ${label}.`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || Array.from(value).length > MAX_SEMANTIC_RENDER_STRING_CODE_POINTS) {
    throw resultError(`Semantic Render returned an invalid ${label}.`);
  }
  return value;
}

function stringArray(value, label) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw resultError(`Semantic Render returned an invalid ${label}.`);
  }
  return Object.freeze(value.map((item) => requiredString(item, `${label} item`)));
}

function numericReport(value, label, fields) {
  if (value === undefined) return null;
  if (!isRecord(value)) throw resultError(`Semantic Render returned an invalid ${label}.`);
  rejectUnknownFields(value, fields, label);
  if ([...fields].some((key) => !Object.hasOwn(value, key))) {
    throw resultError(`Semantic Render returned an incomplete ${label}.`);
  }
  return Object.freeze(Object.fromEntries(
    [...fields].map((key) => [key, finiteCount(value[key], `${label}.${key}`)]),
  ));
}

function projectVariableReport(value) {
  const report = numericReport(value, 'variableReport', VARIABLE_REPORT_FIELDS);
  if (report && (report.bound !== report.references || report.ambiguous !== 0
    || report.unsupported !== 0 || report.reused + report.created > report.references)) {
    throw resultError('Semantic Render returned an inconsistent variableReport.');
  }
  return report;
}

function projectTextStyleReport(value) {
  const report = numericReport(value, 'textStyleReport', TEXT_STYLE_REPORT_FIELDS);
  if (report && (report.bound !== report.references
    || report.reused + report.created > report.references)) {
    throw resultError('Semantic Render returned an inconsistent textStyleReport.');
  }
  return report;
}

function projectFallbackReport(value) {
  const report = numericReport(value, 'fallbackAnnotationReport', FALLBACK_REPORT_FIELDS);
  if (report && report.requested !== report.applied + report.deduplicated + report.unsupported) {
    throw resultError('Semantic Render returned an inconsistent fallbackAnnotationReport.');
  }
  return report;
}

function projectStructuralReport(value, { required }) {
  if (value === undefined && !required) return null;
  if (!isRecord(value)) throw resultError('Semantic Render returned an invalid structural report.');
  rejectUnknownFields(value, STRUCTURAL_FIELDS, 'structural report');
  if (value.version !== 1 || typeof value.passed !== 'boolean') {
    throw resultError('Semantic Render returned an invalid structural report.');
  }
  if (!isRecord(value.summary)) {
    throw resultError('Semantic Render returned an invalid structural report summary.');
  }
  rejectUnknownFields(value.summary, STRUCTURAL_SUMMARY_FIELDS, 'structural report summary');
  if ([...STRUCTURAL_SUMMARY_FIELDS].some((key) => !Object.hasOwn(value.summary, key))) {
    throw resultError('Semantic Render returned an incomplete structural report summary.');
  }
  const summary = Object.freeze(Object.fromEntries([...STRUCTURAL_SUMMARY_FIELDS].map((key) => [
    key, finiteCount(value.summary[key], `structuralReport.summary.${key}`),
  ])));
  const mismatchCount = finiteCount(value.mismatchCount, 'structuralReport.mismatchCount');
  if (value.passed !== (mismatchCount === 0)) {
    throw resultError('Semantic Render returned an inconsistent structural report outcome.');
  }
  const mismatchEvidence = value.mismatches === undefined ? [] : value.mismatches;
  if (!Array.isArray(mismatchEvidence)
    || mismatchEvidence.length !== Math.min(mismatchCount, MAX_STRUCTURAL_MISMATCHES)) {
    throw resultError('Semantic Render returned incomplete structural mismatch evidence.');
  }
  const mismatches = Object.freeze(mismatchEvidence.map((item) => {
    if (!isRecord(item)) throw resultError('Semantic Render returned an invalid structural mismatch.');
    rejectUnknownFields(item, STRUCTURAL_MISMATCH_FIELDS, 'structural mismatch');
    if ([...STRUCTURAL_MISMATCH_FIELDS].some((key) => !Object.hasOwn(item, key))) {
      throw resultError('Semantic Render returned an incomplete structural mismatch.');
    }
    return Object.freeze(Object.fromEntries([...STRUCTURAL_MISMATCH_FIELDS].map((key) => [
      key, requiredString(item[key], `structural mismatch ${key}`),
    ])));
  }));
  return Object.freeze({ version: 1, passed: value.passed, summary, mismatchCount, mismatches });
}

function projectScopeQuestions(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw resultError('Semantic Render returned invalid scope questions.');
  }
  return Object.freeze(value.map((question) => {
    if (!isRecord(question)) throw resultError('Semantic Render returned an invalid scope question.');
    rejectUnknownFields(question, SCOPE_QUESTION_FIELDS, 'scope question');
    const resolvedType = requiredString(question.resolvedType, 'scope question resolvedType');
    const allowedForType = VARIABLE_SCOPES_BY_TYPE[resolvedType];
    const allowedScopes = stringArray(question.allowedScopes, 'scope question allowedScopes');
    const currentScopes = stringArray(question.currentScopes, 'scope question currentScopes');
    if (!allowedForType || question.status !== 'USER_DECISION_REQUIRED'
      || !allowedScopes.length || !currentScopes.length
      || allowedScopes.some((scope) => !allowedForType.includes(scope))
      || currentScopes.some((scope) => !allowedScopes.includes(scope))) {
      throw resultError('Semantic Render returned an inconsistent scope question.');
    }
    return Object.freeze({
      name: requiredString(question.name, 'scope question name'),
      collection: requiredString(question.collection, 'scope question collection'),
      resolvedType,
      status: 'USER_DECISION_REQUIRED',
      currentScopes,
      allowedScopes,
      question: requiredString(question.question, 'scope question text'),
    });
  }));
}

function projectCompletedMutation(value, executor) {
  if (value === undefined && executor !== 'structured-v1') return null;
  if (!isRecord(value)) throw resultError('Semantic Render returned an invalid completed mutation report.');
  rejectUnknownFields(value, COMPLETED_MUTATION_FIELDS, 'completed mutation report');
  const created = finiteCount(value.created, 'mutationReport.created', 100_000);
  if (value.version !== 1 || value.outcome !== 'completed' || created < 1
    || value.removed !== 0 || value.residueCount !== 0 || !Array.isArray(value.residue)
    || value.residue.length !== 0 || value.residueTruncated !== false) {
    throw resultError('Semantic Render returned an invalid completed mutation report.');
  }
  return Object.freeze({
    version: 1, outcome: 'completed', created, removed: 0,
    residueCount: 0, residue: Object.freeze([]), residueTruncated: false,
  });
}

function projectPlannedStructure(value) {
  if (!isRecord(value)) throw new TypeError('Semantic Render Outcome requires planned structure facts.');
  const fields = ['grid', 'flex', 'free', 'absolute'];
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new TypeError('Semantic Render Outcome received unknown planned structure facts.');
  }
  return Object.freeze(Object.fromEntries(fields.map((key) => {
    const count = value[key];
    if (!Number.isSafeInteger(count) || count < 0 || count > 20_000) {
      throw new TypeError(`Semantic Render Outcome received invalid planned structure ${key}.`);
    }
    return [key, count];
  })));
}

function projectNotices(value) {
  if (!Array.isArray(value) || value.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw new TypeError('Semantic Render Outcome received invalid notices.');
  }
  return Object.freeze(value.map((notice) => {
    if (!isRecord(notice) || !['muted', 'warning', 'error', 'success'].includes(notice.tone)
      || typeof notice.text !== 'string' || Array.from(notice.text).length > MAX_SEMANTIC_RENDER_STRING_CODE_POINTS) {
      throw new TypeError('Semantic Render Outcome received an invalid notice.');
    }
    return Object.freeze({ tone: notice.tone, text: notice.text });
  }));
}

function rootFromPlugin(value) {
  const handle = requiredString(value.id, 'root node id');
  if (!NODE_ID.test(handle) || Buffer.byteLength(handle, 'utf8') > MAX_SEMANTIC_RENDER_HANDLE_BYTES) {
    throw resultError('Semantic Render returned an invalid root node id.');
  }
  return Object.freeze({
    handle,
    name: optionalString(value.name, 'root name'),
    dimensions: Object.freeze({
      width: value.width === undefined ? null : finiteNumber(value.width, 'width'),
      height: value.height === undefined ? null : finiteNumber(value.height, 'height'),
    }),
  });
}

function emptyResources() {
  return Object.freeze({
    unresolvedVariables: Object.freeze([]),
    createdVariables: Object.freeze([]),
    createdTextStyles: Object.freeze([]),
    variableReport: null,
    textStyleReport: null,
    fallbackAnnotationReport: null,
    scopeQuestions: Object.freeze([]),
  });
}

function finalizeOutcome(outcome) {
  assertBoundedGraph(outcome, 'Semantic Render Outcome');
  const frozen = Object.freeze(outcome);
  OUTCOMES.add(frozen);
  return frozen;
}

/** Convert one untrusted Plugin response into the only successful Application Outcome. */
export function projectSemanticRenderOutcome(value, { executor, structure, notices = [] }) {
  assertBoundedGraph(value);
  if (!isRecord(value)) throw resultError('Semantic Render returned no structured result.');
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, 'result');
  if (!EXECUTORS[executor]) throw new TypeError('Semantic Render Outcome requires a known executor.');
  if (executor === 'structured-v1' && value.executor !== 'structured-v1') {
    throw resultError('Semantic Render returned the wrong native executor identity.');
  }
  if (executor !== 'structured-v1' && value.executor !== undefined) {
    throw resultError('Semantic Render compatibility returned an unexpected executor identity.');
  }
  if (value.mutationOutcome !== undefined && value.mutationOutcome !== 'completed') {
    throw resultError('Semantic Render returned an inconsistent mutation outcome.');
  }
  const mutation = projectCompletedMutation(value.mutationReport, executor);
  if (executor === 'structured-v1' && value.mutationOutcome !== 'completed') {
    throw resultError('Semantic Render returned incomplete mutation outcome facts.');
  }
  if (executor !== 'structured-v1'
    && ((value.mutationOutcome === undefined) !== (value.mutationReport === undefined))) {
    throw resultError('Semantic Render returned incomplete mutation outcome facts.');
  }
  const liveStructure = projectStructuralReport(value.structuralReport, { required: executor === 'structured-v1' });
  const overflow = value.overflow === undefined
    ? null
    : Object.freeze({ pixels: finiteNumber(value.overflow, 'overflow') });
  const outcome = {
    schemaVersion: SEMANTIC_RENDER_OUTCOME_SCHEMA,
    kind: SEMANTIC_RENDER_OUTCOME_KIND,
    status: liveStructure?.passed === false ? 'completed-with-findings' : 'completed',
    roots: Object.freeze([rootFromPlugin(value)]),
    executor: EXECUTORS[executor],
    structure: Object.freeze({ planned: projectPlannedStructure(structure), live: liveStructure }),
    resources: Object.freeze({
      unresolvedVariables: stringArray(value.unresolved, 'unresolved variables'),
      createdVariables: stringArray(value.createdVariables, 'created variables'),
      createdTextStyles: stringArray(value.createdTextStyles, 'created Text Styles'),
      variableReport: projectVariableReport(value.variableReport),
      textStyleReport: projectTextStyleReport(value.textStyleReport),
      fallbackAnnotationReport: projectFallbackReport(value.fallbackAnnotationReport),
      scopeQuestions: projectScopeQuestions(value.scopeQuestions),
    }),
    overflow,
    mutation,
    notices: projectNotices(notices),
    failure: null,
  };
  return finalizeOutcome(outcome);
}

/** Project only closed failure facts. Error prose, stacks and request inputs are excluded. */
export function projectSemanticRenderFailureOutcome(error, { executor, structure }) {
  const failure = Object.freeze({
    kind: FAILURE_KINDS.has(error?.kind) ? error.kind : 'execution',
    phase: FAILURE_PHASES.has(error?.phase) ? error.phase : 'plugin-execution',
    outcome: FAILURE_OUTCOMES.has(error?.outcome) ? error.outcome : 'unknown-after-dispatch',
    dispatchState: DISPATCH_STATES.has(error?.dispatchState)
      ? error.dispatchState
      : error?.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown',
  });
  return finalizeOutcome({
    schemaVersion: SEMANTIC_RENDER_OUTCOME_SCHEMA,
    kind: SEMANTIC_RENDER_OUTCOME_KIND,
    status: 'failed',
    roots: Object.freeze([]),
    executor: EXECUTORS[executor] || null,
    structure: Object.freeze({ planned: projectPlannedStructure(structure), live: null }),
    resources: emptyResources(),
    overflow: null,
    mutation: parseStructuredMutationReport(error?.mutationReport),
    notices: Object.freeze([]),
    failure,
  });
}

export function isSemanticRenderOutcome(value) {
  return isRecord(value) && OUTCOMES.has(value);
}

export function assertSemanticRenderOutcome(value) {
  if (!isSemanticRenderOutcome(value)) {
    throw new TypeError('Semantic Render Adapter requires an Application Outcome.');
  }
  return value;
}

export function semanticRenderOutcomeCode(value) {
  const outcome = assertSemanticRenderOutcome(value);
  if (outcome.status === 'failed') {
    throw new TypeError('A failed Semantic Render Outcome has no accepted process code.');
  }
  return outcome.status === 'completed-with-findings' ? 1 : 0;
}

export function semanticRenderOutcomeJson(value) {
  return JSON.stringify(assertSemanticRenderOutcome(value), null, 2);
}

export function semanticRenderOutcomeYaml(value) {
  return toYaml(assertSemanticRenderOutcome(value));
}
