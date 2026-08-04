// Commands: canvas-ops (extracted from index.js)
import chalk from 'chalk';
import { toYaml } from '../lib/yaml.js';
import { normalizeNodeId } from '../lib/node-id.js';
import { pageLookupCode } from '../lib/eval-snippets.js';
import {
  program,
  buildNodeSelector,
  checkConnection,
  componentContextExpr,
  daemonExec,
  evalPrint,
  handleEvalError
} from '../lib/cli-core.js';
import { paintsSnippetJs } from '../lib/paint-css.js';

// ============ CANVAS ============

const canvas = program
  .command('canvas')
  .description('Canvas awareness and smart positioning');

canvas
  .command('info')
  .description('Show canvas info (bounds, element count, free space)')
  .action(async () => {
    await checkConnection();
    let code = `(async function() {
// Dynamic page loading: right after a page switch, children is incomplete
// until the page is loaded — measuring then reports bounds that are far too
// small and smart positioning drops new renders onto existing content.
await figma.currentPage.loadAsync();
const children = figma.currentPage.children;
if (children.length === 0) {
  return JSON.stringify({ empty: true, message: 'Canvas is empty', nextX: 0, nextY: 0 });
} else {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  children.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });
  return JSON.stringify({
    elements: children.length,
    bounds: { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) },
    nextX: Math.round(maxX + 100),
    nextY: 0,
    frames: children.filter(n => n.type === 'FRAME').length,
    components: children.filter(n => n.type === 'COMPONENT').length
  }, null, 2);
}
})()`;
    evalPrint(code);
  });

canvas
  .command('pages')
  .description('List all pages in the file (current page marked)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();
    const code = `(async () => {
      // Page names/ids are available without loading page contents.
      return figma.root.children.map(p => ({
        id: p.id,
        name: p.name,
        current: p.id === figma.currentPage.id,
      }));
    })()`;
    try {
      const pages = await daemonExec('eval', { code });
      if (options.json) {
        console.log(JSON.stringify(pages, null, 2));
        return;
      }
      pages.forEach(p => {
        const marker = p.current ? chalk.green('→ ') : '  ';
        console.log(`${marker}${p.name} ${chalk.gray('(' + p.id + ')')}`);
      });
    } catch (e) {
      handleEvalError(e);
    }
  });

