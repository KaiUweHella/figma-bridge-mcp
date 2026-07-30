/**
 * DESIGN.md exporter — the reverse of src/design-md.js.
 *
 * Three units:
 *  1. walkerCode()/listPagesCode(): JS strings evaluated INSIDE Figma
 *     (async IIFEs returning JSON.stringify'd compact node trees).
 *  2. Aggregator: pure functions building color/typography/spacing/radius/
 *     shadow censuses, semantic names, variant matrices from walker JSON.
 *  3. generateDesignMd(): emits the 11-section plugin-compatible markdown
 *     that parseDesignMd() (src/design-md.js) reads back unchanged.
 */

import { paintsSnippetJs } from './lib/paint-css.js';

/** Eval snippet: list all pages of the open file. */
export function listPagesCode() {
  return `(async () => {
    await figma.loadAllPagesAsync();
    return JSON.stringify(figma.root.children.map(p => ({ id: p.id, name: p.name, frames: p.children.length })));
  })()`;
}

/**
 * Eval snippet: capture every LOCAL variable collection of the open file —
 * names, modes, and each variable's per-mode resolved value. This is the
 * authoritative token layer (a system's real semantic tokens, e.g.
 * `button-primary-bgColor-rest` with light/dark modes), which the derived
 * color palette can only approximate by sampling fills.
 *
 * COLOR values resolve to hex (8-digit when alpha < 1), FLOAT/STRING/BOOLEAN
 * pass through, and VARIABLE_ALIAS values are captured as { alias: <id> } for
 * Node-side name resolution. Self-contained for the plugin sandbox.
 */
/**
 * Shared eval helpers spliced into the variable-reading IIFEs: hex(),
 * aliasName() (cached id→name, resolves library/remote refs too), and
 * readVarValues(v, modes) → { modeName: value } applying the COLOR→hex /
 * alias / passthrough rules. Single-sourced so the one-shot and chunked
 * paths can never drift.
 */
const VAR_EVAL_HELPERS = `
    const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('') + (c.a != null && c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, '0') : '');
    const nameCache = new Map();
    const aliasName = async (id) => {
      if (nameCache.has(id)) return nameCache.get(id);
      let name = id;
      try { const t = await figma.variables.getVariableByIdAsync(id); if (t) name = t.name; } catch (e) {}
      nameCache.set(id, name);
      return name;
    };
    const readVarValues = async (v, modes) => {
      const values = {};
      for (const m of modes) {
        const raw = v.valuesByMode[m.id];
        if (raw == null) continue;
        if (typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') values[m.name] = { alias: await aliasName(raw.id) };
        else if (v.resolvedType === 'COLOR' && raw && typeof raw === 'object' && 'r' in raw) values[m.name] = hex(raw);
        else values[m.name] = raw;
      }
      return values;
    };`;

export function variablesCode() {
  return `(async () => {${VAR_EVAL_HELPERS}
    let cols = [];
    try { cols = await figma.variables.getLocalVariableCollectionsAsync(); } catch (e) { return JSON.stringify([]); }
    const out = [];
    for (const col of cols) {
      const modes = col.modes.map(m => ({ id: m.modeId, name: m.name }));
      const variables = [];
      for (const id of col.variableIds) {
        let v;
        try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { continue; }
        if (!v) continue;
        variables.push({ id: v.id, name: v.name, type: v.resolvedType, values: await readVarValues(v, modes) });
      }
      out.push({ id: col.id, name: col.name, modes, variables });
    }
    return JSON.stringify(out);
  })()`;
}

/**
 * Eval snippet: list variable collections WITHOUT reading any values — just
 * id, name, modes and the variableIds. Tiny payload even for huge systems;
 * the command then fetches values in bounded chunks (variableChunkCode) so a
 * 10k-variable library never lands in one oversized/timing-out eval.
 */
export function variableCollectionsCode() {
  return `(async () => {
    let cols = [];
    try { cols = await figma.variables.getLocalVariableCollectionsAsync(); } catch (e) { return JSON.stringify([]); }
    return JSON.stringify(cols.map(c => ({ id: c.id, name: c.name, modes: c.modes.map(m => ({ id: m.modeId, name: m.name })), variableIds: c.variableIds })));
  })()`;
}

/**
 * Eval snippet: read one chunk of variables by explicit id list, for the given
 * modes ([{ id, name }]). Returns [{ id, name, type, values }]. Self-contained;
 * the alias name cache is per-chunk (fresh sandbox), which costs a few extra
 * lookups but keeps each call independent and retryable at a smaller size.
 */
export function variableChunkCode(ids, modes) {
  return `(async () => {${VAR_EVAL_HELPERS}
    const modes = ${JSON.stringify(modes)};
    const ids = ${JSON.stringify(ids)};
    const variables = [];
    for (const id of ids) {
      let v;
      try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { continue; }
      if (!v) continue;
      variables.push({ id: v.id, name: v.name, type: v.resolvedType, values: await readVarValues(v, modes) });
    }
    return JSON.stringify(variables);
  })()`;
}

/**
 * Eval snippet: walk one page and return its compact node tree.
 * Kept self-contained — no outer-scope references — because it runs in the
 * Figma plugin sandbox.
 *
 * Options beyond depth/text:
 *  - resolveInstances: descend INTO instance subtrees (override characters
 *    come through automatically) and resolve each instance's main component
 *    name + variant/text properties. Without this, instances short-circuit to
 *    their (often stale) layer name — fine for a census, fatal for
 *    design-to-code where the real content lives inside instances.
 *  - withIds: carry every node's id so callers can target sub-nodes
 *    (screenshots, inspect) without re-searching.
 *  - withVars: resolve boundVariables (fills, gaps, radii, fontSize, …) to
 *    variable NAMES so specs can say `#ffffff → var(color/surface)`.
 */
