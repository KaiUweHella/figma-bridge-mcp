// Value-returning design-to-code command application Module.
//
// The Interface is deliberately small: a request plus one evaluate adapter in,
// stdout/stderr values out. Commander, MCP, console and process.exit stay
// outside this seam. That gives CLI and MCP the same behaviour and makes the
// command directly testable without booting a process.
import { sectionFinderCode } from '../design-extract.js';
import { formatCodeSpec, specModel } from '../lib/code-spec.js';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  createDesignCaptureModule,
  walkWithDepthRetry,
} from './design-capture.js';
import {
  DEFAULT_SPEC_FORMAT,
  serializeSpecModel,
  STRUCTURED_SPEC_FORMATS,
} from '../lib/spec-format.js';

export const CODE_SPEC_PHASES = ['structure', 'style', 'all'];
export const CODE_SPEC_FORMATS = ['tree', ...STRUCTURED_SPEC_FORMATS];
export { walkWithDepthRetry };

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
  if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
    throw new Error('depth must be an integer between 1 and 30.');
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
  };
}

/**
 * Execute one code-spec request without CLI/MCP process concerns.
 * @param {object} request
 * @param {{evaluate?: (code: string) => Promise<any>, captureDesign?: Function}} [adapters]
 * @returns {Promise<{stdout: string, stderr: string, nodeId: string, format: string}>}
 */
export async function executeCodeSpec(request, adapters = {}) {
  const { evaluate, captureDesign } = adapters;
  if (typeof evaluate !== 'function') throw new TypeError('executeCodeSpec requires evaluate(code)');
  const input = normalizedRequest(request);
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

  return {
    stdout,
    stderr: diagnostics.join('\n'),
    nodeId,
    format: input.format,
  };
}
