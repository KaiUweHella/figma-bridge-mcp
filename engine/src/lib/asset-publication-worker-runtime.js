import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  assetContentDigest,
  ASSET_PUBLICATION_BUFFER_PREFIX,
  cleanupAssetPublicationStage,
  planAssetExport,
  prepareAssetExportPublication,
} from "./asset-manifest.js";
import { optimizePngForUsages } from "./raster-optimize.js";
import { createWorkspaceIO } from "./workspace-io.js";

const buffers = new Map();
const checkpoints = new Map();
let operationChain = Promise.resolve();
let peak = {
  rssBytes: 0,
  heapUsedBytes: 0,
  externalBytes: 0,
  arrayBufferBytes: 0,
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function bufferFile(handle) {
  if (!UUID.test(handle || ""))
    throw new Error(
      "Asset Publication Worker received an invalid byte handle."
    );
  return `${ASSET_PUBLICATION_BUFFER_PREFIX}${handle}`;
}

function sampleMemory() {
  const usage = process.memoryUsage();
  peak = {
    rssBytes: Math.max(peak.rssBytes, usage.rss),
    heapUsedBytes: Math.max(peak.heapUsedBytes, usage.heapUsed),
    externalBytes: Math.max(peak.externalBytes, usage.external),
    arrayBufferBytes: Math.max(peak.arrayBufferBytes, usage.arrayBuffers),
  };
}

function errorEnvelope(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ASSET_WORKER_FAILURE",
    kind: typeof error?.kind === "string" ? error.kind : "asset-worker",
    message:
      typeof error?.message === "string"
        ? error.message
        : "Asset Publication Worker failed.",
  };
}

function checkpoint(requestId, phase, expected = "continue") {
  sampleMemory();
  return new Promise((resolve, reject) => {
    checkpoints.set(requestId, { expected, resolve, reject });
    parentPort.postMessage({ type: "phase", requestId, phase });
  });
}

function imageExtension(source) {
  if (source[0] === 0xff && source[1] === 0xd8) return "jpg";
  if (source[0] === 0x47 && source[1] === 0x49) return "gif";
  if (source[0] === 0x52 && source[1] === 0x49) return "webp";
  return "png";
}

function workspaceFrom(message) {
  if (
    !Array.isArray(message.workspace?.roots) ||
    !message.workspace.roots.length
  ) {
    throw new Error(
      "Asset Publication Worker requires authorized Workspace roots."
    );
  }
  const [root, ...extraRoots] = message.workspace.roots;
  return createWorkspaceIO({
    root,
    extraRoots,
    limits: message.workspace.limits || {},
  });
}

async function processImage(message) {
  await checkpoint(message.requestId, "hash");
  const source = Buffer.from(message.bytes);
  const extension = imageExtension(source);
  const raster =
    extension === "png"
      ? optimizePngForUsages(source, message.usages, message.rasterScale)
      : { buffer: source, optimized: false };
  const digest = assetContentDigest(raster.buffer, "image");
  buffers.set(message.handle, raster.buffer);
  sampleMemory();
  return {
    handle: message.handle,
    byteLength: raster.buffer.length,
    sourceByteLength: source.length,
    extension,
    contentDigest: digest,
    optimized: raster.optimized === true,
    ...(raster.optimized
      ? {
          width: raster.width,
          height: raster.height,
          sourceWidth: raster.sourceWidth,
          sourceHeight: raster.sourceHeight,
          savedBytes: raster.savedBytes,
        }
      : {}),
  };
}

async function processVector(message) {
  await checkpoint(message.requestId, "hash");
  const bytes = Buffer.from(message.bytes);
  const contentDigest = assetContentDigest(bytes, message.kind);
  const dimensions = bytes
    .toString("utf8", 0, Math.min(bytes.length, 500))
    .match(/<svg[^>]*?\bwidth="([0-9.]+)"[^>]*?\bheight="([0-9.]+)"/);
  buffers.set(message.handle, bytes);
  sampleMemory();
  return {
    handle: message.handle,
    byteLength: bytes.length,
    contentDigest,
    dimensions: dimensions
      ? {
          width: Math.round(+dimensions[1]),
          height: Math.round(+dimensions[2]),
        }
      : null,
  };
}

function createStage(message) {
  const io = workspaceFrom(message);
  const outputDir = io.ensureDirectory(message.outputDir, {
    role: "asset-export-directory",
  });
  const requestedStage = join(outputDir, message.stageName);
  mkdirSync(requestedStage, { mode: 0o700 });
  const stageDir = realpathSync.native(requestedStage);
  if (relative(outputDir, stageDir) !== message.stageName) {
    throw new Error("Asset publication stage changed during creation.");
  }
  return { stageName: message.stageName, stagedBytes: 0, bufferedBytes: 0 };
}

async function stageProcessed(message, processed) {
  const io = workspaceFrom(message);
  const outputDir = io.ensureDirectory(message.outputDir, {
    role: "asset-export-directory",
  });
  const stageDir = realpathSync.native(join(outputDir, message.stageName));
  if (relative(outputDir, stageDir) !== message.stageName) {
    throw new Error("Asset publication stage changed before byte write.");
  }
  const bytes = buffers.get(processed.handle);
  if (!bytes) throw new Error("Asset Publication Worker lost a processed asset.");
  try {
    await checkpoint(message.requestId, "asset-write");
    io.write(join(stageDir, bufferFile(processed.handle)), bytes, {
      role: "asset-publication-buffer",
      exclusive: true,
    });
    sampleMemory();
    return processed;
  } finally {
    buffers.delete(processed.handle);
  }
}

