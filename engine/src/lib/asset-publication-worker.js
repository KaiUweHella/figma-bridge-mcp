import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { ASSET_PUBLICATION_STAGE_PREFIX } from "./asset-manifest.js";

const WORKER_URL = new URL(
  "./asset-publication-worker-runtime.js",
  import.meta.url
);
export const ASSET_MAIN_THREAD_STALL_BUDGET_MS = 50;
const POST_COMMIT_CLEANUP_BUDGET_MS = 5_000;

function timeoutError(phase) {
  return Object.assign(
    new Error(
      `Asset Export exceeded its Command Plan deadline during ${phase}.`
    ),
    { kind: "timeout" }
  );
}

function transferBuffer(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "");
  if (
    buffer.byteOffset === 0 &&
    buffer.byteLength === buffer.buffer.byteLength
  ) {
    return buffer.buffer;
  }
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

function workerError(value) {
  return Object.assign(
    new Error(value?.message || "Asset Publication Worker failed."),
    {
      code: value?.code || "ASSET_WORKER_FAILURE",
      kind: value?.kind || "asset-worker",
    }
  );
}

function workspaceProjection(io) {
  if (!Array.isArray(io?.roots) || !io.roots.length || !io.limits) {
    throw new TypeError(
      "Asset Publication Worker requires a WorkspaceIO capability."
    );
  }
  return { roots: [...io.roots], limits: { ...io.limits } };
}

