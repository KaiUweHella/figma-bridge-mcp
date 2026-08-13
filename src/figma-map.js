// Server-side Design Link Registry projection (never spawns the engine).
// figma-bridge.json is the explicit source; figma-map.json remains a legacy
// read adapter. Missing/corrupt files → null silently: annotations are a
// bonus and must never make figma_selection or figma_spec fail.
import fs from "node:fs";
import path from "node:path";
import {
  DESIGN_LINK_REGISTRY_FILE,
  LEGACY_FIGMA_MAP_FILE,
  readDesignLinkRegistry,
  resolveDesignEntity,
} from "../engine/src/lib/design-link-registry.js";

let cache = { signature: null, index: null };

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function mappingFromEntity(entity) {
  const figma = entity.figma || {};
  const storybook = entity.storybook || {};
  const code = entity.code || {};
  return {
    entityId: entity.id,
    entityKind: entity.kind,
    figmaName: figma.name || entity.id,
    figmaPage: figma.page,
    figmaKey: figma.componentKey,
    figmaVariantKey: figma.variantKey,
    figmaNodeId: figma.nodeId,
    figmaFileKey: figma.fileKey,
    storyId: storybook.storyId,
    storyTitle: storybook.storyTitle,
    importPath: storybook.importPath || code.path,
    stories: storybook.stories,
    codePath: code.path,
    codeExport: code.export,
    description: storybook.description,
    documentationLinks: storybook.documentationLinks,
    legacy: entity.legacy === true,
  };
}

/**
 * Load and index the map. Lookup works over BOTH figmaKey (identity) and
 * figmaVariantKey (instancing handle) — selections resolve instances to the
 * variant's key, while sets are identified by their own key.
 * @param {string} [cwd]
 * @returns {{byKey: Map<string, object>} | null}
 */
export function loadFigmaMap(cwd = process.cwd()) {
  const registryFile = path.join(cwd, DESIGN_LINK_REGISTRY_FILE);
  const legacyFile = path.join(cwd, LEGACY_FIGMA_MAP_FILE);
  const signature = `${registryFile}:${fileStamp(registryFile)}|${legacyFile}:${fileStamp(legacyFile)}`;
  try {
    if (cache.signature === signature) return cache.index;
    const loaded = readDesignLinkRegistry(cwd);
    if (!loaded.explicit && !loaded.legacyPath) {
      cache = { signature, index: null };
      return null;
    }
    const byKey = new Map();
    const byId = new Map();
    const byNode = new Map();
    for (const entity of loaded.registry.entities || []) {
      const mapping = mappingFromEntity(entity);
      byId.set(entity.id, mapping);
      if (mapping.figmaKey) byKey.set(mapping.figmaKey, mapping);
      if (mapping.figmaVariantKey) byKey.set(mapping.figmaVariantKey, mapping);
      if (mapping.figmaNodeId) {
        byNode.set(`${mapping.figmaFileKey || ""}\0${mapping.figmaNodeId}`, mapping);
        byNode.set(`\0${mapping.figmaNodeId}`, mapping);
      }
    }
    const index = { byKey, byId, byNode, registry: loaded.registry };
    cache = { signature, index };
    return cache.index;
  } catch {
    cache = { signature, index: null };
    return null;
  }
}

/** Resolve by the strongest available link: entity id, publish key, then node. */
export function designEntityFor(query = {}, cwd = process.cwd()) {
  const index = loadFigmaMap(cwd);
  if (!index) return null;
  if (query.id && index.byId.has(query.id)) return index.byId.get(query.id);
  if (query.componentKey && index.byKey.has(query.componentKey)) return index.byKey.get(query.componentKey);
  if (query.nodeId) {
    return index.byNode.get(`${query.fileKey || ""}\0${query.nodeId}`)
      || index.byNode.get(`\0${query.nodeId}`)
      || null;
  }
  try {
    const entity = resolveDesignEntity(index.registry, query);
    return entity ? mappingFromEntity(entity) : null;
  } catch {
    return null;
  }
}

export function formatDesignEntityAnnotation(mapping) {
  if (!mapping?.entityId) return null;
  const code = mapping.codePath
    ? ` ↔ code ${mapping.codePath}${mapping.codeExport ? `#${mapping.codeExport}` : ""}`
    : "";
  const story = mapping.storyId ? ` ↔ story ${mapping.storyId}` : "";
  return `entity \`${mapping.entityId}\`${code}${story}`;
}