export function walkerCode(pageId, {
  maxDepth = 8, textLimit = 80,
  resolveInstances = false, withIds = false, withVars = false,
  includeHidden = false,
} = {}) {
  return `(async () => {
    const MAX_DEPTH = ${Number(maxDepth)};
    const TEXT_LIMIT = ${Number(textLimit)};
    const RESOLVE_INSTANCES = ${resolveInstances === true};
    const WITH_IDS = ${withIds === true};
    const WITH_VARS = ${withVars === true};
    const INCLUDE_HIDDEN = ${includeHidden === true};
    /* A bare type name ("GRADIENT_LINEAR") is not implementable — paints()
       emits real stops + angle as a css-ready gradient() instead. One shared
       serializer (lib/paint-css.js) for walker AND inspect — the two used to
       drift (mirrored angles here, no angle at all there). */
    ${paintsSnippetJs}
    const varNameCache = new Map();
    const varName = async (id) => {
      if (varNameCache.has(id)) return varNameCache.get(id);
      let name = null;
      try { const v = await figma.variables.getVariableByIdAsync(id); if (v) name = v.name; } catch (e) {}
      varNameCache.set(id, name);
      return name;
    };
    // Shared styles (text styles, color styles): resolve id → { name, bv }.
    // bv holds the STYLE's own variable bindings (fontSize/fontStyle/… →
    // variable names) — design systems bind typography tokens inside their
    // text styles, so without this every text renders as hard values.
    // Post-transform box of a node RELATIVE to its parent's box. Node w/h and
    // x/y are pre-rotation — a -90° wave reads as 204×363 while it renders
    // (and exports) as 363×76. Absolute boxes bake the transform in and also
    // erase the GROUP-coordinate-space special case. 'render' prefers
    // absoluteRenderBounds (the pixels actually drawn — matches the exported
    // SVG); default is absoluteBoundingBox (geometry, no effect bleed).
    const relBox = (n, prefer) => {
      const pb = n.parent && n.parent.absoluteBoundingBox;
      const own = (prefer === 'render' && n.absoluteRenderBounds) ? n.absoluteRenderBounds : n.absoluteBoundingBox;
      if (!pb || !own) return null;
      return { x: Math.round(own.x - pb.x), y: Math.round(own.y - pb.y), w: Math.round(own.width), h: Math.round(own.height) };
    };
    // Component sets seen while resolving instances: name -> { id, props }.
    const SETS = new Map();
    const setsOut = () => {
      const list = [];
      for (const entry of SETS.entries()) {
        const out = { name: entry[0], id: entry[1].id, props: entry[1].props };
        if (entry[1].setKey) out.setKey = entry[1].setKey;
        if (entry[1].dvKey) out.dvKey = entry[1].dvKey;
        list.push(out);
      }
      return list;
    };
    const styleCache = new Map();
    const styleInfo = async (id) => {
      if (styleCache.has(id)) return styleCache.get(id);
      let info = null;
      try {
        const st = await figma.getStyleByIdAsync(id);
        if (st) {
          info = { name: st.name };
          if (WITH_VARS && st.boundVariables) {
            const bv = {};
            for (const entry of Object.entries(st.boundVariables)) {
              const first = Array.isArray(entry[1]) ? entry[1][0] : entry[1];
              if (first && first.id) { const nm = await varName(first.id); if (nm) bv[entry[0]] = nm; }
            }
            if (Object.keys(bv).length) info.bv = bv;
          }
        }
      } catch (e) {}
      styleCache.set(id, info);
      return info;
    };
    const walk = async (n, depth) => {
      // Invisible nodes do not render — putting them in the spec makes the
      // consumer build phantom elements (hidden tag pills, notification
      // bubbles toggled off via BOOLEAN component props: Figma expresses
      // those as visible=false on the controlled layer, so this one check
      // covers both cases). Default: drop. --include-hidden keeps them,
      // marked, for debugging what a toggle would reveal.
      if (n.visible === false && !INCLUDE_HIDDEN) return null;
      const o = { t: n.type, n: n.name };
      if (n.visible === false) o.hidden = true;
      if (WITH_IDS) o.id = n.id;
      if ('width' in n) { o.w = Math.round(n.width); o.h = Math.round(n.height); }
      if ('layoutMode' in n && n.layoutMode !== 'NONE') {
        o.lm = n.layoutMode;
        if (n.itemSpacing) o.gap = n.itemSpacing;
        const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
        if (pad.some(v => v > 0)) o.pad = pad;
        if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== 'MIN') o.ap = n.primaryAxisAlignItems;
        if (n.counterAxisAlignItems && n.counterAxisAlignItems !== 'MIN') o.ac = n.counterAxisAlignItems;
        // GRID auto-layout (2025): sidebar/topbar/main shells are grids. The
        // walker used to know only H/V and silently mislabeled grids as
        // columns WITHOUT child positions — the "everything collapses into a
        // stack" shell bug. Property reads are defensive: names come from the
        // grid API generation and absent ones simply stay unreported (the
        // free-position fallback below still places every child).
        if (n.layoutMode === 'GRID') {
          const g = {};
          try {
            if (typeof n.gridRowCount === 'number') g.rows = n.gridRowCount;
            if (typeof n.gridColumnCount === 'number') g.cols = n.gridColumnCount;
            if (typeof n.gridRowGap === 'number') g.rowGap = n.gridRowGap;
            if (typeof n.gridColumnGap === 'number') g.colGap = n.gridColumnGap;
          } catch (e) {}
          if (Object.keys(g).length) o.grid = g;
        }
      }
      // Grid CELL of this node (parent is a GRID): anchor indices are
      // 0-based; spans only when > 1.
      if (n.parent && n.parent.layoutMode === 'GRID') {
        const c = {};
        try {
          // Anchor -1 = the child is NOT in a grid track (absolutely
          // positioned overlay inside the grid) — no cell for those.
          if (typeof n.gridRowAnchorIndex === 'number' && n.gridRowAnchorIndex >= 0) c.r = n.gridRowAnchorIndex;
          if (typeof n.gridColumnAnchorIndex === 'number' && n.gridColumnAnchorIndex >= 0) c.c = n.gridColumnAnchorIndex;
          if (typeof n.gridRowSpan === 'number' && n.gridRowSpan > 1) c.rs = n.gridRowSpan;
          if (typeof n.gridColumnSpan === 'number' && n.gridColumnSpan > 1) c.cs = n.gridColumnSpan;
        } catch (e) {}
        if (c.r != null || c.c != null) o.cell = c;
      }
      // Sizing modes (fill/hug/fixed) — the classic "hug instead of fill"
      // layout bug is invisible without them.
      if ('layoutSizingHorizontal' in n && n.layoutSizingHorizontal && n.layoutSizingHorizontal !== 'FIXED') o.sh = n.layoutSizingHorizontal;
      if ('layoutSizingVertical' in n && n.layoutSizingVertical && n.layoutSizingVertical !== 'FIXED') o.sv = n.layoutSizingVertical;
      // Min/max constraints — they bound how fill/hug resolve and were
      // previously not read at all ("min-width kommt nie an").
      if (typeof n.minWidth === 'number') o.mnw = Math.round(n.minWidth);
      if (typeof n.maxWidth === 'number') o.mxw = Math.round(n.maxWidth);
      if (typeof n.minHeight === 'number') o.mnh = Math.round(n.minHeight);
      if (typeof n.maxHeight === 'number') o.mxh = Math.round(n.maxHeight);
      // Rendering modifiers the consumer cannot infer from geometry: layer
      // opacity, rotation, and frame clipping (CSS: overflow hidden). Without
      // clip, children overflowing the frame bounds either bleed or get
      // dropped in a rebuild — Figma cuts them silently.
      if (typeof n.opacity === 'number' && n.opacity < 1) o.op = Math.round(n.opacity * 100) / 100;
      if (typeof n.rotation === 'number' && Math.abs(n.rotation) >= 0.5) o.rot = Math.round(n.rotation * 10) / 10;
      if (n.clipsContent === true) o.clip = true;
      // Overlays: an ABSOLUTE child inside auto-layout looked like a normal
      // flow child in the spec — corner badges and bookmarks were rebuilt
      // in-flow. Capture the anchor (from constraints) and the offset FROM
      // the anchored edges, so "abs bottom-right 16,16" is buildable as-is.
      // The same treatment applies to EVERY child of a container that is NOT
      // a flexbox-like auto-layout (HORIZONTAL/VERTICAL): free frames, GRID
      // parents, and any future layoutMode. Grid children get their cell AND
      // their x/y — the offsets double as a cross-check and as the fallback
      // when the grid template could not be read. A spec without positions
      // (the Background Pattern / collapsed-shell case) is unbuildable.
      const parentLm = n.parent && 'layoutMode' in n.parent ? n.parent.layoutMode : null;
      const freeParent = n.parent && typeof n.parent.width === 'number'
        && parentLm !== 'HORIZONTAL' && parentLm !== 'VERTICAL';
      let absBox = null, absPw = 0, absPh = 0;
      if ((n.layoutPositioning === 'ABSOLUTE' || freeParent)
          && n.parent && typeof n.parent.width === 'number' && typeof n.x === 'number') {
        const c = n.constraints || {};
        const AH = { MIN: 'left', MAX: 'right', CENTER: 'center', STRETCH: 'stretch', SCALE: 'scale' };
        const AV = { MIN: 'top', MAX: 'bottom', CENTER: 'center', STRETCH: 'stretch', SCALE: 'scale' };
        const ah = AH[c.horizontal] || 'left';
        const av = AV[c.vertical] || 'top';
        // Post-transform box (rotation baked in, GROUP coordinate spaces
        // normalized). Fallback for boxless environments: raw x/y, with the
        // GROUP-origin correction (group children share the group's space).
        let box = relBox(n);
        if (!box) {
          const px = n.parent.type === 'GROUP' ? (n.parent.x || 0) : 0;
          const py = n.parent.type === 'GROUP' ? (n.parent.y || 0) : 0;
          box = { x: n.x - px, y: n.y - py, w: n.width, h: n.height };
        }
        const pb = n.parent.absoluteBoundingBox;
        const pw = pb ? pb.width : n.parent.width;
        const ph = pb ? pb.height : n.parent.height;
        // x/y are offsets from the ANCHORED edge — right/bottom anchors count
        // from those edges, every other anchor (incl. center/stretch/scale)
        // counts from left/top so the value is directly CSS-buildable.
        o.abs = {
          a: av + '-' + ah,
          x: Math.round(ah === 'right' ? pw - box.x - box.w : box.x),
          y: Math.round(av === 'bottom' ? ph - box.y - box.h : box.y),
        };
        // STRETCH pins BOTH edges — emit the far edge too (left+right / top+bottom).
        if (ah === 'stretch') o.abs.r = Math.round(pw - box.x - box.w);
        if (av === 'stretch') o.abs.b = Math.round(ph - box.y - box.h);
        absBox = box; absPw = pw; absPh = ph;
      }
      // Rendered box for anything that can be (part of) vector art: after a
      // rotation the exported SVG has these dimensions, not width/height —
      // the spec must hand out numbers that match the file it points to.
      const VEC_RB = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1, LINE: 1, ELLIPSE: 1, RECTANGLE: 1, GROUP: 1 };
      if (VEC_RB[n.type] || o.rot) {
        const rb = relBox(n, 'render');
        if (rb) o.rb = rb;
      }
      // Overlay classification, on the RENDERED box when present (only drawn
      // pixels count — a decorative wave whose geometry box overhangs while
      // its visible part fits must not be misjudged):
      //  - inset: covers the parent edge-to-edge (2px tol) — the profile-card
      //    background case. Emitting fixed offsets made builders pin it
      //    top-left; inset says: size WITH the parent.
      //  - ov: extends beyond the parent. Consumers drop exactly these
      //    ("half outside — must be a mistake") — the flag says whether the
      //    parent clips it or it stays visible by design (do not drop).
      if (absBox) {
        const ob = o.rb || absBox;
        if (Math.abs(ob.x) <= 2 && Math.abs(ob.y) <= 2
            && Math.abs(absPw - ob.x - ob.w) <= 2 && Math.abs(absPh - ob.y - ob.h) <= 2) {
          o.abs.inset = true;
        } else if (ob.x < -1 || ob.y < -1 || ob.x + ob.w > absPw + 1 || ob.y + ob.h > absPh + 1) {
          o.ov = n.parent.clipsContent === true ? 'clip' : 'over';
        }
      }
      try { const f = paints(n.fills, 'width' in n ? n.width : 0, 'height' in n ? n.height : 0); if (f) o.fills = f; } catch (e) {}
      // Shared COLOR style applied to the fill (fillStyleId): its name is the
      // semantic handle ("Color/Primary") — capture alongside the raw value.
      if (WITH_VARS && typeof n.fillStyleId === 'string' && n.fillStyleId) {
        const st = await styleInfo(n.fillStyleId);
        if (st) o.fs = st.name;
      }
      try {
        const s = paints(n.strokes, 'width' in n ? n.width : 0, 'height' in n ? n.height : 0);
        if (s) {
          o.strokes = s;
          if (typeof n.strokeWeight === 'number') o.sw = n.strokeWeight;
          else {
            // Per-side borders: strokeWeight is figma.mixed then, and the
            // width used to vanish from the spec entirely (the gradient-border
            // cards). Capture the four sides as [t, r, b, l].
            const t = n.strokeTopWeight, r = n.strokeRightWeight, b = n.strokeBottomWeight, l = n.strokeLeftWeight;
            if ([t, r, b, l].some(v => typeof v === 'number')) o.sw = [t || 0, r || 0, b || 0, l || 0];
          }
          // Stroke alignment changes geometry: INSIDE (the default, = CSS
          // border with border-box) is implicit; OUTSIDE/CENTER are emitted.
          if (n.strokeAlign && n.strokeAlign !== 'INSIDE') o.sa = String(n.strokeAlign).toLowerCase();
        }
      } catch (e) {}
      try { if (Array.isArray(n.dashPattern) && n.dashPattern.length) o.dash = n.dashPattern; } catch (e) {}
      if ('cornerRadius' in n) {
        if (typeof n.cornerRadius === 'number') { if (n.cornerRadius > 0) o.r = n.cornerRadius; }
        else o.r = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
      }
      if (Array.isArray(n.effects) && n.effects.length) {
        const fx = n.effects.filter(e => e.visible !== false).map(e =>
          (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
            ? { type: e.type, x: e.offset.x, y: e.offset.y, blur: e.radius, spread: e.spread || 0, color: hex(e.color), a: Math.round((e.color.a == null ? 1 : e.color.a) * 100) / 100 }
            : { type: e.type, blur: e.radius });
        if (fx.length) o.fx = fx;
      }
      if (WITH_VARS && n.boundVariables) {
        const bv = {};
        for (const entry of Object.entries(n.boundVariables)) {
          const first = Array.isArray(entry[1]) ? entry[1][0] : entry[1];
          if (first && first.id) { const nm = await varName(first.id); if (nm) bv[entry[0]] = nm; }
        }
        if (Object.keys(bv).length) o.bv = bv;
      }
      if (n.type === 'TEXT') {
        o.txt = { chars: (n.characters || '').slice(0, TEXT_LIMIT) };
        if (n.fontName !== figma.mixed) { o.txt.font = n.fontName.family; o.txt.style = n.fontName.style; }
        if (n.fontSize !== figma.mixed) o.txt.size = n.fontSize;
        if (n.lineHeight !== figma.mixed && n.lineHeight && n.lineHeight.unit !== 'AUTO') {
          // PERCENT line-heights are relative to font size; resolve to absolute
          // px so the table/JSON tokens are unambiguous and re-import cleanly.
          // (A raw 142.85 from "142%" would otherwise read as 142.85px.)
          if (n.lineHeight.unit === 'PERCENT') {
            if (o.txt.size != null) o.txt.lh = Math.round(o.txt.size * n.lineHeight.value / 100 * 10) / 10;
          } else {
            o.txt.lh = n.lineHeight.value;
          }
        }
        if (n.letterSpacing !== figma.mixed && n.letterSpacing && n.letterSpacing.value) o.txt.ls = n.letterSpacing.value;
        // Applied TEXT STYLE: the style name ("display/medium") is the
        // semantic identity of this text, and the style's own variable
        // bindings are where typography tokens usually live. Merge the
        // style's bindings under the node's (node-level overrides win).
        if (WITH_VARS && typeof n.textStyleId === 'string' && n.textStyleId) {
          const st = await styleInfo(n.textStyleId);
          if (st) {
            o.txt.ts = st.name;
            if (st.bv) {
              o.bv = o.bv || {};
              for (const k of Object.keys(st.bv)) if (!(k in o.bv)) o.bv[k] = st.bv[k];
            }
          }
        }
      }
      if (n.type === 'COMPONENT_SET') {
        try { o.vp = n.variantGroupProperties; } catch (e) {}
        o.kidCount = n.children.length;
        // Identity handle: the SET's own id/key — the stable identity of the
        // whole component (what a Storybook story mirrors).
        o.setId = n.id;
        try { if (n.key) o.setKey = n.key; } catch (e) {}
        // Reuse handle: the default variant is the COMPONENT you instance
        // (a set has no createInstance). Capture its node id (same-file reuse)
        // and publish key (cross-file reuse, only resolvable once published).
        const dv = n.defaultVariant || n.children[0];
        if (dv) { o.id = dv.id; try { o.key = dv.key; } catch (e) {} }
        if (n.children.length) o.kids = [await walk(n.children[0], depth + 1)].filter(Boolean);
        return o;
      }
      if (n.type === 'INSTANCE') {
        o.mc = n.name;
        if (!RESOLVE_INSTANCES) return o;
        // Truth over layer names: the main component's REAL name (an icon
        // instance renamed "leaf" may actually instantiate "calendar"), the
        // parent set, and the instance's variant/text property values.
        try {
          const main = await n.getMainComponentAsync();
          if (main) {
            o.main = main.name;
            // Stable publish key — the identity a Storybook mapping hangs on.
            try { if (main.key) o.mainKey = main.key; } catch (e) {}
            if (main.parent && main.parent.type === 'COMPONENT_SET') {
              o.set = main.parent.name;
              // Set-level variant axes (state=default/hover/…): collected ONCE
              // per set into the envelope — the screen is only complete when
              // the interactive variants are built too, and without the axes
              // nobody knows they exist.
              if (!SETS.has(main.parent.name)) {
                let props = null;
                try {
                  const vp = main.parent.variantGroupProperties;
                  if (vp) { props = {}; for (const k of Object.keys(vp)) props[k] = vp[k].values; }
                } catch (e) {}
                const entry = { id: main.parent.id, props };
                try { if (main.parent.key) entry.setKey = main.parent.key; } catch (e) {}
                try {
                  const dv = main.parent.defaultVariant || main.parent.children[0];
                  if (dv && dv.key) entry.dvKey = dv.key;
                } catch (e) {}
                SETS.set(main.parent.name, entry);
              }
            }
          }
        } catch (e) {}
        try {
          const cp = n.componentProperties;
          if (cp) {
            const props = {};
            for (const entry of Object.entries(cp)) {
              const d = entry[1];
              if (d && (d.type === 'VARIANT' || d.type === 'TEXT' || d.type === 'BOOLEAN')) props[entry[0].split('#')[0]] = d.value;
            }
            if (Object.keys(props).length) o.props = props;
          }
        } catch (e) {}
        if ('children' in n && n.children.length) {
          if (depth >= MAX_DEPTH) { o.more = n.children.length; return o; }
          o.kids = [];
          for (const c of n.children) { const k = await walk(c, depth + 1); if (k) o.kids.push(k); }
        }
        return o;
      }
      // Standalone COMPONENT (not a variant inside a set — those are reached
      // through the COMPONENT_SET branch above): capture id + publish key so
      // the census/DESIGN.md can list it with a reuse handle. Explicit id —
      // o.id is otherwise only present with --with-ids.
      if (n.type === 'COMPONENT') {
        o.id = n.id;
        try { if (n.key) o.key = n.key; } catch (e) {}
      }
      if ('children' in n && n.children.length) {
        if (depth >= MAX_DEPTH) { o.more = n.children.length; return o; }
        o.kids = [];
        for (const c of n.children) { const k = await walk(c, depth + 1); if (k) o.kids.push(k); }
      }
      return o;
    };
    const page = await figma.getNodeByIdAsync(${JSON.stringify(String(pageId))});
    if (!page) return JSON.stringify({ error: 'page not found' });
    if (typeof page.loadAsync === 'function') await page.loadAsync();
    let visited = 0;
    const count = (n) => { visited++; if ('children' in n) n.children.forEach(count); };
    count(page);
    const tops = page.children;
    const frames = [];
    for (const c of tops) { const f = await walk(c, 0); if (f) frames.push(f); }
    return JSON.stringify({ id: page.id, name: page.name, nodeCount: visited, frames, sets: setsOut() });
  })()`;
}

