import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalSvg } from './svg-dedup.js';

export const ASSET_MANIFEST_SCHEMA_VERSION = 2;

/** Content identity is independent from its semantic label and filename. */
export function assetContentDigest(bytes, kind = '') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  if (kind === 'vector' || kind === 'icon' || /^\s*<svg[\s>]/i.test(buffer.toString('utf8', 0, 256))) {
    return `svg-visual-sha256:${createHash('sha256').update(canonicalSvg(buffer)).digest('hex')}`;
  }
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

const digestToken = (digest, length = 8) => String(digest || '').split(':').at(-1).slice(0, length);
const splitFile = (file) => {
  const match = String(file || '').match(/^(.*?)(\.[^.]+)?$/);
  return { base: match?.[1] || 'asset', ext: match?.[2] || '' };
};

function legacyAssets(prior) {
  const byFile = new Map();
  for (const entry of prior?.assets || []) {
    if (!entry?.file) continue;
    if (!byFile.has(entry.file)) {
      byFile.set(entry.file, {
        sourceIdentity: entry.imageHash ? `figma-image:${entry.imageHash}` : `legacy-file:${entry.file}`,
        contentDigest: null,
        semanticLabel: entry.name || splitFile(entry.file).base,
        file: entry.file,
        kind: entry.kind || 'asset',
        placements: [],
      });
    }
    const { file: _file, kind: _kind, imageHash: _imageHash, ...placement } = entry;
    byFile.get(entry.file).placements.push(placement);
  }
  return [...byFile.values()];
}

function normalizedPriorAssets(prior, { fileExists, digestForFile }) {
  const raw = prior?.schemaVersion === ASSET_MANIFEST_SCHEMA_VERSION
    ? (prior.assets || [])
    : legacyAssets(prior);
  const assets = [];
  for (const asset of raw) {
    if (!asset?.file || !fileExists(asset.file)) continue;
    const actualDigest = digestForFile?.(asset.file, asset.kind) || null;
    if (asset.contentDigest && actualDigest && asset.contentDigest !== actualDigest) {
      throw new Error(`Asset integrity mismatch for ${asset.file}: manifest ${asset.contentDigest}, file ${actualDigest}`);
    }
    assets.push({
      ...asset,
      contentDigest: asset.contentDigest || actualDigest,
      placements: [...(asset.placements || [])],
      ...(asset.sourceAliases ? { sourceAliases: [...asset.sourceAliases] } : {}),
    });
  }
  return assets;
}

function stableCollisionFile(proposedFile, contentDigest, reserved, fileExists, digestForFile, kind) {
  const { base, ext } = splitFile(proposedFile);
  for (const length of [8, 12, 16, 24, 32, 64]) {
    const file = `${base}-${digestToken(contentDigest, length)}${ext}`;
    const known = reserved.get(file);
    if (known?.contentDigest === contentDigest) return file;
    if (!known && !fileExists(file)) return file;
    if (!known && digestForFile?.(file, kind) === contentDigest) return file;
  }
  throw new Error(`Cannot reserve a stable filename for ${proposedFile} (${contentDigest})`);
}

const placementKey = (placement) => `${placement.rootId || ''}\0${placement.nodeId || ''}`;

/**
 * Deep Asset Export Plan Interface. It separates source identity, content,
 * semantic naming, persistent filenames and placements before any write.
 * Existing files are reservations: different content is never overwritten.
 */
