// Closed, versioned result contract for simple and compound Semantic Render.
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
  'designEntity',
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
  'structured-batch-v1': Object.freeze({ kind: 'structured-batch', version: 1 }),
  'generated-eval-compatibility': Object.freeze({ kind: 'generated-eval-compatibility', version: 1 }),
  'generated-eval-batch-compatibility': Object.freeze({ kind: 'generated-eval-batch-compatibility', version: 1 }),
});
const BATCH_TOP_LEVEL_FIELDS = new Set([
  'frames', 'executor', 'unresolved', 'createdVariables', 'createdTextStyles',
  'scopeQuestions', 'variableReport', 'textStyleReport', 'fallbackAnnotationReport',
  'mutationOutcome', 'mutationReport',
]);
const COMPOUND_STAGE_KINDS = new Set([
  'reuse-preflight', 'asset-preparation', 'render', 'placement', 'component-conversion',
  'resize-probe', 'verification', 'structural-gate',
]);
const COMPOUND_STAGE_STATUSES = new Set([
  'completed', 'completed-with-findings', 'failed', 'skipped',
]);
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
const DEGRADATION_KINDS = new Set(['compatibility-fallback', 'unresolved-variable']);
const DEGRADATION_DISPOSITION_BY_KIND = Object.freeze({
  'compatibility-fallback': 'generated-eval-compatibility',
  'unresolved-variable': 'unbound',
});
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

