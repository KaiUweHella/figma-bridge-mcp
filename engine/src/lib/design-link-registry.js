// Design Link Registry — durable identity across a code repository and Figma.
//
// The repository adapter is figma-bridge.json. Figma plugin data is the
// document adapter (the command that writes it lives in commands/link.js).
// This Module owns schema validation, lookup, conflict detection, legacy
// figma-map.json adaptation and atomic persistence so callers never need to
// understand how those representations fit together.
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DESIGN_LINK_REGISTRY_VERSION = 1;
export const DESIGN_LINK_REGISTRY_FILE = 'figma-bridge.json';
export const LEGACY_FIGMA_MAP_FILE = 'figma-map.json';
export const DESIGN_ENTITY_PLUGIN_DATA_KEY = 'figma-bridge-design-entity';
export const DESIGN_ENTITY_PLUGIN_DATA_VERSION = 1;

const ENTITY_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const ENTITY_KINDS = new Set(['component', 'screen', 'frame']);
const FINGERPRINT = /^[a-f0-9]{12,64}$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || child === null || child === '') continue;
    const normalized = compact(child);
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)
      && Object.keys(normalized).length === 0) continue;
    out[key] = normalized;
  }
  return out;
}

export function normalizeDesignEntityId(value) {
  const id = String(value || '').trim();
  if (!ENTITY_ID.test(id)) {
    throw new Error(
      `Invalid Design Entity id "${id}" — use 1-128 lowercase letters, numbers, dot, slash, underscore or hyphen (for example ui.button).`,
    );
  }
  return id;
}

export function normalizeDesignEntityKind(value, fallback = 'frame') {
  const kind = String(value || fallback).trim().toLowerCase();
  if (!ENTITY_KINDS.has(kind)) {
    throw new Error(`Invalid Design Entity kind "${kind}" — use component, screen or frame.`);
  }
  return kind;
}

/** Store source paths portably and refuse links outside the project root. */
export function normalizeRepositoryPath(value, projectRoot = process.cwd()) {
  if (!value) return null;
  const root = resolve(projectRoot);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, absolute);
  if (!rel || rel === '.') return null;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Code source must stay inside the project: ${value}`);
  }
  return rel.split(sep).join('/');
}

export function emptyDesignLinkRegistry(project = {}) {
  return {
    version: DESIGN_LINK_REGISTRY_VERSION,
    project: compact(object(project)),
    entities: [],
  };
}

function normalizeBaseline(value) {
  const raw = object(value);
  if (!Object.keys(raw).length) return {};
  if (raw.version !== 1) throw new Error(`Invalid Design Entity baseline version: ${raw.version}`);
  const codeHash = raw.code?.hash;
  const figmaHash = raw.figma?.hash;
  if (!FINGERPRINT.test(String(codeHash || '')) || !FINGERPRINT.test(String(figmaHash || ''))) {
    throw new Error('Invalid Design Entity baseline: code and Figma fingerprints are required.');
  }
  if (typeof raw.acceptedAt !== 'string' || Number.isNaN(Date.parse(raw.acceptedAt))) {
    throw new Error('Invalid Design Entity baseline: acceptedAt must be an ISO timestamp.');
  }
  return {
    version: 1,
    acceptedAt: raw.acceptedAt,
    code: { hash: codeHash },
    figma: { hash: figmaHash },
    ...(raw.visual && Number.isFinite(Number(raw.visual.diffPct)) ? {
      visual: {
        diffPct: Number(raw.visual.diffPct),
        maxDiff: Number(raw.visual.maxDiff),
        comparedAt: raw.visual.comparedAt,
        buildHash: raw.visual.buildHash,
        figmaPngHash: raw.visual.figmaPngHash,
      },
    } : {}),
  };
}

function normalizeEntity(value) {
  const raw = object(value);
  const entity = compact({
    id: normalizeDesignEntityId(raw.id),
    kind: normalizeDesignEntityKind(raw.kind),
    code: object(raw.code),
    storybook: object(raw.storybook),
    figma: object(raw.figma),
    baseline: normalizeBaseline(raw.baseline),
    legacy: raw.legacy === true ? true : undefined,
  });
  return entity;
}

function handleEntries(entity) {
  const f = object(entity.figma);
  const s = object(entity.storybook);
  return [
    f.componentKey && ['componentKey', String(f.componentKey)],
    f.variantKey && ['variantKey', String(f.variantKey)],
    f.nodeId && ['node', `${f.fileKey || ''}\0${f.nodeId}`],
    s.storyId && ['storyId', String(s.storyId)],
  ].filter(Boolean);
}

function assertNoConflicts(entities) {
  const ids = new Set();
  const handles = new Map();
  for (const entity of entities) {
    if (ids.has(entity.id)) throw new Error(`Duplicate Design Entity id: ${entity.id}`);
    ids.add(entity.id);
    for (const [kind, value] of handleEntries(entity)) {
      const key = `${kind}\0${value}`;
      const previous = handles.get(key);
      if (previous && previous !== entity.id) {
        throw new Error(`Conflicting ${kind} link: ${previous} and ${entity.id}`);
      }
      handles.set(key, entity.id);
    }
  }
}

export function parseDesignLinkRegistry(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (error) {
    throw new Error(`Invalid ${DESIGN_LINK_REGISTRY_FILE}: ${error.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`Invalid ${DESIGN_LINK_REGISTRY_FILE}: root must be an object.`);
  }
  if (doc.version !== DESIGN_LINK_REGISTRY_VERSION) {
    throw new Error(
      `Unsupported ${DESIGN_LINK_REGISTRY_FILE} version ${JSON.stringify(doc.version)}; expected ${DESIGN_LINK_REGISTRY_VERSION}.`,
    );
  }
  if (!Array.isArray(doc.entities)) {
    throw new Error(`Invalid ${DESIGN_LINK_REGISTRY_FILE}: entities must be an array.`);
  }
  const entities = doc.entities.map(normalizeEntity).sort((a, b) => a.id.localeCompare(b.id));
  assertNoConflicts(entities);
  return compact({
    version: DESIGN_LINK_REGISTRY_VERSION,
    project: object(doc.project),
    entities,
  });
}

