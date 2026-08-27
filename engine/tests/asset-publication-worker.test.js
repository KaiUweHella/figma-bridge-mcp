import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSET_MAIN_THREAD_STALL_BUDGET_MS,
  AssetPublicationWorker,
} from "../src/lib/asset-publication-worker.js";
import { createWorkspaceIO } from "../src/lib/workspace-io.js";

test("large hashing and publication keep the main event loop cooperative", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "asset-publication-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const worker = new AssetPublicationWorker({ workspaceIO: io });
  t.after(() => worker.close());

  const bytes = Buffer.alloc(16 * 1024 * 1024, 0x20);
  bytes.write('<svg width="4096" height="4096">');
  bytes.write("</svg>", bytes.length - 6);
  let ticks = 0;
  let maximumDelay = 0;
  let previous = performance.now();
  const heartbeat = setInterval(() => {
    const current = performance.now();
    maximumDelay = Math.max(maximumDelay, current - previous);
    previous = current;
    ticks += 1;
  }, 2);
  try {
    const processed = await worker.processVector(bytes, "vector");
    const candidates = [
      {
        sourceIdentity: "test:large-vector",
        contentDigest: processed.contentDigest,
        semanticLabel: "Large vector",
        proposedFile: "large-vector.svg",
        kind: "vector",
        byteHandle: processed.handle,
        byteLength: processed.byteLength,
        placements: [{ nodeId: "1:2", name: "Large vector", rootId: "1:1" }],
      },
    ];
    const staged = await worker.stage({
      outputDir: join(root, "assets"),
      candidates,
    });
    const result = await worker.publish({
      outputDir: join(root, "assets"),
      candidates,
      root: { id: "1:1", name: "Worker fixture" },
      preservePlacementKeys: [],
      stageName: staged.stageName,
      bufferedBytes: staged.bufferedBytes,
    });
    assert.equal(result.publication.stagedBytes, 16 * 1024 * 1024);
    assert.equal(result.publication.bufferedBytes, 16 * 1024 * 1024);
    assert.ok(result.publication.peakMemory.rssBytes > 0);
    assert.equal(
      statSync(join(root, "assets", "large-vector.svg")).size,
      16 * 1024 * 1024
    );
    assert.equal(
      JSON.parse(readFileSync(join(root, "assets", "assets.json"), "utf8"))
        .assets.length,
      1
    );
  } finally {
    clearInterval(heartbeat);
  }
  assert.ok(ticks >= 3, `expected cooperative heartbeats, got ${ticks}`);
  assert.ok(
    maximumDelay <= ASSET_MAIN_THREAD_STALL_BUDGET_MS * 4,
    `main event-loop delay ${maximumDelay.toFixed(1)}ms exceeded the guarded worker allowance`
  );
});