function assertBoundedGraph(value, label = 'Plugin result', {
  maxCollectionItems = MAX_SEMANTIC_RENDER_COLLECTION_ITEMS,
} = {}) {
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
    if (collectionItems > maxCollectionItems) {
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
  const unbound = report ? report.references - report.bound : 0;
  if (report && (report.bound > report.references
    || report.ambiguous + report.unsupported !== unbound
    || report.reused + report.created > report.bound)) {
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

function projectDegradations(value, unresolvedVariables, { compatibility = false } = {}) {
  if (!Array.isArray(value) || value.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw new TypeError('Semantic Render Outcome received invalid degradation facts.');
  }
  const projected = value.map((item) => {
    if (!isRecord(item)
      || Object.keys(item).sort().join(',') !== 'disposition,fact,kind,path'
      || !DEGRADATION_KINDS.has(item.kind)
      || DEGRADATION_DISPOSITION_BY_KIND[item.kind] !== item.disposition) {
      throw new TypeError('Semantic Render Outcome received an invalid degradation fact.');
    }
    return Object.freeze({
      kind: item.kind,
      path: requiredString(item.path, 'degradation path'),
      fact: requiredString(item.fact, 'degradation fact'),
      disposition: item.disposition,
    });
  });
  if (compatibility && !projected.some((item) => item.kind === 'compatibility-fallback')) {
    projected.push(Object.freeze({
      kind: 'compatibility-fallback',
      path: 'root',
      fact: 'Native Semantic Render support was unavailable',
      disposition: 'generated-eval-compatibility',
    }));
  }
  const remaining = Math.max(0, MAX_SEMANTIC_RENDER_ARRAY_ITEMS - projected.length);
  for (const variable of unresolvedVariables.slice(0, remaining)) {
    if (projected.some((item) => item.kind === 'unresolved-variable' && item.fact === variable)) continue;
    projected.push(Object.freeze({
      kind: 'unresolved-variable',
      path: 'resources.unresolvedVariables',
      fact: variable,
      disposition: 'unbound',
    }));
  }
  return Object.freeze(projected);
}

function rootFromPlugin(value) {
  const handle = requiredString(value.id, 'root node id');
  if (!NODE_ID.test(handle) || Buffer.byteLength(handle, 'utf8') > MAX_SEMANTIC_RENDER_HANDLE_BYTES) {
    throw resultError('Semantic Render returned an invalid root node id.');
  }
  let designEntity = null;
  if (value.designEntity !== undefined) {
    const entity = value.designEntity;
    if (!isRecord(entity)
      || Object.keys(entity).some((key) => !['id', 'kind', 'nodeId'].includes(key))
      || typeof entity.id !== 'string'
      || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(entity.id)
      || !['screen', 'frame'].includes(entity.kind)
      || entity.nodeId !== handle) {
      throw resultError('Semantic Render returned an invalid Design Entity locator.');
    }
    designEntity = Object.freeze({ id: entity.id, kind: entity.kind, nodeId: handle });
  }
  return Object.freeze({
    handle,
    name: optionalString(value.name, 'root name'),
    dimensions: Object.freeze({
      width: value.width === undefined ? null : finiteNumber(value.width, 'width'),
      height: value.height === undefined ? null : finiteNumber(value.height, 'height'),
    }),
    designEntity,
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

function projectReuseReport(report, expectedRoots) {
  if (!isRecord(report)
    || Object.keys(report).some((key) => ![
      'version', 'rootCount', 'placement', 'components', 'flatRepetitions', 'summary',
    ].includes(key))
    || report.version !== 1
    || report.rootCount !== expectedRoots) {
    throw new TypeError('Semantic Render Outcome received an invalid multi-screen reuse report.');
  }
  const placement = report.placement;
  if (!isRecord(placement)
    || Object.keys(placement).some((key) => ![
      'direction', 'startsRightOfOccupiedCanvas', 'explicitVertical',
    ].includes(key))
    || !['row', 'col'].includes(placement.direction)
    || typeof placement.startsRightOfOccupiedCanvas !== 'boolean'
    || typeof placement.explicitVertical !== 'boolean'
    || placement.explicitVertical !== (placement.direction === 'col')
    || (placement.startsRightOfOccupiedCanvas && placement.direction !== 'row')) {
    throw new TypeError('Semantic Render Outcome received invalid multi-screen placement evidence.');
  }
  if (!Array.isArray(report.components) || report.components.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw new TypeError('Semantic Render Outcome received invalid component reuse evidence.');
  }
  const components = Object.freeze(report.components.map((component) => {
    if (!isRecord(component)
      || Object.keys(component).some((key) => !['entity', 'instances', 'rootIndexes', 'firstRoot'].includes(key))
      || typeof component.entity !== 'string'
      || !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(component.entity)) {
      throw new TypeError('Semantic Render Outcome received invalid component reuse evidence.');
    }
    const instances = finiteCount(component.instances, 'component reuse instances');
    const rootIndexes = component.rootIndexes;
    if (!Array.isArray(rootIndexes) || !rootIndexes.length || rootIndexes.length > expectedRoots
      || rootIndexes.some((index, position) => !Number.isSafeInteger(index)
        || index < 0 || index >= expectedRoots
        || (position > 0 && index <= rootIndexes[position - 1]))
      || component.firstRoot !== rootIndexes[0]) {
      throw new TypeError('Semantic Render Outcome received invalid component reuse roots.');
    }
    return Object.freeze({
      entity: component.entity,
      instances,
      rootIndexes: Object.freeze([...rootIndexes]),
      firstRoot: component.firstRoot,
    });
  }));
  if (!Array.isArray(report.flatRepetitions)
    || report.flatRepetitions.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw new TypeError('Semantic Render Outcome received invalid flat repetition evidence.');
  }
  const flatRepetitions = Object.freeze(report.flatRepetitions.map((finding) => {
    if (!isRecord(finding)
      || Object.keys(finding).some((key) => !['id', 'count', 'rootIndexes', 'approved'].includes(key))
      || typeof finding.id !== 'string' || !/^flat-[0-9a-f]{12}$/.test(finding.id)
      || finding.approved !== true) {
      throw new TypeError('Semantic Render Outcome received invalid flat repetition evidence.');
    }
    const count = finiteCount(finding.count, 'flat repetition count');
    const rootIndexes = finding.rootIndexes;
    if (!Array.isArray(rootIndexes) || !rootIndexes.length || rootIndexes.length > expectedRoots
      || rootIndexes.some((index, position) => !Number.isSafeInteger(index)
        || index < 0 || index >= expectedRoots
        || (position > 0 && index <= rootIndexes[position - 1]))) {
      throw new TypeError('Semantic Render Outcome received invalid flat repetition roots.');
    }
    return Object.freeze({
      id: finding.id, count,
      rootIndexes: Object.freeze([...rootIndexes]), approved: true,
    });
  }));
  const summary = report.summary;
  if (!isRecord(summary)
    || Object.keys(summary).some((key) => ![
      'reusedComponents', 'reusedInstances', 'createdComponents', 'approvedFlatRepetitions',
    ].includes(key))) {
    throw new TypeError('Semantic Render Outcome received invalid reuse summary.');
  }
  const projectedSummary = Object.freeze({
    reusedComponents: finiteCount(summary.reusedComponents, 'reused components', 100),
    reusedInstances: finiteCount(summary.reusedInstances, 'reused instances'),
    createdComponents: finiteCount(summary.createdComponents, 'created components', 100),
    approvedFlatRepetitions: finiteCount(summary.approvedFlatRepetitions, 'approved flat repetitions', 100),
  });
  if (projectedSummary.reusedComponents !== components.length
    || projectedSummary.reusedInstances !== components.reduce((sum, item) => sum + item.instances, 0)
    || projectedSummary.approvedFlatRepetitions !== flatRepetitions.length) {
    throw new TypeError('Semantic Render Outcome received an inconsistent reuse summary.');
  }
  return Object.freeze({
    version: 1,
    rootCount: expectedRoots,
    placement: Object.freeze({ ...placement }),
    components,
    flatRepetitions,
    summary: projectedSummary,
  });
}

function projectCompoundStages(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw new TypeError('Semantic Render Outcome received invalid compound stages.');
  }
  const seen = new Set();
  return Object.freeze(value.map((stage) => {
    if (!isRecord(stage)) throw new TypeError('Semantic Render Outcome received an invalid compound stage.');
    const allowed = new Set(['kind', 'status', 'attempted', 'completed', 'failed', 'handles', 'artifacts', 'verification']);
    if (Object.keys(stage).some((key) => !allowed.has(key))) {
      throw new TypeError('Semantic Render Outcome received unknown compound stage facts.');
    }
    if (!COMPOUND_STAGE_KINDS.has(stage.kind) || seen.has(stage.kind)
      || !COMPOUND_STAGE_STATUSES.has(stage.status)) {
      throw new TypeError('Semantic Render Outcome received an invalid compound stage identity.');
    }
    seen.add(stage.kind);
    const attempted = finiteCount(stage.attempted ?? 0, `stage ${stage.kind}.attempted`, 100);
    const completed = finiteCount(stage.completed ?? 0, `stage ${stage.kind}.completed`, 100);
    const failed = finiteCount(stage.failed ?? 0, `stage ${stage.kind}.failed`, 100);
    if (completed + failed > attempted || (stage.status === 'failed' && failed < 1)
      || (stage.status === 'skipped' && attempted !== 0)) {
      throw new TypeError('Semantic Render Outcome received inconsistent compound stage counts.');
    }
    const handles = stringArray(stage.handles, `stage ${stage.kind} handles`);
    if (handles.some((handle) => !NODE_ID.test(handle)
      || Buffer.byteLength(handle, 'utf8') > MAX_SEMANTIC_RENDER_HANDLE_BYTES)) {
      throw new TypeError('Semantic Render Outcome received an invalid compound stage handle.');
    }
    const artifacts = stringArray(stage.artifacts, `stage ${stage.kind} artifacts`);
    let verification;
    if (stage.verification !== undefined) {
      if (stage.kind !== 'verification' || !Array.isArray(stage.verification)
        || stage.verification.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS
        || stage.verification.length !== artifacts.length) {
        throw new TypeError('Semantic Render Outcome received invalid verification evidence.');
      }
      verification = Object.freeze(stage.verification.map((item, index) => {
        if (!isRecord(item)) throw new TypeError('Semantic Render Outcome received invalid verification evidence.');
        const fields = new Set([
          'artifact', 'width', 'height', 'pixelWidth', 'pixelHeight', 'nodeWidth', 'nodeHeight',
          'requestedScale', 'appliedScale', 'scale',
        ]);
        if (Object.keys(item).some((key) => !fields.has(key))
          || item.artifact !== artifacts[index]
          || !Number.isSafeInteger(item.width) || item.width < 1 || item.width > 16_384
          || !Number.isSafeInteger(item.height) || item.height < 1 || item.height > 16_384
          || item.pixelWidth !== item.width || item.pixelHeight !== item.height
          || finiteNumber(item.nodeWidth, 'verification nodeWidth') !== item.nodeWidth
          || finiteNumber(item.nodeHeight, 'verification nodeHeight') !== item.nodeHeight
          || typeof item.requestedScale !== 'number' || !Number.isFinite(item.requestedScale)
          || item.requestedScale <= 0 || item.requestedScale > 4
          || typeof item.appliedScale !== 'number' || !Number.isFinite(item.appliedScale)
          || item.appliedScale <= 0 || item.appliedScale > 4
          || item.scale !== item.appliedScale) {
          throw new TypeError('Semantic Render Outcome received invalid verification evidence.');
        }
        return Object.freeze({ ...item });
      }));
    }
    return Object.freeze({
      kind: stage.kind, status: stage.status, attempted, completed, failed,
      handles, artifacts,
      ...(verification === undefined ? {} : { verification }),
    });
  }));
}

function combinePlannedStructures(structures) {
  if (!Array.isArray(structures) || !structures.length || structures.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw new TypeError('Semantic Render Outcome requires one planned structure per compound root.');
  }
  const totals = { grid: 0, flex: 0, free: 0, absolute: 0 };
  for (const structure of structures) {
    const projected = projectPlannedStructure(structure);
    for (const key of Object.keys(totals)) totals[key] += projected[key];
  }
  return projectPlannedStructure(totals);
}

function combineLiveStructures(reports) {
  const present = reports.filter(Boolean);
  if (!present.length) return null;
  if (present.length !== reports.length) {
    throw resultError('Semantic Render batch returned incomplete structural reports.');
  }
  const summary = {
    nodes: 0, grids: 0, autoLayouts: 0, freeLayouts: 0, instances: 0, absoluteNodes: 0,
  };
  let mismatchCount = 0;
  const mismatches = [];
  for (let index = 0; index < reports.length; index++) {
    const report = reports[index];
    for (const key of Object.keys(summary)) summary[key] += report.summary[key];
    mismatchCount += report.mismatchCount;
    for (const mismatch of report.mismatches) {
      if (mismatches.length >= MAX_STRUCTURAL_MISMATCHES) break;
      mismatches.push(Object.freeze({ ...mismatch, path: `root[${index}].${mismatch.path}` }));
    }
  }
  return Object.freeze({
    version: 1,
    passed: mismatchCount === 0,
    summary: Object.freeze(summary),
    mismatchCount,
    mismatches: Object.freeze(mismatches),
  });
}

function finalizeOutcome(outcome) {
  assertBoundedGraph(outcome, 'Semantic Render Outcome');
  const frozen = Object.freeze(outcome);
  OUTCOMES.add(frozen);
  return frozen;
}

/** Convert one untrusted Plugin response into the only successful Application Outcome. */
export function projectSemanticRenderOutcome(value, {
  executor, structure, notices = [], degradations = [],
}) {
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
  const unresolvedVariables = stringArray(value.unresolved, 'unresolved variables');
  const compatibilitySelected = executor === 'generated-eval-compatibility';
  const projectedDegradations = projectDegradations(degradations, unresolvedVariables, {
    compatibility: compatibilitySelected,
  });
  const overflow = value.overflow === undefined
    ? null
    : Object.freeze({ pixels: finiteNumber(value.overflow, 'overflow') });
  const outcome = {
    schemaVersion: SEMANTIC_RENDER_OUTCOME_SCHEMA,
    kind: SEMANTIC_RENDER_OUTCOME_KIND,
    status: liveStructure?.passed === false || projectedDegradations.length
      ? 'completed-with-findings' : 'completed',
    roots: Object.freeze([rootFromPlugin(value)]),
    executor: EXECUTORS[executor],
    structure: Object.freeze({ planned: projectPlannedStructure(structure), live: liveStructure }),
    resources: Object.freeze({
      unresolvedVariables,
      createdVariables: stringArray(value.createdVariables, 'created variables'),
      createdTextStyles: stringArray(value.createdTextStyles, 'created Text Styles'),
      variableReport: projectVariableReport(value.variableReport),
      textStyleReport: projectTextStyleReport(value.textStyleReport),
      fallbackAnnotationReport: projectFallbackReport(value.fallbackAnnotationReport),
      scopeQuestions: projectScopeQuestions(value.scopeQuestions),
    }),
    overflow,
    mutation,
    reuse: null,
    stages: Object.freeze([]),
    degradations: projectedDegradations,
    notices: projectNotices(notices),
    failure: null,
  };
  return finalizeOutcome(outcome);
}

function projectBatchFrame(frame, { native }) {
  if (!isRecord(frame)) throw resultError('Semantic Render batch returned an invalid frame result.');
  rejectUnknownFields(frame, TOP_LEVEL_FIELDS, 'batch frame');
  if (native && frame.executor !== 'structured-v1') {
    throw resultError('Semantic Render batch returned the wrong frame executor identity.');
  }
  if (!native && frame.executor !== undefined) {
    throw resultError('Semantic Render compatibility batch returned an unexpected frame executor identity.');
  }
  if (frame.mutationOutcome !== undefined || frame.mutationReport !== undefined) {
    throw resultError('Semantic Render batch returned per-frame mutation facts outside the batch journal.');
  }
  const live = projectStructuralReport(frame.structuralReport, { required: native });
  // Validate every per-frame resource fact even though the batch envelope is
  // the canonical aggregate exposed to callers.
  stringArray(frame.unresolved, 'batch frame unresolved variables');
  stringArray(frame.createdVariables, 'batch frame created variables');
  stringArray(frame.createdTextStyles, 'batch frame created Text Styles');
  projectVariableReport(frame.variableReport);
  projectTextStyleReport(frame.textStyleReport);
  projectFallbackReport(frame.fallbackAnnotationReport);
  projectScopeQuestions(frame.scopeQuestions);
  const overflow = frame.overflow === undefined ? null : finiteNumber(frame.overflow, 'batch frame overflow');
  return Object.freeze({ root: rootFromPlugin(frame), live, overflow });
}

/**
 * Project one journaled native/compatibility batch plus its explicit stages.
 * @param {any} value
 * @param {{
 *   executor?: string,
 *   structures?: readonly any[],
 *   notices?: readonly any[],
 *   stages?: readonly any[],
 *   rootHandles?: readonly string[] | null,
 *   degradations?: readonly any[],
 *   reuse?: any,
 * }} [options]
 */
export function projectSemanticRenderBatchOutcome(value, {
  executor, structures, notices = [], stages = [], rootHandles = null, degradations = [], reuse,
} = {}) {
  assertBoundedGraph(value, 'Plugin batch result', { maxCollectionItems: 10_000 });
  const native = executor === 'structured-batch-v1';
  if (!native && executor !== 'generated-eval-batch-compatibility') {
    throw new TypeError('Semantic Render batch Outcome requires a known executor.');
  }
  const envelope = Array.isArray(value) ? { frames: value } : value;
  if (!isRecord(envelope)) throw resultError('Semantic Render batch returned no structured result.');
  rejectUnknownFields(envelope, BATCH_TOP_LEVEL_FIELDS, 'batch result');
  if (!Array.isArray(envelope.frames) || envelope.frames.length !== structures?.length
    || envelope.frames.length < 1 || envelope.frames.length > MAX_SEMANTIC_RENDER_ARRAY_ITEMS) {
    throw resultError('Semantic Render batch returned missing or excess frame results.');
  }
  if (native && envelope.executor !== 'structured-batch-v1') {
    throw resultError('Semantic Render batch returned the wrong executor identity.');
  }
  if (!native && envelope.executor !== undefined) {
    throw resultError('Semantic Render compatibility batch returned an unexpected executor identity.');
  }
  if (native && (envelope.mutationOutcome !== 'completed' || envelope.mutationReport === undefined)) {
    throw resultError('Semantic Render batch returned incomplete mutation outcome facts.');
  }
  if (!native && ((envelope.mutationOutcome === undefined) !== (envelope.mutationReport === undefined))) {
    throw resultError('Semantic Render compatibility batch returned incomplete mutation outcome facts.');
  }
  if (envelope.mutationOutcome !== undefined && envelope.mutationOutcome !== 'completed') {
    throw resultError('Semantic Render batch returned an inconsistent mutation outcome.');
  }
  const mutation = projectCompletedMutation(
    envelope.mutationReport,
    native ? 'structured-v1' : 'generated-eval-batch-compatibility',
  );
  const frames = envelope.frames.map((frame) => projectBatchFrame(frame, { native }));
  if (rootHandles !== null) {
    if (!Array.isArray(rootHandles) || rootHandles.length !== frames.length) {
      throw new TypeError('Semantic Render batch root overrides must match every frame.');
    }
    for (let index = 0; index < rootHandles.length; index++) {
      const handle = requiredString(rootHandles[index], 'compound root override');
      if (!NODE_ID.test(handle) || Buffer.byteLength(handle, 'utf8') > MAX_SEMANTIC_RENDER_HANDLE_BYTES) {
        throw new TypeError('Semantic Render batch received an invalid root override.');
      }
      frames[index] = Object.freeze({
        ...frames[index],
        root: Object.freeze({ ...frames[index].root, handle }),
      });
    }
  }
  const live = combineLiveStructures(frames.map((frame) => frame.live));
  const overflowPixels = frames.map((frame) => frame.overflow).filter((item) => item !== null);
  const outcomeStages = projectCompoundStages(stages);
  const unresolvedVariables = stringArray(envelope.unresolved, 'unresolved variables');
  const projectedDegradations = projectDegradations(degradations, unresolvedVariables, {
    compatibility: !native,
  });
  const projectedReuse = projectReuseReport(reuse, frames.length);
  return finalizeOutcome({
    schemaVersion: SEMANTIC_RENDER_OUTCOME_SCHEMA,
    kind: SEMANTIC_RENDER_OUTCOME_KIND,
    status: projectedDegradations.length || live?.passed === false
      || outcomeStages.some((stage) => stage.status === 'completed-with-findings')
      ? 'completed-with-findings' : 'completed',
    roots: Object.freeze(frames.map((frame) => frame.root)),
    executor: EXECUTORS[executor],
    structure: Object.freeze({ planned: combinePlannedStructures(structures), live }),
    resources: Object.freeze({
      unresolvedVariables,
      createdVariables: stringArray(envelope.createdVariables, 'created variables'),
      createdTextStyles: stringArray(envelope.createdTextStyles, 'created Text Styles'),
      variableReport: projectVariableReport(envelope.variableReport),
      textStyleReport: projectTextStyleReport(envelope.textStyleReport),
      fallbackAnnotationReport: projectFallbackReport(envelope.fallbackAnnotationReport),
      scopeQuestions: projectScopeQuestions(envelope.scopeQuestions),
    }),
    overflow: overflowPixels.length ? Object.freeze({ pixels: Math.max(...overflowPixels) }) : null,
    mutation,
    reuse: projectedReuse,
    stages: outcomeStages,
    degradations: projectedDegradations,
    notices: projectNotices(notices),
    failure: null,
  });
}

/** Project only closed failure facts. Error prose, stacks and request inputs are excluded. */
export function projectSemanticRenderFailureOutcome(error, {
  executor, structure, partialOutcome = null, stages = [], degradations = [], reuse = null,
}) {
  const failure = Object.freeze({
    kind: FAILURE_KINDS.has(error?.kind) ? error.kind : 'execution',
    phase: FAILURE_PHASES.has(error?.phase) ? error.phase : 'plugin-execution',
    outcome: FAILURE_OUTCOMES.has(error?.outcome) ? error.outcome : 'unknown-after-dispatch',
    dispatchState: DISPATCH_STATES.has(error?.dispatchState)
      ? error.dispatchState
      : error?.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown',
  });
  if (partialOutcome !== null) assertSemanticRenderOutcome(partialOutcome);
  const planned = partialOutcome?.structure?.planned
    || (Array.isArray(structure) ? combinePlannedStructures(structure) : projectPlannedStructure(structure));
  const projectedDegradations = partialOutcome?.degradations || projectDegradations(
    degradations,
    Object.freeze([]),
    { compatibility: String(executor || '').includes('compatibility') },
  );
  return finalizeOutcome({
    schemaVersion: SEMANTIC_RENDER_OUTCOME_SCHEMA,
    kind: SEMANTIC_RENDER_OUTCOME_KIND,
    status: 'failed',
    roots: partialOutcome?.roots || Object.freeze([]),
    executor: partialOutcome?.executor || EXECUTORS[executor] || null,
    structure: partialOutcome?.structure || Object.freeze({ planned, live: null }),
    resources: partialOutcome?.resources || emptyResources(),
    overflow: partialOutcome?.overflow || null,
    mutation: parseStructuredMutationReport(error?.mutationReport) || partialOutcome?.mutation || null,
    reuse: partialOutcome?.reuse || (reuse === null ? null : projectReuseReport(
      reuse,
      Array.isArray(structure) ? structure.length : 1,
    )),
    stages: projectCompoundStages(stages),
    degradations: projectedDegradations,
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
