/**
 * Deterministic asset naming shared by `export assets` (writes files) and the
 * code-spec renderer (references them). Vector art uses semantic layer names;
 * IMAGE fills use Figma's stable image hash because separate requested roots
 * do not necessarily have the same ancestor-name context.
 */

const GENERIC = new Set(['group', 'frame', 'vector', 'rectangle', 'ellipse', 'image', 'union', 'subtract', 'intersect', 'exclude']);

/** Layer name → filesystem-safe kebab slug. */
export function assetSlug(name, fallback = 'asset') {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')       // strip diacritics
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return slug || fallback;
}

/** True for auto-generated layer names that make useless filenames. */
export function isGenericName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return true;
  // "Group", "Frame 2610008", "Vector 12", "image 4" …
  return GENERIC.has(n) || [...GENERIC].some((g) => new RegExp(`^${g}[\\s_-]*\\d*$`).test(n));
}

/**
 * Best display/file name for an asset node: its own name unless generic,
 * else the nearest meaningful ancestor name.
 */
export function effectiveAssetName(name, ancestors = []) {
  if (!isGenericName(name)) return name;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (!isGenericName(ancestors[i])) return ancestors[i];
  }
  return name || 'asset';
}

export function assetFileName(name, kind, ancestors = []) {
  return `${assetSlug(effectiveAssetName(name, ancestors))}.${kind}`;
}

/** Stable base for IMAGE-fill files. A node name/path changes with the
 * requested spec root; Figma's image hash does not. */
export function imageAssetBase(hash) {
  const stable = String(hash || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 24);
  return `image-${stable || 'unknown'}`;
}
