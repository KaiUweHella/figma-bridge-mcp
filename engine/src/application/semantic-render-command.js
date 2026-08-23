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
  assertSemanticRenderOutcome,
  projectSemanticRenderFailureOutcome,
  projectSemanticRenderOutcome,
} from '../lib/semantic-render-outcome.js';
import {
  SEMANTIC_RENDER_DEVICE_PRESETS,
  semanticRenderArgvFromRequest,
  semanticRenderArgvRoute,
  semanticRenderRequestFromArgv,
} from './semantic-render-request.js';

export { semanticRenderArgvFromRequest } from './semantic-render-request.js';
export { semanticRenderOutcomeCode } from '../lib/semantic-render-outcome.js';

const APPLICATION_ID = 'render';
const PREPARED_RENDER_REQUESTS = new WeakSet();
const MAX_EVIDENCE_ITEMS = 100;
const MAX_EVIDENCE_STRING_CODE_POINTS = 512;

/** @typedef {{tone:string,text:string,marker?:string,markerTone?:string}} SemanticRenderRow */

function boundedText(value, max = MAX_EVIDENCE_STRING_CODE_POINTS) {
  const points = Array.from(String(value ?? ''));
  return points.length > max ? `${points.slice(0, Math.max(0, max - 1)).join('')}…` : points.join('');
}

function preflightError(message) {
  return Object.assign(new Error(message), {
    kind: 'validation',
    phase: 'request-validation',
    outcome: 'not-dispatched',
  });
}

function preflightCount(value, label, max = 20_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw preflightError(`Semantic Render produced invalid ${label} diagnostics.`);
  }
  return value;
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
  const attachFailureOutcome = (error, failedExecutor) => {
    /** @type {Error & {semanticRenderOutcome?: unknown}} */
    const failure = error instanceof Error ? error : new Error(String(error || 'Semantic Render failed'));
    if (!failure.semanticRenderOutcome) {
      const outcome = projectSemanticRenderFailureOutcome(failure, {
        executor: failedExecutor,
        structure: prepared.evidence.structure,
      });
      try {
        failure.semanticRenderOutcome = outcome;
      } catch {
        /** @type {Error & {semanticRenderOutcome?: unknown,kind?:unknown,phase?:unknown,outcome?:unknown,dispatchState?:unknown,mutationReport?:unknown}} */
        const wrapped = new Error(failure.message, { cause: failure });
        for (const key of ['kind', 'phase', 'outcome', 'dispatchState', 'mutationReport']) {
          if (key in failure) wrapped[key] = failure[key];
        }
        wrapped.semanticRenderOutcome = outcome;
        return wrapped;
      }
    }
    return failure;
  };
  if (prepared.support.supported) {
    try {
      raw = await adapters.renderPlan(prepared.renderPlan);
      executor = 'structured-v1';
    } catch (error) {
      if (!permitsCompatibilityRedispatch(error)) throw attachFailureOutcome(error, 'structured-v1');
      compatibilityReason = 'Plugin did not advertise the native Semantic Render capability before dispatch.';
    }
  } else {
    compatibilityReason = `Native preflight unsupported: ${prepared.support.problems.slice(0, 5).map((problem) => boundedText(problem)).join('; ')}`;
  }

  if (compatibilityReason) {
    executor = 'generated-eval-compatibility';
    try {
      const code = await prepared.client.compileRenderPlan(prepared.renderPlan);
      raw = await adapters.evaluate(code);
    } catch (error) {
      throw attachFailureOutcome(error, executor);
    }
  }
  const warnings = [...prepared.evidence.warnings];
  if (compatibilityReason) warnings.push(Object.freeze({ tone: 'warning', text: boundedText(compatibilityReason) }));

  // Validate the untrusted post-dispatch response before any advisory read.
  try {
    projectSemanticRenderOutcome(raw, {
      executor,
      structure: prepared.evidence.structure,
      notices: warnings,
    });
  } catch (error) {
    throw attachFailureOutcome(error, executor);
  }

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

  try {
    return projectSemanticRenderOutcome(raw, {
      executor,
      structure: prepared.evidence.structure,
      notices: warnings.slice(0, MAX_EVIDENCE_ITEMS),
    });
  } catch (error) {
    throw attachFailureOutcome(error, executor);
  }
}

/** Convenience Interface for tests and Adapters without a readiness phase. */
export async function executeSemanticRenderPlan(plan, adapters = {}) {
  const prepared = prepareSemanticRenderPlan(plan, adapters);
  return executePreparedSemanticRender(prepared, adapters);
}

