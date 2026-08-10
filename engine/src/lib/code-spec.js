/**
 * Code-spec formatter — turns a walker-v2 node tree (design-extract.js with
 * resolveInstances/withIds/withVars) into the two-phase markdown spec that
 * `export code-spec` prints.
 *
 * Phases mirror how a developer builds a screen:
 *  - structure: hierarchy + REAL content only (text characters, resolved
 *    icon/component names, variants, layout direction) — "the HTML".
 *  - style: per-node visual detail (sizes, gap/padding/alignment/sizing,
 *    fills/strokes with variable names, radius, effects, typography) — "the CSS".
 *  - all: both merged into one tree.
 *
 * Everything here is pure (no Figma access) so it is unit-testable.
 */
import { dedupSiblings } from '../design-extract.js';
import { assetFileName } from './asset-names.js';
import {
  captureVectorFacts,
  capturedVectorCluster,
  isCapturedVectorArt,
} from './asset-policy.js';

/**
 * True when a node renders vector geometry rather than content: a vector
 * primitive, or a GROUP/FRAME whose entire subtree is vector primitives. Pure.
 */
export function isVectorish(node) {
  return captureVectorFacts(node).vec;
}

/**
 * Vector ART: a subtree `export assets` will write as ONE svg file — pure
 * vector with at least one hand-drawn path. The spec renders it as a single
 * asset-pointer line. Soft-only primitives (a lone RECTANGLE gradient
 * overlay, an ELLIPSE dot) are NOT art: they render as regular styled nodes,
 * fills and all — they used to vanish from the spec entirely. Pure.
 */
export function isVectorArt(node) {
  return isCapturedVectorArt(node);
}

/**
 * Vector CLUSTER: a container that is mostly vector art (≥6 children, ≥80%
 * art). Mirrors the collector rule in assetCollectorCode — spec and
 * `export assets` must agree on what counts as ONE artwork, or the spec
 * floods with per-shape lines the exporter never writes. Pure.
 */
export function isVectorCluster(node) {
  return capturedVectorCluster(node).cluster;
}

/**
 * Icon instance: an INSTANCE whose visible children are ALL vector geometry.
 * Its identity is the main-component name — internals stay collapsed, so
 * `icon → calendar` never floods the spec with its paths. Pure.
 */
export function isIconInstance(node) {
  return node.t === 'INSTANCE' && (node.kids || []).length > 0 && node.kids.every(isVectorish);
}

/** Paint-less styling helper (bounding rect, mask shape): renders nothing. */
const isInvisibleHelper = (node) =>
  isVectorish(node) && !(node.kids?.length) && !node.fills && !node.strokes && !node.fx;

const pad4 = (pad) => {
  const [t, r, b, l] = pad;
  if (t === r && r === b && b === l) return `pad${t}`;
  if (t === b && r === l) return `pad${t}/${r}`;
  return `pad${t}/${r}/${b}/${l}`;
};

const ALIGN_NAMES = { CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'between', BASELINE: 'baseline' };

/** Variable-binding suffix for a paint/number segment: ` → var(name)`. */
const varSuffix = (name) => (name ? ` → var(${name})` : '');

/** First bound-variable name among the given boundVariables keys. */
const bvName = (node, ...keys) => {
  if (!node.bv) return null;
  for (const k of keys) if (node.bv[k]) return node.bv[k];
  return null;
};

/**
 * Identity segment: layer name plus what the node IS — quoted characters for
 * TEXT, resolved component for instances (set/main + variant props). Pure.
 */
export function identSeg(node) {
  if (node.t === 'TEXT') {
    const chars = `"${node.txt?.chars ?? ''}"`;
    // Layer name usually mirrors the characters; only show it when it adds
    // information (a semantic label like "Title" or "Meta").
    const name = node.n && node.n !== node.txt?.chars ? `${node.n}: ` : '';
    return `${name}${chars}`;
  }
  const parts = [node.n];
  if (node.main || node.mc) {
    const target = node.main || node.mc;
    const set = node.set && node.set !== target ? `${node.set}/` : '';
    let ref = `→ ${set}${target}`;
    if (node.props) {
      // A variant's main-component name IS its prop list ("Variant=Ghost,
      // Size=SM") — repeating those pairs in the parens doubled every
      // instance line for zero information. Show only the props the name
      // does not already state (text overrides, booleans, extra variants).
      const inMain = new Set(String(target).split(',').map((s) => s.trim()));
      const props = Object.entries(node.props)
        .map(([k, v]) => `${k}=${v}`)
        .filter((pair) => !inMain.has(pair))
        .join(', ');
      if (props) ref += ` (${props})`;
    }
    parts.push(ref);
  }
  return parts.join(' ');
}

/**
 * Absolute-overlay segment, CSS-ready: `abs left:12 top:-5`,
 * `abs right:16 bottom:16`, stretch pins both edges
 * (`abs left:0 right:0 top:-64`). x/y are offsets from the anchored edges;
 * non-right/bottom anchors (incl. center) count from left/top. Pure.
 */
export function absSeg(abs) {
  // Edge-to-edge overlay: never pin it to a corner with fixed offsets —
  // it must resize with the parent (CSS `inset: 0`).
  if (abs.inset) return 'abs inset:0 (fills parent — size with it)';
  const [av, ah] = String(abs.a || 'top-left').split('-');
  const parts = [ah === 'right' ? `right:${abs.x}` : `left:${abs.x}`];
  if (abs.r != null) parts.push(`right:${abs.r}`);
  parts.push(av === 'bottom' ? `bottom:${abs.y}` : `top:${abs.y}`);
  if (abs.b != null) parts.push(`bottom:${abs.b}`);
  // SCALE constraints: offsets AND size are proportional to the parent.
  const scale = ah === 'scale' || av === 'scale' ? ' (scales with parent — keep proportional, use %)' : '';
  return `abs ${parts.join(' ')}${scale}`;
}

/** Overhang marker: the overlay's geometry extends beyond its parent. Pure. */
const ovSeg = (ov) => (ov === 'clip'
  ? 'overhangs parent — parent clips (overflow hidden cuts the excess)'
  : 'overhangs parent — visible by design, do not drop or resize');

/** row | col | grid — the structural direction word. Pure. */
const dirName = (lm) => (lm === 'HORIZONTAL' ? 'row' : lm === 'GRID' ? 'grid' : 'col');

/** Grid template segment: `grid 2×2 row-gap0 col-gap2`. Pure. */
const gridSeg = (node) => {
  let s = 'grid';
  const g = node.grid;
  if (g && (g.rows != null || g.cols != null)) s += ` ${g.rows ?? '?'}×${g.cols ?? '?'}`;
  if (g?.rowGap != null) s += ` row-gap${g.rowGap}`;
  if (g?.colGap != null) s += ` col-gap${g.colGap}`;
  return s;
};

