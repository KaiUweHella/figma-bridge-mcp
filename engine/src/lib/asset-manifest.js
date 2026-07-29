/**
 * Manifest merging for `export assets` — pure, so the merge rules are
 * unit-testable without a Figma connection.
 *
 * Every export used to CLOBBER assets.json: a partial re-export (one card)
 * replaced the full-page manifest, orphaning every earlier `→ assets/…`
 * reference. Merging keeps prior entries alive as long as their files still
 * exist, and records every root the directory has been exported from.
 */

/**
 * Merge a prior manifest (parsed assets.json or null) with the entries of a
 * fresh export run.
 *
 * @param {object|null} prior - previous manifest ({ root, rootName, roots?, assets })
 * @param {Array} nextAssets - manifest entries of this run
 * @param {{id: string, name: string}} root - root node of this run
 * @param {(file: string) => boolean} fileExists - probe for a prior entry's file
 * @returns {{root: string, rootName: string, roots: Array, assets: Array}}
 */
export function mergeAssetManifest(prior, nextAssets, root, fileExists = () => true) {
  const newIds = new Set(nextAssets.map((m) => m.nodeId));
  const kept = (prior?.assets || []).filter((a) =>
    a && a.nodeId && !newIds.has(a.nodeId) && a.file && fileExists(a.file));
  const priorRoots = prior?.roots
    || (prior?.root ? [{ id: prior.root, name: prior.rootName }] : []);
  const roots = [...priorRoots.filter((r) => r && r.id !== root.id), { id: root.id, name: root.name }];
  return { root: root.id, rootName: root.name, roots, assets: [...kept, ...nextAssets] };
}