canvas
  .command('page-create <name>')
  .description('Create a new page and switch to it')
  .option('--no-switch', 'Create the page without switching to it')
  .action(async (name, options) => {
    await checkConnection();
    const code = `(async () => {
      const existing = figma.root.children.find(p => p.name === ${JSON.stringify(name)});
      if (existing) throw new Error('Page already exists: ' + ${JSON.stringify(name)} + ' (' + existing.id + ')');
      const page = figma.createPage();
      page.name = ${JSON.stringify(name)};
      ${options.switch === false ? '' : 'await figma.setCurrentPageAsync(page);'}
      return { id: page.id, name: page.name, switched: ${options.switch !== false} };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓') + ` Created page: ${r.name} ${chalk.gray('(' + r.id + ')')}${r.switched ? ' — now current' : ''}`);
    } catch (e) {
      handleEvalError(e);
    }
  });

canvas
  .command('page <nameOrId>')
  .description('Switch the current page (by exact id, exact name, or unique substring)')
  .action(async (nameOrId) => {
    await checkConnection();
    const code = `(async () => {
      ${pageLookupCode(nameOrId)}
      await figma.setCurrentPageAsync(target);
      return { id: target.id, name: target.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓') + ` Switched to page: ${r.name} ${chalk.gray('(' + r.id + ')')}`);
    } catch (e) {
      handleEvalError(e);
    }
  });

canvas
  .command('next')
  .description('Get next free position on canvas (no overlap)')
  .option('-g, --gap <n>', 'Gap from existing elements', '100')
  .option('-d, --direction <dir>', 'Direction: right, below', 'right')
  .action(async (options) => {
    await checkConnection();
    let code = `(async function() {
// Same dynamic-page-loading caveat as \`canvas info\`: measure only after
// the page is fully loaded, or the "free" position lands on real content.
await figma.currentPage.loadAsync();
const children = figma.currentPage.children;
const gap = ${options.gap};
if (children.length === 0) {
  return JSON.stringify({ x: 0, y: 0 });
} else {
  ${options.direction === 'below' ? `
  let maxY = -Infinity;
  children.forEach(n => { maxY = Math.max(maxY, n.y + n.height); });
  return JSON.stringify({ x: 0, y: Math.round(maxY + gap) });
  ` : `
  let maxX = -Infinity;
  children.forEach(n => { maxX = Math.max(maxX, n.x + n.width); });
  return JSON.stringify({ x: Math.round(maxX + gap), y: 0 });
  `}
}
})()`;
    evalPrint(code);
  });

// (The selection-driven command groups `bind`, `sizing`, `padding`, `gap`,
// `align`, `select`, `delete`, `duplicate` and `set` were removed. Every one
// of them read figma.currentPage.selection, which an MCP caller cannot set,
// and none was allowlisted. The id-addressed equivalents live in `node`
// (move/resize/rename/set-text/set-fill/set-image/delete) and `create`.
// docu/FUNDLISTE-toter-code.md lists what has no equivalent yet.)

// ============ PIN (edge-anchored absolute positioning) ============
//
// Implements the directededges "Absolute Positioning" spec:
// https://directededges.github.io/specs/guides/absolute-positioning/
//
// Figma stores absolutely-positioned elements as raw x/y from the parent's
// top-left, plus a `constraints` object that records the anchor edge.
// Designers think in terms of edges ("16 from right"), but figma's API
// forces you to compute raw x = parent.width - node.width - 16 yourself.
// `pin` does the math AND sets the matching constraint so the element
// stays anchored when the parent resizes.

program
  .command('pin <edge>')
  .description('Pin node(s) to a parent edge with an edge-relative offset. Edges: left | right | top | bottom | top-left | top-right | bottom-left | bottom-right | center-x | center-y | stretch-x | stretch-y | scale-x | scale-y')
  .option('-n, --node <id>', 'Node ID (or comma-separated list)')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern>')
  .option('-o, --offset <n>', 'Offset from the edge in px (default: 0). For top-right etc. it applies to the FIRST edge; use --offset-x / --offset-y to split.')
  .option('--offset-x <n>', 'Horizontal offset (overrides --offset on the horizontal axis)')
  .option('--offset-y <n>', 'Vertical offset (overrides --offset on the vertical axis)')
  .option('--start <v>', 'For stretch-x/stretch-y/scale-x/scale-y: start offset (px) or percentage string for scale')
  .option('--end <v>', 'For stretch-x/stretch-y/scale-x/scale-y: end offset (px) or percentage string for scale')
  .action(async (edge, options) => {
    await checkConnection();
    const validEdges = new Set([
      'left', 'right', 'top', 'bottom',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
      'center-x', 'center-y',
      'stretch-x', 'stretch-y',
      'scale-x', 'scale-y',
    ]);
    if (!validEdges.has(edge)) {
      console.error(chalk.red('✗'), `Unknown edge "${edge}". Valid: ${[...validEdges].join(', ')}`);
      process.exit(1);
    }
    const off = parseFloat(options.offset ?? 0);
    const offX = options.offsetX !== undefined ? parseFloat(options.offsetX) : off;
    const offY = options.offsetY !== undefined ? parseFloat(options.offsetY) : off;
    const start = options.start;
    const end = options.end;

    // Build the per-node mutation. Runs inside the eval, so it can read each
    // node's parent dimensions and compute the raw x/y per the Spec formulas.
    // Constraints are set so Figma keeps the anchor when the parent resizes.
    const pinExpr = `
      function pinOne(n) {
        if (!n || typeof n.x !== 'number' || !('constraints' in n)) return false;
        const p = n.parent;
        if (!p || typeof p.width !== 'number') return false;
        const pw = p.width, ph = p.height;
        const c = { ...n.constraints };
        const edge = ${JSON.stringify(edge)};
        const offX = ${offX}, offY = ${offY};
        if (edge === 'left')        { n.x = offX;                          c.horizontal = 'MIN'; }
        else if (edge === 'right')  { n.x = pw - n.width - offX;            c.horizontal = 'MAX'; }
        else if (edge === 'top')    { n.y = offY;                          c.vertical = 'MIN'; }
        else if (edge === 'bottom') { n.y = ph - n.height - offY;           c.vertical = 'MAX'; }
        else if (edge === 'top-left')     { n.x = offX; n.y = offY;
                                             c.horizontal = 'MIN'; c.vertical = 'MIN'; }
        else if (edge === 'top-right')    { n.x = pw - n.width - offX; n.y = offY;
                                             c.horizontal = 'MAX'; c.vertical = 'MIN'; }
        else if (edge === 'bottom-left')  { n.x = offX; n.y = ph - n.height - offY;
                                             c.horizontal = 'MIN'; c.vertical = 'MAX'; }
        else if (edge === 'bottom-right') { n.x = pw - n.width - offX; n.y = ph - n.height - offY;
                                             c.horizontal = 'MAX'; c.vertical = 'MAX'; }
        else if (edge === 'center-x') { n.x = (pw - n.width) / 2 + offX; c.horizontal = 'CENTER'; }
        else if (edge === 'center-y') { n.y = (ph - n.height) / 2 + offY; c.vertical = 'CENTER'; }
        else if (edge === 'stretch-x') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sNum = s == null ? 0 : parseFloat(s);
          const eNum = e == null ? 0 : parseFloat(e);
          n.x = sNum;
          n.resize(Math.max(1, pw - sNum - eNum), n.height);
          c.horizontal = 'STRETCH';
        }
        else if (edge === 'stretch-y') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sNum = s == null ? 0 : parseFloat(s);
          const eNum = e == null ? 0 : parseFloat(e);
          n.y = sNum;
          n.resize(n.width, Math.max(1, ph - sNum - eNum));
          c.vertical = 'STRETCH';
        }
        else if (edge === 'scale-x') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sPct = typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : (parseFloat(s) || 0) / pw;
          const ePct = typeof e === 'string' && e.endsWith('%') ? parseFloat(e) / 100 : (parseFloat(e) || 0) / pw;
          n.x = pw * sPct;
          n.resize(Math.max(1, pw - n.x - pw * ePct), n.height);
          c.horizontal = 'SCALE';
        }
        else if (edge === 'scale-y') {
          const s = ${JSON.stringify(start)}, e = ${JSON.stringify(end)};
          const sPct = typeof s === 'string' && s.endsWith('%') ? parseFloat(s) / 100 : (parseFloat(s) || 0) / ph;
          const ePct = typeof e === 'string' && e.endsWith('%') ? parseFloat(e) / 100 : (parseFloat(e) || 0) / ph;
          n.y = ph * sPct;
          n.resize(n.width, Math.max(1, ph - n.y - ph * ePct));
          c.vertical = 'SCALE';
        }
        n.constraints = c;
        return true;
      }
    `;

    const selector = buildNodeSelector(options);
    const code = `(async () => {
      ${selector}
      if (nodes.length === 0) return 'No node found';
      ${pinExpr}
      let count = 0;
      for (const n of nodes) if (pinOne(n)) count++;
      return 'Pinned ' + count + ' element(s) to ' + ${JSON.stringify(edge)};
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓ ' + (r || 'Done')));
    } catch (e) {
      handleEvalError(e);
    }
  });

// (`unwrap` and `use`/`theme` were removed: unreachable through the MCP
// allowlist. `use` — rebinding every bound variable to a target collection —
// is the one with no replacement; see docu/FUNDLISTE-toter-code.md.)

// ============ INSPECT (reverse: Figma → Spec) ============

program
  .command('inspect <nodeId>')
  .description('Inspect a node and emit its position as Spec-canonical properties (start/end/centerOffset/etc.). Machine-readable via --format yaml (compact) or --json.')
  .option('--json', 'Output as JSON (machine-readable)')
  .option('-f, --format <fmt>', 'yaml | json — structured output (yaml is the token-cheaper default for agents)')
  .option('--spec', 'Output only the absolute-positioning spec block (compact)')
  .action(async (nodeId, options) => {
    await checkConnection();
    {
      const norm = normalizeNodeId(nodeId);
      if (norm.warning) console.error(chalk.yellow('⚠ ' + norm.warning));
      nodeId = norm.id;
    }
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)} + ' in the currently open file "' + figma.root.name + '" — Safe Mode only reaches the file open in Figma Desktop.');
      const p = n.parent;
      const out = {
        id: n.id,
        name: n.name,
        type: n.type,
        width: 'width' in n ? n.width : null,
        height: 'height' in n ? n.height : null,
      };
      // Absolute-positioning spec output. Mirrors the directededges spec:
      // active keys carry computed values, inactive ones are null (so a
      // consumer can diff variants reliably).
      if (n.layoutPositioning === 'ABSOLUTE' && p && 'width' in p) {
        const c = n.constraints || { horizontal: 'MIN', vertical: 'MIN' };
        const pw = p.width, ph = p.height;
        const pos = {
          position: 'ABSOLUTE',
          start: null, end: null, top: null, bottom: null,
          centerHorizontalOffset: null, centerVerticalOffset: null,
          width: n.width, height: n.height,
          layoutSizingHorizontal: null, layoutSizingVertical: null,
        };
        const pct = (v) => {
          const p2 = Math.round(v * 10000) / 100;
          return (p2 % 1 === 0 ? p2.toFixed(0) : (p2 % 0.1 === 0 ? p2.toFixed(1) : p2.toFixed(2))) + '%';
        };
        switch (c.horizontal) {
          case 'MIN':     pos.start = n.x; break;
          case 'MAX':     pos.end = pw - n.x - n.width; break;
          case 'CENTER':  pos.centerHorizontalOffset = n.x + n.width / 2 - pw / 2; break;
          case 'STRETCH': pos.start = n.x; pos.end = pw - n.x - n.width; pos.width = null; break;
          case 'SCALE':   pos.start = pct(n.x / pw); pos.end = pct((pw - n.x - n.width) / pw); pos.width = null; break;
        }
        switch (c.vertical) {
          case 'MIN':     pos.top = n.y; break;
          case 'MAX':     pos.bottom = ph - n.y - n.height; break;
          case 'CENTER':  pos.centerVerticalOffset = n.y + n.height / 2 - ph / 2; break;
          case 'STRETCH': pos.top = n.y; pos.bottom = ph - n.y - n.height; pos.height = null; break;
          case 'SCALE':   pos.top = pct(n.y / ph); pos.bottom = pct((ph - n.y - n.height) / ph); pos.height = null; break;
        }
        out.absolutePositioning = pos;
      } else if (n.layoutPositioning === 'AUTO' || p?.layoutMode !== 'NONE') {
        out.absolutePositioning = {
          position: 'AUTO',
          start: null, end: null, top: null, bottom: null,
          centerHorizontalOffset: null, centerVerticalOffset: null,
          width: null, height: null,
          layoutSizingHorizontal: n.layoutSizingHorizontal ?? null,
          layoutSizingVertical: n.layoutSizingVertical ?? null,
        };
      }
      // Component context: what this INSTANCE instantiates and which
      // variant/property values it carries. Shared with the component main
      // command via componentContextExpr (one resolution).
      const __ctx = ${componentContextExpr('n')};
      if (__ctx && __ctx.role) out.component = __ctx;
      // Typography context for TEXT nodes: applied text style (resolved to
      // its name) plus the effective font — makes "is this text styled or
      // raw?" checkable without opening Figma.
      if (n.type === 'TEXT') {
        const styleId = n.textStyleId && n.textStyleId !== figma.mixed ? n.textStyleId : null;
        let styleName = null;
        if (styleId) {
          try {
            const st = await figma.getStyleByIdAsync(styleId);
            styleName = st ? st.name : null;
          } catch (e) {}
        }
        out.text = {
          characters: n.characters.length > 60 ? n.characters.slice(0, 60) + '…' : n.characters,
          fontSize: n.fontSize === figma.mixed ? 'mixed' : n.fontSize,
          fontName: n.fontName === figma.mixed ? 'mixed' : n.fontName,
          textStyle: styleName,
        };
      }
      // Style block: fills/strokes/effects/clip/opacity/radius. Without
      // these, inspect was geometry-only and useless as a detail tool for
      // paints ("figma_inspect liefert keine Fills/Effects/clipsContent").
      // Serialization is the SHARED snippet from lib/paint-css.js — inspect
      // used to have its own copy that dropped gradient angles entirely
      // (Run-7, Rectangle 28: spec said 45deg, inspect said nothing).
      ${paintsSnippetJs}
      const __w = 'width' in n ? n.width : 0, __h = 'height' in n ? n.height : 0;
      const style = {};
      try { const f = paints(n.fills, __w, __h); if (f) style.fills = f; } catch (e) {}
      // Applied shared COLOR style (semantic handle alongside the raw fill).
      try {
        if (typeof n.fillStyleId === 'string' && n.fillStyleId) {
          const fst = await figma.getStyleByIdAsync(n.fillStyleId);
          if (fst) style.fillStyle = fst.name;
        }
      } catch (e) {}
      try { const s = paints(n.strokes, __w, __h); if (s) { style.strokes = s; if (typeof n.strokeWeight === 'number') style.strokeWeight = n.strokeWeight; } } catch (e) {}
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
      // Raw geometry alongside, useful for debugging the spec output
      if ('x' in n) {
        out.raw = { x: n.x, y: n.y, constraints: n.constraints };
      }
      return out;
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      const fmt = options.format ? String(options.format).toLowerCase() : null;
      if (fmt === 'yaml') {
        console.log(toYaml(r));
      } else if (options.json || fmt === 'json') {
        console.log(JSON.stringify(r, null, 2));
      } else if (options.spec) {
        console.log(JSON.stringify(r.absolutePositioning, null, 2));
      } else {
        console.log(chalk.cyan(`${r.name || '(unnamed)'} (${r.id}) — ${r.type}`));
        console.log(chalk.gray(`  size: ${r.width}×${r.height}`));
        if (r.absolutePositioning) {
          console.log(chalk.cyan('  Absolute Positioning spec:'));
          for (const [k, v] of Object.entries(r.absolutePositioning)) {
            if (v !== null) console.log(`    ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
          }
        }
        if (r.style) {
          console.log(chalk.cyan('  Style:'));
          for (const [k, v] of Object.entries(r.style)) console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
        if (r.raw) {
          console.log(chalk.gray(`  raw: x=${r.raw.x}, y=${r.raw.y}, constraints=${JSON.stringify(r.raw.constraints)}`));
        }
      }
    } catch (e) {
      handleEvalError(e);
    }
  });

// (`unstack`, `arrange` and `get` were removed: all three worked on the
// current selection or on every top-level frame, which no MCP caller can
// set up. `node tree` reads structure; `node move` positions by id.)

// ============ FIND ============

program
  .command('find <name>')
  .description('Find nodes by name (partial match)')
  .option('-t, --type <type>', 'Filter by type (FRAME, TEXT, RECTANGLE, etc.)')
  .option('-l, --limit <n>', 'Limit results', '20')
  .action(async (name, options) => {
    await checkConnection();
    let code = `(function() {
const results = [];
function search(node) {
  if (node.name && node.name.toLowerCase().includes(${JSON.stringify(name.toLowerCase())})) {
    ${options.type ? `if (node.type === ${JSON.stringify(options.type.toUpperCase())})` : ''}
    results.push({ id: node.id, name: node.name, type: node.type });
  }
  if (node.children && results.length < ${options.limit}) {
    node.children.forEach(search);
  }
}
search(figma.currentPage);
return results.length === 0 ? 'No nodes found matching "${name}"' : results.slice(0, ${options.limit}).map(r => r.id + ' [' + r.type + '] ' + r.name).join('\\n');
})()`;
    evalPrint(code);
  });

