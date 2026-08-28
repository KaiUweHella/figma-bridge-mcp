// Value-returning verification screenshot Command Application.
//
// Figma capture is behind evaluate(); filesystem persistence is behind save().
// CLI and MCP therefore share validation, scale limits, measurement and error
// semantics without sharing console/process behaviour.
import { normalizeNodeId } from '../lib/node-id.js';
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  createVerificationArtifactWriter,
  decodeVerificationPngBase64,
  VERIFICATION_ARTIFACT_ROLE,
} from './verification-artifact.js';
import {
  parseScreenshotRequest,
  screenshotArgvFromRequest,
  screenshotPlanningArgvFromRequest,
} from './screenshot-request.js';
import {
  parseLegacyRasterExportRequest,
  screenshotRequestFromLegacyRasterExport,
} from './legacy-raster-export-request.js';

export {
  screenshotArgvFromRequest,
  screenshotPlanningArgvFromRequest,
} from './screenshot-request.js';

const SCREENSHOT_APPLICATION_ID = 'verify';
const SCREENSHOT_COMPATIBILITY_IDS = new Set(['export.node', 'export.screenshot']);

function finiteNumber(value, fallback, { min, max }) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= min || number > max) {
    throw new Error(`value must be greater than ${min} and at most ${max}`);
  }
  return number;
}

function normalizedRequest(request = {}) {
  const normalized = request.nodeId ? normalizeNodeId(String(request.nodeId)) : { id: '', warning: '' };
  return {
    nodeId: normalized.id,
    warning: normalized.warning || '',
    scale: finiteNumber(request.scale, 0.5, { min: 0, max: 4 }),
    maxDimension: Math.max(1, Math.round(finiteNumber(request.maxDimension, 2000, { min: 0, max: 8000 }))),
    measure: request.measure === true,
    savePath: request.savePath ? String(request.savePath) : null,
    saveDefault: request.saveDefault === true,
    includeBase64: request.includeBase64 === true,
  };
}

function projectedNodePixels(nodeWidth, nodeHeight, appliedScale) {
  return Object.freeze({
    width: Math.max(1, Math.round(nodeWidth * appliedScale)),
    height: Math.max(1, Math.round(nodeHeight * appliedScale)),
  });
}

function degenerateExportError(image, result) {
  const projected = projectedNodePixels(
    result.nodeWidth,
    result.nodeHeight,
    result.appliedScale,
  );
  const collapsedWidth = image.width <= 1 && projected.width > 1;
  const collapsedHeight = image.height <= 1 && projected.height > 1;
  if (!collapsedWidth && !collapsedHeight) return null;
  return new Error(
    `Figma returned a degenerate ${image.width}×${image.height} PNG for node geometry `
    + `${result.nodeWidth}×${result.nodeHeight} at scale ${result.appliedScale} `
    + `(scaled geometry ${projected.width}×${projected.height}). `
    + 'The screenshot was not accepted or saved. Refresh the current component/Variant identity with '
    + 'figma_run ["component","list"], retry the exact current Variant id, or capture its parent Component Set.',
  );
}

export function screenshotCode({ nodeId, scale, maxDimension, measure }) {
  return `(async () => {
    let node;
    ${nodeId
      ? `node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});`
      : `const sel = figma.currentPage.selection; node = sel.length > 0 ? sel[0] : null;`}
    if (!node) return { error: ${nodeId
      ? `'Node not found: ' + ${JSON.stringify(nodeId)} + ' in the currently open file "' + figma.root.name + '". Safe Mode can only access the file open in Figma Desktop — if this id comes from another file, open or target that file first.'`
      : `'Nothing selected in Figma — select a frame or pass a node id.'`} };
    if (node.type === 'PAGE' || node.type === 'DOCUMENT') {
      if (node.type === 'PAGE') await node.loadAsync();
      const kids = (node.children || [])
        .filter(n => n.type === 'SECTION' || n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')
        .slice(0, 12).map(n => '  ' + n.type + '  ' + n.id + '  "' + n.name + '"');
      return { error: 'Cannot screenshot a whole ' + node.type + ' — pass a frame or section id instead.'
        + (kids.length ? ' Top-level candidates:\\n' + kids.join('\\n') : '') };
    }
    if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
    const nodeWidth = node.width || 100, nodeHeight = node.height || 100;
    let finalScale = ${scale};
    const maxNodeDim = Math.max(nodeWidth, nodeHeight);
    if (maxNodeDim * finalScale > ${maxDimension}) finalScale = ${maxDimension} / maxNodeDim;
    if (maxNodeDim * finalScale > 7500) finalScale = 7500 / maxNodeDim;
    const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: finalScale } });
    let measurement = null;
    if (${measure}) {
      const walk = (n, depth) => {
        const m = { name: n.name, type: n.type, w: Math.round(n.width), h: Math.round(n.height),
          layout: n.layoutMode && n.layoutMode !== 'NONE' ? n.layoutMode : undefined,
          sizeH: n.layoutSizingHorizontal, sizeV: n.layoutSizingVertical };
        if (depth > 0 && 'children' in n && n.children.length) m.children = n.children.slice(0, 24).map(c => walk(c, depth - 1));
        return m;
      };
      measurement = walk(node, 3);
    }
    return { name: node.name, id: node.id,
      nodeWidth, nodeHeight, appliedScale: finalScale,
      base64: figma.base64Encode(bytes), measure: measurement };
  })()`;
}