/**
 * Eval snippet: walk a single NODE (not a page) with the same options as
 * walkerCode. Used by `export code-spec <nodeId>`; wraps the result in the
 * same { id, name, frames } envelope so downstream formatters are shared.
 */
export function nodeWalkerCode(nodeId, opts = {}) {
  // Reuse walkerCode's body by swapping the page lookup for a node lookup:
  // walk the one node as the single "frame". The page-level count/loadAsync
  // is replaced by loading the node's page (dynamic-page requirement).
  const base = walkerCode('__NODE__', opts);
  return base.replace(
    /const page = await figma\.getNodeByIdAsync\("__NODE__"\);[\s\S]*?return JSON\.stringify\(\{ id: page\.id, name: page\.name, nodeCount: visited, frames, sets: setsOut\(\) \}\);/,
    `const node = await figma.getNodeByIdAsync(${JSON.stringify(String(nodeId))});
    if (!node) return JSON.stringify({ error: 'node not found: ' + ${JSON.stringify(String(nodeId))} + ' in the currently open file "' + figma.root.name + '". Safe Mode can only reach the file open in Figma Desktop — if this id comes from another file (check the URL file key), open that file first.' });
    let visited = 0;
    const count = (n) => { visited++; if ('children' in n) n.children.forEach(count); };
    count(node);
    return JSON.stringify({ id: node.id, name: node.name, nodeCount: visited, frames: [await walk(node, 0)].filter(Boolean), sets: setsOut() });`
  );
}