export function semanticRenderResultRows(result) {
  const outcome = assertSemanticRenderOutcome(result);
  if (outcome.status === 'failed') throw new TypeError('Semantic Render formatter cannot format a failed Outcome as success.');
  const root = outcome.roots[0];
  const resources = outcome.resources;
  const structuralReport = outcome.structure.live;
  /** @type {SemanticRenderRow[]} */
  const rows = [{
    tone: 'muted',
    text: `JSX structure: ${outcome.structure.planned.grid} Grid, ${outcome.structure.planned.flex} Auto Layout, ${outcome.structure.planned.free} explicit free, ${outcome.structure.planned.absolute} absolute`,
  }];
  rows.push(...outcome.notices.map((notice) => ({ tone: notice.tone, text: notice.text })));
  rows.push({ tone: 'success', marker: '✓', markerTone: 'success', text: `Rendered: ${root.handle}` });
  if (root.name) rows.push({ tone: 'muted', text: `name: ${root.name}` });
  rows.push({
    tone: outcome.executor.kind === 'structured' ? 'muted' : 'warning',
    text: `executor: ${outcome.executor.kind === 'structured' ? `Semantic Render Plan v${outcome.executor.version}` : 'generated eval compatibility'}`,
  });
  if (structuralReport) {
    const summary = structuralReport.summary;
    const detail = `${summary.nodes} nodes, ${summary.grids} Grid, ${summary.autoLayouts} Auto Layout, ${summary.freeLayouts} free, ${summary.instances} instances, ${summary.absoluteNodes} absolute`;
    rows.push({
      tone: structuralReport.passed ? 'muted' : 'error',
      text: `live structural audit: ${structuralReport.passed ? 'PASS' : `FAIL — ${structuralReport.mismatchCount} mismatch(es)`} — ${detail}`,
    });
    if (!structuralReport.passed) {
      for (const finding of structuralReport.mismatches.slice(0, 5)) {
        rows.push({ tone: 'error', text: `${finding.path}: ${finding.fact}; expected ${finding.expected}, got ${finding.actual}` });
      }
    }
  }
  if (resources.unresolvedVariables.length) {
    rows.push({ tone: 'warning', text: `${resources.unresolvedVariables.length} unresolved variable reference(s): ${resources.unresolvedVariables.join(', ')}. These bindings rendered as grey placeholders; inspect variables with figma_run ["var","list"].` });
  }
  if (resources.variableReport) {
    const report = resources.variableReport;
    rows.push({ tone: 'muted', text: `variable report: ${report.references} reference(s), ${report.reused} reused, ${report.created} created, ${report.bound} bound, ${report.ambiguous} ambiguous, ${report.unsupported} unsupported` });
  }
  if (resources.textStyleReport) {
    const report = resources.textStyleReport;
    rows.push({ tone: 'muted', text: `Text Style report: ${report.references} reference(s), ${report.reused} reused, ${report.created} created, ${report.bound} bound` });
  }
  if (resources.fallbackAnnotationReport?.requested) {
    const report = resources.fallbackAnnotationReport;
    rows.push({ tone: report.unsupported ? 'warning' : 'muted', text: `fallback annotations: ${report.applied} added, ${report.deduplicated} already present, ${report.unsupported} unsupported` });
  }
  if (resources.createdVariables.length) rows.push({ tone: 'success', text: `${resources.createdVariables.length} variable(s) created and bound: ${resources.createdVariables.join(', ')}` });
  if (resources.createdTextStyles.length) rows.push({ tone: 'success', text: `${resources.createdTextStyles.length} Text Style(s) created: ${resources.createdTextStyles.join(', ')}` });
  for (const question of resources.scopeQuestions) {
    rows.push({ tone: 'warning', text: `variable scope decision: ${question.collection ? `${question.collection}/` : ''}${question.name} (${question.resolvedType}); choices: ${question.allowedScopes.join(', ')}` });
    rows.push({ tone: 'muted', text: question.question });
  }
  if (outcome.overflow) rows.push({ tone: 'warning', text: `Content overflows the fixed frame height by ${outcome.overflow.pixels}px; shrink a child or raise the frame height.` });
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export function formatSemanticRenderResult(result) {
  return semanticRenderResultRows(result)
    .map((row) => row.marker ? `${row.marker} ${row.text}` : row.text)
    .join('\n');
}
