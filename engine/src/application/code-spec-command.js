// Value-returning design-to-code command application Module.
//
// The Interface is deliberately small: a request plus one evaluate adapter in,
// stdout/stderr values out. Commander, MCP, console and process.exit stay
// outside this seam. That gives CLI and MCP the same behaviour and makes the
// command directly testable without booting a process.
import { sectionFinderCode } from '../design-extract.js';
import { componentStateCoverage, formatCodeSpec, layerCoverage, specModel } from '../lib/code-spec.js';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  createDesignCaptureModule,
  walkWithDepthRetry,
} from './design-capture.js';
import {
  DEFAULT_SPEC_FORMAT,
  serializeSpecModel,
} from '../lib/spec-format.js';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  CODE_SPEC_FORMATS,
  CODE_SPEC_PHASES,
  codeSpecArgvFromRequest,
  codeSpecPlanningArgvFromRequest,
  parseCodeSpecRequest,
} from './code-spec-request.js';

export {
  CODE_SPEC_FORMATS,
  CODE_SPEC_PHASES,
  codeSpecArgvFromRequest,
  codeSpecPlanningArgvFromRequest,
} from './code-spec-request.js';
export { walkWithDepthRetry };

const CODE_SPEC_APPLICATION_ID = 'export.code-spec';
export const CODE_SPEC_OUTPUT_ROLE = 'code-spec-output';

// CLI calls are short-lived and cannot prove a revision, so they use the same
// Capture Interface with storage disabled. MCP supplies the long-lived,
// revision-aware Adapter for explicit-node requests.
const uncachedCapture = createDesignCaptureModule({ maxEntries: 0, maxBytes: 0 });

const instancePathHint = (nodeId) =>
  /^I/.test(String(nodeId))
    ? ' Instance-path ids (I…;…) often cannot be resolved — use the TOP-LEVEL instance id or the main component id instead.'
    : '';

