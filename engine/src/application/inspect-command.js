// Value-returning node inspection Command Application.
//
// Commander and MCP are adapters at this seam. Geometry, positioning,
// component identity, typography and visual style are captured once here.
import { normalizeNodeId } from '../lib/node-id.js';
import { componentContextExpr } from '../lib/eval-snippets.js';
import { paintsSnippetJs } from '../lib/paint-css.js';
import { toYaml } from '../lib/yaml.js';

export const INSPECT_FORMATS = ['text', 'spec', 'yaml', 'json'];

function normalizedRequest(request = {}) {
  if (typeof request.nodeId !== 'string' || !request.nodeId.trim()) {
    throw new TypeError('inspect requires a non-empty nodeId');
  }
  const normalized = normalizeNodeId(request.nodeId);
  const format = String(request.format || 'text').toLowerCase();
  if (!INSPECT_FORMATS.includes(format)) {
    throw new Error(`Unknown inspect format "${request.format}" — use ${INSPECT_FORMATS.join(', ')}.`);
  }
  return { nodeId: normalized.id, warning: normalized.warning || '', format };
}

export function inspectNodeCode(nodeId) {
  return `(async () => {
    const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!n) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)} + ' in the currently open file "' + figma.root.name + '" — Safe Mode only reaches the file open in Figma Desktop.');
    const p = n.parent;
    const out = {
      id: n.id, name: n.name, type: n.type,
      width: 'width' in n ? n.width : null,
      height: 'height' in n ? n.height : null,
    };
    if (n.layoutPositioning === 'ABSOLUTE' && p && 'width' in p) {
      const c = n.constraints || { horizontal: 'MIN', vertical: 'MIN' };
      const pw = p.width, ph = p.height;
      const pos = {
        position: 'ABSOLUTE', start: null, end: null, top: null, bottom: null,
        centerHorizontalOffset: null, centerVerticalOffset: null,
        width: n.width, height: n.height,
        layoutSizingHorizontal: null, layoutSizingVertical: null,
      };
      const pct = (v) => {
        const p2 = Math.round(v * 10000) / 100;
        return (p2 % 1 === 0 ? p2.toFixed(0) : (p2 % 0.1 === 0 ? p2.toFixed(1) : p2.toFixed(2))) + '%';
      };
      switch (c.horizontal) {
        case 'MIN': pos.start = n.x; break;
        case 'MAX': pos.end = pw - n.x - n.width; break;
        case 'CENTER': pos.centerHorizontalOffset = n.x + n.width / 2 - pw / 2; break;
        case 'STRETCH': pos.start = n.x; pos.end = pw - n.x - n.width; pos.width = null; break;
        case 'SCALE': pos.start = pct(n.x / pw); pos.end = pct((pw - n.x - n.width) / pw); pos.width = null; break;
      }
      switch (c.vertical) {
        case 'MIN': pos.top = n.y; break;
        case 'MAX': pos.bottom = ph - n.y - n.height; break;
        case 'CENTER': pos.centerVerticalOffset = n.y + n.height / 2 - ph / 2; break;
        case 'STRETCH': pos.top = n.y; pos.bottom = ph - n.y - n.height; pos.height = null; break;
        case 'SCALE': pos.top = pct(n.y / ph); pos.bottom = pct((ph - n.y - n.height) / ph); pos.height = null; break;
      }
      out.absolutePositioning = pos;
    } else if (n.layoutPositioning === 'AUTO' || (p && p.layoutMode !== 'NONE')) {
      out.absolutePositioning = {
        position: 'AUTO', start: null, end: null, top: null, bottom: null,
        centerHorizontalOffset: null, centerVerticalOffset: null,
        width: null, height: null,
        layoutSizingHorizontal: n.layoutSizingHorizontal == null ? null : n.layoutSizingHorizontal,
        layoutSizingVertical: n.layoutSizingVertical == null ? null : n.layoutSizingVertical,
      };
    }
    const __ctx = ${componentContextExpr('n')};
    if (__ctx && __ctx.role) out.component = __ctx;
    if (n.type === 'TEXT') {
      const styleId = n.textStyleId && n.textStyleId !== figma.mixed ? n.textStyleId : null;
      let styleName = null;
      if (styleId) {
        try { const st = await figma.getStyleByIdAsync(styleId); styleName = st ? st.name : null; } catch (e) {}
      }
      out.text = {
        characters: n.characters.length > 60 ? n.characters.slice(0, 60) + '…' : n.characters,
        fontSize: n.fontSize === figma.mixed ? 'mixed' : n.fontSize,
        fontName: n.fontName === figma.mixed ? 'mixed' : n.fontName,
        textStyle: styleName,
      };
    }
    ${paintsSnippetJs}
    const __w = 'width' in n ? n.width : 0, __h = 'height' in n ? n.height : 0;
    const style = {};
    try { const f = paints(n.fills, __w, __h); if (f) style.fills = f; } catch (e) {}
    try {
      if (typeof n.fillStyleId === 'string' && n.fillStyleId) {
        const fst = await figma.getStyleByIdAsync(n.fillStyleId); if (fst) style.fillStyle = fst.name;
      }
    } catch (e) {}
    try {
      const s = paints(n.strokes, __w, __h);
      if (s) { style.strokes = s; if (typeof n.strokeWeight === 'number') style.strokeWeight = n.strokeWeight; }
    } catch (e) {}
    if ('cornerRadius' in n) {
      if (typeof n.cornerRadius === 'number') { if (n.cornerRadius > 0) style.cornerRadius = n.cornerRadius; }
      else style.cornerRadius = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
    }
    if (typeof n.opacity === 'number' && n.opacity < 1) style.opacity = n.opacity;
    if ('clipsContent' in n) style.clipsContent = n.clipsContent === true;
    if (typeof n.rotation === 'number' && Math.abs(n.rotation) >= 0.5) style.rotation = Math.round(n.rotation * 10) / 10;
    if (Array.isArray(n.effects) && n.effects.length) {
      style.effects = n.effects.filter(e => e.visible !== false).map(e =>
        (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
          ? { type: e.type, x: e.offset.x, y: e.offset.y, blur: e.radius, spread: e.spread || 0, color: hex(e.color), alpha: e.color.a == null ? 1 : Math.round(e.color.a * 100) / 100 }
          : { type: e.type, blur: e.radius });
    }
    if (Object.keys(style).length) out.style = style;
    if ('x' in n) out.raw = { x: n.x, y: n.y, constraints: n.constraints };
    return out;
  })()`;
}