/**
 * Eval snippet: resolve a SECTION by name inside a node's subtree — the
 * `--section` sugar (Run-7 report: "give me section X in full depth straight
 * from the root" instead of copying long instance ids around). Breadth-first
 * so the shallowest hit wins; exact name match (case-insensitive) beats
 * substring match. Returns { id, name, matches } or { error }.
 */
export function sectionFinderCode(nodeId, sectionName) {
  return `(async () => {
    const root = await figma.getNodeByIdAsync(${JSON.stringify(String(nodeId))});
    if (!root) return JSON.stringify({ error: 'node not found: ' + ${JSON.stringify(String(nodeId))} + ' in the currently open file "' + figma.root.name + '".' });
    const want = ${JSON.stringify(String(sectionName).toLowerCase())};
    const queue = 'children' in root ? [...root.children] : [];
    let exact = null, partial = null, matches = 0;
    while (queue.length) {
      const n = queue.shift();
      if (n.visible === false) continue;
      const name = String(n.name).toLowerCase();
      if (name === want || name.includes(want)) {
        matches++;
        if (name === want && !exact) exact = n;
        if (!partial) partial = n;
      }
      if ('children' in n) queue.push(...n.children);
    }
    const hit = exact || partial;
    if (!hit) return JSON.stringify({ error: 'no node named like "' + want + '" under ' + root.name + ' — check the structure spec for the exact layer name.' });
    return JSON.stringify({ id: hit.id, name: hit.name, matches });
  })()`;
}

/**
 * Eval snippet: collect ASSET CANDIDATES under a node — no bytes yet, just a
 * small manifest. The CLI then pulls each asset in its own round-trip
 * (payload limits: a single eval with 8 artworks of raw bytes would not fit).
 *
 * Two kinds:
 *  - image: any visible node with a visible IMAGE fill. Deduped by imageHash
 *    — the ORIGINAL bytes are fetched later via getImageByHash, so five
 *    avatars sharing one photo yield one file.
 *  - vector: the TOPMOST subtree that is pure vector art (contains at least
 *    one hard vector — VECTOR/BOOLEAN_OPERATION/STAR/POLYGON — rects and
 *    ellipses alone are styling, not art). Not descended into.
 * Hidden nodes are skipped entirely (M1 rule: invisible does not exist).
 */
