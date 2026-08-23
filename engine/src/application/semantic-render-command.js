// Value-returning Command Application for a simple single-root Semantic Render.
//
// JSX is an input Adapter into one validated Semantic Render Plan. Commander,
// figma_run and figma_render share this preparation, native/compatibility
// selection, result projection and formatter. Compound Render modes remain a
// named Commander compatibility Adapter until their effects are explicit.

import { dirname } from 'node:path';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { FigmaClient } from '../lib/jsx-render.js';
import {
  componentLinksFromRegistry,
  readDesignLinkRegistry,
} from '../lib/design-link-registry.js';
import {
  findRepeatedSiblings,
  formatReuseWarning,
  matchInventory,
  namedContainers,
} from '../lib/render-lint.js';
import { cachedInventoryCode } from '../lib/component-inventory.js';
import { permitsCompatibilityRedispatch } from '../lib/daemon-error-envelope.js';
import { inspectStructuredRenderPlan } from '../lib/structured-render-executor.js';
import {
  SEMANTIC_RENDER_DEVICE_PRESETS,
  semanticRenderArgvFromRequest,
  semanticRenderArgvRoute,
  semanticRenderRequestFromArgv,
} from './semantic-render-request.js';

export { semanticRenderArgvFromRequest } from './semantic-render-request.js';

const APPLICATION_ID = 'render';
const PREPARED_RENDER_REQUESTS = new WeakSet();
const NODE_ID = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const MAX_EVIDENCE_ITEMS = 100;
const MAX_EVIDENCE_STRING_CODE_POINTS = 512;

/** @typedef {{tone:string,text:string,marker?:string,markerTone?:string}} SemanticRenderRow */

function boundedText(value, max = MAX_EVIDENCE_STRING_CODE_POINTS) {
  const points = Array.from(String(value ?? ''));
  return points.length > max ? `${points.slice(0, max).join('')}…` : points.join('');
}

function preflightError(message) {
  return Object.assign(new Error(message), {
    kind: 'validation',
    phase: 'request-validation',
    outcome: 'not-dispatched',
  });
}

function resultError(message) {
  return Object.assign(new Error(message), {
    kind: 'plugin-result',
    phase: 'plugin-response',
    outcome: 'unknown-after-dispatch',
  });
}

function finiteCount(value, label, max = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw resultError(`Semantic Render returned an invalid ${label}.`);
  }
  return value;
}

function preflightCount(value, label, max = 20_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw preflightError(`Semantic Render produced invalid ${label} diagnostics.`);
  }
  return value;
}

function boundedStringArray(value, label) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw resultError(`Semantic Render returned an invalid ${label}.`);
  const items = value.slice(0, MAX_EVIDENCE_ITEMS).map((item) => {
    if (typeof item !== 'string') throw resultError(`Semantic Render returned an invalid ${label} item.`);
    return boundedText(item);
  });
  return Object.freeze(items);
}

function numericReport(value, label, keys) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw resultError(`Semantic Render returned an invalid ${label}.`);
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    throw resultError(`Semantic Render returned an incomplete ${label}.`);
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, finiteCount(value[key], `${label}.${key}`)])));
}

function fallbackAnnotationReport(value) {
  const report = numericReport(value, 'fallbackAnnotationReport', [
    'requested', 'applied', 'deduplicated', 'unsupported',
  ]);
  if (report && report.requested !== report.applied + report.deduplicated + report.unsupported) {
    throw resultError('Semantic Render returned an inconsistent fallbackAnnotationReport.');
  }
  return report;
}

function variableReport(value) {
  const report = numericReport(value, 'variableReport', [
    'references', 'reused', 'created', 'bound', 'ambiguous', 'unsupported',
  ]);
  if (report && (report.bound !== report.references || report.ambiguous !== 0
    || report.unsupported !== 0 || report.reused + report.created > report.references)) {
    throw resultError('Semantic Render returned an inconsistent variableReport.');
  }
  return report;
}