export function formatInspection(result, format = 'text') {
  if (format === 'yaml') return toYaml(result);
  if (format === 'json') return JSON.stringify(result, null, 2);
  if (format === 'spec') return JSON.stringify(result.absolutePositioning ?? null, null, 2);
  const lines = [`${result.name || '(unnamed)'} (${result.id}) — ${result.type}`, `  size: ${result.width}×${result.height}`];
  if (result.absolutePositioning) {
    lines.push('  Absolute Positioning spec:');
    for (const [key, value] of Object.entries(result.absolutePositioning)) {
      if (value !== null) lines.push(`    ${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`);
    }
  }
  if (result.style) {
    lines.push('  Style:');
    for (const [key, value] of Object.entries(result.style)) lines.push(`    ${key}: ${JSON.stringify(value)}`);
  }
  if (result.raw) lines.push(`  raw: x=${result.raw.x}, y=${result.raw.y}, constraints=${JSON.stringify(result.raw.constraints)}`);
  return lines.join('\n');
}

/** @param {object} request @param {{evaluate?: (code:string) => Promise<any>}} [adapters] */
export async function executeInspect(request, adapters = {}) {
  const { evaluate } = adapters;
  if (typeof evaluate !== 'function') throw new TypeError('executeInspect requires evaluate(code)');
  const input = normalizedRequest(request);
  const value = await evaluate(inspectNodeCode(input.nodeId));
  if (!value || typeof value !== 'object') throw new Error(`inspect returned no data for node ${input.nodeId}`);
  return {
    stdout: formatInspection(value, input.format),
    stderr: input.warning ? `⚠ ${input.warning}` : '',
    result: value,
  };
}
