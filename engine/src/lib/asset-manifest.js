import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { canonicalSvg } from "./svg-dedup.js";
import { createWorkspaceIO, workspaceIO } from "./workspace-io.js";

export const ASSET_MANIFEST_SCHEMA_VERSION = 2;

/** Content identity is independent from its semantic label and filename. */
export function assetContentDigest(bytes, kind = "") {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  if (
    kind === "vector" ||
    kind === "icon" ||
    /^\s*<svg[\s>]/i.test(buffer.toString("utf8", 0, 256))
  ) {
    return `svg-visual-sha256:${createHash("sha256").update(canonicalSvg(buffer)).digest("hex")}`;
  }
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

const digestToken = (digest, length = 8) =>
  String(digest || "")
    .split(":")
    .at(-1)
    .slice(0, length);
const RESERVED_ASSET_OUTPUT_NAMES = new Set([
  "assets.json",
  ".figma-bridge-assets.lock",
]);
export const ASSET_PUBLICATION_STAGE_PREFIX = ".figma-bridge-assets-stage-";
export const ASSET_PUBLICATION_BUFFER_PREFIX = ".figma-bridge-asset-buffer-";
const ASSET_PUBLICATION_STAGE =
  /^\.figma-bridge-assets-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ASSET_PUBLICATION_BUFFER =
  /^\.figma-bridge-asset-buffer-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Manifest files live directly inside the authorized export directory. */
export function assertAssetManifestFile(file) {
  const unsafeWindowsDevice =
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/i;
  if (
    typeof file !== "string" ||
    !file ||
    file === "." ||
    file === ".." ||
    /[<>:"/\\|?*\x00-\x1f\x7f]/.test(file) ||
    /[ .]$/.test(file) ||
    unsafeWindowsDevice.test(file) ||
    RESERVED_ASSET_OUTPUT_NAMES.has(String(file).toLowerCase()) ||
    String(file).toLowerCase().startsWith(ASSET_PUBLICATION_STAGE_PREFIX) ||
    String(file).toLowerCase().startsWith(ASSET_PUBLICATION_BUFFER_PREFIX) ||
    Buffer.byteLength(file, "utf8") > 255
  ) {
    throw new Error("Asset manifest contains an unsafe file path.");
  }
  return file;
}

const splitFile = (file) => {
  const match = String(file || "").match(/^(.*?)(\.[^.]+)?$/);
  return { base: match?.[1] || "asset", ext: match?.[2] || "" };
};

function legacyAssets(prior) {
  const byFile = new Map();
  for (const entry of prior?.assets || []) {
    if (!entry?.file) continue;
    assertAssetManifestFile(entry.file);
    if (!byFile.has(entry.file)) {
      byFile.set(entry.file, {
        sourceIdentity: entry.imageHash
          ? `figma-image:${entry.imageHash}`
          : `legacy-file:${entry.file}`,
        contentDigest: null,
        semanticLabel: entry.name || splitFile(entry.file).base,
        file: entry.file,
        kind: entry.kind || "asset",
        placements: [],
      });
    }
    const {
      file: _file,
      kind: _kind,
      imageHash: _imageHash,
      ...placement
    } = entry;
    byFile.get(entry.file).placements.push(placement);
  }
  return [...byFile.values()];
}

function normalizedPriorAssets(prior, { fileExists, digestForFile }) {
  const raw =
    prior?.schemaVersion === ASSET_MANIFEST_SCHEMA_VERSION
      ? prior.assets || []
      : legacyAssets(prior);
  const assets = [];
  for (const asset of raw) {
    if (!asset?.file) continue;
    assertAssetManifestFile(asset.file);
    if (!fileExists(asset.file)) continue;
    const actualDigest = digestForFile?.(asset.file, asset.kind) || null;
    if (
      asset.contentDigest &&
      actualDigest &&
      asset.contentDigest !== actualDigest
    ) {
      throw new Error(
        `Asset integrity mismatch for ${asset.file}: manifest ${asset.contentDigest}, file ${actualDigest}`
      );
    }
    assets.push({
      ...asset,
      contentDigest: asset.contentDigest || actualDigest,
      placements: [...(asset.placements || [])],
      ...(asset.sourceAliases
        ? { sourceAliases: [...asset.sourceAliases] }
        : {}),
    });
  }
  return assets;
}

function stableCollisionFile(
  proposedFile,
  contentDigest,
  reserved,
  fileExists,
  digestForFile,
  kind
) {
  const { base, ext } = splitFile(proposedFile);
  for (const length of [8, 12, 16, 24, 32, 64]) {
    const file = `${base}-${digestToken(contentDigest, length)}${ext}`;
    const known = reserved.get(file);
    if (known?.contentDigest === contentDigest) return file;
    if (!known && !fileExists(file)) return file;
    if (!known && digestForFile?.(file, kind) === contentDigest) return file;
  }
  throw new Error(
    `Cannot reserve a stable filename for ${proposedFile} (${contentDigest})`
  );
}

const placementKey = (placement) =>
  `${placement.rootId || ""}\0${placement.nodeId || ""}`;

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
  const byDigest = new Map(
    assets
      .filter((asset) => asset.contentDigest)
      .map((asset) => [asset.contentDigest, asset])
  );
  const filesToWrite = [];
  const preservePlacementKeys = new Set(adapters.preservePlacementKeys || []);

  // A re-export replaces placements in its own root while preserving every
  // prior filename reservation and placements belonging to other roots.
  for (const asset of assets) {
    asset.placements = asset.placements.filter(
      (placement) =>
        placement.rootId !== root.id ||
        preservePlacementKeys.has(placementKey(placement))
    );
  }

  for (const candidate of candidates || []) {
    if (!candidate?.sourceIdentity)
      throw new Error("Asset candidate needs a sourceIdentity");
    if (!candidate?.contentDigest)
      throw new Error(
        `Asset ${candidate.sourceIdentity} needs a contentDigest`
      );
    if (!candidate?.proposedFile)
      throw new Error(`Asset ${candidate.sourceIdentity} needs a proposedFile`);
    assertAssetManifestFile(candidate.proposedFile);
    if (
      candidate.bytes &&
      assetContentDigest(candidate.bytes, candidate.kind) !==
        candidate.contentDigest
    ) {
      throw new Error(
        `Asset ${candidate.sourceIdentity} contentDigest does not match its bytes`
      );
    }

    let asset = byDigest.get(candidate.contentDigest);
    if (!asset) {
      let file = candidate.proposedFile;
      const reservation = reserved.get(file);
      const diskDigest =
        !reservation && fileExists(file)
          ? digestForFile(file, candidate.kind)
          : null;
      if (
        (reservation &&
          reservation.contentDigest !== candidate.contentDigest) ||
        (!reservation &&
          fileExists(file) &&
          diskDigest !== candidate.contentDigest)
      ) {
        file = stableCollisionFile(
          file,
          candidate.contentDigest,
          reserved,
          fileExists,
          digestForFile,
          candidate.kind
        );
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
        if (!fileExists(file))
          filesToWrite.push({
            file,
            bytes: candidate.bytes,
            ...(candidate.byteHandle
              ? { byteHandle: candidate.byteHandle }
              : {}),
            ...(candidate.byteLength
              ? { byteLength: candidate.byteLength }
              : {}),
            contentDigest: candidate.contentDigest,
            kind: candidate.kind,
          });
      }
    }

    if (asset.sourceIdentity !== candidate.sourceIdentity) {
      asset.sourceAliases = [
        ...new Set([...(asset.sourceAliases || []), candidate.sourceIdentity]),
      ];
    }
    const placements = new Map(
      asset.placements.map((placement) => [placementKey(placement), placement])
    );
    for (const placement of candidate.placements || []) {
      const normalized = { ...placement, rootId: placement.rootId || root.id };
      placements.set(placementKey(normalized), normalized);
    }
    asset.placements = [...placements.values()];
  }

  const priorRoots =
    prior?.roots ||
    (prior?.root ? [{ id: prior.root, name: prior.rootName }] : []);
  const roots = [
    ...priorRoots.filter((item) => item?.id && item.id !== root.id),
    { id: root.id, name: root.name },
  ];
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
export function publishAssetExportPlan(
  outDir,
  plan,
  {
    io = process.env.FIGMA_BRIDGE_WORKSPACE_ROOTS
      ? workspaceIO()
      : createWorkspaceIO({ root: outDir }),
  } = {}
) {
  const canonicalOut = io.ensureDirectory(outDir, {
    role: "asset-export-directory",
  });
  const writes = plan?.filesToWrite || [];
  for (const write of writes) {
    assertAssetManifestFile(write.file);
    if (assetContentDigest(write.bytes, write.kind) !== write.contentDigest) {
      throw new Error(`Asset publication digest mismatch for ${write.file}`);
    }
  }
  for (const asset of plan?.manifest?.assets || [])
    assertAssetManifestFile(asset.file);
  for (const write of writes) {
    const target = join(canonicalOut, write.file);
    if (!io.exists(target, { role: "exported-asset", kind: "file" })) continue;
    const actual = assetContentDigest(
      io.read(target, { role: "exported-asset" }),
      write.kind
    );
    if (actual !== write.contentDigest) {
      throw new Error(
        `Asset publication refusing to overwrite ${write.file}: existing ${actual}, planned ${write.contentDigest}`
      );
    }
  }

  const written = [];
  const reused = [];
  for (const write of writes) {
    const target = join(canonicalOut, write.file);
    if (io.exists(target, { role: "exported-asset", kind: "file" })) {
      const actual = assetContentDigest(
        io.read(target, { role: "exported-asset" }),
        write.kind
      );
      if (actual !== write.contentDigest) {
        throw new Error(
          `Asset publication refusing late collision for ${write.file}: existing ${actual}, planned ${write.contentDigest}`
        );
      }
      reused.push(write.file);
      continue;
    }
    io.write(target, write.bytes, {
      role: "exported-asset",
      createParents: true,
      exclusive: true,
    });
    written.push(write.file);
  }
  const manifestPath = io.write(
    join(canonicalOut, "assets.json"),
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
    { role: "asset-manifest", createParents: true }
  );
  return { manifestPath, written, reused };
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(rel))
  );
}