export function assetCollectorCode(nodeId) {
  return `(async () => {
    const root = await figma.getNodeByIdAsync(${JSON.stringify(String(nodeId))});
    if (!root) return JSON.stringify({ error: 'node not found: ' + ${JSON.stringify(String(nodeId))} + ' in the currently open file "' + figma.root.name + '". Safe Mode can only reach the file open in Figma Desktop.' });
    const SOFT_VEC = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, LINE: 1, POLYGON: 1, ELLIPSE: 1, RECTANGLE: 1 };
    const HARD_VEC = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1 };
    const hasImageFill = (n) => {
      try {
        return Array.isArray(n.fills) && n.fills.some((f) => f.type === 'IMAGE' && f.visible !== false && f.imageHash);
      } catch (e) { return false; }
    };
    const isVec = (n) => {
      /* Hidden children are IGNORED, not a veto — one invisible helper layer
         must not shatter a 232-vector pattern into 232 files. An IMAGE-filled
         shape is an image, never vector art — it vetoes its group. */
      if (hasImageFill(n)) return { vec: false, hard: false };
      if (SOFT_VEC[n.type]) return { vec: true, hard: !!HARD_VEC[n.type] };
      if ((n.type === 'GROUP' || n.type === 'FRAME') && 'children' in n && n.children.length) {
        let hard = false, any = false;
        for (const c of n.children) {
          if (c.visible === false) continue;
          any = true;
          const r = isVec(c);
          if (!r.vec) return { vec: false, hard: false };
          hard = hard || r.hard;
        }
        return { vec: any, hard };
      }
      return { vec: false, hard: false };
    };
    const images = new Map(); /* hash -> { hash, nodes: [] } */
    const vectors = [];
    /* Placement facts per node, so the manifest ALONE positions an overlay
       (no spec cross-reference needed): parent NODE ID, x/y offsets in the
       parent, absolute-positioning flag (same rule as the spec walker: an
       explicit ABSOLUTE child, or any child of a non-flex parent) and an
       overhang flag (rendered pixels extend beyond the parent's box — the
       assets builders drop first). */
    const posInfo = (n) => {
      const out = {};
      const p = n.parent;
      if (p && p.id) out.parentId = p.id;
      const rb = n.absoluteRenderBounds || n.absoluteBoundingBox;
      const pb = p && p.absoluteBoundingBox;
      if (rb && pb) {
        out.x = Math.round(rb.x - pb.x);
        out.y = Math.round(rb.y - pb.y);
        out.overhang = rb.x < pb.x - 1 || rb.y < pb.y - 1
          || rb.x + rb.width > pb.x + pb.width + 1
          || rb.y + rb.height > pb.y + pb.height + 1;
      }
      const parentLm = p && 'layoutMode' in p ? p.layoutMode : null;
      const freeParent = p && typeof p.width === 'number'
        && parentLm !== 'HORIZONTAL' && parentLm !== 'VERTICAL';
      out.absolute = n.layoutPositioning === 'ABSOLUTE' || !!freeParent;
      return out;
    };
    const pushVec = (n, ancestors, cluster) => {
      /* Rendered (post-transform) box: a rotated vector's width/height are
         pre-rotation and do NOT match the exported SVG. Prefer render bounds;
         fall back to node dimensions when boxes are unavailable. */
      const rb = n.absoluteRenderBounds || n.absoluteBoundingBox;
      const entry = {
        id: n.id, name: n.name,
        w: Math.round((rb && rb.width) || n.width || 0), h: Math.round((rb && rb.height) || n.height || 0),
        parent: ancestors.join(' / '), ancestors,
        ...posInfo(n),
      };
      if (cluster) entry.cluster = cluster;
      vectors.push(entry);
    };
    const walk = (n, ancestors, depth) => {
      if (n.visible === false) return;
      try {
        if (Array.isArray(n.fills)) {
          for (const f of n.fills) {
            if (f.type === 'IMAGE' && f.visible !== false && f.imageHash) {
              if (!images.has(f.imageHash)) images.set(f.imageHash, { hash: f.imageHash, nodes: [] });
              images.get(f.imageHash).nodes.push({
                id: n.id, name: n.name, w: Math.round(n.width || 0), h: Math.round(n.height || 0),
                parent: ancestors.join(' / '), ancestors,
                ...posInfo(n),
              });
            }
          }
        }
      } catch (e) {}
      /* The requested ROOT is never itself an asset — exporting the whole
         frame as one file is the job of "export node". Always descend at 0. */
      if (depth > 0) {
        const v = isVec(n);
        if (v.vec && v.hard) {
          pushVec(n, ancestors);
          return; /* topmost vector art — internals are the artwork itself */
        }
      }
      if ('children' in n && n.children.length) {
        /* Cluster rule: a container that is MOSTLY vector art (a pattern of
           hundreds of shapes with one stray non-vector child) exports as ONE
           artwork, not one file per shape. */
        const visible = n.children.filter((c) => c.visible !== false);
        if (depth > 0 && visible.length >= 6) {
          let vecKids = 0;
          for (const c of visible) { const r = isVec(c); if (r.vec && r.hard) vecKids++; }
          if (vecKids / visible.length >= 0.8) { pushVec(n, ancestors, vecKids); return; }
        }
        for (const c of visible) walk(c, ancestors.concat(n.name), depth + 1);
      }
    };
    walk(root, [], 0);
    return JSON.stringify({ id: root.id, name: root.name, images: [...images.values()], vectors });
  })()`;
}

/**
 * Eval snippet: every variable ACTUALLY BOUND in a node's subtree — the
 * scoped token set for `export css`/`export dtcg <nodeId>`.
 *
 * Why not getLocalVariablesAsync(): that reads the LOCAL collections of the
 * open file only. A design bound to library tokens returns none of them, and
 * when the file also carries unrelated local collections (earlier test runs,
 * another theme) the export silently delivers the wrong system — the exact
 * failure of the plant-care-vs-DLS token bug. Bound variables resolve through
 * getVariableByIdAsync, which reaches library variables too.
 *
 * Collected: node.boundVariables (fills, strokes, gaps, radii, typography …),
 * the boundVariables of every applied shared style (text/fill/stroke/effect),
 * and the full alias chain of each hit (alias targets export as tokens of
 * their own). Values are first-mode, alias-resolved; COLOR → hex (8-digit
 * when alpha < 1). Each entry carries its collection name and, when the
 * variable is itself an alias, the target's name as `ref`.
 */
export function usedVariablesCode(nodeId) {
  return `(async () => {
    const root = await figma.getNodeByIdAsync(${JSON.stringify(String(nodeId))});
    if (!root) return JSON.stringify({ error: 'node not found: ' + ${JSON.stringify(String(nodeId))} + ' in the currently open file "' + figma.root.name + '". Safe Mode can only reach the file open in Figma Desktop.' });
    const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('') + (c.a != null && c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, '0') : '');
    const ids = [];
    const idSet = new Set();
    const add = (id) => { if (id && !idSet.has(id)) { idSet.add(id); ids.push(id); } };
    const addBV = (bv) => {
      if (!bv) return;
      for (const key of Object.keys(bv)) {
        const val = bv[key];
        const list = Array.isArray(val) ? val : [val];
        for (const it of list) if (it && it.id) add(it.id);
      }
    };
    const styleIds = new Set();
    const walk = (n) => {
      if (n.visible === false) return;
      try { addBV(n.boundVariables); } catch (e) {}
      for (const k of ['textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId']) {
        try { const v = n[k]; if (typeof v === 'string' && v) styleIds.add(v); } catch (e) {}
      }
      /* paint-level bindings (a gradient stop bound to a color token) */
      try { for (const p of (Array.isArray(n.fills) ? n.fills : [])) addBV(p.boundVariables); } catch (e) {}
      try { for (const p of (Array.isArray(n.strokes) ? n.strokes : [])) addBV(p.boundVariables); } catch (e) {}
      if ('children' in n) for (const c of n.children) walk(c);
    };
    walk(root);
    for (const sid of styleIds) {
      try { const st = await figma.getStyleByIdAsync(sid); if (st) addBV(st.boundVariables); } catch (e) {}
    }
    const colName = new Map();
    const collectionName = async (cid) => {
      if (!cid) return null;
      if (colName.has(cid)) return colName.get(cid);
      let name = null;
      try { const c = await figma.variables.getVariableCollectionByIdAsync(cid); if (c) name = c.name; } catch (e) {}
      colName.set(cid, name);
      return name;
    };
    const out = [];
    const seen = new Set();
    for (let i = 0; i < ids.length && i < 2000; i++) {
      const id = ids[i];
      if (seen.has(id)) continue;
      seen.add(id);
      let v = null;
      try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) {}
      if (!v) continue;
      let val = Object.values(v.valuesByMode || {})[0];
      let ref = null;
      let guard = 10;
      while (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && guard-- > 0) {
        add(val.id); /* alias target exports as a token of its own */
        let t = null;
        try { t = await figma.variables.getVariableByIdAsync(val.id); } catch (e) {}
        if (!t) { val = null; break; }
        if (!ref) ref = t.name;
        val = Object.values(t.valuesByMode || {})[0];
      }
      if (v.resolvedType === 'COLOR' && val && typeof val === 'object' && 'r' in val) val = hex(val);
      if (val && typeof val === 'object') val = null; /* unresolvable */
      out.push({ name: v.name, type: v.resolvedType, value: val === undefined ? null : val, ref, collection: await collectionName(v.variableCollectionId) });
    }
    return JSON.stringify({ file: figma.root.name, node: root.name, id: root.id, vars: out });
  })()`;
}

/** Eval snippet: original encoded bytes of one image fill, base64. */
export function imageBytesCode(hash) {
  return `(async () => {
    const img = figma.getImageByHash(${JSON.stringify(String(hash))});
    if (!img) return JSON.stringify({ error: 'image not found' });
    const bytes = await img.getBytesAsync();
    let size = null;
    try { size = await img.getSizeAsync(); } catch (e) {}
    return JSON.stringify({ base64: figma.base64Encode(bytes), size });
  })()`;
}

