import { join } from "node:path";
import { isFigmaCommandPlan } from "../../../src/capability-catalog.js";
import {
  assetExportArgvFromRequest,
  DEFAULT_ASSET_EXPORT_MAX,
  DEFAULT_ASSET_RASTER_SCALE,
  parseAssetExportRequest,
} from "./asset-export-request.js";
import {
  assetSlug,
  effectiveAssetName,
  imageAssetBase,
} from "../lib/asset-names.js";
import { normalizeNodeId } from "../lib/node-id.js";
import { workspaceIO } from "../lib/workspace-io.js";
import {
  assetCollectorCode,
  imageBytesCode,
  svgBytesCode,
} from "../design-extract.js";
import { createRevisionContext } from "../lib/revision-context.js";
import { withAssetOutputLock } from "../lib/asset-output-lock.js";
import { AssetPublicationWorker } from "../lib/asset-publication-worker.js";

export { assetExportArgvFromRequest } from "./asset-export-request.js";
export { assetExportPlanningArgvFromRequest } from "./asset-export-request.js";

const ASSET_EXPORT_APPLICATION_ID = "export.assets";
// The old child process could be reclaimed after a huge export. The shared
// long-lived Application therefore refuses an unbounded aggregate Buffer set.
// Normal exports remain far below this; a larger root can be exported by its
// child frames until the streaming follow-up replaces Base64 transport.
export const MAX_BUFFERED_ASSET_BYTES = 512 * 1024 * 1024;

export class AssetExportFailure extends Error {
  constructor(
    message,
    { result = null, cause = null, kind = "asset-export" } = {}
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = "AssetExportFailure";
    this.kind = kind;
    this.code = 1;
    this.result = result;
    this.stdout = result ? formatAssetExportResult(result) : "";
    this.stderr = result ? "" : message;
  }
}

export function assetExportRequestFromArgv(args) {
  return parseAssetExportRequest(args);
}

export function assetExportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError(
      "Asset Export routing requires a Command Plan created by the Capability Catalog."
    );
  }
  return plan.allowed && plan.id === ASSET_EXPORT_APPLICATION_ID
    ? "command-application"
    : "not-asset-export";
}

export async function executeAssetExportPlan(plan, adapters = {}) {
  if (assetExportPlanRoute(plan) !== "command-application") {
    throw new Error(
      `Command Plan ${plan?.id || "(unknown)"} is not owned by the Asset Export Command Application.`
    );
  }
  return executeAssetExport(assetExportRequestFromArgv(plan.argv), {
    ...adapters,
    target: plan.target,
    // Authentic Command Plans always use daemon-owned metadata. The direct
    // execute Interface remains available to isolated unit Adapters only.
    requireStableRevision: true,
  });
}