function textStyleReport(value) {
  const report = numericReport(value, 'textStyleReport', [
    'references', 'reused', 'created', 'bound',
  ]);
  if (report && (report.bound !== report.references
    || report.reused + report.created > report.references)) {
    throw resultError('Semantic Render returned an inconsistent textStyleReport.');
  }
  return report;
}

function completedMutationReport(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.outcome !== 'completed'
    || !Number.isSafeInteger(value.created) || value.created < 0 || value.created > 100_000
    || value.removed !== 0 || value.residueCount !== 0
    || !Array.isArray(value.residue) || value.residue.length !== 0
    || value.residueTruncated !== false) {
    throw resultError('Semantic Render returned an invalid completed mutation report.');
  }
  return Object.freeze({
    version: 1,
    outcome: 'completed',
    created: value.created,
    removed: 0,
    residueCount: 0,
    residue: Object.freeze([]),
    residueTruncated: false,
  });
}

function structuralReport(value, { required }) {
  if (value === undefined && !required) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || typeof value.passed !== 'boolean') {
    throw resultError('Semantic Render returned an invalid structural report.');
  }
  const summaryKeys = ['nodes', 'grids', 'autoLayouts', 'freeLayouts', 'instances', 'absoluteNodes'];
  if (!value.summary || typeof value.summary !== 'object' || Array.isArray(value.summary)
    || summaryKeys.some((key) => !Object.hasOwn(value.summary, key))) {
    throw resultError('Semantic Render returned an invalid structural report summary.');
  }
  const summary = Object.freeze(Object.fromEntries(summaryKeys.map((key) => [
    key, finiteCount(value.summary[key], `structuralReport.summary.${key}`),
  ])));
  if (!Object.hasOwn(value, 'mismatchCount')) {
    throw resultError('Semantic Render returned an invalid structural mismatch count.');
  }
  const mismatchCount = finiteCount(value.mismatchCount, 'structuralReport.mismatchCount');
  if (value.passed !== (mismatchCount === 0)) {
    throw resultError('Semantic Render returned an inconsistent structural report outcome.');
  }
  const mismatches = [];
  if (value.mismatches !== undefined) {
    if (!Array.isArray(value.mismatches)) throw resultError('Semantic Render returned invalid structural mismatches.');
    for (const item of value.mismatches.slice(0, 20)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw resultError('Semantic Render returned an invalid structural mismatch.');
      }
      if (['path', 'fact', 'expected', 'actual'].some((key) => typeof item[key] !== 'string')) {
        throw resultError('Semantic Render returned a structural mismatch with invalid text fields.');
      }
      mismatches.push(Object.freeze({
        path: boundedText(item.path),
        fact: boundedText(item.fact),
        expected: boundedText(item.expected),
        actual: boundedText(item.actual),
      }));
    }
  }
  if (mismatches.length !== Math.min(mismatchCount, 20)) {
    throw resultError('Semantic Render returned incomplete structural mismatch evidence.');
  }
  return Object.freeze({
    passed: value.passed,
    summary,
    mismatchCount,
    mismatches: Object.freeze(mismatches),
  });
}

function scopeQuestions(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw resultError('Semantic Render returned invalid scope questions.');
  return Object.freeze(value.slice(0, MAX_EVIDENCE_ITEMS).map((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw resultError('Semantic Render returned an invalid scope question.');
    }
    const textKeys = ['name', 'collection', 'resolvedType', 'status', 'question'];
    if (textKeys.some((key) => typeof question[key] !== 'string')) {
      throw resultError('Semantic Render returned a scope question with invalid text fields.');
    }
    if (!Array.isArray(question.allowedScopes)) {
      throw resultError('Semantic Render returned a scope question without allowedScopes.');
    }
    const allowedScopes = boundedStringArray(question.allowedScopes, 'scope question allowedScopes');
    if (!question.name || !question.collection || !question.question || !allowedScopes.length
      || question.status !== 'USER_DECISION_REQUIRED'
      || !['BOOLEAN', 'COLOR', 'FLOAT', 'STRING'].includes(question.resolvedType)) {
      throw resultError('Semantic Render returned an inconsistent scope question.');
    }
    return Object.freeze({
      name: boundedText(question.name),
      collection: boundedText(question.collection),
      resolvedType: boundedText(question.resolvedType),
      status: boundedText(question.status),
      question: boundedText(question.question),
      allowedScopes,
    });
  }));
}