function exactChild(parent, candidate, basename) {
  return relative(parent, candidate) === basename;
}

function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function removeDirectoryIfEmpty(path) {
  try {
    rmdirSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function safeStageName(stageName) {
  if (!ASSET_PUBLICATION_STAGE.test(stageName || "")) {
    throw new Error(
      "Asset publication requires a canonical transaction stage name."
    );
  }
  return stageName;
}

function stageFiles(stageDir) {
  let directory;
  try {
    directory = opendirSync(stageDir, { bufferSize: 1 });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      let accepted =
        entry.name === "assets.json" ||
        ASSET_PUBLICATION_BUFFER.test(entry.name);
      if (!accepted) {
        try {
          assertAssetManifestFile(entry.name);
          accepted = true;
        } catch {}
      }
      if (!entry.isFile() || !accepted) {
        throw new Error(
          "Asset publication stage contains an unexpected entry."
        );
      }
      files.push(entry.name);
      if (files.length > 100_001) {
        throw new Error("Asset publication stage contains too many entries.");
      }
    }
  } finally {
    directory.closeSync();
  }
  return files;
}

/** Remove one exact private stage without traversing or following entries. */
export function cleanupAssetPublicationStage(
  outDir,
  stageName,
  {
    io = process.env.FIGMA_BRIDGE_WORKSPACE_ROOTS
      ? workspaceIO()
      : createWorkspaceIO({ root: outDir }),
  } = {}
) {
  safeStageName(stageName);
  const canonicalOut = io.ensureDirectory(outDir, {
    role: "asset-export-directory",
  });
  const requested = join(canonicalOut, stageName);
  if (
    !io.exists(requested, {
      role: "asset-publication-stage",
      kind: "directory",
    })
  )
    return false;
  const stageDir = io.authorizePath(requested, {
    access: "read",
    role: "asset-publication-stage",
    kind: "directory",
  }).canonical;
  if (!exactChild(canonicalOut, stageDir, stageName)) {
    throw new Error("Asset publication stage changed during cleanup.");
  }
  for (const file of stageFiles(stageDir)) {
    const path = join(stageDir, file);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Asset publication stage contains an unsafe entry.");
    }
    unlinkSync(path);
  }
  removeDirectoryIfEmpty(stageDir);
  return true;
}