export class AssetPublicationWorker {
  /**
   * @param {{
   *   workspaceIO: object,
   *   remainingMs?: () => number,
   *   onPhase?: (phase:string) => Promise<void>|void,
   *   WorkerClass?: typeof Worker,
   * }} options
   */
  constructor({
    workspaceIO,
    remainingMs = () => Number.POSITIVE_INFINITY,
    onPhase = async () => {},
    WorkerClass = Worker,
  }) {
    this.io = workspaceIO;
    this.workspace = workspaceProjection(workspaceIO);
    this.remainingMs = remainingMs;
    this.onPhase = onPhase;
    this.worker = new WorkerClass(WORKER_URL, {
      argv: [],
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        codeRangeSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    this.current = null;
    this.closed = false;
    this.worker.on("message", (message) => {
      void this.#message(message);
    });
    this.worker.on("error", (error) => {
      void this.#workerStopped(error);
    });
    this.worker.on("exit", (code) => {
      if (!this.closed && this.current) {
        void this.#workerStopped(
          new Error(`Asset Publication Worker exited with code ${code}.`)
        );
      }
    });
  }

  async #cleanupStage(current) {
    if (!current?.stageName || !current.outputDir) return;
    const cleanupWorker = new Worker(WORKER_URL, {
      argv: [],
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
      },
    });
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        void cleanupWorker.terminate();
        resolve();
      }, 5_000);
      const finish = () => {
        clearTimeout(timer);
        cleanupWorker.removeAllListeners();
        void cleanupWorker.terminate();
        resolve();
      };
      cleanupWorker.once("message", finish);
      cleanupWorker.once("error", finish);
      cleanupWorker.once("exit", finish);
      cleanupWorker.postMessage({
        type: "request",
        requestId: randomUUID(),
        action: "cleanup",
        workspace: this.workspace,
        outputDir: current.outputDir,
        stageName: current.stageName,
      });
    });
  }

  async #fail(error) {
    const current = this.current;
    if (!current || current.settled) return;
    current.settled = true;
    clearTimeout(current.timer);
    this.current = null;
    this.closed = true;
    try {
      await this.worker.terminate();
    } catch {}
    await this.#cleanupStage(current);
    if (current.committedResult) current.resolve(current.committedResult);
    else current.reject(error);
  }

  async #workerStopped(error) {
    await this.#fail(workerError(error));
  }

  async #message(message) {
    const current = this.current;
    if (!current || message?.requestId !== current.requestId || current.settled)
      return;
    if (message.type === "phase") {
      try {
        await this.onPhase(message.phase);
      } catch (error) {
        if (!current.commitStarted) return this.#fail(error);
      }
      if (message.phase === "prepared") {
        if (Number(this.remainingMs()) <= 0) {
          return this.#fail(timeoutError("publication preparation"));
        }
        current.commitStarted = true;
        clearTimeout(current.timer);
        this.worker.postMessage({
          type: "checkpoint",
          requestId: current.requestId,
          decision: "commit",
        });
        return;
      }
      if (!current.commitStarted && Number(this.remainingMs()) <= 0) {
        return this.#fail(timeoutError(message.phase));
      }
      this.worker.postMessage({
        type: "checkpoint",
        requestId: current.requestId,
        decision: "continue",
      });
      return;
    }
    if (message.type === "committed") {
      current.committedResult = message.result;
      clearTimeout(current.timer);
      current.timer = setTimeout(() => {
        if (!current.settled)
          void this.#fail(timeoutError("post-commit cleanup"));
      }, POST_COMMIT_CLEANUP_BUDGET_MS);
      return;
    }
    if (message.type === "error") {
      if (current.committedResult) return this.#finish(current.committedResult);
      return this.#fail(workerError(message.error));
    }
    if (message.type === "result") return this.#finish(message.result);
  }

  async #finish(result) {
    const current = this.current;
    if (!current || current.settled) return;
    current.settled = true;
    clearTimeout(current.timer);
    this.current = null;
    current.resolve(result);
  }

  #request(action, payload, transfer = []) {
    if (this.closed)
      return Promise.reject(new Error("Asset Publication Worker is closed."));
    if (this.current)
      return Promise.reject(
        new Error("Asset Publication Worker is already processing bytes.")
      );
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const remaining = Number(this.remainingMs());
      if (Number.isFinite(remaining) && remaining <= 0) {
        reject(timeoutError(action));
        return;
      }
      const current = {
        requestId,
        action,
        resolve,
        reject,
        settled: false,
        commitStarted: false,
        committedResult: null,
        stageName: payload.stageName || null,
        outputDir: payload.outputDir || null,
        timer: null,
      };
      if (Number.isFinite(remaining)) {
        current.timer = setTimeout(
          () => {
            if (!current.commitStarted) void this.#fail(timeoutError(action));
          },
          Math.max(1, remaining)
        );
      }
      this.current = current;
      this.worker.postMessage(
        {
          type: "request",
          requestId,
          action,
          workspace: this.workspace,
          ...payload,
        },
        transfer
      );
    });
  }

  processImage(bytes, { usages = [], rasterScale = 0 } = {}) {
    const transferable = transferBuffer(bytes);
    const handle = randomUUID();
    return this.#request(
      "image",
      {
        handle,
        bytes: transferable,
        usages,
        rasterScale,
      },
      [transferable]
    );
  }

  processVector(bytes, kind) {
    const transferable = transferBuffer(bytes);
    const handle = randomUUID();
    return this.#request(
      "vector",
      {
        handle,
        bytes: transferable,
        kind,
      },
      [transferable]
    );
  }

  stage({ outputDir, candidates }) {
    const stageName = `${ASSET_PUBLICATION_STAGE_PREFIX}${randomUUID()}`;
    const canonicalOut = this.io.ensureDirectory(outputDir, {
      role: "asset-export-directory",
    });
    return this.#request("stage", {
      outputDir: canonicalOut,
      candidates,
      stageName,
    });
  }

  publish({
    outputDir,
    candidates,
    root,
    preservePlacementKeys,
    stageName,
    bufferedBytes,
  }) {
    const canonicalOut = this.io.ensureDirectory(outputDir, {
      role: "asset-export-directory",
    });
    return this.#request("publish", {
      outputDir: canonicalOut,
      candidates,
      root,
      preservePlacementKeys,
      stageName,
      bufferedBytes,
    });
  }

  cleanupStage(outputDir, stageName) {
    const canonicalOut = this.io.ensureDirectory(outputDir, {
      role: "asset-export-directory",
    });
    return this.#request("cleanup", { outputDir: canonicalOut, stageName });
  }

  async close() {
    if (this.closed) return;
    if (this.current)
      throw new Error(
        "Asset Publication Worker cannot close during an operation."
      );
    this.closed = true;
    await this.worker.terminate();
  }
}