/** Eval snippet: SVG markup of one node, base64. */
export function svgBytesCode(nodeId) {
  return `(async () => {
    const n = await figma.getNodeByIdAsync(${JSON.stringify(String(nodeId))});
    if (!n) return JSON.stringify({ error: 'node not found' });
    if (!('exportAsync' in n)) return JSON.stringify({ error: 'node cannot be exported' });
    const bytes = await n.exportAsync({ format: 'SVG' });
    return JSON.stringify({ base64: figma.base64Encode(bytes) });
  })()`;
}

// ============ Aggregator (pure, Node-side) ============

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

/** Hex '#rrggbb' → { h, s, l } each 0..1 (h 0..360). */
export function hexToHsl(hexStr) {
  const v = hexStr.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/**
 * Walk all page trees and count every design decision.
 * Returns { colors, typography, radii, spacing, shadows: Map, fonts: Set,
 *           componentSets: [{name, page, props, variants, sample, key, id, setKey, setId}],
 *           components: [{name, page, key, id}] } — `components` are STANDALONE
 * components (variants inside a set are excluded via the underSet flag).
 * Color keys are bare hex (opacity suffix stripped); typography keys are
 * 'family|style|size|lh|ls'.
 */
export function buildCensus(pages) {
  const census = {
    colors: new Map(), typography: new Map(), radii: new Map(),
    spacing: new Map(), shadows: new Map(), fonts: new Set(), componentSets: [],
    components: [],
  };
  const visitPaints = (arr) => (arr || []).forEach(p => {
    if (typeof p === 'string' && p.startsWith('#')) bump(census.colors, p.split('@')[0]);
  });
  const visit = (n, pageName, underSet = false) => {
    visitPaints(n.fills);
    visitPaints(n.strokes);
    if (n.gap > 0) bump(census.spacing, n.gap);
    (n.pad || []).forEach(v => { if (v > 0) bump(census.spacing, v); });
    if (n.r != null) (Array.isArray(n.r) ? n.r : [n.r]).forEach(v => { if (v > 0) bump(census.radii, v); });
    (n.fx || []).forEach(e => bump(census.shadows, JSON.stringify(e)));
    if (n.txt && n.txt.font) {
      census.fonts.add(n.txt.font);
      bump(census.typography, [n.txt.font, n.txt.style || '', n.txt.size ?? '', n.txt.lh ?? '', n.txt.ls ?? ''].join('|'));
    }
    if (n.t === 'COMPONENT_SET') {
      census.componentSets.push({
        name: n.n, page: pageName, props: n.vp || {}, variants: n.kidCount || 0,
        sample: n.kids?.[0], key: n.key, id: n.id, setKey: n.setKey, setId: n.setId,
      });
    }
    // A set's sample variant is walked as its child — it is NOT a standalone.
    if (n.t === 'COMPONENT' && !underSet) {
      census.components.push({ name: n.n, page: pageName, key: n.key, id: n.id });
    }
    (n.kids || []).forEach(k => visit(k, pageName, n.t === 'COMPONENT_SET'));
  };
  for (const page of pages) (page.frames || []).forEach(f => visit(f, page.name));
  return census;
}

/**
 * Rank colors by usage and assign the semantic names the plugin format uses
 * (background, surface, text-primary, text-secondary, text-tertiary, border,
 * accent — with -alt / -3 / -4 suffixes for repeats within a role).
 * Input: Map<hex, count>. Output: { name: hex } ordered by usage.
 */
export function assignSemanticNames(colors) {
  const roleOf = (hex) => {
    const { s, l } = hexToHsl(hex);
    if (s > 0.25 && l > 0.08 && l < 0.95) return 'accent';
    if (l >= 0.97) return 'background';
    if (l >= 0.85) return 'surface';
    if (l >= 0.6) return 'border';
    if (l >= 0.45) return 'text-tertiary';
    if (l >= 0.25) return 'text-secondary';
    return 'text-primary';
  };
  const ranked = [...colors.entries()].sort((a, b) => b[1] - a[1]);
  const used = new Map(); // role → count so far
  const out = {};
  for (const [hex] of ranked) {
    const role = roleOf(hex);
    const nth = (used.get(role) || 0) + 1;
    used.set(role, nth);
    const name = nth === 1 ? role : nth === 2 ? `${role}-alt` : `${role}-${nth}`;
    out[name] = hex;
  }
  return out;
}

const WEIGHT_MAP = {
  thin: 100, extralight: 200, 'extra light': 200, light: 300, regular: 400,
  medium: 500, semibold: 600, 'semi bold': 600, bold: 700,
  extrabold: 800, 'extra bold': 800, black: 900,
};

/** 'Semi Bold Italic' → 600. Unknown styles → 400. */
export function styleToWeight(style) {
  const s = String(style || '').toLowerCase().replace(/\s*italic\s*/, '').trim();
  return WEIGHT_MAP[s] || 400;
}

/**
 * Map a typography census (Map<'family|style|size|lh|ls', count>) onto the
 * scale names parseDesignMd's typography import understands:
 * display (>=36), h1..h6 (descending unique sizes >= body), body-lg, body,
 * body-sm, caption (<=12). Within a size, highest-usage entry wins the base
 * name; further entries get '-2', '-3' suffixes.
 */
export function buildTypeScale(typography) {
  const entries = [...typography.entries()].map(([key, count]) => {
    const [family, style, size, lh, ls] = key.split('|');
    return { family, style, size: parseFloat(size), lh: lh ? parseFloat(lh) : undefined, ls: ls ? parseFloat(ls) : undefined, count };
  }).filter(e => Number.isFinite(e.size));
  entries.sort((a, b) => b.size - a.size || b.count - a.count);

  const nameFor = (size, headingIdx) => {
    if (size >= 36) return 'display';
    if (size >= 18 && headingIdx <= 6) return `h${headingIdx}`;
    if (size >= 16) return 'body-lg';
    if (size >= 13) return 'body';
    if (size > 12) return 'body-sm';
    return 'caption';
  };
  const out = {};
  const usedNames = new Map();
  let headingIdx = 1;
  let lastHeadingSize = null;
  for (const e of entries) {
    let base = nameFor(e.size, headingIdx);
    if (base.startsWith('h')) {
      if (lastHeadingSize !== null && e.size < lastHeadingSize) headingIdx += 1;
      base = nameFor(e.size, headingIdx);
      lastHeadingSize = e.size;
    }
    const nth = (usedNames.get(base) || 0) + 1;
    usedNames.set(base, nth);
    const name = nth === 1 ? base : `${base}-${nth}`;
    out[name] = {
      fontFamily: e.family, fontSize: e.size, fontWeight: styleToWeight(e.style),
      ...(e.lh !== undefined ? { lineHeight: e.lh } : {}),
      ...(e.ls !== undefined ? { letterSpacing: e.ls } : {}),
    };
  }
  return out;
}

/** Most plausible base unit (2, 4 or 8) from a spacing census. Default 8. */
export function inferBaseUnit(spacing) {
  if (!spacing.size) return 8;
  const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  const values = [...spacing.keys()].filter(v => Number.isFinite(v) && v > 0);
  if (!values.length) return 8;
  const g = values.reduce((acc, v) => gcd(acc, v));
  if (g >= 8) return 8;
  if (g >= 4) return 4;
  return 2;
}

/** Radius census → { 'radius-sm': 2, 'radius-md': 6, ... , 'radius-full': 9999 }. */
export function nameRadii(radii) {
  const values = [...radii.keys()].sort((a, b) => a - b);
  const out = {};
  const tiers = ['radius-sm', 'radius-md', 'radius-lg'];
  let tierIdx = 0;
  const usedNames = new Map();
  for (const v of values) {
    let base;
    if (v >= 999) base = 'radius-full';
    else { base = tiers[Math.min(tierIdx, tiers.length - 1)]; tierIdx += 1; }
    const nth = (usedNames.get(base) || 0) + 1;
    usedNames.set(base, nth);
    out[nth === 1 ? base : `${base}-${nth}`] = v;
  }
  return out;
}

// ============ Structure formatting ============

/** Signature for dedup: structural identity key (excludes accumulated repeat
 * count and node ids — ids are unique by definition and would defeat dedup,
 * while differing CONTENT (text, icons) intentionally keeps siblings apart). */
const sibKey = (n) => JSON.stringify(n, (k, v) => (k === 'repeat' || k === 'id') ? undefined : v);

/** Collapse runs of structurally identical siblings into one node + repeat count. */
export function dedupSiblings(kids) {
  const out = [];
  for (const k of kids) {
    const prev = out[out.length - 1];
    if (prev && sibKey(prev) === sibKey(k)) prev.repeat = (prev.repeat || 1) + 1;
    else out.push({ ...k });
  }
  return out;
}

const layoutDesc = (n) => {
  if (!n.lm) return null;
  const parts = [n.lm === 'HORIZONTAL' ? 'horizontal row' : 'vertical stack'];
  if (n.gap) parts.push(`gap ${n.gap}px`);
  if (n.pad) {
    const [t, r, b, l] = n.pad;
    parts.push(t === r && r === b && b === l ? `padding ${t}px` : `padding ${t}/${r}/${b}/${l}px`);
  }
  return parts.join(', ');
};

/**
 * One node → markdown bullet lines (plugin notation):
 * `- **Name** · \`TYPE\` · WxH · horizontal row, gap 8px, padding … · N children`
 * Text nodes append `· "chars"`. Repeats append `· ×N`. Omissions are always
 * explicit: `_…and N more_`.
 */
export function formatTree(node, depth) {
  const indent = '  '.repeat(depth);
  const bits = [`**${node.n}**`, `\`${node.t}\``];
  if (node.w != null) bits.push(`${node.w}×${node.h}`);
  const ld = layoutDesc(node);
  if (ld) bits.push(ld);
  if (node.kids?.length || node.kidCount) bits.push(`${node.kidCount ?? node.kids.length} children`);
  if (node.txt) bits.push(`“${node.txt.chars}”`);
  if (node.mc || node.main) {
    // Prefer the resolved main-component name (truth) over the instance's
    // layer name (often stale after swaps); qualify with the parent set.
    const target = node.main || node.mc;
    const set = node.set && node.set !== target ? `${node.set} / ` : '';
    bits.push(`instance of ${set}${target}`);
    if (node.props) bits.push(Object.entries(node.props).map(([k, v]) => `${k}=${v}`).join(', '));
  }
  if (node.repeat) bits.push(`×${node.repeat}`);
  const lines = [`${indent}- ${bits.join(' · ')}`];
  if (node.kids) {
    for (const k of dedupSiblings(node.kids)) lines.push(...formatTree(k, depth + 1));
  }
  if (node.more) lines.push(`${'  '.repeat(depth + 1)}- _…and ${node.more} more_`);
  return lines;
}

/** variantGroupProperties → markdown property/values table. */
export function variantMatrixTable(props) {
  const rows = Object.entries(props || {}).map(([prop, def]) =>
    `| ${prop} | ${(def.values || []).join(', ')} |`);
  if (!rows.length) return '_no variant properties_';
  return ['| Property | Values |', '|---|---|', ...rows].join('\n');
}

/**
 * Reuse handle markdown line for a component census entry. Pure.
 * Returns the line, or null when there is no handle to emit.
 */
export function reuseHandleLine({ key, id } = {}) {
  const parts = [];
  if (key) parts.push(`key \`${key}\``);
  if (id) parts.push(`node \`${id}\``);
  if (!parts.length) return null;
  return `Reuse: import existing — ${parts.join(' · ')}`;
}

// ============ Variables (real Figma variable collections) ============

/**
 * Replace every { alias: <variableId> } in a captured collection list with
 * { alias: <variableName> } so the export is portable (ids are file-local and
 * meaningless after re-import; names are the stable reference). Unknown ids
 * (e.g. aliases to other libraries) are left as the raw id. Pure; returns a
 * new structure, does not mutate the input.
 */
export function resolveAliases(collections = []) {
  const idToName = new Map();
  for (const col of collections)
    for (const v of col.variables || []) idToName.set(v.id, v.name);
  const resolveVal = (val) =>
    val && typeof val === 'object' && 'alias' in val
      ? { alias: idToName.get(val.alias) || val.alias }
      : val;
  return collections.map(col => ({
    name: col.name,
    modes: (col.modes || []).map(m => m.name),
    variables: (col.variables || []).map(v => ({
      name: v.name, type: v.type,
      values: Object.fromEntries(Object.entries(v.values || {}).map(([m, val]) => [m, resolveVal(val)])),
    })),
  }));
}

/** One variable value → a markdown table cell. Pure. */
export function formatVarValue(val) {
  if (val == null) return '—';
  if (typeof val === 'object' && 'alias' in val) return `→ var:${val.alias}`;
  if (typeof val === 'string') return val.startsWith('#') ? `\`${val}\`` : `"${val}"`;
  return String(val);
}

/**
 * Escape an arbitrary string for use inside a single markdown table cell.
 * Variable / collection / mode names and STRING token values come from any
 * design system, so they may contain `|` (column separator) or newlines that
 * would otherwise shatter the table. The JSON token block keeps raw values —
 * this is purely for the human-readable tables. Pure.
 */
export function mdCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Resolved collections → the JSON `variables` block: keyed by collection name,
 * each with its mode list and a { name → {type, values} } variable map.
 * `values` keeps the resolved-alias shape ({ alias: name }) so it roundtrips.
 * Collection names are not unique in Figma, so colliding names are suffixed
 * ` (2)`, ` (3)`… rather than silently overwriting each other.
 */
export function buildVariableTokens(resolvedCollections = []) {
  const out = {};
  for (const col of resolvedCollections) {
    let key = col.name;
    for (let n = 2; key in out; n++) key = `${col.name} (${n})`;
    out[key] = {
      modes: col.modes,
      variables: Object.fromEntries(col.variables.map(v => [v.name, { type: v.type, values: v.values }])),
    };
  }
  return out;
}

// ============ Markdown writer ============

export const ALL_SECTIONS = [
  'identity', 'structure', 'color', 'variables', 'typography', 'spacing',
  'depth', 'components', 'states', 'rules', 'extending', 'tokens',
];

const SECTION_TITLES = {
  identity: 'Identity', structure: 'Structure', color: 'Color', variables: 'Variables',
  typography: 'Typography', spacing: 'Spacing & Layout', depth: 'Depth & Motion',
  components: 'Components', states: 'States', rules: 'Rules',
  extending: 'Extending this system', tokens: 'Machine-readable tokens',
};

/**
 * extraction = { fileName, date, pages: [walker page JSON] }
 * options = { sections?: string[] }  (subset of ALL_SECTIONS, order ignored)
 *
 * Output layout matches the "Design to Markdown" plugin format so
 * parseDesignMd() (Format B: json design-tokens block) reads it unchanged.
 */
export function generateDesignMd(extraction, options = {}) {
  const sections = ALL_SECTIONS.filter(s => !options.sections || options.sections.includes(s));
  const census = buildCensus(extraction.pages);
  const colorNames = assignSemanticNames(census.colors);
  const typeScale = buildTypeScale(census.typography);
  const radiusNames = nameRadii(census.radii);
  const baseUnit = inferBaseUnit(census.spacing);
  const fonts = [...census.fonts];
  const hexToName = Object.fromEntries(Object.entries(colorNames).map(([n, h]) => [h, n]));
  const resolvedVars = resolveAliases(extraction.variables || []);

  const out = [];
  out.push(`# DESIGN.md -- ${extraction.fileName}`, '');
  out.push('<!-- extraction-meta');
  out.push(`source: Figma file "${extraction.fileName}"`);
  out.push(`scope: ${extraction.pages.length} page(s)`);
  out.push(`date: ${extraction.date}`);
  out.push(`nodes-scanned: ${extraction.pages.reduce((a, p) => a + (p.nodeCount || 0), 0)}`);
  out.push(`generator: figma-cli extract`);
  out.push('-->', '');

  let num = 0;
  const header = (key) => { num += 1; out.push(`## ${num}. ${SECTION_TITLES[key]}`, ''); };

  for (const key of sections) {
    if (key === 'identity') {
      header(key);
      out.push(`**In one line:** A design system using ${fonts.join(', ') || 'system fonts'} with ${census.colors.size} unique colors extracted directly from Figma.`, '');
      out.push('**Signature Techniques:**');
      out.push('- Consistent auto-layout spacing system');
      out.push(`- Component library with ${census.componentSets.reduce((a, c) => a + c.variants, 0)} variants across ${census.componentSets.length} component sets`);
      out.push('');
    }
    if (key === 'structure') {
      header(key);
      out.push('High-level composition. Each entry: frame name, type, dimensions, auto-layout.', '');
      for (const page of extraction.pages) {
        out.push(`### Page: ${page.name}`, '');
        if (page.error) { out.push(`<!-- page "${page.name}" skipped: ${page.error} -->`, ''); continue; }
        out.push(`_${page.frames.length} top-level frame(s)_`, '');
        for (const frame of page.frames) out.push(...formatTree(frame, 0));
        out.push('');
      }
    }
    if (key === 'color') {
      header(key);
      out.push('### Palette', '');
      out.push('| Token | Hex | Usage count |', '|---|---|---|');
      const ranked = [...census.colors.entries()].sort((a, b) => b[1] - a[1]);
      for (const [hex, count] of ranked) out.push(`| ${hexToName[hex]} | \`${hex}\` | ${count} |`);
      out.push('');
    }
    if (key === 'variables') {
      header(key);
      if (!resolvedVars.length) {
        out.push('_no local variables found — this file has no variable collections, the palette above is sampled from raw fills_', '');
      } else {
        out.push('Real Figma variable collections — the authoritative tokens (names, modes, values). These come straight from the file, unlike the sampled palette above. `figma-cli import` can recreate them as variables.', '');
        for (const col of resolvedVars) {
          out.push(`### Collection: ${col.name}  ·  ${col.variables.length} variables  ·  modes: ${col.modes.join(', ')}`, '');
          out.push(`| Variable | Type | ${col.modes.map(mdCell).join(' | ')} |`);
          out.push(`|---|---|${col.modes.map(() => '---').join('|')}|`);
          for (const v of col.variables) {
            const cells = col.modes.map(m => mdCell(formatVarValue(v.values[m])));
            out.push(`| ${mdCell(v.name)} | ${v.type} | ${cells.join(' | ')} |`);
          }
          out.push('');
        }
      }
    }
    if (key === 'typography') {
      header(key);
      out.push('### Fonts', '');
      for (const f of fonts) out.push(`- ${f}`);
      out.push('', '### Scale', '');
      out.push('| Token | Family | Size | Weight | Line height |', '|---|---|---|---|---|');
      for (const [name, t] of Object.entries(typeScale)) {
        out.push(`| ${name} | ${t.fontFamily} | ${t.fontSize}px | ${t.fontWeight} | ${t.lineHeight != null ? t.lineHeight + 'px' : 'auto'} |`);
      }
      out.push('');
    }
    if (key === 'spacing') {
      header(key);
      out.push('### Base Unit', '', `${baseUnit}px`, '');
      out.push('### Border Radius', '');
      out.push('| Token | Value |', '|---|---|');
      for (const [name, v] of Object.entries(radiusNames)) out.push(`| ${name} | ${v}px |`);
      out.push('');
    }
    if (key === 'depth') {
      header(key);
      out.push('### Elevation', '');
      const shadows = [...census.shadows.entries()].sort((a, b) => b[1] - a[1]);
      if (!shadows.length) out.push('_no shadow effects found_');
      for (const [json, count] of shadows) {
        const e = JSON.parse(json);
        if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
          out.push(`- ${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${e.color} @ ${Math.round(e.a * 100)}% (used ${count}×)`);
        } else {
          out.push(`- ${e.type} blur ${e.blur}px (used ${count}×)`);
        }
      }
      out.push('');
    }
    if (key === 'components') {
      header(key);
      const standalones = census.components || [];
      if (!census.componentSets.length && !standalones.length) out.push('_no components found_', '');
      for (const cs of census.componentSets) {
        out.push(`### ${cs.name}`, '');
        out.push(`Page: ${cs.page} · ${cs.variants} variants`, '');
        // Set key = the stable IDENTITY of the whole component (what a
        // Storybook story mirrors). The Reuse line below stays the
        // INSTANCING handle (default variant) — parseReuseLine depends on it.
        if (cs.setKey) out.push(`Set key: \`${cs.setKey}\``, '');
        const reuse = reuseHandleLine({ key: cs.key, id: cs.id });
        if (reuse) out.push(reuse, '');
        out.push(variantMatrixTable(cs.props), '');
        if (cs.sample) {
          out.push('Sample variant structure:', '');
          out.push(...formatTree(cs.sample, 0), '');
        }
      }
      for (const c of standalones) {
        out.push(`### ${c.name}`, '');
        out.push(`Page: ${c.page} · standalone component`, '');
        const reuse = reuseHandleLine({ key: c.key, id: c.id });
        if (reuse) out.push(reuse, '');
      }
    }
    if (key === 'states') {
      header(key);
      out.push('State tokens should be derived from the base palette above. Recommended mappings:', '');
      out.push('| State | Treatment |', '|-------|-----------|');
      out.push('| Hover | Lighten/darken accent by 10% |');
      out.push('| Focus | 2px ring using accent color with 30% opacity |');
      out.push('| Disabled | 40% opacity, no pointer events |');
      out.push('| Error | Use danger color for border and text |', '');
    }
    if (key === 'rules') {
      header(key);
      out.push('### Do', '');
      out.push(`- Use the ${baseUnit}px base unit for all spacing decisions`);
      const accent = colorNames['accent'];
      if (accent) out.push(`- Use \`${accent}\` (accent) as the primary accent color`);
      out.push('- Bind colors to the tokens below instead of hardcoding hex values', '');
      out.push("### Don't", '');
      out.push('- Introduce new colors without adding them to the palette');
      out.push('- Mix corner radii outside the radius scale', '');
    }
    if (key === 'extending') {
      header(key);
      out.push('### How to reuse this DESIGN.md', '');
      out.push('Import into Figma with `figma-cli import <this file>` — colors, radii and typography become variables.', '');
      out.push('### When to add a new token vs reuse', '');
      out.push('Reuse the closest existing token; add a new one only when a new semantic role appears.', '');
    }
    if (key === 'tokens') {
      header(key);
      out.push('The block below is the canonical token map. It mirrors the tables above but is unambiguous and parseable.', '');
      const tokens = {
        $schema: 'design-tokens.v1',
        meta: { source: extraction.fileName, generated: extraction.date },
        color: colorNames,
        typography: typeScale,
        spacing: { 'base-unit': baseUnit },
        radius: Object.fromEntries(Object.entries(radiusNames).map(([n, v]) => [n, `${v}px`])),
        shadow: {},
        fonts,
        ...(resolvedVars.length ? { variables: buildVariableTokens(resolvedVars) } : {}),
      };
      let i = 0;
      for (const [json] of [...census.shadows.entries()].sort((a, b) => b[1] - a[1])) {
        const e = JSON.parse(json);
        if (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW') continue;
        i += 1;
        tokens.shadow[`shadow-${i}`] = `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${e.color}${e.a < 1 ? Math.round(e.a * 255).toString(16).padStart(2, '0') : ''}`;
      }
      out.push('```json design-tokens');
      out.push(JSON.stringify(tokens, null, 2));
      out.push('```', '');
    }
  }
  return out.join('\n');
}

/** Full uncompressed tree for one page (used by --split). */
export function generatePageStructureMd(page) {
  const out = [`# Structure: ${page.name}`, ''];
  if (page.error) { out.push(`_page skipped: ${page.error}_`); return out.join('\n'); }
  for (const frame of page.frames) out.push(...formatTree(frame, 0));
  return out.join('\n');
}

/** ~3.8 chars per token is a good markdown estimate. */
const CHARS_PER_TOKEN = 3.8;

/**
 * Estimated LLM token cost of the Structure section for these pages.
 * Used by the extract command to auto-split oversized files: above the
 * threshold the structure trees move to DESIGN-structure/ so the main
 * DESIGN.md stays loadable in one AI context.
 */
export function estimateStructureTokens(pages) {
  let chars = 0;
  for (const page of pages) {
    if (page.error) continue;
    for (const frame of page.frames || []) {
      chars += formatTree(frame, 0).join('\n').length + 1;
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN);
}
