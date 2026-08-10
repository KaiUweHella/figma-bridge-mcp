// Canonical Asset Policy for vector artwork.
//
// The policy accepts a tiny node-access adapter so the exact same
// Implementation classifies captured Design facts in Node and live Figma
// SceneNodes inside generated plugin code. This is the seam that prevents the
// spec and asset exporter from drifting.

export const VECTOR_CLUSTER_MIN_CHILDREN = 6;
export const VECTOR_CLUSTER_MIN_RATIO = 0.8;
const VECTOR_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'POLYGON', 'ELLIPSE', 'RECTANGLE'];
const HARD_VECTOR_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON'];

/**
 * Return whether a subtree is vector geometry and whether it contains at
 * least one hard/path primitive. `access` adapts either captured or live nodes.
 */
export function assetVectorFacts(node, access) {
  if (!node || access.visible(node) === false || access.hasImage(node)) {
    return { vec: false, hard: false };
  }
  const type = access.type(node);
  if (VECTOR_TYPES.includes(type)) return { vec: true, hard: HARD_VECTOR_TYPES.includes(type) };
  const kids = access.children(node).filter((child) => access.visible(child) !== false);
  if ((type === 'GROUP' || type === 'FRAME') && kids.length) {
    let hasHard = false;
    for (const child of kids) {
      const facts = assetVectorFacts(child, access);
      if (!facts.vec) return { vec: false, hard: false };
      hasHard = hasHard || facts.hard;
    }
    return { vec: true, hard: hasHard };
  }
  return { vec: false, hard: false };
}

/** One top-level artwork file: pure vector geometry with a path primitive. */
export function isAssetVectorArt(node, access) {
  const facts = assetVectorFacts(node, access);
  return facts.vec && facts.hard;
}

/** One artwork file for a mostly-vector container with a small amount of noise. */
export function assetVectorCluster(node, access) {
  const kids = access.children(node).filter((child) => access.visible(child) !== false);
  if (kids.length < VECTOR_CLUSTER_MIN_CHILDREN) return { cluster: false, vectorChildren: 0, totalChildren: kids.length };
  let vectorChildren = 0;
  for (const child of kids) if (isAssetVectorArt(child, access)) vectorChildren++;
  return {
    cluster: vectorChildren / kids.length >= VECTOR_CLUSTER_MIN_RATIO,
    vectorChildren,
    totalChildren: kids.length,
  };
}

export const CAPTURE_ASSET_ACCESS = Object.freeze({
  type: (node) => node.t,
  children: (node) => node.kids || [],
  visible: (node) => node.hidden !== true,
  hasImage: (node) => (node.fills || []).includes('IMAGE'),
});

export const captureVectorFacts = (node) => assetVectorFacts(node, CAPTURE_ASSET_ACCESS);
export const isCapturedVectorArt = (node) => isAssetVectorArt(node, CAPTURE_ASSET_ACCESS);
export const capturedVectorCluster = (node) => assetVectorCluster(node, CAPTURE_ASSET_ACCESS);

/**
 * Source for the plugin sandbox. Function source comes from the same policy
 * Implementation used in Node; only the live-node access adapter differs.
 */
export function assetPolicyPluginSource() {
  return `
    const VECTOR_CLUSTER_MIN_CHILDREN = ${VECTOR_CLUSTER_MIN_CHILDREN};
    const VECTOR_CLUSTER_MIN_RATIO = ${VECTOR_CLUSTER_MIN_RATIO};
    const VECTOR_TYPES = ${JSON.stringify(VECTOR_TYPES)};
    const HARD_VECTOR_TYPES = ${JSON.stringify(HARD_VECTOR_TYPES)};
    const assetVectorFacts = ${assetVectorFacts.toString()};
    const isAssetVectorArt = ${isAssetVectorArt.toString()};
    const assetVectorCluster = ${assetVectorCluster.toString()};
    const __assetAccess = {
      type: (n) => n.type,
      children: (n) => ('children' in n ? Array.from(n.children) : []),
      visible: (n) => n.visible !== false,
      hasImage: (n) => {
        try { return Array.isArray(n.fills) && n.fills.some((f) => f.type === 'IMAGE' && f.visible !== false && f.imageHash); }
        catch (e) { return false; }
      },
    };`;
}