export function planAssetExport(prior, candidates, root, adapters = {}) {
  const fileExists = adapters.fileExists || (() => false);
  const digestForFile = adapters.digestForFile || (() => null);
  const assets = normalizedPriorAssets(prior, { fileExists, digestForFile });
  const reserved = new Map(assets.map((asset) => [asset.file, asset]));
  const byDigest = new Map(assets.filter((asset) => asset.contentDigest)
    .map((asset) => [asset.contentDigest, asset]));
  const filesToWrite = [];

  // A re-export replaces placements in its own root while preserving every
  // prior filename reservation and placements belonging to other roots.
  for (const asset of assets) {
    asset.placements = asset.placements.filter((placement) => placement.rootId !== root.id);
  }

  for (const candidate of candidates || []) {
    if (!candidate?.sourceIdentity) throw new Error('Asset candidate needs a sourceIdentity');
    if (!candidate?.contentDigest) throw new Error(`Asset ${candidate.sourceIdentity} needs a contentDigest`);
    if (!candidate?.proposedFile) throw new Error(`Asset ${candidate.sourceIdentity} needs a proposedFile`);
    if (candidate.bytes && assetContentDigest(candidate.bytes, candidate.kind) !== candidate.contentDigest) {
      throw new Error(`Asset ${candidate.sourceIdentity} contentDigest does not match its bytes`);
    }

    let asset = byDigest.get(candidate.contentDigest);
    if (!asset) {
      let file = candidate.proposedFile;
      const reservation = reserved.get(file);
      const diskDigest = !reservation && fileExists(file) ? digestForFile(file, candidate.kind) : null;
      if ((reservation && reservation.contentDigest !== candidate.contentDigest)
        || (!reservation && fileExists(file) && diskDigest !== candidate.contentDigest)) {
        file = stableCollisionFile(file, candidate.contentDigest, reserved, fileExists, digestForFile, candidate.kind);
      }
      asset = reserved.get(file);
      if (!asset) {
        asset = {
          sourceIdentity: candidate.sourceIdentity,
          contentDigest: candidate.contentDigest,
          semanticLabel: candidate.semanticLabel,
          file,
          kind: candidate.kind,
          ...(candidate.metadata || {}),
          placements: [],
        };
        assets.push(asset);
        reserved.set(file, asset);
        byDigest.set(candidate.contentDigest, asset);
        if (!fileExists(file)) filesToWrite.push({
          file,
          bytes: candidate.bytes,
          contentDigest: candidate.contentDigest,
          kind: candidate.kind,
        });
      }
    }

    if (asset.sourceIdentity !== candidate.sourceIdentity) {
      asset.sourceAliases = [...new Set([...(asset.sourceAliases || []), candidate.sourceIdentity])];
    }
    const placements = new Map(asset.placements.map((placement) => [placementKey(placement), placement]));
    for (const placement of candidate.placements || []) {
      const normalized = { ...placement, rootId: placement.rootId || root.id };
      placements.set(placementKey(normalized), normalized);
    }
    asset.placements = [...placements.values()];
  }

  const priorRoots = prior?.roots || (prior?.root ? [{ id: prior.root, name: prior.rootName }] : []);
  const roots = [...priorRoots.filter((item) => item?.id && item.id !== root.id), { id: root.id, name: root.name }];
  return {
    manifest: {
      schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
      root: root.id,
      rootName: root.name,
      roots,
      assets,
    },
    filesToWrite,
  };
}

/**
 * Publish files first and the manifest last. All conflicting destinations are
 * preflighted before the first rename, so a failed export cannot replace an
 * existing asset or advertise a manifest whose new files were not published.
 */
export function publishAssetExportPlan(outDir, plan) {
  const stageDir = mkdtempSync(join(outDir, '.figma-bridge-assets-'));
  const writes = plan?.filesToWrite || [];
  try {
    for (const write of writes) {
      if (assetContentDigest(write.bytes, write.kind) !== write.contentDigest) {
        throw new Error(`Asset publication digest mismatch for ${write.file}`);
      }
      writeFileSync(join(stageDir, write.file), write.bytes, { flag: 'wx' });
    }
    writeFileSync(join(stageDir, 'assets.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`, { flag: 'wx' });

    for (const write of writes) {
      const target = join(outDir, write.file);
      if (!existsSync(target)) continue;
      const actual = assetContentDigest(readFileSync(target), write.kind);
      if (actual !== write.contentDigest) {
        throw new Error(`Asset publication refusing to overwrite ${write.file}: existing ${actual}, planned ${write.contentDigest}`);
      }
    }

    const written = [];
    const reused = [];
    for (const write of writes) {
      const target = join(outDir, write.file);
      if (existsSync(target)) {
        reused.push(write.file);
        continue;
      }
      renameSync(join(stageDir, write.file), target);
      written.push(write.file);
    }
    renameSync(join(stageDir, 'assets.json'), join(outDir, 'assets.json'));
    return { manifestPath: join(outDir, 'assets.json'), written, reused };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/**
 * Manifest-v1 compatibility adapter retained for callers that still emit one
 * entry per node. New exports use planAssetExport and schemaVersion 2.
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