/** Grid cell segment, 1-based for direct CSS use: `cell row:1 col:2/span 2`. Pure. */
export const cellSeg = (cell) => {
  const parts = [];
  if (cell.r != null) parts.push(`row:${cell.r + 1}${cell.rs ? `/span ${cell.rs}` : ''}`);
  if (cell.c != null) parts.push(`col:${cell.c + 1}${cell.cs ? `/span ${cell.cs}` : ''}`);
  return `cell ${parts.join(' ')}`;
};

/** Layout segment. Direction is structural; the rest is style detail. Pure. */
export function layoutSeg(node, { detail }) {
  const parts = [];
  if (node.lm) parts.push(node.lm === 'GRID' ? gridSeg(node) : dirName(node.lm));
  if (node.scroll) {
    const scroll = {
      HORIZONTAL_SCROLLING: 'horizontal', VERTICAL_SCROLLING: 'vertical',
      HORIZONTAL_AND_VERTICAL_SCROLLING: 'both',
    }[node.scroll] || String(node.scroll).toLowerCase();
    parts.push(`scroll:${scroll}`);
  }
  if (node.fixed) parts.push('prototype-fixed');
  // Structural placement reads BEFORE the flow detail — the reader must know
  // "this is a grid cell / not a flow child" first.
  if (node.cell) parts.push(cellSeg(node.cell));
  if (node.abs) parts.push(absSeg(node.abs));
  if (node.ov) parts.push(node.ov === 'clip' ? '(clipped by parent)' : '(overhangs parent — keep)');
  if (detail) {
    if (node.gap) parts.push(`gap${node.gap}${varSuffix(bvName(node, 'itemSpacing'))}`);
    if (node.pad) parts.push(`${pad4(node.pad)}${varSuffix(bvName(node, 'paddingTop', 'paddingLeft'))}`);
    if (node.ap) parts.push(`main:${ALIGN_NAMES[node.ap] || node.ap.toLowerCase()}`);
    if (node.ac) parts.push(`cross:${ALIGN_NAMES[node.ac] || node.ac.toLowerCase()}`);
    const sizing = [];
    if (node.sh) sizing.push(`w:${node.sh.toLowerCase()}`);
    if (node.sv) sizing.push(`h:${node.sv.toLowerCase()}`);
    if (node.mnw != null) sizing.push(`min-w:${node.mnw}`);
    if (node.mxw != null) sizing.push(`max-w:${node.mxw}`);
    if (node.mnh != null) sizing.push(`min-h:${node.mnh}`);
    if (node.mxh != null) sizing.push(`max-h:${node.mxh}`);
    if (sizing.length) parts.push(sizing.join(' '));
  }
  return parts.join(' ');
}

/** Paint segment: fills, strokes, radius, effects — with variable names. Pure.
 * opts.ancestors: layer-name chain for the asset-name fallback — a node
 * called "Frame 64" gets its file named after the nearest meaningful
 * ancestor, exactly like `export assets` names the file. */
export function paintSeg(node, opts = {}) {
  const parts = [];
  if (node.fills) {
    // A bare "IMAGE" was a dead end (the test run fell back to screenshot
    // cropping). Point at the file `export assets` will write — both sides
    // derive the same name from the same node name + ancestor chain.
    const fills = node.fills.map((f) =>
      f === 'IMAGE' ? `IMAGE → assets/${assetFileName(node.n, 'png', opts.ancestors || [])} (export assets)` : f);
    // fs = applied COLOR STYLE name — the semantic handle when a file uses
    // shared styles instead of (or in addition to) variables.
    const styleRef = node.fs ? ` → style(${node.fs})` : '';
    parts.push(`fill ${fills.join('+')}${varSuffix(bvName(node, 'fills'))}${styleRef}`);
  }
  if (node.strokes) {
    // w<n> uniform, w<t/r/b/l> per side; alignment only when not INSIDE
    // (inside = a normal CSS border on a border-box element).
    const w = node.sw == null ? '' : ` w${Array.isArray(node.sw) ? node.sw.join('/') : node.sw}`;
    const align = node.sa ? ` ${node.sa}` : '';
    parts.push(`stroke ${node.strokes.join('+')}${w}${align}${node.dash ? ` dash[${node.dash.join(',')}]` : ''}${varSuffix(bvName(node, 'strokes'))}`);
  }
  if (node.r != null) {
    const r = Array.isArray(node.r) ? node.r.join('/') : node.r;
    parts.push(`r${r}${varSuffix(bvName(node, 'topLeftRadius', 'cornerRadius'))}`);
  }
  for (const e of node.fx || []) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      parts.push(`${e.type === 'INNER_SHADOW' ? 'inner-' : ''}shadow ${e.x}/${e.y}/${e.blur}/${e.spread} ${e.color}@${Math.round((e.a ?? 1) * 100)}%`);
    } else {
      parts.push(`${e.type.toLowerCase().replace(/_/g, '-')} ${e.blur}`);
    }
  }
  if (node.op != null) parts.push(`opacity ${Math.round(node.op * 100)}%`);
  if (node.rot) parts.push(`rot ${node.rot}°`);
  // Frame clipping (CSS: overflow hidden). Without it, children that overhang
  // the frame bounds either bleed in the rebuild or get dropped entirely.
  if (node.clip) parts.push('clip');
  return parts.join(' · ');
}

/** Typography segment for TEXT nodes. Pure.
 * Leads with the applied Figma TEXT STYLE (`style:display/medium`) — the
 * semantic identity to map onto a CSS class/typography token. Every part
 * carries its variable binding: family/weight/size/line-height used to render
 * as hard values even when the design system bound them to tokens. */
