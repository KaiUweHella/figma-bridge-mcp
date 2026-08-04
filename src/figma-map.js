// figma-map.json reader — the Figma↔Storybook mapping written by
// `figma-cli map storybook`. Server-side only (never spawns the engine):
// annotates figma_selection and figma_spec output with the mirroring story.
// Missing/corrupt file → null, silently: the annotation is a bonus, never
// a failure mode.
import fs from "node:fs";
import path from "node:path";

let cache = { path: null, mtimeMs: 0, index: null };

/**
 * Load and index the map. Lookup works over BOTH figmaKey (identity) and
 * figmaVariantKey (instancing handle) — selections resolve instances to the
 * variant's key, while sets are identified by their own key.
 * @param {string} [cwd]
 * @returns {{byKey: Map<string, object>} | null}
 */
export function loadFigmaMap(cwd = process.cwd()) {
  const file = path.join(cwd, "figma-map.json");
  try {
    const stat = fs.statSync(file);
    if (cache.path === file && cache.mtimeMs === stat.mtimeMs) return cache.index;
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const byKey = new Map();
    for (const m of doc.mappings || []) {
      if (!m || typeof m !== "object") continue;
      if (m.figmaKey) byKey.set(m.figmaKey, m);
      if (m.figmaVariantKey) byKey.set(m.figmaVariantKey, m);
    }
    cache = { path: file, mtimeMs: stat.mtimeMs, index: { byKey } };
    return cache.index;
  } catch {
    cache = { path: file, mtimeMs: 0, index: null };
    return null;
  }
}

/**
 * Annotation text for a component key, or null when unmapped/no map.
 * @param {string} key
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function annotationFor(key, cwd = process.cwd()) {
  if (!key) return null;
  const index = loadFigmaMap(cwd);
  const m = index?.byKey.get(key);
  if (!m || !m.storyId) return null;
  // description comes from the REST library-metadata enrichment (optional) —
  // in maintained design systems it often names the code path or usage rule.
  const desc = m.description ? `  desc: ${truncate(m.description, 80)}` : "";
  return `↔ story ${m.storyId}${m.importPath ? ` (${m.importPath})` : ""}${desc}`;
}

function truncate(s, max) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Scan text output (figma_spec) for the backtick key form `key \`…\`` and
 * build a "## Storybook mapping" trailer for every mapped hit. Returns "" when
 * nothing matches or no map exists.
 * @param {string} text
 * @param {string} [cwd]
 * @returns {string}
 */
export function storybookTrailer(text, cwd = process.cwd()) {
  const index = loadFigmaMap(cwd);
  if (!index) return "";
  const seen = new Set();
  const lines = [];
  for (const m of String(text).matchAll(/key `([^`]+)`/g)) {
    const mapping = index.byKey.get(m[1]);
    if (!mapping || !mapping.storyId || seen.has(mapping.storyId)) continue;
    seen.add(mapping.storyId);
    const desc = mapping.description ? ` — ${truncate(mapping.description, 80)}` : "";
    lines.push(`- ${mapping.figmaName} ↔ story ${mapping.storyId}${mapping.importPath ? ` (${mapping.importPath})` : ""}${desc}`);
  }
  return lines.length ? `\n\n## Storybook mapping\n${lines.join("\n")}` : "";
}