/**
 * @param {object} request
 * @param {{evaluate?: (code:string) => Promise<any>, save?: (path:string, bytes:Buffer) => unknown|Promise<unknown>, defaultSavePath?: (result:any) => string}} [adapters]
 */
export async function executeScreenshot(request, adapters = {}) {
  const { evaluate, save, defaultSavePath } = adapters;
  if (typeof evaluate !== 'function') throw new TypeError('executeScreenshot requires evaluate(code)');
  const input = normalizedRequest(request);
  const result = await evaluate(screenshotCode(input));
  if (result?.error) throw new Error(result.error);
  if (!result || typeof result.base64 !== 'string' || !result.base64 || !result.id) {
    throw new Error('screenshot returned no image data');
  }
  let image;
  try { image = decodeVerificationPngBase64(result.base64); }
  catch { throw new Error('screenshot returned invalid bounded PNG data'); }
  if (!Number.isFinite(result.nodeWidth) || result.nodeWidth < 0 || result.nodeWidth > 10_000_000
    || !Number.isFinite(result.nodeHeight) || result.nodeHeight < 0 || result.nodeHeight > 10_000_000
    || !Number.isFinite(result.appliedScale) || result.appliedScale <= 0 || result.appliedScale > 4) {
    throw new Error('screenshot returned invalid bounded geometry evidence');
  }
  const degenerate = degenerateExportError(image, result);
  if (degenerate) throw degenerate;
  /** @type {Record<string, any>} */
  const metadata = {
    name: result.name, id: result.id,
    width: image.width, height: image.height,
    pixelWidth: image.width, pixelHeight: image.height,
    nodeWidth: result.nodeWidth, nodeHeight: result.nodeHeight,
    requestedScale: input.scale, appliedScale: result.appliedScale,
    scale: result.appliedScale,
    ...(result.measure ? { measure: result.measure } : {}),
  };
  const savePath = input.savePath || (input.saveDefault
    ? (typeof defaultSavePath === 'function' ? defaultSavePath(result) : null)
    : null);
  if (input.saveDefault && !savePath) {
    throw new TypeError('executeScreenshot requires defaultSavePath(result) for default persistence');
  }
  if (savePath) {
    if (typeof save !== 'function') throw new TypeError('executeScreenshot requires save(path, bytes) when savePath is set');
    await save(savePath, image.bytes);
    metadata.saved = savePath;
  }
  if (input.includeBase64) metadata.base64 = result.base64;
  return { stdout: JSON.stringify(metadata), stderr: input.warning ? `⚠ ${input.warning}` : '', result: metadata };
}

export function screenshotPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Screenshot routing requires a Command Plan created by the Capability Catalog.');
  }
  if (!plan.allowed) return 'not-screenshot';
  if (plan.id === SCREENSHOT_APPLICATION_ID) return 'command-application';
  if (!SCREENSHOT_COMPATIBILITY_IDS.has(plan.id)) return 'not-screenshot';
  return parseLegacyRasterExportRequest(plan.argv).format === 'PNG'
    ? 'command-application'
    : 'not-screenshot';
}

function formatCompatibilityResult(action, metadata) {
  const dimensions = `${metadata.pixelWidth}x${metadata.pixelHeight}`;
  return action === 'node'
    ? `✓ Exported ${metadata.name} (${dimensions}) to ${metadata.saved}`
    : `✓ Screenshot: ${metadata.name} (${dimensions}) → ${metadata.saved}`;
}

export async function executeScreenshotPlan(plan, adapters = {}) {
  if (screenshotPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Screenshot Command Application.`);
  }
  const compatibility = SCREENSHOT_COMPATIBILITY_IDS.has(plan.id)
    ? parseLegacyRasterExportRequest(plan.argv)
    : null;
  const request = compatibility
    ? screenshotRequestFromLegacyRasterExport(compatibility)
    : parseScreenshotRequest(plan.argv);
  const outputs = plan.outputs.filter((output) => output.role === VERIFICATION_ARTIFACT_ROLE);
  if (request.persistence === 'inline') {
    if (outputs.length) throw new Error('Inline screenshot Command Plan must not declare file artifacts.');
    return executeScreenshot(request, { evaluate: adapters.evaluate });
  }
  if (outputs.length !== 1) {
    throw new Error('Persisted screenshot Command Plan must declare exactly one verification artifact.');
  }
  const writer = createVerificationArtifactWriter(outputs, { workspaceIO: adapters.workspaceIO });
  const result = await executeScreenshot({
    ...request,
    savePath: outputs[0].path,
    saveDefault: false,
    includeBase64: false,
  }, {
    evaluate: adapters.evaluate,
    save: (_path, bytes) => writer.write(0, bytes),
  });
  return compatibility
    ? { ...result, stdout: formatCompatibilityResult(compatibility.action, result.result) }
    : result;
}