export function typeSeg(node) {
  if (!node.txt) return '';
  const t = node.txt;
  const parts = [];
  if (t.ts) parts.push(`style:${t.ts}`);
  if (t.font) {
    const family = `${t.font}${varSuffix(bvName(node, 'fontFamily'))}`;
    const weight = t.style ? ` ${t.style}${varSuffix(bvName(node, 'fontStyle', 'fontWeight'))}` : '';
    parts.push(`${family}${weight}`);
  }
  if (t.weight != null) parts.push(`fw${t.weight}`);
  if (t.size != null) parts.push(`${t.size}${varSuffix(bvName(node, 'fontSize'))}${t.lh != null ? `/${t.lh}${varSuffix(bvName(node, 'lineHeight'))}` : ''}`);
  if (t.ls) parts.push(`ls${t.ls}${varSuffix(bvName(node, 'letterSpacing'))}`);
  if (Array.isArray(t.ot) && t.ot.length) parts.push(`ot(${t.ot.join(',')})`);
  if (Array.isArray(t.axisRanges)) {
    for (const range of t.axisRanges) {
      const axes = Object.entries(range.axes || {}).map(([tag, value]) => `${tag}=${value}`).join(',');
      parts.push(`axes-meta[${range.start}:${range.end}](${axes})`);
    }
  }
  if (t.axisMetadataError) parts.push(`axes-meta-error(${t.axisMetadataError})`);
  if (Array.isArray(t.runs) && t.runs.length) {
    const runs = t.runs.map((run) => {
      const { ot, decoration, case: textCase, fills, fs, bv, ...typography } = run;
      const runNode = { txt: typography, fills, fs, bv };
      const detail = [
        typeSeg(runNode),
        paintSeg(runNode),
        decoration ? `decoration:${String(decoration).toLowerCase()}` : '',
        textCase ? `case:${String(textCase).toLowerCase()}` : '',
        Array.isArray(ot) && ot.length ? `ot(${ot.join(',')})` : '',
      ].filter(Boolean).join(' · ');
      return `${run.start}:${run.end} ${JSON.stringify(run.chars)} → ${detail}`;
    });
    parts.push(`runs{${runs.join(' | ')}}`);
  }
  return parts.join(' ');
}

/** Native Figma Inspect CSS, kept local to the layer that owns it. */
export function cssSeg(node) {
  if (!node.css || typeof node.css !== 'object') return '';
  const entries = Object.entries(node.css);
  if (!entries.length) return '';
  return `css{${entries.map(([property, value]) => `${property}:${value}`).join('; ')}}`;
}

// ============ style dedup (content-addressed, Framelink-style) ============
//
// The same visual style repeats across a screen far more often than whole
// sibling subtrees do (dedupSiblings only collapses EXACT structural twins).
// Four cards that differ in their texts still share one style bundle; a
// hundred body-text nodes share one typography+color bundle. Emitting the
// full detail on every line was the single biggest cost of `--phase style`
// on real screens.
//
// Mechanism: every node's style-relevant FIELDS (not its rendered segs) are
// content-addressed into a bundle key. Bundles seen 2+ times get an id (S1,
// S2, … in emission order). The first occurrence renders exactly like the
// undeduped line, tagged `≡S1`; every later occurrence collapses to the bare
// ref `S1`. Keying on fields — the same key the structured spec model uses —
// guarantees the text and yaml/json formats can never disagree about what
// counts as "the same style".

// NOTE: `abs` (overlay position) is deliberately NOT a style field — position
// is per-node geometry; two badges sharing a style sit at different corners.
const STYLE_NODE_KEYS = ['gap', 'pad', 'ap', 'ac', 'sh', 'sv', 'mnw', 'mxw', 'mnh', 'mxh', 'fills', 'fs', 'strokes', 'sw', 'sa', 'dash', 'r', 'fx', 'op', 'rot', 'clip', 'bv', 'css'];
const STYLE_TXT_KEYS = ['ts', 'font', 'style', 'weight', 'size', 'lh', 'ls', 'ot', 'axisRanges', 'axisMetadataError', 'runs'];
/** Below this rendered length a ref saves nothing — leave the value inline. */
const DEDUP_MIN_DEF_LEN = 16;

/** JSON.stringify with recursively sorted object keys — stable content key. */
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * The style-relevant subset of a walker node: layout detail, paints, radius,
 * effects, variable bindings, and typography WITHOUT the characters (content
 * is identity, not style). Pure.
 */
export function styleFields(node) {
  const out = {};
  for (const k of STYLE_NODE_KEYS) if (node[k] !== undefined) out[k] = node[k];
  if (node.txt) {
    const t = {};
    for (const k of STYLE_TXT_KEYS) if (node.txt[k] !== undefined) t[k] = node.txt[k];
    if (Object.keys(t).length) out.txt = t;
  }
  // An IMAGE fill renders as a per-node asset reference — two image nodes
  // with different names must NOT share a style bundle, or the ref line
  // would silently point at the wrong file.
  if ((node.fills || []).includes('IMAGE')) out.asset = node.n;
  return out;
}

/** Content key for a node's style bundle, or null when it has none. */
export function bundleKey(node) {
  const fields = styleFields(node);
  return Object.keys(fields).length ? stableStringify(fields) : null;
}

/** Rendered style detail of a node (what a ref replaces): layout detail + paint + type.
 * Structural/geometric fields (direction, grid template, cell, abs, overhang)
 * are NOT part of a style bundle — they render on every line, refs included —
 * so the definition must not bake one node's geometry into the shared text. */
function bundleDef(node) {
  const { lm, grid, cell, abs, ov, ...styleOnly } = node;
  return [layoutSeg(styleOnly, { detail: true }), cssSeg(styleOnly), paintSeg(styleOnly), typeSeg(styleOnly)].filter(Boolean).join(' · ');
}

/**
 * Pass 1 over the exact nodes that will be emitted (same dedupSiblings /
 * isVectorish path as specLines): count style bundles. Pure.
 */
export function countStyleBundles(frames) {
  const counts = new Map();
  const visit = (node) => {
    if (isVectorArt(node)) return; // renders as one pointer line — no styles emitted
    if (isVectorCluster(node)) return;
    if (isInvisibleHelper(node)) return;
    const key = bundleKey(node);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
    if (isIconInstance(node)) return; // internals stay collapsed
    for (const k of dedupSiblings(node.kids || [])) visit(k);
  };
  for (const f of frames || []) visit(f);
  return counts;
}

/** Fresh emission context for one spec section. */
export function newDedupCtx(frames) {
  return { counts: countStyleBundles(frames), ids: new Map(), next: 1, used: false };
}

// ============ instance props-diff grouping (IMPROVEMENTS #10) ============
//
// dedupSiblings collapses EXACT twins; a list of cards that differ only in
// their titles never collapses, so its whole subtree repeats N times. This
// second, looser stage groups CONSECUTIVE sibling instances of the same main
// component with the same skeleton: the first renders in full, the rest
// render as one diff line each — which is precisely the data row a `.map()`
// loop needs. Lossless by construction: a pair only groups when every
// difference is expressible as prop value, text characters, or a nested
// variant swap; any style/structure difference vetoes the group.

/** Structural skeleton of a node: type + component + child skeletons. Pure.
 * Nested instances are identified by their SET (component family), not their
 * variant name — a badge swapped from state=default to state=attention is a
 * recordable diff, not a different skeleton. */
function shapeSig(node) {
  if (isVectorArt(node)) return 'v';
  return stableStringify({
    t: node.t,
    m: node.set || node.main || node.mc || null,
    k: (node.kids || []).filter((k) => !isVectorArt(k)).map(shapeSig),
  });
}

