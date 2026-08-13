import { Script } from 'node:vm';

export function parseResizeProbeDelta(value, fallback = 120) {
  if (value === undefined || value === true) return fallback;
  const delta = Number(value);
  if (!Number.isFinite(delta) || delta < 1 || delta > 2000) {
    throw new Error(`--resize-probe must be a number from 1 to 2000, got "${value}"`);
  }
  return delta;
}

/** Build a reversible live Figma probe. It temporarily widens the rendered
 * root, measures every semantically tagged descendant, and restores the exact
 * root size in a finally block. The report distinguishes declared FILL nodes
 * that stayed fixed from measured full-width children whose fill intent was
 * lost before execution. */
export function semanticRootResizeProbeCode(nodeId, delta = 120) {
  const safeDelta = parseResizeProbeDelta(delta);
  const source = `(async () => {
  const root = await figma.getNodeByIdAsync(${JSON.stringify(String(nodeId))});
  if (!root || typeof root.resize !== 'function') throw new Error('Resize probe root is unavailable or not resizable');
  const nodes = [root, ...root.findAll((node) => typeof node.getPluginData === 'function'
    && Boolean(node.getPluginData('figmaBridge.semanticPath')))];
  const measure = (node) => ({
    id: node.id, name: node.name,
    path: typeof node.getPluginData === 'function' ? node.getPluginData('figmaBridge.semanticPath') : '',
    width: node.width, height: node.height, x: node.x, y: node.y,
    parentId: node.parent?.id || null,
  });
  const snapshot = () => new Map(nodes.map((node) => [node.id, measure(node)]));
  const before = snapshot();
  let after;
  let restored;
  try {
    root.resize(root.width + ${safeDelta}, root.height);
    after = snapshot();
  } finally {
    const initial = before.get(root.id);
    root.resize(initial.width, initial.height);
    restored = snapshot();
  }
  const changedBy = (id, field, first = before, second = after) =>
    Math.abs((second.get(id)?.[field] || 0) - (first.get(id)?.[field] || 0));
  const parentHasFlexibleColumn = (node) => {
    const parent = node.parent;
    if (!parent || parent.layoutMode !== 'GRID') return true;
    const start = Number(node.gridColumnAnchorIndex || 0);
    const span = Math.max(1, Number(node.gridColumnSpan || 1));
    return Array.from(parent.gridColumnSizes || []).slice(start, start + span)
      .some((track) => track.type === 'FLEX');
  };
  const responsive = nodes.filter((node) => {
    if (node === root || !node.parent || !before.has(node.parent.id)) return false;
    if (node.layoutSizingHorizontal !== 'FILL') return false;
    if (changedBy(node.parent.id, 'width') <= 0.5) return false;
    return parentHasFlexibleColumn(node);
  });
  const stuck = responsive.filter((node) => changedBy(node.id, 'width') <= 0.5);
  const suspiciousFixed = nodes.filter((node) => {
    const parent = node.parent;
    if (node === root || !parent || parent.layoutMode !== 'VERTICAL' || !before.has(parent.id)) return false;
    if (node.layoutSizingHorizontal === 'FILL' || changedBy(parent.id, 'width') <= 0.5 || changedBy(node.id, 'width') > 0.5) return false;
    const parentBefore = before.get(parent.id);
    const innerWidth = parentBefore.width - Number(parent.paddingLeft || 0) - Number(parent.paddingRight || 0);
    return Math.abs(before.get(node.id).width - innerWidth) <= 1;
  });
  const changed = nodes.filter((node) => changedBy(node.id, 'width') > 0.5 || changedBy(node.id, 'x') > 0.5);
  const restoreMismatches = nodes.filter((node) =>
    changedBy(node.id, 'width', before, restored) > 0.5
    || changedBy(node.id, 'height', before, restored) > 0.5
    || changedBy(node.id, 'x', before, restored) > 0.5
    || changedBy(node.id, 'y', before, restored) > 0.5);
  const brief = (node) => ({
    id: node.id, path: before.get(node.id)?.path || node.name,
    beforeWidth: Math.round(before.get(node.id).width * 1000) / 1000,
    probeWidth: Math.round(after.get(node.id).width * 1000) / 1000,
    deltaWidth: Math.round((after.get(node.id).width - before.get(node.id).width) * 1000) / 1000,
  });
  return {
    version: 1,
    root: { id: root.id, beforeWidth: before.get(root.id).width, probeWidth: after.get(root.id).width, restoredWidth: restored.get(root.id).width },
    passed: responsive.length > 0 && stuck.length === 0 && suspiciousFixed.length === 0 && restoreMismatches.length === 0,
    summary: {
      nodes: nodes.length, changedNodes: changed.length,
      responsiveCandidates: responsive.length, stuckResponsiveNodes: stuck.length,
      suspiciousFixedWidthNodes: suspiciousFixed.length, restoreMismatches: restoreMismatches.length,
    },
    responsive: responsive.slice(0, 20).map(brief),
    stuck: stuck.slice(0, 20).map(brief),
    suspiciousFixed: suspiciousFixed.slice(0, 20).map(brief),
    restoreMismatches: restoreMismatches.slice(0, 20).map(brief),
  };
})()`;
  // Keep code-generation failures local and deterministic rather than finding
  // them only after a Figma write.
  new Script(source);
  return source;
}

export function formatSemanticResizeProbe(report) {
  const summary = report?.summary || {};
  const status = report?.passed ? 'PASS' : 'FAIL';
  return `${status} — +${Number(report?.root?.probeWidth || 0) - Number(report?.root?.beforeWidth || 0)} px; `
    + `${summary.changedNodes || 0} changed, ${summary.responsiveCandidates || 0} responsive, `
    + `${summary.stuckResponsiveNodes || 0} stuck, ${summary.suspiciousFixedWidthNodes || 0} suspicious fixed, `
    + `${summary.restoreMismatches || 0} restore mismatches`;
}