function publishStagedFile(io, canonicalOut, stagedPath, file) {
  assertAssetManifestFile(file);
  const staged = io.authorizePath(stagedPath, {
    access: "read",
    role: "asset-publication-stage-file",
    kind: "file",
  }).canonical;
  const target = io.authorizePath(join(canonicalOut, file), {
    access: "write",
    role: "exported-asset",
    kind: "file",
  });
  if (dirname(dirname(staged)) !== dirname(target.canonical)) {
    throw new Error("Asset publication stage and output are not siblings.");
  }
  const stagedMetadata = lstatSync(staged);
  if (!stagedMetadata.isFile() || stagedMetadata.isSymbolicLink()) {
    throw new Error("Asset publication stage file is unsafe.");
  }
  linkSync(staged, target.canonical);
  const published = io.authorizePath(join(canonicalOut, file), {
    access: "read",
    role: "exported-asset",
    kind: "file",
  }).canonical;
  const publishedMetadata = lstatSync(published);
  if (
    publishedMetadata.dev !== stagedMetadata.dev ||
    publishedMetadata.ino !== stagedMetadata.ino
  ) {
    throw new Error("Asset publication target changed during commit.");
  }
  return published;
}

function replaceManifest(io, canonicalOut, stagedPath) {
  const staged = io.authorizePath(stagedPath, {
    access: "read",
    role: "asset-publication-stage-manifest",
    kind: "file",
  }).canonical;
  const target = io.authorizePath(join(canonicalOut, "assets.json"), {
    access: "write",
    role: "asset-manifest",
    kind: "file",
  });
  if (dirname(dirname(staged)) !== dirname(target.canonical)) {
    throw new Error(
      "Asset publication manifest stage and output are not siblings."
    );
  }
  const stagedMetadata = lstatSync(staged);
  if (!stagedMetadata.isFile() || stagedMetadata.isSymbolicLink()) {
    throw new Error("Asset publication staged manifest is unsafe.");
  }
  renameSync(staged, target.canonical);
  // renameSync is the commit point. No fallible validation follows it: once
  // the new manifest is visible, the caller must report a committed outcome.
  return target.canonical;
}