const describeInstance = (node) => {
  const main = node.main || node.mc || '';
  const props = node.props
    ? Object.entries(node.props).map(([k, v]) => `${k}=${v}`).join(', ')
    : '';
  return props ? `${main} (${props})` : main;
};

/**
 * Differences of `node` against `base` (same main, same skeleton), as a flat
 * label→value map — or null when a difference cannot be expressed that way
 * (different style, different structure), which vetoes grouping. Pure.
 */
export function instanceDiff(base, node) {
  const diffs = {};
  // Own component props, key by key. Their values also serve to suppress
  // duplicate reporting of the TEXT nodes they drive.
  const propValues = new Set();
  const bp = base.props || {}, np = node.props || {};
  for (const k of new Set([...Object.keys(bp), ...Object.keys(np)])) {
    if (bp[k] !== np[k]) { diffs[k] = String(np[k]); propValues.add(String(np[k])); }
  }
  let ok = true;
  const walk2 = (a, b) => {
    if (!ok) return;
    if (a.t !== b.t) { ok = false; return; }
    if (a.t === 'TEXT') {
      if (bundleKey(a) !== bundleKey(b)) { ok = false; return; } // style differs
      const bc = b.txt?.chars;
      if (a.txt?.chars !== bc && !propValues.has(String(bc))) {
        diffs[a.n || 'text'] = JSON.stringify(bc ?? '');
      }
      return;
    }
    if (a.t === 'INSTANCE') {
      const sameConfig = (a.main || a.mc) === (b.main || b.mc)
        && stableStringify(a.props || {}) === stableStringify(b.props || {});
      if (!sameConfig) {
        // Variant/prop swap of a nested instance: its internals differ BY
        // DEFINITION of the swap — record the swap, don't descend.
        diffs[a.n || a.main || a.mc] = describeInstance(b);
        return;
      }
      // fall through: same config → internals must match like any node
    }
    if (bundleKey(a) !== bundleKey(b)) { ok = false; return; }
    const ak = (a.kids || []).filter((k) => !isVectorArt(k));
    const bk = (b.kids || []).filter((k) => !isVectorArt(k));
    if (ak.length !== bk.length) { ok = false; return; }
    for (let i = 0; i < ak.length; i++) walk2(ak[i], bk[i]);
  };
  const ak = (base.kids || []).filter((k) => !isVectorArt(k));
  const bk = (node.kids || []).filter((k) => !isVectorArt(k));
  if (ak.length !== bk.length) return null;
  for (let i = 0; i < ak.length; i++) walk2(ak[i], bk[i]);
  return ok ? diffs : null;
}

/**
 * Group consecutive same-component sibling instances into
 * [base, { __diffGroup }] pairs. Non-groupable entries pass through. Pure.
 */
export function groupInstanceSiblings(kids) {
  const out = [];
  let i = 0;
  while (i < kids.length) {
    const k = kids[i];
    const groupable = k.t === 'INSTANCE' && (k.main || k.mc) && !k.repeat
      && (k.kids || []).some((c) => !isVectorArt(c));
    if (!groupable) { out.push(k); i++; continue; }
    const sig = shapeSig(k);
    let j = i + 1;
    const variants = [];
    while (j < kids.length) {
      const n = kids[j];
      if (n.t !== 'INSTANCE' || n.repeat || (n.main || n.mc) !== (k.main || k.mc) || shapeSig(n) !== sig) break;
      const d = instanceDiff(k, n);
      if (!d) break;
      variants.push({ id: n.id, diffs: d });
      j++;
    }
    if (variants.length >= 1) {
      out.push(k, { __diffGroup: { of: k.set || k.main || k.mc, variants } });
      i = j;
    } else {
      out.push(k);
      i++;
    }
  }
  return out;
}

/**
 * One node → markdown lines for the given phase. Vector-only subtrees are
 * skipped (icon identity lives on the instance). Pure.
 * ctx (optional): style-dedup emission context from newDedupCtx().
 */