function parseEvaluation(value, role) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${role} returned invalid JSON: ${error.message}`);
  }
}

const instancePathHint = (nodeId) =>
  /^I/.test(String(nodeId))
    ? " Instance-path ids (I…;…) often cannot be resolved — use the TOP-LEVEL instance id or the main component id instead."
    : "";

function targetAwareNodeWarning(normalized, target) {
  if (!normalized.warning) {
    return target?.source === "figma-url" && target.fileKey
      ? `Node id and target file were taken from the Figma URL (${target.fileKey}).`
      : null;
  }
  if (!normalized.fileKey || target?.kind !== "plugin-file")
    return normalized.warning;
  if (target.fileKey === normalized.fileKey) {
    return `Node id and target file were taken from the Figma URL (${normalized.fileKey}).`;
  }
  if (target.fileKey) {
    return `The node URL names Figma file ${normalized.fileKey}, but the Command Plan targets ${target.fileKey}; the node may not be found.`;
  }
  return normalized.warning;
}

function placement(node) {
  return {
    ...(node.x != null ? { x: node.x, y: node.y } : {}),
    ...(node.rootX != null
      ? {
          rootX: node.rootX,
          rootY: node.rootY,
          coordinateSpace: node.coordinateSpace || "export-root",
          ...(node.rootId ? { rootId: node.rootId } : {}),
        }
      : {}),
    parent: node.parent,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.absolute != null ? { absolutePosition: !!node.absolute } : {}),
    ...(node.overhang != null ? { overhang: !!node.overhang } : {}),
  };
}

function workList(found, max) {
  const jobs = [];
  for (const image of found.images) {
    const first = image.nodes?.[0];
    if (!first)
      throw new Error("Asset collector returned an image without usage nodes.");
    jobs.push({
      kind: "image",
      hash: image.hash,
      nodes: image.nodes,
      name: first.name,
      ancestors: first.ancestors,
      area: Number(first.w || 0) * Number(first.h || 0),
    });
  }
  for (const vector of found.vectors) {
    jobs.push({
      kind: "vector",
      id: vector.id,
      nodes: [vector],
      name: vector.name,
      ancestors: vector.ancestors,
      area: Number(vector.w || 0) * Number(vector.h || 0),
      icon: vector.icon === true,
    });
  }
  jobs.sort((left, right) => right.area - left.area);
  return { jobs: jobs.slice(0, max), dropped: jobs.slice(max) };
}

const placementKey = (rootId, nodeId) => `${rootId || ""}\0${nodeId || ""}`;

function preservedPlacementKeys(jobs, rootId) {
  return jobs.flatMap((job) =>
    (job.nodes || []).map((node) =>
      placementKey(node.rootId || rootId, node.id)
    )
  );
}

function isTransportFailure(error) {
  return typeof error?.kind === "string" && typeof error?.outcome === "string";
}

function assertTimeRemaining(remainingMs) {
  if (typeof remainingMs !== "function") return;
  const remaining = Number(remainingMs());
  if (Number.isFinite(remaining) && remaining <= 0) {
    throw Object.assign(
      new Error("Asset Export exceeded its Command Plan deadline."),
      {
        kind: "timeout",
      }
    );
  }
}

async function evaluateJson(
  evaluate,
  code,
  role,
  remainingMs,
  revisionContext = null
) {
  assertTimeRemaining(remainingMs);
  const response = await evaluate(code, {
    phase: role,
    remainingMs:
      typeof remainingMs === "function"
        ? Math.max(1, remainingMs())
        : undefined,
    ...(revisionContext?.targetFileKey()
      ? { fileKey: revisionContext.targetFileKey() }
      : {}),
    ...(revisionContext
      ? { revisionObservation: revisionContext.observation() }
      : {}),
  });
  if (!revisionContext) return parseEvaluation(response, role);
  if (
    !response ||
    typeof response !== "object" ||
    !Object.hasOwn(response, "value")
  ) {
    throw Object.assign(
      new Error(
        `Figma Bridge returned no revision metadata envelope during ${role}; the existing workspace output was left unchanged.`
      ),
      {
        kind: "document-drift",
        phase: "plugin-response",
        outcome: "unknown-after-dispatch",
      }
    );
  }
  revisionContext.accept(response.metadata, role);
  return parseEvaluation(response.value, role);
}

async function imageCandidate(job, response, rasterScale, byteWorker) {
  if (response?.error) throw new Error(response.error);
  if (typeof response?.base64 !== "string" || response.base64.length === 0) {
    throw new Error("image bytes were missing from the plugin response");
  }
  const source = Buffer.from(response.base64, "base64");
  if (source.length === 0) throw new Error("decoded image bytes were empty");
  const raster = await byteWorker.processImage(source, {
    usages: job.nodes,
    rasterScale,
  });
  const contentDigest = raster.contentDigest;
  return {
    candidate: {
      sourceIdentity: `figma-image:${job.hash}`,
      contentDigest,
      semanticLabel: job.name,
      proposedFile: `${imageAssetBase(job.hash)}.${raster.extension}`,
      kind: "image",
      byteHandle: raster.handle,
      byteLength: raster.byteLength,
      metadata: {
        imageHash: job.hash,
        ...(raster.optimized
          ? {
              optimizedForScale: rasterScale,
              pixelWidth: raster.width,
              pixelHeight: raster.height,
              sourcePixelWidth: raster.sourceWidth,
              sourcePixelHeight: raster.sourceHeight,
            }
          : {}),
      },
      placements: job.nodes.map((node) => ({
        nodeId: node.id,
        name: node.name,
        width: node.w,
        height: node.h,
        ...placement(node),
      })),
    },
    optimized: raster.optimized
      ? { contentDigest, savedBytes: raster.savedBytes }
      : null,
    oversized:
      !raster.optimized &&
      rasterScale === 0 &&
      raster.sourceByteLength >= 1024 * 1024 &&
      Math.max(...job.nodes.map((node) => Math.max(node.w, node.h))) <= 256
        ? { contentDigest, bytes: raster.sourceByteLength, nodes: job.nodes }
        : null,
  };
}

async function vectorCandidate(job, response, byteWorker) {
  if (response?.error) throw new Error(response.error);
  if (typeof response?.base64 !== "string" || response.base64.length === 0) {
    throw new Error("SVG bytes were missing from the plugin response");
  }
  const bytes = Buffer.from(response.base64, "base64");
  if (bytes.length === 0) throw new Error("decoded SVG bytes were empty");
  const node = job.nodes[0];
  const kind = job.icon ? "icon" : "vector";
  const processed = await byteWorker.processVector(bytes, kind);
  const contentDigest = processed.contentDigest;
  return {
    sourceIdentity: node.designEntityId
      ? `design-entity:${node.designEntityId}`
      : `svg-content:${contentDigest.split(":").at(-1)}`,
    contentDigest,
    semanticLabel: effectiveAssetName(job.name, job.ancestors),
    proposedFile: `${assetSlug(effectiveAssetName(job.name, job.ancestors))}.svg`,
    kind,
    byteHandle: processed.handle,
    byteLength: processed.byteLength,
    placements: [
      {
        nodeId: node.id,
        name: node.name,
        width: processed.dimensions?.width ?? node.w,
        height: processed.dimensions?.height ?? node.h,
        ...(job.icon ? { frameSize: { w: node.w, h: node.h } } : {}),
        ...placement(node),
      },
    ],
  };
}

function failedResult({
  nodeId,
  root,
  outputDir,
  warning,
  dropped,
  failures,
  max,
  rasterScale,
}) {
  return {
    status: "failed",
    nodeId,
    root,
    outputDir,
    warning,
    max,
    rasterScale,
    files: [],
    placements: [],
    manifestPath: join(outputDir, "assets.json"),
    dropped,
    failures,
    flagged: [],
    optimizedRasters: [],
    oversizedRasters: [],
    kept: 0,
  };
}

/**
 * Value-returning Asset Export Command Application. It owns collection,
 * identity planning and manifest-last publication; Adapters own transport,
 * target/deadline binding, job tracking and presentation colour.
 */
export async function executeAssetExport(request, adapters = {}) {
  if (!request?.nodeId) throw new Error("Asset Export node id is required.");
  if (!request.outputDir)
    throw new Error("Asset Export output directory is required.");
  if (typeof adapters.evaluate !== "function") {
    throw new Error("Asset Export command requires a Figma evaluate adapter.");
  }
  const max = Number(request.max ?? DEFAULT_ASSET_EXPORT_MAX);
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new Error("Asset Export max must be a positive safe integer.");
  }
  const rasterScale = Number(request.rasterScale ?? DEFAULT_ASSET_RASTER_SCALE);
  if (!Number.isFinite(rasterScale) || rasterScale < 0 || rasterScale > 4) {
    throw new Error(
      "Asset Export raster scale must be a number between 0 and 4."
    );
  }

  const io = adapters.workspaceIO || workspaceIO();
  const yieldControl = adapters.yieldControl || (() => Promise.resolve());
  const remainingMs = adapters.remainingMs;
  const bufferLimit = Number(
    adapters.maxBufferedBytes ?? MAX_BUFFERED_ASSET_BYTES
  );
  const normalized = normalizeNodeId(request.nodeId);
  const nodeId = normalized.id;
  let warning = targetAwareNodeWarning(normalized, adapters.target);
  const outputDir = request.outputDir;
  const revisionContext = adapters.requireStableRevision
    ? createRevisionContext({
        expectedFileKey: adapters.target?.fileKey || null,
        revisionObservation: { scope: "page", nodeId },
      })
    : null;
  let found;
  try {
    found = await evaluateJson(
      adapters.evaluate,
      assetCollectorCode(nodeId),
      "asset collector",
      remainingMs,
      revisionContext
    );
  } catch (error) {
    throw new AssetExportFailure(
      `export assets failed: ${error.message}${instancePathHint(nodeId)}`,
      { cause: error, kind: error.kind || "asset-export" }
    );
  }
  if (found?.error) {
    throw new AssetExportFailure(`${found.error}${instancePathHint(nodeId)}`);
  }
  if (!found || !Array.isArray(found.images) || !Array.isArray(found.vectors)) {
    throw new AssetExportFailure(
      `export assets: the plugin returned no data for node ${nodeId}.` +
        instancePathHint(nodeId) +
        " Otherwise retry — this is usually a transient bridge hiccup."
    );
  }

  const { jobs, dropped } = workList(found, max);
  const ownsByteWorker = !adapters.assetPublicationWorker;
  const byteWorker =
    adapters.assetPublicationWorker ||
    new AssetPublicationWorker({
      workspaceIO: io,
      remainingMs: remainingMs || (() => Number.POSITIVE_INFINITY),
      onPhase: adapters.onAssetWorkerPhase,
    });
  const candidates = [];
  const failures = [];
  const optimizedRasters = [];
  const oversizedRasters = [];
  const failedJobs = [];
  let bufferedBytes = 0;

  try {
    for (const job of jobs) {
      try {
        const response = await evaluateJson(
          adapters.evaluate,
          job.kind === "image"
            ? imageBytesCode(job.hash)
            : svgBytesCode(job.id),
          job.kind === "image" ? "image bytes" : "SVG bytes",
          remainingMs,
          revisionContext
        );
        const resolved =
          job.kind === "image"
            ? await imageCandidate(job, response, rasterScale, byteWorker)
            : {
                candidate: await vectorCandidate(job, response, byteWorker),
                optimized: null,
                oversized: null,
              };
        bufferedBytes += resolved.candidate.byteLength;
        if (
          !Number.isFinite(bufferLimit) ||
          bufferLimit < 1 ||
          bufferedBytes > bufferLimit
        ) {
          throw new AssetExportFailure(
            `Asset Export buffered more than ${(bufferLimit / 1024 / 1024).toFixed(0)} MiB. Export smaller child frames; the existing manifest was left unchanged.`,
            { kind: "asset-export-limit" }
          );
        }
        candidates.push(resolved.candidate);
        if (resolved.optimized) optimizedRasters.push(resolved.optimized);
        if (resolved.oversized) oversizedRasters.push(resolved.oversized);
      } catch (error) {
        if (
          error instanceof AssetExportFailure ||
          error?.kind === "timeout" ||
          error?.kind === "asset-worker" ||
          isTransportFailure(error)
        )
          throw error;
        failures.push({ name: job.name, message: error.message });
        failedJobs.push(job);
      }
      await yieldControl();
      assertTimeRemaining(remainingMs);
    }

    if (failures.length > 0 && candidates.length === 0) {
      const result = failedResult({
        nodeId,
        root: { id: found.id, name: found.name },
        outputDir,
        warning,
        dropped,
        failures,
        max,
        rasterScale,
      });
      throw new AssetExportFailure(
        `No assets could be exported from node ${nodeId}; the existing manifest was left unchanged.`,
        { result }
      );
    }

    // Large candidate bytes are staged before acquiring the shared output lock.
    // The lock therefore covers only revision fence -> read prior -> plan ->
    // atomic manifest commit, not PNG/SVG writes.
    const staged = await byteWorker.stage({ outputDir, candidates });
    let lockedPublication;
    try {
      lockedPublication = await withAssetOutputLock(
        outputDir,
        {
          io,
          remainingMs: remainingMs || (() => Number.POSITIVE_INFINITY),
        },
        async () => {
          // Close the Figma snapshot only after waiting for the output lock. This
          // prevents a queued export from publishing an old revision and keeps the
          // lock over the complete read-prior -> plan -> publish transaction.
          if (revisionContext) {
            await evaluateJson(
              adapters.evaluate,
              "(async () => null)()",
              "asset revision fence",
              remainingMs,
              revisionContext
            );
            if (revisionContext.source()?.proof === "connection-only") {
              const version = revisionContext.source()?.pluginVersion;
              const compatibilityWarning = `Plugin ${version || "(legacy)"} cannot prove Document Revision; this export was pinned to one connection/file. Restart or re-import the bundled plugin for concurrent-edit detection.`;
              warning = [warning, compatibilityWarning]
                .filter(Boolean)
                .join(" ");
            }
          }

          assertTimeRemaining(remainingMs);
          await yieldControl();
          assertTimeRemaining(remainingMs);
          return byteWorker.publish({
            outputDir,
            candidates,
            root: { id: found.id, name: found.name },
            // A transient byte-export failure or an explicit --max truncation must
            // not erase last-known-good placements that are still present in the
            // collector snapshot. Successful candidates replace their own facts.
            preservePlacementKeys: preservedPlacementKeys(
              [...failedJobs, ...dropped],
              found.id
            ),
            stageName: staged.stageName,
            bufferedBytes: staged.bufferedBytes,
          });
        }
      );
    } finally {
      try {
        await byteWorker.cleanupStage(outputDir, staged.stageName);
      } catch {}
    }
    const { exportPlan, publication } = lockedPublication;

    const merged = exportPlan.manifest;
    const assetByDigest = new Map(
      merged.assets.map((asset) => [asset.contentDigest, asset])
    );
    const placements = candidates.flatMap((candidate) => {
      const asset = assetByDigest.get(candidate.contentDigest);
      return candidate.placements.map((placementInfo) => ({
        ...placementInfo,
        file: asset.file,
        kind: asset.kind,
        sourceIdentity: candidate.sourceIdentity,
        contentDigest: candidate.contentDigest,
      }));
    });
    const totalPlacements = merged.assets.reduce(
      (sum, asset) => sum + asset.placements.length,
      0
    );
    const kept = Math.max(0, totalPlacements - placements.length);
    for (const item of [...optimizedRasters, ...oversizedRasters]) {
      item.file = assetByDigest.get(item.contentDigest)?.file;
    }
    const files = [...new Set(placements.map((item) => item.file))];
    const flagged = [
      ...new Map(
        placements
          .filter((item) => item.absolutePosition || item.overhang)
          .map((item) => [item.file, item])
      ).values(),
    ];

    return {
      status: "complete",
      nodeId,
      root: { id: found.id, name: found.name },
      outputDir,
      warning,
      max,
      rasterScale,
      manifestPath: publication.manifestPath,
      files,
      placements,
      flagged,
      optimizedRasters,
      oversizedRasters,
      dropped,
      failures,
      kept,
      publication,
      source: revisionContext?.source() || null,
    };
  } finally {
    if (ownsByteWorker) {
      try {
        await byteWorker.close();
      } catch {}
    }
  }
}

export function assetExportResultRows(result) {
  const rows = [];
  if (result.warning)
    rows.push({ tone: "warning", text: `⚠ ${result.warning}` });
  if (result.status === "failed") {
    rows.push({
      tone: "error",
      text: `✗ No assets exported from node ${result.nodeId}; existing assets.json left unchanged.`,
    });
  } else {
    rows.push({
      tone: "success",
      text: `✓ ${result.files.length} file(s) → ${result.outputDir}/ (${result.placements.length} node reference(s); manifest: ${result.manifestPath})`,
    });
    for (const file of result.files.slice(0, 30))
      rows.push({ tone: "plain", text: `  ${file}` });
    if (result.files.length > 30) {
      rows.push({
        tone: "plain",
        text: `  … ${result.files.length - 30} more (see assets.json)`,
      });
    }
    if (result.flagged.length) {
      rows.push({
        tone: "warning",
        text: `⚠ ${result.flagged.length} of ${result.files.length} file(s) are absolutely positioned or overhang their parent — exactly these get lost in builds:`,
      });
      for (const item of result.flagged) {
        const at =
          item.rootX != null
            ? ` @ root ${item.rootX},${item.rootY}`
            : item.x != null
              ? ` @ parent ${item.x},${item.y}`
              : "";
        const overhang = item.overhang ? " — overhangs, keep visible" : "";
        rows.push({
          tone: "plain",
          text: `  - ${item.file}${at} in "${item.parent || "root"}"${overhang}`,
        });
      }
    }
    if (result.optimizedRasters.length) {
      const saved = result.optimizedRasters.reduce(
        (sum, item) => sum + item.savedBytes,
        0
      );
      rows.push({
        tone: "success",
        text: `✓ ${result.optimizedRasters.length} oversized PNG(s) downsampled for ${result.rasterScale}× use; saved ${(saved / 1024).toFixed(0)} KiB`,
      });
    }
    if (result.oversizedRasters.length) {
      rows.push({
        tone: "warning",
        text: `⚠ ${result.oversizedRasters.length} PNG(s) exceed 1 MiB although every usage is at most 256px:`,
      });
      for (const item of result.oversizedRasters.slice(0, 10)) {
        const maxUse = Math.max(
          ...item.nodes.map((node) => Math.max(node.w, node.h))
        );
        rows.push({
          tone: "plain",
          text: `  - ${item.file}: ${(item.bytes / 1024 / 1024).toFixed(1)} MiB for max ${maxUse}px use`,
        });
      }
      rows.push({
        tone: "plain",
        text: "  Re-run this export with --raster-scale 2 for a retina-sized PNG; placement and CSS crop semantics stay unchanged.",
      });
    }
    rows.push({
      tone: "plain",
      text: "Before declaring the build done: every file above must be referenced in the project — run `verify-build <projectDir>` to check the whole manifest mechanically (or grep each filename).",
    });
    if (result.kept > 0) {
      rows.push({
        tone: "muted",
        text: `  manifest merged: ${result.kept} entr${result.kept === 1 ? "y" : "ies"} from earlier export(s) kept`,
      });
    }
  }
  if (result.dropped.length) {
    rows.push({
      tone: "warning",
      text: `⚠ --max ${result.max}: dropped ${result.dropped.length} smaller asset(s): ${result.dropped
        .slice(0, 10)
        .map((item) => item.name)
        .join(", ")}${result.dropped.length > 10 ? ", …" : ""}`,
    });
  }
  if (result.failures.length) {
    rows.push({
      tone: "warning",
      text: `⚠ ${result.failures.length} asset(s) failed to export:`,
    });
    for (const failure of result.failures) {
      rows.push({
        tone: "warning",
        text: `  - ${failure.name}: ${failure.message}`,
      });
    }
  }
  return rows;
}

export function formatAssetExportResult(result) {
  return assetExportResultRows(result)
    .map((row) => row.text)
    .join("\n");
}