function validateResult(value, executor) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw resultError('Semantic Render returned no structured result.');
  }
  if (typeof value.id !== 'string' || value.id.length > 512 || !NODE_ID.test(value.id)) {
    throw resultError('Semantic Render returned an invalid root node id.');
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    throw resultError('Semantic Render returned an invalid root name.');
  }
  if (executor === 'structured-v1' && value.executor !== 'structured-v1') {
    throw resultError('Semantic Render returned the wrong native executor identity.');
  }
  for (const key of ['width', 'height', 'overflow']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number'
      || !Number.isFinite(value[key]) || value[key] < 0)) {
      throw resultError(`Semantic Render returned an invalid ${key}.`);
    }
  }
  if (value.mutationOutcome !== undefined && value.mutationOutcome !== 'completed') {
    throw resultError('Semantic Render returned an inconsistent mutation outcome.');
  }
  const mutation = completedMutationReport(value.mutationReport);
  if ((value.mutationOutcome === undefined) !== (mutation === null)) {
    throw resultError('Semantic Render returned incomplete mutation outcome facts.');
  }

  return Object.freeze({
    id: value.id,
    name: boundedText(value.name || ''),
    executor,
    width: value.width === undefined ? null : value.width,
    height: value.height === undefined ? null : value.height,
    overflow: value.overflow === undefined ? null : value.overflow,
    structuralReport: structuralReport(value.structuralReport, { required: executor === 'structured-v1' }),
    unresolved: boundedStringArray(value.unresolved, 'unresolved variables'),
    createdVariables: boundedStringArray(value.createdVariables, 'created variables'),
    createdTextStyles: boundedStringArray(value.createdTextStyles, 'created Text Styles'),
    scopeQuestions: scopeQuestions(value.scopeQuestions),
    variableReport: variableReport(value.variableReport),
    textStyleReport: textStyleReport(value.textStyleReport),
    fallbackAnnotationReport: fallbackAnnotationReport(value.fallbackAnnotationReport),
    mutationOutcome: value.mutationOutcome || null,
    mutationReport: mutation,
  });
}

function devicePreset(jsx, presetName) {
  if (!presetName) return { jsx, note: null };
  const [width, height] = SEMANTIC_RENDER_DEVICE_PRESETS[presetName];
  const match = jsx.match(/<Frame\b([^>]*)>/);
  if (!match) return { jsx, note: null };
  const props = match[1];
  const hasWidth = /\b(?:w|width)=/.test(props);
  const hasHeight = /\b(?:h|height)=/.test(props);
  if (hasWidth && hasHeight) {
    return { jsx, note: `preset ${presetName} (${width}×${height}) ignored — the JSX sets explicit w/h` };
  }
  const injected = `${hasWidth ? '' : ` w="${width}"`}${hasHeight ? '' : ` h="${height}"`}`;
  return {
    jsx: jsx.replace(/<Frame\b/, `<Frame${injected} `),
    note: `preset ${presetName}: root frame ${width}×${height}`,
  };
}