export function specLines(node, depth, phase, ctx = null, ancestors = [], behind = null) {
  const vectorArtLine = (n, extra = '') => {
    const detail = phase !== 'structure';
    // Rendered (post-transform) box wins: after a rotation the node's w/h are
    // pre-rotation and do NOT match the exported SVG file — the numbers here
    // must be the ones the file actually has.
    const box = n.rb || (n.w != null ? { w: n.w, h: n.h } : null);
    const size = detail && box ? ` · ${box.w}×${box.h}` : '';
    // Placement + opacity: without them the exported artwork is a file the
    // consumer cannot position (the Background Pattern case). `place` is the
    // rendered top-left offset inside the parent — position the SVG exactly
    // there; the abs anchor line is the fallback without rendered bounds.
    let pos = '';
    if (detail && n.abs) {
      if (n.abs.inset) {
        pos = ' · place inset:0 (fills parent — the svg stretches with it, width/height 100%)';
      } else if (n.rb) {
        // MAX anchors: the design pins the artwork to the far edge — say so,
        // or a fixed left/top drifts as soon as the parent resizes.
        const [av, ah] = String(n.abs.a || 'top-left').split('-');
        const pinned = [ah === 'right' && 'right', av === 'bottom' && 'bottom'].filter(Boolean);
        const pin = pinned.length ? ` (design pins it to the ${pinned.join('+')} edge — keep that on resize)` : '';
        pos = ` · place left:${n.rb.x} top:${n.rb.y} in parent${pin}`;
      } else {
        pos = ` · ${absSeg(n.abs)}`;
      }
    }
    const ov = detail && n.ov ? ` · ${ovSeg(n.ov)}` : '';
    const op = detail && n.op != null ? ` · opacity ${Math.round(n.op * 100)}%` : '';
    const id = detail && n.id ? ` · [${n.id}]` : '';
    const hid = n.hidden ? ' · (hidden — not rendered)' : '';
    return `${'  '.repeat(depth)}- ${n.n}${size} · vector art${extra} → assets/${assetFileName(n.n, 'svg', ancestors)} (export assets)${pos}${ov}${op}${hid}${id}`;
  };
  if (isVectorArt(node)) {
    // Vector ART (hand-drawn paths) — even small glyphs: a 26×34 flame on a
    // nav item or a 22×30 speech-bubble shape IS the design. One pointer
    // line; internals stay hidden — the artwork is fetched as a file, not
    // rebuilt from paths.
    return [vectorArtLine(node)];
  }
  if (isVectorCluster(node)) {
    // Mostly-vector container (pattern of hundreds of shapes): ONE line,
    // exactly like `export assets` writes ONE file for it.
    return [vectorArtLine(node, ` ×${(node.kids || []).length}`)];
  }
  if (isInvisibleHelper(node)) return []; // paint-less bounding/mask shape — renders nothing
  // Soft primitives (RECTANGLE/ELLIPSE/LINE, incl. gradient overlays) fall
  // through: they are CSS-buildable and render as regular styled nodes.
  const detail = phase !== 'structure';
  const segs = [identSeg(node)];
  // Only present with --include-hidden: the node does NOT render. Marked
  // loudly so nobody builds it into the screen by accident.
  if (node.hidden) segs.push('(hidden — not rendered)');
  if (detail && node.w != null) segs.push(`${node.w}×${node.h}`);

  // Dedup decision: eligible = bundle repeats AND its definition is long
  // enough that a ref actually saves tokens.
  let mode = 'inline';
  let refId = null;
  if (detail && ctx) {
    const key = bundleKey(node);
    if (key && (ctx.counts.get(key) || 0) >= 2 && bundleDef(node).length >= DEDUP_MIN_DEF_LEN) {
      if (ctx.ids.has(key)) {
        mode = 'ref';
        refId = ctx.ids.get(key);
      } else {
        refId = `S${ctx.next++}`;
        ctx.ids.set(key, refId);
        ctx.used = true;
        mode = 'define';
      }
    }
  }

  if (mode === 'ref') {
    // Structure and geometry stay visible on refs — direction/grid, cell,
    // absolute position, overhang are per-node, never part of the bundle.
    // (Refs used to drop `abs`, so every repeated badge lost its position.)
    const structural = layoutSeg(
      {
        lm: node.lm, grid: node.grid, cell: node.cell, abs: node.abs, ov: node.ov,
        scroll: node.scroll, fixed: node.fixed,
      },
      { detail: false },
    );
    if (structural) segs.push(structural);
    segs.push(refId);
  } else {
    const layout = layoutSeg(node, { detail });
    if (layout) segs.push(layout);
    if (detail) {
      const css = cssSeg(node);
      if (css) segs.push(css);
      const paint = paintSeg(node, { ancestors });
      if (paint) segs.push(paint);
      const type = typeSeg(node);
      if (type) segs.push(type);
    }
    if (mode === 'define') segs.push(`≡${refId}`);
  }
  // Fill-less container sitting OVER an absolutely-positioned sibling: say
  // out loud that it is transparent. Run 7: the menu frame had no fill and
  // let the background pattern shine through — the spec never said so, the
  // build gave it an opaque surface and the pattern "vanished".
  if (detail && behind?.length && !node.fills && node.kids?.length) {
    segs.push(`fill:none (transparent — ${behind.map((n) => `"${n}"`).join(', ')} behind it stays visible through this frame; do NOT give it an opaque background)`);
  }
  // IDs belong to the structure contract too: repeated names are common in
  // Figma, and an exact follow-up style call must never target by guesswork.
  if (node.id) segs.push(`[${node.id}]`);
  if (node.repeat) segs.push(`×${node.repeat}`);
  const lines = [`${'  '.repeat(depth)}- ${segs.filter(Boolean).join(' · ')}`];
  // Icon instances collapse: their identity is the main-component name, the
  // paths inside are noise. All other containers DO list their vector kids.
  const rawKids = isIconInstance(node) ? [] : node.kids || [];
  // Instance grouping only runs under a ctx — bare specLines calls (and
  // --no-dedup) render every sibling in full.
  const kidList = ctx
    ? groupInstanceSiblings(dedupSiblings(rawKids))
    : rawKids;
  // Absolutely-positioned siblings BEHIND each kid (z-order = sibling order):
  // a later fill-less container must keep them visible through itself.
  const behindOverlays = [];
  for (const k of kidList) {
    if (k.__diffGroup) {
      // The instance ABOVE this line rendered in full; each sibling here is
      // structurally identical and differs only in the listed values — the
      // literal data rows for a `.map()` over that component.
      const g = k.__diffGroup;
      const ind = '  '.repeat(depth + 1);
      lines.push(`${ind}- ↻ ×${g.variants.length} more ${g.of} — same structure as above, only:`);
      for (const v of g.variants) {
        const pairs = Object.entries(v.diffs).map(([dk, dv]) => `${dk}: ${dv}`).join(', ');
        const idSuffix = phase !== 'structure' && v.id ? ` · [${v.id}]` : '';
        lines.push(`${ind}  - { ${pairs} }${idSuffix}`);
      }
      if (ctx) ctx.usedDiff = true;
      continue;
    }
    lines.push(...specLines(k, depth + 1, phase, ctx, ancestors.concat(node.n),
      behindOverlays.length ? [...behindOverlays] : null));
    if (k.abs && !k.hidden && !isInvisibleHelper(k)) behindOverlays.push(k.n);
  }
  if (node.more) lines.push(`${'  '.repeat(depth + 1)}- …${node.more} more (depth limit — re-run with -d)`);
  return lines;
}

/**
 * Distinct asset files the spec references (vector art + IMAGE fills), using
 * the same naming/emission rules as specLines — the completeness yardstick
 * for the footer ("all N must appear in the build"). Pure.
 */
export function countAssetFiles(frames) {
  const files = new Set();
  const visit = (node, ancestors) => {
    if (node.hidden) return;
    if (isVectorArt(node) || isVectorCluster(node)) {
      files.add(assetFileName(node.n, 'svg', ancestors));
      return;
    }
    if (isInvisibleHelper(node)) return;
    if ((node.fills || []).includes('IMAGE')) files.add(assetFileName(node.n, 'png', ancestors));
    if (isIconInstance(node)) return;
    for (const k of node.kids || []) visit(k, ancestors.concat(node.n));
  };
  for (const f of frames || []) visit(f, []);
  return files;
}

/**
 * Account for every visible captured layer, including layers intentionally
 * represented by one exported SVG and paint-less helpers that render no UI.
 * sourceVisible comes from the live Figma tree before depth projection.
 */
export function layerCoverage(frames, sourceVisible = null) {
  const coverage = {
    captured: 0,
    explicitRows: 0,
    assetInternalLayers: 0,
    componentInternalLayers: 0,
    nonRenderingHelpers: 0,
  };
  const subtreeSize = (node) => node.hidden
    ? 0
    : 1 + (node.kids || []).reduce((sum, child) => sum + subtreeSize(child), 0);
  const visit = (node) => {
    if (node.hidden) return;
    if (isVectorArt(node) || isVectorCluster(node)) {
      const size = subtreeSize(node);
      coverage.captured += size;
      coverage.explicitRows += 1;
      coverage.assetInternalLayers += Math.max(0, size - 1);
      return;
    }
    coverage.captured += 1;
    if (isInvisibleHelper(node)) {
      coverage.nonRenderingHelpers += 1;
      return;
    }
    coverage.explicitRows += 1;
    if (isIconInstance(node)) {
      const internals = (node.kids || []).reduce((sum, child) => sum + subtreeSize(child), 0);
      coverage.captured += internals;
      coverage.componentInternalLayers += internals;
      return;
    }
    for (const child of node.kids || []) visit(child);
  };
  for (const frame of frames || []) visit(frame);
  const source = Number.isInteger(sourceVisible) ? sourceVisible : coverage.captured;
  const unaccounted = Math.max(0, source - coverage.captured);
  return {
    sourceVisible: source,
    ...coverage,
    unaccounted,
    complete: unaccounted === 0,
  };
}

