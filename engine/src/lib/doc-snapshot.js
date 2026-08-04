// Structural snapshots of a Figma subtree — the local half of version history.
//
// The plugin API can WRITE a version (figma.saveVersionHistoryAsync) but not
// read one back, so "what changed since yesterday" is not answerable from the
// bridge alone. A snapshot is our own answer: walk a subtree, record a
// normalized shape per node, and store it. Two snapshots then diff without any
// Figma credential at all (lib/doc-diff.js).
//
// Division of labour: the eval snippet collects RAW values and nothing else —
// no hashing, no formatting. Everything derived is computed here, on the CLI
// side, so the hash algorithm can change without touching the plugin, and so
// the normalization is unit-testable against plain objects.
//
// The same normalizer also accepts REST `GET /v1/files/:key` nodes, which is
// what lets one differ work on both local snapshots and real Figma versions.
import { createHash } from 'crypto';

export const SNAPSHOT_FORMAT = 1;

// Properties compared per node. Keeping this list explicit (rather than
// diffing whatever the plugin happened to return) is what stops a Figma API
// addition from silently showing up as "everything changed".
const COMPARED = [
  'visible', 'opacity', 'rotation', 'blendMode',
  'layoutMode', 'itemSpacing', 'counterAxisSpacing',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'primaryAxisAlignItems', 'counterAxisAlignItems',
  'primaryAxisSizingMode', 'counterAxisSizingMode',
  'layoutSizingHorizontal', 'layoutSizingVertical',
  'clipsContent', 'cornerRadius',
  'fills', 'strokes', 'strokeWeight', 'effects',
  'characters', 'fontSize', 'fontName', 'fontWeight',
  'textAlignHorizontal', 'lineHeight', 'letterSpacing',
  'componentKey', 'mainComponent', 'variantProperties',
];

/**
 * JS source for the plugin sandbox: walk `root` and return one flat array of
 * raw node records. Flat rather than nested because the diff is keyed by id
 * and path — nesting would only have to be flattened again on arrival.
 *
 * @param {{nodeId?: string, depth?: number}} opts
 *   nodeId — subtree root; omitted means the current page.
 *   depth  — max levels below the root (default: unlimited).
 */
