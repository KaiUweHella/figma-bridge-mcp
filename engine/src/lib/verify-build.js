/**
 * Pure logic of `verify-build` — grep a project's text files against the
 * assets.json manifest(s) of `export assets`.
 *
 * Acceptance proof: three decorative SVGs (background pattern, metric waves,
 * nav glow) were exported, described in the spec, and still missing from the
 * build — a one-line grep over the project found all three mechanically.
 * This module IS that grep, plus a border-image lint (the other mechanical
 * finding: gradient stroke + radius built with border-image loses the
 * radius). Pure and filesystem-free so the rules are unit-testable.
 */

/**
 * @param {Array<object>} manifests - parsed assets.json contents ({ assets: [...] })
 * @param {Array<{path: string, text: string}>} files - project text files to grep
 * @returns {{
 *   total: number,
 *   referenced: string[],
 *   missing: Array<{file: string, entries: Array<object>}>,
 *   borderImage: Array<{path: string, line: number}>,
 * }}
 */
export function verifyBuild(manifests, files) {
  // Distinct asset file → its manifest entries (an entry per referencing node;
  // placement fields x/y/rootX/rootY/parent/parentId/absolutePosition/overhang ride along
  // so a missing file reports WHERE it belongs, not just that it is gone).
  const byFile = new Map();
  for (const m of manifests || []) {
    for (const a of m?.assets || []) {
      if (!a || !a.file) continue;
      if (!byFile.has(a.file)) byFile.set(a.file, []);
      byFile.get(a.file).push(a);
    }
  }
  const referenced = [];
  const missing = [];
  for (const [file, entries] of byFile) {
    const hit = (files || []).some((f) => f.text.includes(file));
    if (hit) referenced.push(file);
    else missing.push({ file, entries });
  }
  // border-image lint: CSS border-image IGNORES border-radius — a gradient
  // stroke on a rounded card silently loses its corners. The fix is the
  // wrapper/padding or mask pattern, never border-image.
  const borderImage = [];
  for (const f of files || []) {
    if (!/border-image/.test(f.text)) continue;
    const lines = f.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/border-image/.test(lines[i])) borderImage.push({ path: f.path, line: i + 1 });
    }
  }
  return { total: byFile.size, referenced, missing, borderImage };
}

/** One-line description of where a missing asset belongs, from its entries. */
export function describeMissing({ file, entries }) {
  const e = entries[0] || {};
  const size = e.width != null ? ` (${e.width}×${e.height})` : '';
  const at = e.rootX != null
    ? ` @ root ${e.rootX},${e.rootY}`
    : (e.x != null ? ` @ parent ${e.x},${e.y}` : '');
  const root = e.rootId ? ` [root ${e.rootId}]` : '';
  const parent = e.parent ? ` in "${e.parent}"` : '';
  const id = e.parentId ? ` [parent ${e.parentId}]` : '';
  const flags = [
    e.absolutePosition ? 'absolutely positioned' : null,
    e.overhang ? 'overhangs its parent — keep visible' : null,
  ].filter(Boolean);
  return `${file}${size}${at}${root}${parent}${id}${flags.length ? ` — ${flags.join(', ')}` : ''}`;
}