/** True when any node in the frames satisfies pred. Pure. */
const anyNode = (frames, pred) => {
  const visit = (n) => pred(n) || (n.kids || []).some(visit);
  return (frames || []).some(visit);
};

/**
 * Absolutely-positioned overlays in the emitted spec (every node with `abs`,
 * files AND styled divs alike) — builders drop exactly these, decorative
 * gradient shapes first. Counted with the same emission rules as specLines.
 * Pure.
 */
export function countOverlays(frames) {
  let count = 0;
  const visit = (node) => {
    if (node.hidden) return;
    if (isInvisibleHelper(node)) return;
    if (node.abs) count += 1;
    if (isVectorArt(node) || isVectorCluster(node) || isIconInstance(node)) return;
    for (const k of node.kids || []) visit(k);
  };
  for (const f of frames || []) visit(f);
  return count;
}

/**
 * Overlay-visibility relations: for every absolutely-positioned overlay, the
 * LATER fill-less container siblings it stays visible through (sibling order
 * = z-order). These are the frames a rebuild must keep transparent — giving
 * them an opaque surface is exactly how the Run-7 background pattern
 * vanished. Pure.
 */
export function overlayVisibility(frames) {
  const out = [];
  const visit = (node) => {
    if (node.hidden) return;
    if (isVectorArt(node) || isVectorCluster(node) || isIconInstance(node)) return;
    const kids = (node.kids || []).filter((k) => !k.hidden && !isInvisibleHelper(k));
    for (let i = 0; i < kids.length; i++) {
      const ov = kids[i];
      if (!ov.abs) continue;
      const through = kids.slice(i + 1)
        .filter((s) => !s.fills && s.kids?.length && !isVectorArt(s) && !isVectorCluster(s))
        .map((s) => s.n);
      if (through.length) out.push({ overlay: ov.n, through });
    }
    for (const k of kids) visit(k);
  };
  for (const f of frames || []) visit(f);
  return out;
}

/** Stroke facts across the frames — drive the conditional footer hints. Pure. */
export function strokeFacts(frames) {
  const facts = { perSide: false, align: false, gradient: false };
  const visit = (n) => {
    if (Array.isArray(n.sw)) facts.perSide = true;
    if (n.sa) facts.align = true;
    if ((n.strokes || []).some((s) => String(s).includes('gradient('))) facts.gradient = true;
    (n.kids || []).forEach(visit);
  };
  (frames || []).forEach(visit);
  return facts;
}

/**
 * Distinct gradient-stroke configurations across the frames — one specimen
 * per (gradient, widths, radius) combination, with the name of the first
 * node carrying it. These drive the READY-MADE CSS in the footer. Pure.
 */
export function gradientStrokeSpecimens(frames) {
  const seen = new Map();
  const visit = (n) => {
    const grad = (n.strokes || []).find((s) => String(s).includes('gradient('));
    if (grad) {
      const key = stableStringify([grad, n.sw ?? 1, n.r ?? 0]);
      if (!seen.has(key)) seen.set(key, { n: n.n, gradient: grad, sw: n.sw ?? 1, r: n.r ?? 0 });
    }
    (n.kids || []).forEach(visit);
  };
  (frames || []).forEach(visit);
  return [...seen.values()];
}

/**
 * Ready-made CSS for ONE gradient-stroke specimen: the padded-pseudo-element
 * mask pattern, with the node's real per-side widths as padding and its real
 * radius. Deterministically generated so the consumer never hand-builds the
 * error-prone part (border-image ignores border-radius; the wrapper trick
 * leaks at rounded corners with per-side widths — Run 7, main container). Pure.
 */
export function gradientBorderCss(spec, cls) {
  const px = (v) => (v ? `${v}px` : '0');
  const radius = Array.isArray(spec.r) ? spec.r.map(px).join(' ') : px(spec.r);
  const padding = Array.isArray(spec.sw) ? spec.sw.map(px).join(' ') : px(spec.sw);
  return [
    `/* ${spec.n} — gradient stroke ${Array.isArray(spec.sw) ? `w${spec.sw.join('/')}` : `w${spec.sw}`}, radius ${Array.isArray(spec.r) ? spec.r.join('/') : spec.r} */`,
    `.${cls} { position: relative; border-radius: ${radius}; }`,
    `.${cls}::before {`,
    '  content: "";',
    '  position: absolute;',
    '  inset: 0;',
    '  border-radius: inherit;',
    `  padding: ${padding};          /* stroke widths t/r/b/l */`,
    `  background: ${spec.gradient};`,
    '  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);',
    '  mask-composite: exclude;',
    '  -webkit-mask-composite: xor;',
    '  pointer-events: none;',
    '}',
  ].join('\n');
}

const INTERACTIVE_STATE_VALUE = /^(hover|active|press(ed)?|focus(ed)?|disabled|selected|loading)$/i;

/**
 * Dynamic fidelity facts shared by every structured output adapter.
 *
 * These used to exist only as prose appended to the tree renderer, so YAML
 * and JSON silently missed useful completeness information. Keeping them in
 * the canonical model means every lossless adapter carries the same facts.
 */
export function specChecks(result) {
  const frames = result.frames || [];
  const checks = { layerCoverage: layerCoverage(frames, result.visibleNodeCount) };
  const assets = [...countAssetFiles(frames)].sort();
  if (assets.length) {
    checks.assets = { count: assets.length, files: assets.map((file) => `assets/${file}`) };
  }

  const overlayCount = countOverlays(frames);
  const transparency = overlayVisibility(frames);
  if (overlayCount) {
    checks.overlays = {
      count: overlayCount,
      ...(transparency.length ? { transparency } : {}),
    };
  }

  const interactiveSets = [];
  for (const set of result.sets || []) {
    const axes = Object.entries(set.props || {})
      .filter(([axis, values]) =>
        /state|interaction/i.test(axis)
        || (values || []).some((value) => INTERACTIVE_STATE_VALUE.test(String(value).trim())))
      .map(([axis]) => axis);
    if (axes.length) interactiveSets.push({ name: set.name, id: set.id, axes });
  }
  if (interactiveSets.length) checks.interactiveSets = interactiveSets;

  if (anyNode(frames, (node) => node.lm === 'GRID')) checks.cssGrid = true;
  const strokes = strokeFacts(frames);
  if (strokes.perSide || strokes.align || strokes.gradient) checks.strokes = strokes;
  const gradientStrokes = gradientStrokeSpecimens(frames);
  if (gradientStrokes.length) checks.gradientStrokes = gradientStrokes;
  return checks;
}