function repeatedStructureWarnings(client, jsx) {
  try {
    const open = String(jsx).match(/<Frame\s+([^>]*)>/);
    if (!open) return [];
    const props = client.parseProps(open[1]);
    const children = client.parseChildren(
      client.extractContent(String(jsx).slice(open.index + open[0].length), 'Frame'),
    );
    const root = { _type: 'frame', ...props, _children: children };
    const groups = [
      ...findRepeatedSiblings([root]),
      ...findRepeatedSiblings(root._children),
    ];
    return groups.map((group) => `${group.count}× the same structure${group.sampleName ? ` ("${group.sampleName}")` : ''} in one render — make it a component, then place Instance copies.`);
  } catch {
    return [];
  }
}

function compileEvidence(client, jsx, renderPlan, request, presetNote) {
  const warnings = [];
  if (presetNote) warnings.push({ tone: 'muted', text: presetNote });
  for (const warning of client.validateJsxProps(jsx)) {
    warnings.push({
      tone: 'warning',
      text: `Unknown prop "${boundedText(warning.prop)}" on <${boundedText(warning.tag)}>${warning.suggestion ? ` — did you mean "${boundedText(warning.suggestion)}"?` : ' (ignored)'}`,
    });
  }
  for (const warning of repeatedStructureWarnings(client, jsx)) {
    warnings.push({ tone: 'warning', text: warning });
  }

  const diagnostics = renderPlan.diagnostics || {};
  const layouts = diagnostics.layouts || {};
  const unclassified = diagnostics.unclassifiedFallbacks || [];
  if (unclassified.length) {
    const detail = unclassified.slice(0, 10)
      .map((finding) => `${boundedText(finding.path)}: ${boundedText(finding.fact)}`)
      .join('; ');
    throw preflightError(`Semantic Render has ${unclassified.length} unclassified structural problem(s): ${detail}`);
  }
  const pendingFontAxes = (diagnostics.classifiedFallbacks || []).filter((finding) =>
    finding.fallback === 'font.named-faces'
    && !request.approvedFallbacks.some((approval) => approval === finding.fallback
      || approval === finding.path || approval === `${finding.path}:${finding.fallback}`));
  if (pendingFontAxes.length) {
    throw preflightError('Semantic Render needs a variable-font decision; install the requested font or approve font.named-faces.');
  }
  if (diagnostics.classifiedFallbacks?.length) {
    warnings.push({ tone: 'warning', text: `${diagnostics.classifiedFallbacks.length} explicit/classified structural fallback(s).` });
  }
  if (diagnostics.unresolvedIcons?.length) {
    const names = [...new Set(diagnostics.unresolvedIcons.map((item) => boundedText(item.name)))];
    warnings.push({ tone: 'warning', text: `${diagnostics.unresolvedIcons.length} unresolved icon(s): ${names.slice(0, 20).join(', ')}.` });
  }

  return Object.freeze({
    structure: Object.freeze({
      grid: preflightCount(Number(layouts.grid || 0), 'diagnostics.layouts.grid'),
      flex: preflightCount(Number(layouts.flex || 0), 'diagnostics.layouts.flex'),
      free: preflightCount(Number(layouts.free || 0), 'diagnostics.layouts.free'),
      absolute: preflightCount(Number(diagnostics.absoluteNodes || 0), 'diagnostics.absoluteNodes'),
    }),
    warnings: Object.freeze(warnings.slice(0, MAX_EVIDENCE_ITEMS).map((warning) => Object.freeze({
      tone: warning.tone,
      text: boundedText(warning.text),
    }))),
  });
}

/** Select the exact Adapter without executing the Command. */
export function semanticRenderPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Semantic Render routing requires a Command Plan created by the Capability Catalog.');
  }
  if (!plan.allowed || plan.id !== APPLICATION_ID) return 'not-render';
  const route = semanticRenderArgvRoute([...plan.argv]);
  return route.kind === 'simple' ? 'command-application' : 'commander-compatibility';
}