export function buildSnapshotEval({ nodeId = null, depth = null } = {}) {
  const rootExpr = nodeId
    ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})`
    : 'figma.currentPage';
  const maxDepth = Number.isInteger(depth) && depth >= 0 ? depth : -1;

  return `(async () => {
  const root = ${rootExpr};
  if (!root) return { error: 'NOT_FOUND' };
  const MAX_DEPTH = ${maxDepth};
  const out = [];

  const paint = (p) => {
    if (!p || typeof p !== 'object') return null;
    const base = { type: p.type, opacity: p.opacity, visible: p.visible, blendMode: p.blendMode };
    if (p.type === 'SOLID') return { ...base, color: p.color };
    if (p.type === 'IMAGE') return { ...base, imageHash: p.imageHash, scaleMode: p.scaleMode };
    if (p.gradientStops) {
      return { ...base,
        gradientTransform: p.gradientTransform,
        stops: p.gradientStops.map(s => ({ position: s.position, color: s.color })) };
    }
    return base;
  };
  const effect = (e) => e && typeof e === 'object'
    ? { type: e.type, radius: e.radius, color: e.color, offset: e.offset,
        spread: e.spread, visible: e.visible }
    : null;

  // figma.mixed is a symbol: it must never reach JSON.stringify as-is, and it
  // is genuinely meaningful ("this node has several values here"), so it is
  // preserved as a sentinel string rather than dropped.
  const plain = (v) => {
    if (v === figma.mixed) return '__mixed__';
    if (v === undefined || v === null) return null;
    if (typeof v === 'symbol') return '__mixed__';
    if (Array.isArray(v)) return v.map(plain);
    if (typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = plain(v[k]);
      return o;
    }
    return v;
  };

  const walk = async (node, parentId, index, pathParts, level) => {
    const path = pathParts.concat(node.name).join(' / ');
    const rec = {
      id: node.id, name: node.name, type: node.type,
      path, parentId, index,
      x: node.x, y: node.y, w: node.width, h: node.height,
      props: {},
    };
    for (const key of ${JSON.stringify(COMPARED)}) {
      if (!(key in node)) continue;
      let v;
      try { v = node[key]; } catch (e) { continue; }
      if (v === undefined) continue;
      if (key === 'fills' || key === 'strokes') {
        rec.props[key] = v === figma.mixed ? '__mixed__' : (Array.isArray(v) ? v.map(paint) : null);
      } else if (key === 'effects') {
        rec.props[key] = Array.isArray(v) ? v.map(effect) : null;
      } else if (key === 'mainComponent') {
        rec.props.mainComponentKey = v && v.key ? v.key : null;
        rec.props.mainComponentName = v && v.name ? v.name : null;
      } else {
        rec.props[key] = plain(v);
      }
    }
    out.push(rec);
    const kids = node.children;
    if (!kids || !kids.length) return;
    if (MAX_DEPTH >= 0 && level >= MAX_DEPTH) return;
    const nextPath = pathParts.concat(node.name);
    for (let i = 0; i < kids.length; i++) {
      await walk(kids[i], node.id, i, nextPath, level + 1);
    }
  };

  await walk(root, null, 0, [], 0);
  return {
    rootId: root.id,
    rootName: root.name,
    rootType: root.type,
    fileKey: figma.fileKey || null,
    fileName: figma.root.name,
    page: figma.currentPage.name,
    nodes: out,
  };
})()`;
}

/** Stable stringify: object keys sorted, so key order never affects a hash. */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/** Short content hash — 12 hex chars is ample for change detection. */
export function hashOf(value) {
  return createHash('sha256').update(stable(value)).digest('hex').slice(0, 12);
}

// Geometry is rounded before hashing: Figma stores floats, and a 0.0001px
// difference from a re-layout is noise, not a change anyone wants reported.
function round(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

/**
 * Turn a raw eval result into the stored snapshot shape: per-node content
 * hashes plus a subtree hash, so the differ can skip untouched branches and
 * report "this whole section is unchanged" instead of walking it.
 *
 * @param {object} raw - what buildSnapshotEval() returned
 * @param {{label?: string, takenAt?: string}} [meta]
 */
export function normalizeSnapshot(raw, { label = null, takenAt = null } = {}) {
  if (!raw || !Array.isArray(raw.nodes)) {
    throw new Error('Snapshot payload has no nodes — the plugin returned nothing usable.');
  }

  const nodes = raw.nodes.map((n) => {
    const geom = { x: round(n.x), y: round(n.y), w: round(n.w), h: round(n.h) };
    return {
      id: String(n.id),
      name: String(n.name ?? ''),
      type: String(n.type ?? ''),
      path: String(n.path ?? ''),
      parentId: n.parentId ?? null,
      index: Number.isInteger(n.index) ? n.index : 0,
      ...geom,
      props: n.props && typeof n.props === 'object' ? n.props : {},
      hash: hashOf({ name: n.name, type: n.type, ...geom, props: n.props }),
    };
  });

  return attachSubtreeHashes({
    format: SNAPSHOT_FORMAT,
    takenAt: takenAt || new Date().toISOString(),
    label: label || null,
    source: 'plugin',
    fileKey: raw.fileKey ?? null,
    fileName: raw.fileName ?? null,
    page: raw.page ?? null,
    rootId: raw.rootId ?? null,
    rootName: raw.rootName ?? null,
    nodeCount: nodes.length,
    nodes,
  });
}

/**
 * Same shape, built from a Figma REST document node (`GET /v1/files/:key`,
 * optionally `?version=`). This is what makes real Figma versions diffable with
 * the exact same engine as local snapshots.
 *
 * REST names properties differently from the plugin API, so only the fields
 * that mean the same thing on both sides are carried over — a REST-vs-plugin
 * diff would otherwise be a wall of false positives.
 */
export function normalizeRestDocument(doc, { fileKey = null, fileName = null, version = null, takenAt = null } = {}) {
  if (!doc || typeof doc !== 'object') {
    throw new Error('REST document payload is empty.');
  }
  const nodes = [];
  const walk = (node, parentId, index, pathParts) => {
    if (!node || !node.id) return;
    const path = pathParts.concat(node.name ?? '').join(' / ');
    const box = node.absoluteBoundingBox || {};
    const geom = { x: round(box.x), y: round(box.y), w: round(box.width), h: round(box.height) };
    const props = {};
    // Deliberately narrow: these are the REST fields whose plugin-API
    // counterparts carry the same meaning under the same name.
    for (const key of ['visible', 'opacity', 'layoutMode', 'itemSpacing', 'clipsContent',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'primaryAxisAlignItems', 'counterAxisAlignItems', 'characters', 'cornerRadius',
      'fills', 'strokes', 'strokeWeight', 'effects']) {
      if (node[key] !== undefined) props[key] = node[key];
    }
    if (node.componentId) props.componentId = node.componentId;
    const rec = {
      id: String(node.id), name: String(node.name ?? ''), type: String(node.type ?? ''),
      path, parentId, index, ...geom, props,
      hash: hashOf({ name: node.name, type: node.type, ...geom, props }),
    };
    nodes.push(rec);
    const kids = node.children || [];
    const nextPath = pathParts.concat(node.name ?? '');
    kids.forEach((k, i) => walk(k, node.id, i, nextPath));
  };
  walk(doc, null, 0, []);

  const snapshot = {
    format: SNAPSHOT_FORMAT,
    takenAt: takenAt || new Date().toISOString(),
    label: version ? `Figma version ${version}` : null,
    source: 'rest',
    version,
    fileKey,
    fileName,
    page: null,
    rootId: doc.id ?? null,
    rootName: doc.name ?? null,
    nodeCount: nodes.length,
    nodes,
  };
  // Reuse the plugin path's subtree folding rather than duplicating it.
  return attachSubtreeHashes(snapshot);
}

/** Fold child hashes into parents. Exported for reuse and testing. */
export function attachSubtreeHashes(snapshot) {
  const childIds = new Map();
  for (const n of snapshot.nodes) {
    if (!n.parentId) continue;
    if (!childIds.has(n.parentId)) childIds.set(n.parentId, []);
    childIds.get(n.parentId).push(n.id);
  }
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const cache = new Map();
  const compute = (id, seen = new Set()) => {
    if (cache.has(id)) return cache.get(id);
    if (seen.has(id)) return '';
    seen.add(id);
    const node = byId.get(id);
    if (!node) return '';
    const kids = (childIds.get(id) || []).map((k) => compute(k, seen));
    const h = hashOf({ self: node.hash, kids });
    cache.set(id, h);
    return h;
  };
  for (const n of snapshot.nodes) n.subtreeHash = compute(n.id);
  return snapshot;
}