/**
 * Walker result ({ id, name, frames }) → the full spec document. Pure.
 * phase: 'structure' | 'style' | 'all'
 * dedup: collapse repeated style bundles to S<n> refs (default on;
 *        --no-dedup for the fully inlined form).
 */
export function formatCodeSpec(result, { phase = 'all', dedup = true } = {}) {
  const out = [];
  let anyDedup = false;
  let anyDiff = false;
  const emit = (ph, title) => {
    // One dedup context PER SECTION: a ref is only ever resolved within the
    // section it was defined in — no cross-section lookups. The structure
    // section gets an empty-counts ctx: no style refs there, but instance
    // props-diff grouping applies in both sections. --no-dedup (ctx: null)
    // disables both mechanisms — the fully expanded form.
    const ctx = dedup
      ? (ph !== 'structure' ? newDedupCtx(result.frames) : { counts: new Map(), ids: new Map(), next: 1, used: false })
      : null;
    out.push(`## ${title}`, '');
    for (const f of result.frames || []) out.push(...specLines(f, 0, ph, ctx));
    out.push('');
    if (ctx?.used) anyDedup = true;
    if (ctx?.usedDiff) anyDiff = true;
  };
  out.push(`# Code-Spec: ${result.name} (${result.id})`, '');
  if (phase === 'all' || phase === 'structure') {
    emit('structure', 'Structure — hierarchy & real content (build this first)');
  }
  if (phase === 'all' || phase === 'style') {
    emit('style', 'Style — sizes, layout, paints, typography (then style it)');
  }
  // Component sets: the screen shows ONE variant per instance, but the axes
  // (state=default/hover/…) define the interactive states the build needs.
  let anyInteractive = false;
  if (result.sets?.length) {
    out.push('## Component sets used on this screen', '');
    for (const s of result.sets) {
      const axes = s.props
        ? Object.entries(s.props).map(([axis, values]) => {
          const interactive = /state|interaction/i.test(axis) || (values || []).some((v) => INTERACTIVE_STATE_VALUE.test(String(v).trim()));
          if (interactive) anyInteractive = true;
          return `${axis}: ${(values || []).join('/')}${interactive ? ' ⚑' : ''}`;
        }).join(' · ')
        : '';
      // Full set key ONCE per set (not per instance): the stable identity a
      // Storybook mapping (figma-map.json) is keyed by. The backtick form is
      // what the MCP layer's annotation pass greps for.
      out.push(`- ${s.name}${axes ? ` — ${axes}` : ''} · [${s.id}]${s.setKey ? ` · key \`${s.setKey}\`` : ''}`);
    }
    out.push('');
    if (anyInteractive) {
      out.push('_⚑ = required INTERACTIVE STATES. Pull each flagged set variant and implement its exact hover/active/focus/disabled style._', '');
    }
  }
  out.push('_Figma facts: copy, never invent content/names. `→ var(name)` = token binding; `style:<name>` / `→ style(name)` = shared style._');
  const coverage = layerCoverage(result.frames || [], result.visibleNodeCount);
  out.push('', `_Layer coverage: ${coverage.captured}/${coverage.sourceVisible} visible Figma layers accounted for; ${coverage.explicitRows} explicit implementation row(s), ${coverage.assetInternalLayers} SVG-internal, ${coverage.componentInternalLayers} component-internal, ${coverage.nonRenderingHelpers} non-rendering helper(s), ${coverage.unaccounted} unaccounted.${coverage.complete ? '' : ' INCOMPLETE — request deeper or smaller node specs before coding.'}_`);
  if (phase !== 'structure') {
    out.push('', '_Sibling order = z-order; `clip` = `overflow:hidden`; `abs` offsets are parent-relative. Export/place every `vector art → assets/…` at its rendered W×H/offset; retain `overhangs parent`._');
  }
  if (anyNode(result.frames, (n) => n.lm === 'GRID')) {
    out.push('', '_`grid R×C` = a CSS grid, not flex. `cell row:N col:M /span S` maps directly to CSS grid placement; offsets are the cross-check._');
  }
  if (anyNode(result.frames, (n) => n.scroll || n.fixed)) {
    out.push('', '_Prototype facts are explicit: `scroll:vertical|horizontal|both` is the Figma overflow direction; `prototype-fixed` stays fixed inside that scrolling frame. Do not infer fixed/sticky behavior for unmarked layers._');
  }
  // Completeness yardstick: dropped assets (the overhanging SVGs) are the
  // top fidelity bug — give the consumer a number to check off against.
  // Emitted in EVERY phase, structure included: large frames are mapped with
  // a structure call and then built per section, and overlays hanging off
  // the layout root belong to no section — without the count here, no build
  // step ever "owns" them (acceptance evidence, Background Pattern).
  const assetFiles = countAssetFiles(result.frames);
  if (assetFiles.size) {
    out.push('', `_This spec references ${assetFiles.size} distinct asset file(s): export and use all of them; \`verify-build <projectDir>\` checks this._`);
  }
  const overlays = countOverlays(result.frames);
  if (overlays) {
    out.push('', `_${overlays} absolutely-positioned overlay(s): implement every \`abs\`/\`place\`/\`inset\` node, INCLUDING purely decorative gradient rectangles._`);
    // Which fill-less siblings each overlay must stay visible through —
    // without this the relation had to be inferred, and builds painted the
    // transparent frames opaque (Run 7: the background pattern vanished).
    const vis = overlayVisibility(result.frames);
    for (const v of vis) {
      out.push('', `_Overlay "${v.overlay}" stays visible through ${v.through.map((n) => `"${n}"`).join(', ')} — ${v.through.length === 1 ? 'that sibling has' : 'those siblings have'} NO fill in the design (transparent)._`);
    }
  }
  if (phase !== 'structure') {
    // The fill→fixed-px translation error is the top layout bug of real
    // rebuilds — spell the CSS mapping out instead of assuming it.
    out.push('', '_Sizing: `w:fill` = stretch into the parent (`flex:1`/`align-self:stretch`), NEVER a fixed px width; `w:hug` = fit-content; bare W×H = fixed. Min/max map directly. Use space-between only for `main:between`._');
    // Stroke legends only when the screen actually uses the feature — a spec
    // without gradient borders should not pay for the how-to.
    const facts = strokeFacts(result.frames);
    if (facts.perSide || facts.align) {
      out.push('', '_`stroke … w<t/r/b/l>` = per-side widths (top/right/bottom/left). Default alignment is inside; `outside`/`center` need outline or box-shadow._');
    }
    if (facts.gradient) {
      out.push('', '_Gradient stroke + radius: `border-image` IGNORES `border-radius`. Use the ready-made pseudo-element pattern below VERBATIM._');
      const specimens = gradientStrokeSpecimens(result.frames);
      const shown = specimens.slice(0, 3);
      if (shown.length) {
        out.push('', '```css');
        out.push(shown.map((s, i) => gradientBorderCss(s, `gradient-border-${i + 1}`)).join('\n\n'));
        out.push('```');
        if (specimens.length > shown.length) {
          out.push('', `_${specimens.length - shown.length} more gradient-stroke variant(s): reuse the pattern with their stated radius/width/gradient._`);
        }
      }
    }
  }
  if (anyDedup) {
    out.push('', '_`≡S<n>` defines a repeated style bundle; later `S<n>` references it exactly. `--no-dedup` inlines values._');
  }
  if (anyDiff) {
    out.push('', '_`↻ ×N more` siblings match the prior structure; `{…}` contains only differing props/text/variants. Build them as a loop._');
  }
  if (phase === 'structure') {
    // The test run showed what happens without this nudge: the agent built
    // from structure alone and guessed every color, font and radius.
    out.push('', '_This output has NO styles: pull `--phase style` (or `all`) for exact colors/fonts/radii; never estimate._');
  }
  return out.join('\n');
}