export function serializeDesignLinkRegistry(registry) {
  const parsed = parseDesignLinkRegistry(JSON.stringify(registry));
  return JSON.stringify(parsed, null, 2) + '\n';
}

function legacyId(mapping) {
  const seed = mapping.storyTitle || mapping.storyId || mapping.figmaKey || mapping.figmaNodeId || 'entity';
  const slug = String(seed).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 80) || 'entity';
  const hash = createHash('sha256').update(JSON.stringify([
    mapping.figmaKey, mapping.figmaVariantKey, mapping.storyTitle, mapping.storyId,
  ])).digest('hex').slice(0, 8);
  return `legacy.${slug}.${hash}`;
}

export function adaptLegacyFigmaMap(doc) {
  const entities = [];
  for (const mapping of Array.isArray(doc?.mappings) ? doc.mappings : []) {
    if (!mapping || typeof mapping !== 'object') continue;
    try {
      entities.push(normalizeEntity({
        id: legacyId(mapping),
        kind: 'component',
        code: mapping.importPath ? { path: String(mapping.importPath).replace(/^\.\//, '') } : {},
        storybook: {
          storyId: mapping.storyId,
          storyTitle: mapping.storyTitle,
          importPath: mapping.importPath,
          stories: mapping.stories,
        },
        figma: {
          nodeId: mapping.figmaNodeId,
          componentKey: mapping.figmaKey,
          variantKey: mapping.figmaVariantKey,
          name: mapping.figmaName,
          page: mapping.figmaPage,
        },
        legacy: true,
      }));
    } catch {
      // One malformed legacy row must not hide every valid mapping.
    }
  }
  // Legacy maps predate conflict enforcement and can contain stale duplicates.
  // Preserve the first unambiguous handle; explicit registry entities win later.
  const accepted = [];
  for (const entity of entities) {
    try { assertNoConflicts([...accepted, entity]); accepted.push(entity); } catch {}
  }
  return accepted;
}

function mergeLegacy(registry, legacyEntities) {
  const explicit = registry.entities || [];
  const merged = [...explicit];
  for (const entity of legacyEntities) {
    try { assertNoConflicts([...merged, entity]); merged.push(entity); } catch {}
  }
  return { ...registry, entities: merged.sort((a, b) => a.id.localeCompare(b.id)) };
}

/**
 * Read the explicit registry and enrich it with non-conflicting legacy rows.
 * @param {string} [projectRoot]
 * @param {{manifestPath?: string}} [options]
 */
export function readDesignLinkRegistry(projectRoot = process.cwd(), { manifestPath } = {}) {
  const root = resolve(projectRoot);
  const path = manifestPath ? resolve(manifestPath) : join(root, DESIGN_LINK_REGISTRY_FILE);
  const legacyPath = join(root, LEGACY_FIGMA_MAP_FILE);
  let registry = emptyDesignLinkRegistry();
  let explicit = false;
  if (existsSync(path)) {
    registry = parseDesignLinkRegistry(readFileSync(path, 'utf8'));
    explicit = true;
  }
  let legacyEntities = [];
  if (existsSync(legacyPath)) {
    try { legacyEntities = adaptLegacyFigmaMap(JSON.parse(readFileSync(legacyPath, 'utf8'))); } catch {}
  }
  return {
    registry: mergeLegacy(registry, legacyEntities),
    // Commands may read the merged projection, but only this explicit side is
    // writable. A legacy adapter must never silently become stored truth.
    writableRegistry: registry,
    path,
    explicit,
    legacyPath: legacyEntities.length ? legacyPath : null,
  };
}

export function resolveDesignEntity(registry, query = {}) {
  const entities = Array.isArray(registry?.entities) ? registry.entities : [];
  const matches = entities.filter((entity) => {
    if (query.id && entity.id === query.id) return true;
    const f = object(entity.figma);
    const s = object(entity.storybook);
    if (query.componentKey && (f.componentKey === query.componentKey || f.variantKey === query.componentKey)) return true;
    if (query.nodeId && f.nodeId === query.nodeId && (!query.fileKey || !f.fileKey || f.fileKey === query.fileKey)) return true;
    if (query.storyId && s.storyId === query.storyId) return true;
    return false;
  });
  if (matches.length > 1) {
    throw new Error(`Ambiguous Design Entity lookup: ${matches.map((entity) => entity.id).join(', ')}`);
  }
  return matches[0] || null;
}

/** Project the durable component entities into the minimal lookup table used
 * by Code -> Figma DOM compilation. A display name alone is deliberately not
 * a handle: only a publish key or an explicit file-local node id may produce
 * an Instance. */
export function componentLinksFromRegistry(registry) {
  const links = {};
  for (const entity of Array.isArray(registry?.entities) ? registry.entities : []) {
    if (entity.kind !== 'component') continue;
    const figmaLink = object(entity.figma);
    const key = figmaLink.variantKey || figmaLink.componentKey || null;
    const id = figmaLink.nodeId || null;
    if (!key && !id) continue;
    links[entity.id] = compact({
      entityId: entity.id,
      key,
      id,
      name: figmaLink.name,
      fileKey: figmaLink.fileKey,
      variant: figmaLink.variant,
    });
  }
  return links;
}

/** Upsert one explicit entity while preserving fields omitted by the caller. */
export function upsertDesignEntity(registry, patch) {
  const id = normalizeDesignEntityId(patch?.id);
  const current = (registry?.entities || []).find((entity) => entity.id === id && entity.legacy !== true);
  const merged = normalizeEntity({
    ...current,
    ...patch,
    id,
    code: { ...object(current?.code), ...object(patch?.code) },
    storybook: { ...object(current?.storybook), ...object(patch?.storybook) },
    figma: { ...object(current?.figma), ...object(patch?.figma) },
    baseline: { ...object(current?.baseline), ...object(patch?.baseline) },
    legacy: undefined,
  });
  const explicit = (registry?.entities || []).filter((entity) => entity.legacy !== true && entity.id !== id);
  const entities = [...explicit, merged].sort((a, b) => a.id.localeCompare(b.id));
  assertNoConflicts(entities);
  return {
    version: DESIGN_LINK_REGISTRY_VERSION,
    project: compact(object(registry?.project)),
    entities,
  };
}

/** Atomic repository-adapter write: readers see either the old or new file. */
export function writeDesignLinkRegistry(path, registry) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, serializeDesignLinkRegistry(registry), { mode: 0o644 });
    renameSync(temp, target);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  return target;
}

export function serializeDesignEntityPluginData(entity) {
  return JSON.stringify({
    version: DESIGN_ENTITY_PLUGIN_DATA_VERSION,
    id: normalizeDesignEntityId(entity?.id),
    kind: normalizeDesignEntityKind(entity?.kind),
  });
}

export function parseDesignEntityPluginData(text) {
  if (!text) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (value?.version !== DESIGN_ENTITY_PLUGIN_DATA_VERSION) return null;
  try {
    return {
      version: DESIGN_ENTITY_PLUGIN_DATA_VERSION,
      id: normalizeDesignEntityId(value.id),
      kind: normalizeDesignEntityKind(value.kind),
    };
  } catch {
    return null;
  }
}