function parseEval(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function frontierNodes(frames = []) {
  const found = new Map();
  const visit = (node) => {
    for (const child of node.frontier || []) {
      if (child?.id) found.set(child.id, { id: child.id, name: child.name || 'Unnamed layer' });
    }
    for (const child of node.kids || []) visit(child);
  };
  for (const frame of frames) visit(frame);
  return [...found.values()];
}

function frontierRetryHint(result) {
  const all = frontierNodes(result.frames);
  const nodes = all.slice(0, 20);
  if (!nodes.length) return '';
  const lines = nodes.map((node) =>
    `- ${node.name} [${node.id}] → figma_spec {"nodeId":${JSON.stringify(node.id)},"phase":"style","depth":0}`);
  const total = all.length;
  if (total > nodes.length) lines.push(`- …${total - nodes.length} more frontier node(s); request their parent structure map.`);
  return `\nExact follow-up calls for the omitted frontier:\n${lines.join('\n')}`;
}

function normalizedRequest(request = {}) {
  const phase = String(request.phase ?? 'all').toLowerCase();
  if (!CODE_SPEC_PHASES.includes(phase)) {
    throw new Error(`Unknown phase "${request.phase}" — use ${CODE_SPEC_PHASES.join(', ')}.`);
  }
  const format = String(request.format ?? DEFAULT_SPEC_FORMAT).toLowerCase();
  if (!CODE_SPEC_FORMATS.includes(format)) {
    throw new Error(`Unknown format "${request.format}" — use ${CODE_SPEC_FORMATS.join(', ')}.`);
  }
  const depth = Number.parseInt(request.depth ?? 12, 10);
  if (!Number.isInteger(depth) || depth < 0 || depth > 30) {
    throw new Error('depth must be an integer between 0 and 30.');
  }
  if (request.section != null && (typeof request.section !== 'string' || request.section.length === 0)) {
    throw new Error('section must be a non-empty string (a layer name from the structure map).');
  }
  return {
    nodeId: request.nodeId ? String(request.nodeId) : '',
    phase,
    format,
    depth,
    section: request.section || null,
    includeHidden: request.includeHidden === true,
    dedup: request.dedup !== false,
    outputPath: request.outputPath ? String(request.outputPath) : null,
  };
}

/**
 * Execute one code-spec request without CLI/MCP process concerns.
 * @param {object} request
 * @param {{evaluate?: (code: string) => Promise<any>, captureDesign?: Function, workspaceIO?: {write: Function}}} [adapters]
 * @returns {Promise<{stdout: string, stderr: string, nodeId: string, format: string, saved?: string}>}
 */
export async function executeCodeSpec(request, adapters = {}) {
  const { evaluate, captureDesign, workspaceIO } = adapters;
  if (typeof evaluate !== 'function') throw new TypeError('executeCodeSpec requires evaluate(code)');
  const input = normalizedRequest(request);
  if (input.outputPath && (!workspaceIO || typeof workspaceIO.write !== 'function')) {
    throw new TypeError('executeCodeSpec requires WorkspaceIO for persisted output.');
  }
  const diagnostics = [];
  let nodeId = input.nodeId;
  const cacheableExplicitNode = Boolean(nodeId) && !input.section;

  if (!nodeId) {
    const selection = parseEval(await evaluate(
      `(async () => JSON.stringify(figma.currentPage.selection.map(n => n.id)))()`,
    ));
    if (!Array.isArray(selection) || !selection.length) {
      throw new Error('No nodeId given and nothing selected in Figma. Pass a node id or select a frame.');
    }
    nodeId = selection[0];
  } else {
    const normalized = normalizeNodeId(nodeId);
    nodeId = normalized.id;
    if (normalized.warning) diagnostics.push(`⚠ ${normalized.warning}`);
  }

  if (input.section) {
    const section = parseEval(await evaluate(sectionFinderCode(nodeId, input.section)));
    if (section?.error) throw new Error(section.error);
    diagnostics.push(
      `section "${input.section}" → ${section.name} [${section.id}]` +
      (section.matches > 1
        ? ` (${section.matches} name matches — shallowest/exact one taken; pass a node id to target another)`
        : ''),
    );
    nodeId = section.id;
  }

  let capture;
  try {
    capture = cacheableExplicitNode && typeof captureDesign === 'function'
      ? await captureDesign({
          nodeId,
          depth: input.depth,
          includeHidden: input.includeHidden,
        })
      : await uncachedCapture.capture({
          nodeId,
          depth: input.depth,
          includeHidden: input.includeHidden,
        }, { evaluate });
  } catch (error) {
    if (/Design Capture returned no data/.test(error.message)) {
      throw new Error(
        `code-spec: the plugin returned no data for node ${nodeId}.` +
        instancePathHint(nodeId) +
        ' Otherwise retry, or reduce --depth.',
      );
    }
    throw error;
  }
  const result = capture.result;
  const depth = capture.completeness.actualDepth;
  if (input.phase !== 'structure' && capture.completeness.depthLimited) {
    throw new Error(
      `Exact style contract is incomplete at depth ${depth}. ` +
      'Use the exact depth 0 child calls below, or raise depth; styling from a truncated tree would require guessing.' +
      frontierRetryHint(result),
    );
  }
  const coverage = layerCoverage(result.frames, result.visibleNodeCount);
  if (input.phase !== 'structure' && !coverage.complete) {
    throw new Error(
      `Exact style contract is incomplete: ${coverage.unaccounted} visible Figma layer(s) are unaccounted. ` +
      'Use the ids from the structure map to request smaller child-node specs; never fill the gap by inference.',
    );
  }
  const componentStates = componentStateCoverage(result);
  if (input.phase !== 'structure' && !componentStates.complete) {
    const missing = componentStates.sets.filter((set) => set.status === 'notCaptured');
    const labels = missing.map((set) => `${set.name || 'Unnamed set'} [${set.id}]`).join(', ');
    const nodeIds = missing.map((set) => set.id).filter(Boolean).slice(0, 8);
    const recipe = JSON.stringify({ nodeIds, phase: 'all', depth: 2 });
    throw new Error(
      `Component state contract is incomplete for: ${labels}. ` +
      `Capture the available set ids in one Manual Mode approval: figma_spec ${recipe}`,
    );
  }
  if (depth < input.depth) {
    diagnostics.push(`⚠ payload limit — reduced depth to ${depth}; nested content may be truncated`);
  }

  let stdout;
  if (input.format === 'tree') {
    stdout = formatCodeSpec(result, { phase: input.phase, dedup: input.dedup });
  } else {
    const model = specModel(result, {
      phase: input.phase,
      dedup: input.dedup,
      capture: {
        requestedDepth: input.depth,
        actualDepth: depth,
        includeHidden: input.includeHidden,
        payloadComplete: capture.completeness.payloadComplete,
        depthLimited: capture.completeness.depthLimited,
      },
    });
    stdout = serializeSpecModel(model, input.format);
  }

  if (input.outputPath) {
    // Large screens exceed any inline result budget. The complete projection
    // lands in the workspace; stdout carries only verifiable summary facts.
    const text = stdout.endsWith('\n') ? stdout : `${stdout}\n`;
    await workspaceIO.write(input.outputPath, text, {
      role: CODE_SPEC_OUTPUT_ROLE,
      createParents: true,
    });
    const completeness = capture.completeness;
    const stitched = Number(completeness.stitchedCaptures) || 0;
    stdout = [
      `✓ Code Spec written to ${input.outputPath}`,
      `node: ${result.name || nodeId} [${nodeId}] · phase ${input.phase} · depth ${depth}/${input.depth} · format ${input.format}`,
      `layers: ${Number.isFinite(result.visibleNodeCount) ? result.visibleNodeCount : 'unknown'} visible, ${coverage.unaccounted} unaccounted · plugin evals: ${1 + stitched}`
        + (stitched ? ` (${completeness.budgetCuts} budget cut(s) completed under one observed revision)` : ''),
      `bytes: ${Buffer.byteLength(text, 'utf8')}`,
    ].join('\n');
  }

  return {
    stdout,
    stderr: diagnostics.join('\n'),
    nodeId,
    format: input.format,
    ...(input.outputPath ? { saved: input.outputPath } : {}),
  };
}

export function codeSpecPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Code Spec routing requires a Command Plan created by the Capability Catalog.');
  }
  return plan.allowed && plan.id === CODE_SPEC_APPLICATION_ID
    ? 'command-application'
    : 'not-code-spec';
}

export async function executeCodeSpecPlan(plan, adapters = {}) {
  if (codeSpecPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Code Spec Command Application.`);
  }
  const request = parseCodeSpecRequest(plan.argv);
  const outputs = (plan.outputs || []).filter((output) => output.role === CODE_SPEC_OUTPUT_ROLE);
  if (request.outputPath) {
    if ((plan.outputs || []).length !== 1 || outputs.length !== 1 || outputs[0].path !== request.outputPath) {
      throw new Error('Code Spec output path is not owned by the Command Plan.');
    }
  } else if ((plan.outputs || []).length !== 0) {
    throw new Error('Inline Code Spec must not declare Workspace outputs.');
  }
  return executeCodeSpec(request, adapters);
}