// ============ canonical structured spec model ============

/**
 * Walker result → structured spec model for every lossless format adapter:
 * { name, id, styles: { S1: {…fields} }, frames: [nodes] } where a node
 * carries `s: "S1"` INSTEAD of its style fields when its bundle repeats.
 * Same bundle key as the text renderer, so S-ids mean the same thing in
 * every format. expandSpecModel() is the exact inverse — the tests hold
 * both directions together. Pure.
 */
export function specModel(result, { phase = 'all', dedup = true, capture = {} } = {}) {
  const detail = phase !== 'structure';
  const counts = dedup && detail ? countStyleBundles(result.frames) : new Map();
  const styles = {};
  const ids = new Map();
  let next = 1;

  const toNode = (node, ancestors = [], behind = null) => {
    // Vector ART nodes are pointer nodes, never dropped: the yaml/json spec
    // used to swallow them entirely (the missing-decor bug class).
    if (isVectorArt(node) || isVectorCluster(node)) {
      const o = { t: node.t, n: node.n, vectorArt: `assets/${assetFileName(node.n, 'svg', ancestors)}` };
      if (!isVectorArt(node)) o.shapes = (node.kids || []).length; // cluster: N shapes → one artwork
      if (node.id) o.id = node.id;
      if (node.hidden) o.hidden = true;
      // Rendered box wins over pre-rotation w/h — same rule as the text
      // renderer: the numbers must match the exported SVG file.
      if (detail && node.rb) {
        o.w = node.rb.w; o.h = node.rb.h;
        if (node.abs?.inset) o.place = { inset: 0 };
        else if (node.abs) o.place = { left: node.rb.x, top: node.rb.y };
      } else if (detail && node.w != null) { o.w = node.w; o.h = node.h; }
      if (detail && node.abs) o.abs = node.abs;
      if (node.ov) o.overhang = node.ov === 'clip' ? 'clipped-by-parent' : 'visible-by-design';
      if (node.op != null) o.op = node.op;
      return o;
    }
    if (isInvisibleHelper(node)) return null; // paint-less bounding/mask shape
    const o = { t: node.t, n: node.n };
    if (node.id) o.id = node.id;
    if (node.hidden) o.hidden = true;
    if (node.lm) o.dir = dirName(node.lm);
    if (node.scroll) o.scroll = node.scroll;
    if (node.fixed) o.fixed = true;
    if (node.grid) o.grid = node.grid;
    if (node.cell) o.cell = node.cell;
    // Content / identity (structure information):
    if (node.txt?.chars !== undefined) o.text = node.txt.chars;
    if (node.main) o.main = node.main;
    if (node.mainKey) o.mainKey = node.mainKey;
    if (node.set) o.set = node.set;
    if (node.mc && !node.main) o.mc = node.mc;
    if (node.props) o.props = node.props;
    if (detail) {
      if (node.w != null) { o.w = node.w; o.h = node.h; }
      if (node.abs) o.abs = node.abs;
      if (node.ov) o.overhang = node.ov === 'clip' ? 'clipped-by-parent' : 'visible-by-design';
      // Transparent container over abs overlays — same rule as the text
      // renderer's fill:none note (the vanished-background-pattern bug).
      if (behind?.length && !node.fills && node.kids?.length) o.seeThrough = behind;
      const fields = styleFields(node);
      if (Object.keys(fields).length) {
        const key = stableStringify(fields);
        if ((counts.get(key) || 0) >= 2) {
          let id = ids.get(key);
          if (!id) { id = `S${next++}`; ids.set(key, id); styles[id] = fields; }
          o.s = id;
        } else {
          o.style = fields;
        }
      }
    }
    if (node.repeat) o.repeat = node.repeat;
    if (node.more) o.more = node.more;
    // Icon instances collapse (identity = main-component name); everything
    // else lists its vector kids as vectorArt pointer nodes.
    const rawKids = isIconInstance(node) ? [] : node.kids || [];
    const behindOverlays = [];
    const kids = [];
    for (const k of dedupSiblings(rawKids)) {
      const child = toNode(k, ancestors.concat(node.n), behindOverlays.length ? [...behindOverlays] : null);
      if (child) kids.push(child);
      if (k.abs && !k.hidden && !isInvisibleHelper(k)) behindOverlays.push(k.n);
    }
    if (kids.length) o.kids = kids;
    return o;
  };

  const frames = (result.frames || []).map((f) => toNode(f)).filter(Boolean);
  const model = {
    schemaVersion: 1,
    capture: { phase, ...capture },
    name: result.name,
    id: result.id,
    frames,
  };
  if (result.sets?.length) model.sets = result.sets;
  if (Object.keys(styles).length) model.styles = styles;
  const checks = specChecks(result);
  if (Object.keys(checks).length) model.checks = checks;
  return model;
}

/**
 * Inverse of specModel's dedup: replace every `s: "S<n>"` ref by the full
 * style fields. After expansion the model equals specModel(…, {dedup:false})
 * — that equivalence is the no-information-loss guarantee. Pure.
 */
export function expandSpecModel(model) {
  const styles = model.styles || {};
  const expand = (node) => {
    const { s, ...rest } = node;
    if (s) rest.style = styles[s];
    if (rest.kids) rest.kids = rest.kids.map(expand);
    return rest;
  };
  const { styles: _styles, frames, ...envelope } = model;
  return { ...envelope, frames: (frames || []).map(expand) };
}