async function processImageToStage(message) {
  return stageProcessed(message, await processImage(message));
}

async function processVectorToStage(message) {
  return stageProcessed(message, await processVector(message));
}

async function stage(message) {
  const io = workspaceFrom(message);
  const outputDir = io.ensureDirectory(message.outputDir, {
    role: "asset-export-directory",
  });
  const requestedStage = join(outputDir, message.stageName);
  mkdirSync(requestedStage, { mode: 0o700 });
  const stageDir = realpathSync.native(requestedStage);
  let stagedBytes = 0;
  try {
    for (const candidate of message.candidates) {
      const bytes = buffers.get(candidate.byteHandle);
      if (!bytes)
        throw new Error("Asset Publication Worker lost a buffered asset.");
      await checkpoint(message.requestId, "asset-write");
      io.write(join(stageDir, bufferFile(candidate.byteHandle)), bytes, {
        role: "asset-publication-buffer",
        exclusive: true,
      });
      stagedBytes += bytes.length;
      buffers.delete(candidate.byteHandle);
      sampleMemory();
    }
    return {
      stageName: message.stageName,
      stagedBytes,
      bufferedBytes: stagedBytes,
    };
  } catch (error) {
    try {
      cleanupAssetPublicationStage(outputDir, message.stageName, { io });
    } catch {}
    throw error;
  }
}

async function publish(message) {
  const io = workspaceFrom(message);
  const outputDir = realpathSync.native(message.outputDir);
  if (
    !isAbsolute(outputDir || "") ||
    !io.roots.some((root) => {
      const rel = relative(root, outputDir);
      return (
        rel === "" ||
        (rel !== ".." &&
          !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
          !isAbsolute(rel))
      );
    })
  ) {
    throw new Error(
      "Asset Publication Worker output is outside its authorized Workspace roots."
    );
  }
  const manifestPath = join(outputDir, "assets.json");
  const prior = io.exists(manifestPath, {
    role: "asset-manifest",
    kind: "file",
  })
    ? io.readJson(manifestPath, { role: "asset-manifest" })
    : null;
  const candidates = message.candidates.map((candidate) => ({ ...candidate }));
  await checkpoint(message.requestId, "hash");
  const planned = planAssetExport(prior, candidates, message.root, {
    fileExists: (file) =>
      io.exists(join(outputDir, file), {
        role: "exported-asset",
        kind: "file",
      }),
    digestForFile: (file, kind) =>
      assetContentDigest(
        io.read(join(outputDir, file), { role: "exported-asset" }),
        kind
      ),
    preservePlacementKeys: message.preservePlacementKeys,
  });
  let transaction = null;
  let committedResult = null;
  try {
    transaction = await prepareAssetExportPublication(outputDir, planned, {
      io,
      stageName: message.stageName,
      reuseStage: true,
      sourceForWrite: (write) =>
        join(outputDir, message.stageName, bufferFile(write.byteHandle)),
      checkpoint: (phase) => checkpoint(message.requestId, phase),
    });
    await checkpoint(message.requestId, "prepared", "commit");
    const publication = await transaction.commit();
    committedResult = {
      exportPlan: { manifest: planned.manifest },
      publication: {
        ...publication,
        stageName: message.stageName,
        stagedBytes: transaction.stagedBytes,
        bufferedBytes: message.bufferedBytes,
        peakMemory: peak,
      },
    };
    parentPort.postMessage({
      type: "committed",
      requestId: message.requestId,
      result: committedResult,
    });
    await checkpoint(message.requestId, "post-commit-cleanup");
    transaction.cleanup();
    return committedResult;
  } catch (error) {
    try {
      transaction?.cleanup();
    } catch {}
    if (committedResult)
      return {
        ...committedResult,
        publication: { ...committedResult.publication, cleanupPending: true },
      };
    throw error;
  }
}

async function cleanup(message) {
  const io = workspaceFrom(message);
  return cleanupAssetPublicationStage(
    realpathSync.native(message.outputDir),
    message.stageName,
    { io }
  );
}

async function execute(message) {
  if (message.action === "create-stage") return createStage(message);
  if (message.action === "image") return processImage(message);
  if (message.action === "image-to-stage") return processImageToStage(message);
  if (message.action === "vector") return processVector(message);
  if (message.action === "vector-to-stage") return processVectorToStage(message);
  if (message.action === "stage") return stage(message);
  if (message.action === "publish") return publish(message);
  if (message.action === "cleanup") return cleanup(message);
  if (message.action === "release") {
    buffers.delete(message.handle);
    return { released: true };
  }
  throw new Error("Asset Publication Worker received an unknown action.");
}

parentPort.on("message", (message) => {
  if (message?.type === "checkpoint") {
    const pending = checkpoints.get(message.requestId);
    if (!pending) return;
    checkpoints.delete(message.requestId);
    if (message.decision === pending.expected) pending.resolve();
    else
      pending.reject(
        Object.assign(
          new Error(
            message.reason ||
              "Asset Publication Worker checkpoint was cancelled."
          ),
          { kind: "timeout" }
        )
      );
    return;
  }
  if (message?.type !== "request") return;
  const request = { ...message, requestId: message.requestId || randomUUID() };
  operationChain = operationChain.then(async () => {
    try {
      const result = await execute(request);
      sampleMemory();
      parentPort.postMessage({
        type: "result",
        requestId: request.requestId,
        result,
      });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        requestId: request.requestId,
        error: errorEnvelope(error),
      });
    }
  });
});
