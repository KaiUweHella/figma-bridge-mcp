// Format-appropriate export for the documented `export node` and
// `export screenshot` compatibility names.
//
// PNG remains verification evidence owned by the Screenshot Command
// Application. JPG, SVG and PDF use this Plan-bound Application so Plugin
// capture, bounded transport validation and Workspace publication cannot
// diverge between Commander and MCP.
import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import { MAX_PLUGIN_MESSAGE_BYTES } from '../lib/protocol-contract.js';
import { rasterDimensions, rasterKind } from '../lib/raster-dimensions.js';
import {
  legacyRasterExportArgvFromRequest,
  parseLegacyRasterExportRequest,
} from './legacy-raster-export-request.js';

export const IMAGE_EXPORT_OUTPUT_ROLE = 'export-image-output';
// Preserve room for the signed result envelope and bounded metadata inside the
// authenticated 5 MiB Plugin message. The legacy path could not carry more.
export const MAX_IMAGE_EXPORT_BASE64_CODE_UNITS = MAX_PLUGIN_MESSAGE_BYTES - (64 * 1024);
export const MAX_IMAGE_EXPORT_BYTES = Math.floor(MAX_IMAGE_EXPORT_BASE64_CODE_UNITS / 4) * 3;
const IMAGE_EXPORT_APPLICATION_IDS = new Set(['export.node', 'export.screenshot']);
const IMAGE_EXPORT_FORMATS = new Set(['JPG', 'SVG', 'PDF']);
const MAX_NAME_CODE_UNITS = 1024;
const MAX_NODE_ID_CODE_UNITS = 512;
const MAX_GEOMETRY = 10_000_000;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function normalizedRequest(request) {
  const input = parseLegacyRasterExportRequest(legacyRasterExportArgvFromRequest(request));
  if (!IMAGE_EXPORT_FORMATS.has(input.format)) {
    throw new Error('Image Export supports JPG, SVG, or PDF; PNG belongs to the Screenshot Command Application.');
  }
  return input;
}

function boundedGeometry(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_GEOMETRY;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || !value
    || value.length > MAX_IMAGE_EXPORT_BASE64_CODE_UNITS
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Image Export returned invalid bounded Base64 data.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_EXPORT_BYTES
    || bytes.toString('base64') !== value) {
    throw new Error('Image Export returned non-canonical or oversized Base64 data.');
  }
  return bytes;
}

