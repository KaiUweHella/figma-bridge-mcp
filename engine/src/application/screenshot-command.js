// Value-returning verification screenshot Command Application.
//
// Figma capture is behind evaluate(); filesystem persistence is behind save().
// CLI and MCP therefore share validation, scale limits, measurement and error
// semantics without sharing console/process behaviour.
import { normalizeNodeId } from '../lib/node-id.js';

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
    maxDimension: Math.round(finiteNumber(request.maxDimension, 2000, { min: 0, max: 8000 })),
    measure: request.measure === true,
    savePath: request.savePath ? String(request.savePath) : null,
    saveDefault: request.saveDefault === true,
    includeBase64: request.includeBase64 === true,
  };
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
      width: Math.round(nodeWidth * finalScale), height: Math.round(nodeHeight * finalScale),
      scale: Math.round(finalScale * 1000) / 1000,
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
  if (!result || typeof result.base64 !== 'string' || !result.id) {
    throw new Error('screenshot returned no image data');
  }
  /** @type {Record<string, any>} */
  const metadata = {
    name: result.name, id: result.id, width: result.width, height: result.height, scale: result.scale,
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
    await save(savePath, Buffer.from(result.base64, 'base64'));
    metadata.saved = savePath;
  }
  if (input.includeBase64) metadata.base64 = result.base64;
  return { stdout: JSON.stringify(metadata), stderr: input.warning ? `⚠ ${input.warning}` : '', result: metadata };
}