export function designEntityAnnotationFor(query, cwd = process.cwd()) {
  return formatDesignEntityAnnotation(designEntityFor(query, cwd));
}

/** Add repository links for every explicit entity rendered in tree specs. */
export function designEntityTrailer(text, cwd = process.cwd()) {
  const seen = new Set();
  const lines = [];
  for (const match of String(text).matchAll(/entity `([^`]+)`/g)) {
    const mapping = designEntityFor({ id: match[1] }, cwd);
    if (!mapping || seen.has(mapping.entityId)) continue;
    seen.add(mapping.entityId);
    const annotation = formatDesignEntityAnnotation(mapping);
    if (annotation) lines.push(`- ${annotation}`);
  }
  return lines.length ? `\n\n## Design Entity links\n${lines.join("\n")}` : "";
}

/** Resolve canonical structured-spec entity fields to portable repo links. */
export function designEntityMappingsForSpecModel(model, cwd = process.cwd()) {
  if (!model || typeof model !== "object") return [];
  const ids = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.entityId === "string" && node.entityId) ids.add(node.entityId);
    for (const child of node.kids || []) visit(child);
  };
  for (const frame of model.frames || []) visit(frame);
  for (const set of model.sets || []) visit(set);
  return [...ids].map((id) => designEntityFor({ id }, cwd)).filter(Boolean).map((mapping) => ({
    id: mapping.entityId,
    kind: mapping.entityKind,
    ...(mapping.codePath ? { code: {
      path: mapping.codePath,
      ...(mapping.codeExport ? { export: mapping.codeExport } : {}),
    } } : {}),
    ...(mapping.storyId ? { storybook: {
      storyId: mapping.storyId,
      ...(mapping.storyTitle ? { storyTitle: mapping.storyTitle } : {}),
    } } : {}),
    ...(mapping.figmaNodeId || mapping.figmaKey ? { figma: {
      ...(mapping.figmaFileKey ? { fileKey: mapping.figmaFileKey } : {}),
      ...(mapping.figmaNodeId ? { nodeId: mapping.figmaNodeId } : {}),
      ...(mapping.figmaKey ? { componentKey: mapping.figmaKey } : {}),
    } } : {}),
  }));
}

/**
 * Annotation text for a component key, or null when unmapped/no map.
 * @param {string} key
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function annotationFor(key, cwd = process.cwd()) {
  if (!key) return null;
  const m = designEntityFor({ componentKey: key }, cwd);
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

/**
 * Resolve Storybook mappings from canonical structured-spec fields.
 *
 * Tree output exposes keys as rendered text; YAML/JSON keep them as `mainKey`,
 * `setKey` and `dvKey`. Walking the model avoids a format-specific regex and
 * makes Storybook enrichment equally available to every structured adapter.
 * @param {object} model
 * @param {string} [cwd]
 * @returns {object[]}
 */
export function storybookMappingsForSpecModel(model, cwd = process.cwd()) {
  const index = loadFigmaMap(cwd);
  if (!index || !model || typeof model !== "object") return [];
  const keys = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const field of ["mainKey", "setKey", "dvKey"]) {
      if (typeof node[field] === "string" && node[field]) keys.add(node[field]);
    }
    for (const child of node.kids || []) visit(child);
  };
  for (const frame of model.frames || []) visit(frame);
  for (const set of model.sets || []) visit(set);

  const seen = new Set();
  const mappings = [];
  for (const key of keys) {
    const mapping = index.byKey.get(key);
    if (!mapping?.storyId || seen.has(mapping.storyId)) continue;
    seen.add(mapping.storyId);
    mappings.push({
      figmaName: mapping.figmaName,
      ...(mapping.figmaKey ? { figmaKey: mapping.figmaKey } : {}),
      ...(mapping.figmaVariantKey ? { figmaVariantKey: mapping.figmaVariantKey } : {}),
      storyId: mapping.storyId,
      ...(mapping.importPath ? { importPath: mapping.importPath } : {}),
      ...(mapping.description ? { description: mapping.description } : {}),
      ...(mapping.documentationLinks?.length
        ? { documentationLinks: mapping.documentationLinks }
        : {}),
    });
  }
  return mappings;
}