function inspectSvg(bytes) {
  let markup;
  try { markup = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Image Export returned invalid UTF-8 SVG data.'); }
  const document = markup.replace(/^\uFEFF/, '').trim();
  if (!/^(?:<\?xml\s[^?]*\?>\s*)?<svg(?:\s|>)/i.test(document)
    || !/<\/svg>\s*$/i.test(document)) {
    throw new Error('Image Export returned data without a complete SVG root.');
  }
  return Object.freeze({ kind: 'svg' });
}

function inspectPdf(bytes) {
  if (bytes.length < 12 || !bytes.subarray(0, 8).toString('ascii').match(/^%PDF-1\.[0-9]$/)) {
    throw new Error('Image Export returned data without a PDF header.');
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString('latin1');
  if (!/%%EOF\s*$/.test(tail)) {
    throw new Error('Image Export returned data without a bounded PDF terminator.');
  }
  return Object.freeze({ kind: 'pdf' });
}

function inspectExport(bytes, format) {
  if (format === 'JPG') {
    if (rasterKind(bytes) !== 'jpeg') {
      throw new Error('Image Export returned data without a JPEG signature.');
    }
    const dimensions = rasterDimensions(bytes, 'jpeg');
    return Object.freeze({ kind: 'jpeg', pixelWidth: dimensions.width, pixelHeight: dimensions.height });
  }
  if (format === 'SVG') return inspectSvg(bytes);
  return inspectPdf(bytes);
}

function validatedResult(value, request) {
  if (exact(value, ['error'])) {
    if (typeof value.error !== 'string' || !value.error || value.error.length > 4096) {
      throw new Error('Image Export returned an invalid bounded Figma error.');
    }
    if (UNSAFE_TEXT.test(value.error)) {
      throw new Error('Image Export returned an unsafe Figma error.');
    }
    throw new Error(value.error);
  }
  const keys = [
    'name', 'id', 'nodeWidth', 'nodeHeight',
    'projectedWidth', 'projectedHeight', 'base64',
  ];
  if (!exact(value, keys)
    || typeof value.name !== 'string' || value.name.length > MAX_NAME_CODE_UNITS
    || UNSAFE_TEXT.test(value.name)
    || typeof value.id !== 'string' || !value.id || value.id.length > MAX_NODE_ID_CODE_UNITS
    || !NODE_ID_PATTERN.test(value.id)
    || (request.action === 'node' && value.id !== request.nodeId)
    || !boundedGeometry(value.nodeWidth) || !boundedGeometry(value.nodeHeight)
    || !Number.isSafeInteger(value.projectedWidth) || value.projectedWidth < 1
    || value.projectedWidth > MAX_GEOMETRY
    || !Number.isSafeInteger(value.projectedHeight) || value.projectedHeight < 1
    || value.projectedHeight > MAX_GEOMETRY
    || value.projectedWidth !== Math.max(1, Math.round(value.nodeWidth * request.scale))
    || value.projectedHeight !== Math.max(1, Math.round(value.nodeHeight * request.scale))) {
    throw new Error('Image Export returned invalid bounded node evidence.');
  }
  const bytes = decodeCanonicalBase64(value.base64);
  return Object.freeze({
    name: value.name,
    id: value.id,
    format: request.format,
    bytes,
    byteLength: bytes.length,
    nodeWidth: value.nodeWidth,
    nodeHeight: value.nodeHeight,
    projectedWidth: value.projectedWidth,
    projectedHeight: value.projectedHeight,
    ...inspectExport(bytes, request.format),
  });
}

export function imageExportCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const clean = (value, max) => typeof value === 'string'
      ? value.slice(0, max).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    let node;
    ${input.action === 'node'
      ? `node = await figma.getNodeByIdAsync(${JSON.stringify(input.nodeId)});`
      : 'const selection = figma.currentPage.selection; node = selection.length > 0 ? selection[0] : figma.currentPage;'}
    if (!node) return { error: ${input.action === 'node'
      ? `'Node not found: ' + ${JSON.stringify(input.nodeId)} + ' in the currently open file "' + clean(figma.root.name, ${MAX_NAME_CODE_UNITS}) + '" — Safe Mode only reaches the file open in Figma Desktop.'`
      : "'No page or selection'"} };
    if (!('exportAsync' in node)) return { error: 'Node cannot be exported' };
    const nodeWidth = Number(node.width);
    const nodeHeight = Number(node.height);
    if (!Number.isFinite(nodeWidth) || nodeWidth < 0 || nodeWidth > ${MAX_GEOMETRY}
      || !Number.isFinite(nodeHeight) || nodeHeight < 0 || nodeHeight > ${MAX_GEOMETRY}) {
      return { error: 'Node has invalid export geometry' };
    }
    const bytes = await node.exportAsync({
      format: ${JSON.stringify(input.format)},
      constraint: { type: 'SCALE', value: ${input.scale} }
    });
    if (!bytes || !Number.isSafeInteger(bytes.length) || bytes.length < 1
      || bytes.length > ${MAX_IMAGE_EXPORT_BYTES}) {
      return { error: 'Image export exceeds the bounded Plugin transport.' };
    }
    const base64 = figma.base64Encode(bytes);
    if (base64.length > ${MAX_IMAGE_EXPORT_BASE64_CODE_UNITS}) {
      return { error: 'Image export exceeds the bounded Plugin transport.' };
    }
    return {
      name: clean(node.name, ${MAX_NAME_CODE_UNITS}),
      id: clean(node.id, ${MAX_NODE_ID_CODE_UNITS}),
      nodeWidth,
      nodeHeight,
      projectedWidth: Math.max(1, Math.round(nodeWidth * ${input.scale})),
      projectedHeight: Math.max(1, Math.round(nodeHeight * ${input.scale})),
      base64
    };
  })()`;
}

function formatCompatibilityResult(request, result) {
  const dimensions = request.action === 'node'
    ? `${result.nodeWidth}x${result.nodeHeight}`
    : `${result.projectedWidth}x${result.projectedHeight}`;
  return request.action === 'node'
    ? `✓ Exported ${result.name} (${dimensions}) to ${result.saved}`
    : `✓ Screenshot: ${result.name} (${dimensions}) → ${result.saved}`;
}

export function imageExportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError('Image Export routing requires a Command Plan created by the Capability Catalog.');
  }
  if (!plan.allowed || !IMAGE_EXPORT_APPLICATION_IDS.has(plan.id)) return 'not-image-export';
  return IMAGE_EXPORT_FORMATS.has(parseLegacyRasterExportRequest(plan.argv).format)
    ? 'command-application'
    : 'not-image-export';
}

export async function executeImageExportPlan(plan, adapters = {}) {
  if (imageExportPlanRoute(plan) !== 'command-application') {
    throw new Error(`Command Plan ${plan?.id || '(unknown)'} is not owned by the Image Export Command Application.`);
  }
  if (typeof adapters.evaluate !== 'function') {
    throw new TypeError('executeImageExportPlan requires evaluate(code).');
  }
  if (!adapters.workspaceIO || typeof adapters.workspaceIO.write !== 'function') {
    throw new TypeError('executeImageExportPlan requires WorkspaceIO.');
  }
  const request = parseLegacyRasterExportRequest(plan.argv);
  const outputs = plan.outputs.filter((output) => output.role === IMAGE_EXPORT_OUTPUT_ROLE);
  if (plan.outputs.length !== 1 || outputs.length !== 1 || outputs[0].path !== request.outputPath) {
    throw new Error('Image Export output path is not owned by the Command Plan.');
  }
  const result = validatedResult(await adapters.evaluate(imageExportCode(request)), request);
  await adapters.workspaceIO.write(outputs[0].path, result.bytes, {
    role: IMAGE_EXPORT_OUTPUT_ROLE,
    createParents: true,
  });
  const metadata = Object.freeze({
    name: result.name,
    id: result.id,
    format: result.format,
    byteLength: result.byteLength,
    nodeWidth: result.nodeWidth,
    nodeHeight: result.nodeHeight,
    projectedWidth: result.projectedWidth,
    projectedHeight: result.projectedHeight,
    ...(result.kind === 'jpeg'
      ? { pixelWidth: result.pixelWidth, pixelHeight: result.pixelHeight }
      : {}),
    saved: outputs[0].path,
  });
  return {
    stdout: formatCompatibilityResult(request, metadata),
    stderr: '',
    result: metadata,
  };
}