/** Parse JSX and prepare the exact native or generated execution decision. */
export function prepareSemanticRenderPlan(plan, adapters = {}) {
  if (semanticRenderPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the simple Semantic Render Command Application.`);
  }
  const request = semanticRenderRequestFromArgv([...plan.argv]);
  const preset = devicePreset(request.jsx, request.preset);
  const client = new FigmaClient();
  if (request.collection) client.setCollection(request.collection);
  if (request.manifest) {
    if (!adapters.workspaceIO) throw new TypeError('Semantic Render requires a WorkspaceIO adapter.');
    const registry = readDesignLinkRegistry(dirname(request.manifest), {
      manifestPath: request.manifest,
      io: adapters.workspaceIO,
    }).registry;
    client.setComponentLinks(componentLinksFromRegistry(registry));
  }
  const renderPlan = client.planJSX(preset.jsx);
  const evidence = compileEvidence(client, preset.jsx, renderPlan, request, preset.note);
  const support = inspectStructuredRenderPlan(renderPlan);
  const prepared = Object.freeze({ request, client, renderPlan, support, evidence, jsx: preset.jsx });
  PREPARED_RENDER_REQUESTS.add(prepared);
  return prepared;
}

/** Execute one prepared write, with compatibility only from proven preflight. */
export async function executePreparedSemanticRender(prepared, adapters = {}) {
  if (!PREPARED_RENDER_REQUESTS.has(prepared)) {
    throw new TypeError('Semantic Render execution requires a prepared request from this Application.');
  }
  if (typeof adapters.renderPlan !== 'function' || typeof adapters.evaluate !== 'function') {
    throw new TypeError('Semantic Render requires renderPlan and evaluate adapters.');
  }

  let raw;
  let executor;
  let compatibilityReason = null;
  if (prepared.support.supported) {
    try {
      raw = await adapters.renderPlan(prepared.renderPlan);
      executor = 'structured-v1';
    } catch (error) {
      if (!permitsCompatibilityRedispatch(error)) throw error;
      compatibilityReason = 'Plugin did not advertise the native Semantic Render capability before dispatch.';
    }
  } else {
    compatibilityReason = `Native preflight unsupported: ${prepared.support.problems.slice(0, 5).map((problem) => boundedText(problem)).join('; ')}`;
  }

  if (compatibilityReason) {
    const code = await prepared.client.compileRenderPlan(prepared.renderPlan);
    raw = await adapters.evaluate(code);
    executor = 'generated-eval-compatibility';
  }
  const projected = validateResult(raw, executor);
  const warnings = [...prepared.evidence.warnings];
  if (compatibilityReason) warnings.push(Object.freeze({ tone: 'warning', text: boundedText(compatibilityReason) }));

  if (typeof adapters.inspectInventory === 'function') {
    try {
      const names = namedContainers([prepared.jsx]);
      if (names.length) {
        const inventory = await adapters.inspectInventory(cachedInventoryCode(true));
        for (const finding of matchInventory(names, inventory).slice(0, 20)) {
          warnings.push(Object.freeze({ tone: 'warning', text: boundedText(`reuse: ${formatReuseWarning(finding)}`) }));
        }
      }
    } catch {
      // Reuse lint is advisory and read-only; it must never turn a completed
      // canvas write into an ambiguous failure.
    }
  }

  return Object.freeze({
    ...projected,
    structure: prepared.evidence.structure,
    warnings: Object.freeze(warnings.slice(0, MAX_EVIDENCE_ITEMS)),
  });
}

/** Convenience Interface for tests and Adapters without a readiness phase. */
export async function executeSemanticRenderPlan(plan, adapters = {}) {
  const prepared = prepareSemanticRenderPlan(plan, adapters);
  return executePreparedSemanticRender(prepared, adapters);
}

export function semanticRenderOutcomeCode(result) {
  return result?.structuralReport?.passed === false ? 1 : 0;
}

export function semanticRenderResultRows(result) {
  if (!result || typeof result !== 'object' || !NODE_ID.test(result.id || '')) {
    throw new TypeError('Semantic Render formatter requires an Application result.');
  }
  /** @type {SemanticRenderRow[]} */
  const rows = [{
    tone: 'muted',
    text: `JSX structure: ${result.structure.grid} Grid, ${result.structure.flex} Auto Layout, ${result.structure.free} explicit free, ${result.structure.absolute} absolute`,
  }];
  rows.push(...result.warnings.map((warning) => ({ tone: warning.tone, text: warning.text })));
  rows.push({ tone: 'success', marker: '✓', markerTone: 'success', text: `Rendered: ${result.id}` });
  if (result.name) rows.push({ tone: 'muted', text: `name: ${result.name}` });
  rows.push({
    tone: result.executor === 'structured-v1' ? 'muted' : 'warning',
    text: `executor: ${result.executor === 'structured-v1' ? 'Semantic Render Plan v1' : 'generated eval compatibility'}`,
  });
  if (result.structuralReport) {
    const summary = result.structuralReport.summary;
    const detail = `${summary.nodes} nodes, ${summary.grids} Grid, ${summary.autoLayouts} Auto Layout, ${summary.freeLayouts} free, ${summary.instances} instances, ${summary.absoluteNodes} absolute`;
    rows.push({
      tone: result.structuralReport.passed ? 'muted' : 'error',
      text: `live structural audit: ${result.structuralReport.passed ? 'PASS' : `FAIL — ${result.structuralReport.mismatchCount} mismatch(es)`} — ${detail}`,
    });
    if (!result.structuralReport.passed) {
      for (const finding of result.structuralReport.mismatches.slice(0, 5)) {
        rows.push({ tone: 'error', text: `${finding.path}: ${finding.fact}; expected ${finding.expected}, got ${finding.actual}` });
      }
    }
  }
  if (result.unresolved.length) {
    rows.push({ tone: 'warning', text: `${result.unresolved.length} unresolved variable reference(s): ${result.unresolved.join(', ')}. These bindings rendered as grey placeholders; inspect variables with figma_run ["var","list"].` });
  }
  if (result.variableReport) {
    const report = result.variableReport;
    rows.push({ tone: 'muted', text: `variable report: ${report.references} reference(s), ${report.reused} reused, ${report.created} created, ${report.bound} bound, ${report.ambiguous} ambiguous, ${report.unsupported} unsupported` });
  }
  if (result.textStyleReport) {
    const report = result.textStyleReport;
    rows.push({ tone: 'muted', text: `Text Style report: ${report.references} reference(s), ${report.reused} reused, ${report.created} created, ${report.bound} bound` });
  }
  if (result.fallbackAnnotationReport?.requested) {
    const report = result.fallbackAnnotationReport;
    rows.push({ tone: report.unsupported ? 'warning' : 'muted', text: `fallback annotations: ${report.applied} added, ${report.deduplicated} already present, ${report.unsupported} unsupported` });
  }
  if (result.createdVariables.length) rows.push({ tone: 'success', text: `${result.createdVariables.length} variable(s) created and bound: ${result.createdVariables.join(', ')}` });
  if (result.createdTextStyles.length) rows.push({ tone: 'success', text: `${result.createdTextStyles.length} Text Style(s) created: ${result.createdTextStyles.join(', ')}` });
  for (const question of result.scopeQuestions) {
    rows.push({ tone: 'warning', text: `variable scope decision: ${question.collection ? `${question.collection}/` : ''}${question.name} (${question.resolvedType}); choices: ${question.allowedScopes.join(', ')}` });
    rows.push({ tone: 'muted', text: question.question });
  }
  if (result.overflow) rows.push({ tone: 'warning', text: `Content overflows the fixed frame height by ${result.overflow}px; shrink a child or raise the frame height.` });
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export function formatSemanticRenderResult(result) {
  return semanticRenderResultRows(result)
    .map((row) => row.marker ? `${row.marker} ${row.text}` : row.text)
    .join('\n');
}
