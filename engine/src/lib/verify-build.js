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
import { assetContentDigest } from './asset-manifest.js';

/**
 * @param {Array<object>} manifests - parsed assets.json contents ({ assets: [...] })
 * @param {Array<{path: string, text: string}>} files - project text files to grep
 * @param {Array<{file: string, path?: string, bytes: Uint8Array}>|null} assetFiles
 * @returns {{
 *   total: number,
 *   referenced: string[],
 *   missing: Array<{file: string, entries: Array<object>}>,
 *   borderImage: Array<{path: string, line: number}>,
 *   integrity: {checked: string[], mismatched: Array<object>, missingFiles: Array<object>, unverified: string[]},
 * }}
 */
export function verifyBuild(manifests, files, assetFiles = null) {
  // Distinct asset file → its manifest entries (an entry per referencing node;
  // placement fields x/y/rootX/rootY/parent/parentId/absolutePosition/overhang ride along
  // so a missing file reports WHERE it belongs, not just that it is gone).
  const byFile = new Map();
  for (const m of manifests || []) {
    for (const a of m?.assets || []) {
      if (!a || !a.file) continue;
      if (!byFile.has(a.file)) byFile.set(a.file, []);
      if (Array.isArray(a.placements) && a.placements.length) {
        for (const placement of a.placements) byFile.get(a.file).push({
          ...placement,
          file: a.file,
          kind: a.kind,
          sourceIdentity: a.sourceIdentity,
          contentDigest: a.contentDigest,
        });
      } else {
        byFile.get(a.file).push(a);
      }
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

  const expectedByFile = new Map();
  for (const manifest of manifests || []) {
    for (const asset of manifest?.assets || []) {
      if (!asset?.file) continue;
      if (!expectedByFile.has(asset.file)) expectedByFile.set(asset.file, []);
      expectedByFile.get(asset.file).push(asset);
    }
  }
  const actualByFile = new Map();
  for (const assetFile of assetFiles || []) {
    if (!actualByFile.has(assetFile.file)) actualByFile.set(assetFile.file, []);
    actualByFile.get(assetFile.file).push(assetFile);
  }
  const integrity = { checked: [], mismatched: [], missingFiles: [], unverified: [] };
  for (const [file, expectedAssets] of expectedByFile) {
    const digests = [...new Set(expectedAssets.map((asset) => asset.contentDigest).filter(Boolean))];
    if (!digests.length || !Array.isArray(assetFiles)) {
      integrity.unverified.push(file);
      continue;
    }
    if (digests.length > 1) {
      integrity.mismatched.push({ file, expected: digests, actual: null, reason: 'conflicting manifest digests' });
      continue;
    }
    const actualFiles = actualByFile.get(file) || [];
    if (!actualFiles.length) {
      integrity.missingFiles.push({ file, expected: digests[0] });
      continue;
    }
    let clean = true;
    for (const actualFile of actualFiles) {
      const kind = actualFile.kind || expectedAssets[0].kind;
      const actual = assetContentDigest(actualFile.bytes, kind);
      if (actual !== digests[0]) {
        clean = false;
        integrity.mismatched.push({
          file,
          ...(actualFile.path ? { path: actualFile.path } : {}),
          expected: digests[0],
          actual,
        });
      }
    }
    if (clean) integrity.checked.push(file);
  }
  return { total: byFile.size, referenced, missing, borderImage, integrity };
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