/**
 * Stage every byte before returning a tiny manifest commit transaction.
 * This function is async only at explicit checkpoints; synchronous filesystem
 * and digest work is intended to run in the Asset Publication Worker.
 * @param {string} outDir
 * @param {object} plan
 * @param {{
 *   io?: object,
 *   stageName: string,
 *   checkpoint?: (phase:string) => Promise<void>|void,
 *   reuseStage?: boolean,
 *   sourceForWrite?: (write:object) => string,
 * }} options
 */
export async function prepareAssetExportPublication(
  outDir,
  plan,
  {
    io = process.env.FIGMA_BRIDGE_WORKSPACE_ROOTS
      ? workspaceIO()
      : createWorkspaceIO({ root: outDir }),
    stageName,
    checkpoint = async () => {},
    reuseStage = false,
    sourceForWrite = null,
  }
) {
  safeStageName(stageName);
  const canonicalOut = io.ensureDirectory(outDir, {
    role: "asset-export-directory",
  });
  const requestedStage = join(canonicalOut, stageName);
  if (!reuseStage) mkdirSync(requestedStage, { mode: 0o700 });
  const stageDir = realpathSync.native(requestedStage);
  if (
    !contained(canonicalOut, stageDir) ||
    !exactChild(canonicalOut, stageDir, stageName)
  ) {
    throw new Error("Asset publication stage changed during creation.");
  }
  const writes = plan?.filesToWrite || [];
  const staged = [];
  const reused = [];
  try {
    for (const write of writes) {
      assertAssetManifestFile(write.file);
      if (write.bytes) {
        await checkpoint("hash");
      }
      if (
        write.bytes &&
        assetContentDigest(write.bytes, write.kind) !== write.contentDigest
      ) {
        throw new Error(`Asset publication digest mismatch for ${write.file}`);
      }
      if (!write.bytes && typeof sourceForWrite !== "function") {
        throw new Error(
          `Asset publication bytes are unavailable for ${write.file}`
        );
      }
    }
    for (const asset of plan?.manifest?.assets || [])
      assertAssetManifestFile(asset.file);
    for (const write of writes) {
      const target = join(canonicalOut, write.file);
      if (!io.exists(target, { role: "exported-asset", kind: "file" }))
        continue;
      await checkpoint("hash");
      const actual = assetContentDigest(
        io.read(target, { role: "exported-asset" }),
        write.kind
      );
      if (actual !== write.contentDigest) {
        throw new Error(
          `Asset publication refusing to overwrite ${write.file}: existing ${actual}, planned ${write.contentDigest}`
        );
      }
      reused.push(write.file);
    }
    for (const write of writes) {
      if (reused.includes(write.file)) continue;
      await checkpoint(write.bytes ? "asset-write" : "asset-link");
      if (write.bytes) {
        io.write(join(stageDir, write.file), write.bytes, {
          role: "asset-publication-stage-file",
          exclusive: true,
        });
      } else {
        const source = io.authorizePath(sourceForWrite(write), {
          access: "read",
          role: "asset-publication-buffer",
          kind: "file",
        }).canonical;
        if (dirname(source) !== stageDir) {
          throw new Error("Asset publication buffer changed before planning.");
        }
        linkSync(source, join(stageDir, write.file));
      }
      staged.push(write.file);
    }
    await checkpoint("manifest-write");
    const stagedManifest = io.write(
      join(stageDir, "assets.json"),
      `${JSON.stringify(plan.manifest, null, 2)}\n`,
      { role: "asset-publication-stage-manifest", exclusive: true }
    );
    let committed = false;
    const published = [];
    return {
      stageName,
      stageDir,
      stagedBytes: staged.reduce(
        (sum, file) =>
          sum +
          (writes.find((write) => write.file === file)?.bytes?.length ||
            writes.find((write) => write.file === file)?.byteLength ||
            0),
        0
      ),
      async commit() {
        try {
          for (const file of staged) {
            publishStagedFile(io, canonicalOut, join(stageDir, file), file);
            published.push(file);
          }
          const manifestPath = replaceManifest(
            io,
            canonicalOut,
            stagedManifest
          );
          committed = true;
          return { manifestPath, written: [...published], reused: [...reused] };
        } catch (error) {
          if (!committed) {
            for (const file of published.reverse())
              unlinkIfPresent(join(canonicalOut, file));
          }
          throw error;
        }
      },
      cleanup() {
        return cleanupAssetPublicationStage(canonicalOut, stageName, { io });
      },
    };
  } catch (error) {
    try {
      cleanupAssetPublicationStage(canonicalOut, stageName, { io });
    } catch {}
    throw error;
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
export function mergeAssetManifest(
  prior,
  nextAssets,
  root,
  fileExists = () => true
) {
  const newIds = new Set(nextAssets.map((m) => m.nodeId));
  const kept = (prior?.assets || []).filter(
    (a) =>
      a && a.nodeId && !newIds.has(a.nodeId) && a.file && fileExists(a.file)
  );
  const priorRoots =
    prior?.roots ||
    (prior?.root ? [{ id: prior.root, name: prior.rootName }] : []);
  const roots = [
    ...priorRoots.filter((r) => r && r.id !== root.id),
    { id: root.id, name: root.name },
  ];
  return {
    root: root.id,
    rootName: root.name,
    roots,
    assets: [...kept, ...nextAssets],
  };
}
