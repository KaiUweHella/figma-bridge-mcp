import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planFigmaCommand } from "../../src/capability-catalog.js";
import {
  AssetExportFailure,
  assetExportArgvFromRequest,
  assetExportPlanningArgvFromRequest,
  assetExportPlanRoute,
  assetExportRequestFromArgv,
  executeAssetExport,
  executeAssetExportPlan,
  assetExportResultRows,
  formatAssetExportResult,
} from "../src/application/asset-export-command.js";
import {
  ASSET_OUTPUT_LOCK_DIRECTORY,
  withAssetOutputLock,
} from "../src/lib/asset-output-lock.js";
import { createWorkspaceIO } from "../src/lib/workspace-io.js";

const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
const svgBytes = Buffer.from(
  '<svg width="32" height="24"><path d="M0 0h32v24z"/></svg>'
);

function collector({ images = true, vectors = true } = {}) {
  return {
    id: "1:1",
    name: "Asset Lab",
    images: images
      ? [
          {
            hash: "HASH-1",
            nodes: [
              {
                id: "1:2",
                name: "Hero",
                ancestors: ["Asset Lab"],
                w: 320,
                h: 180,
                parent: "Asset Lab",
                rootId: "1:1",
              },
              {
                id: "1:3",
                name: "Thumbnail",
                ancestors: ["Asset Lab"],
                w: 80,
                h: 45,
                parent: "Asset Lab",
                rootId: "1:1",
              },
            ],
          },
        ]
      : [],
    vectors: vectors
      ? [
          {
            id: "1:4",
            name: "Brand Mark",
            ancestors: ["Asset Lab"],
            w: 32,
            h: 24,
            parent: "Asset Lab",
            rootId: "1:1",
            x: 4,
            y: 8,
            rootX: 4,
            rootY: 8,
          },
        ]
      : [],
  };
}

function evaluator(found = collector(), overrides = {}) {
  return async (code) => {
    if (code.includes("getImageByHash")) {
      return (
        overrides.image ??
        JSON.stringify({ base64: imageBytes.toString("base64") })
      );
    }
    if (code.includes("format: 'SVG'")) {
      return (
        overrides.svg ?? JSON.stringify({ base64: svgBytes.toString("base64") })
      );
    }
    return overrides.collector ?? JSON.stringify(found);
  };
}

function metadataEvaluator(
  found = collector(),
  overrides = {},
  metadataForCall = () => ({
    connectionId: "CONNECTION_A",
    fileKey: "FILE_A",
    pluginVersion: "3.3.26",
    documentRevisionBefore: null,
    documentRevisionAfter: null,
    revisionObservation: {
      scope: "page",
      pageId: "0:1",
      revisionBefore: 7,
      revisionAfter: 7,
    },
  })
) {
  const evaluate = evaluator(found, overrides);
  let calls = 0;
  return async (code) => ({
    value: await evaluate(code),
    metadata: metadataForCall(calls++, code),
  });
}

function workspace(t, prefix = "asset-export-command-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writes = [];
  const io = createWorkspaceIO({
    root,
    testHooks: {
      beforeWriteOpen(path) {
        writes.push(basename(path));
      },
    },
  });
  return { root, io, writes };
}

test("Asset Export request Interface is closed, canonical and validates before planning", () => {
  const request = {
    nodeId: "1:2",
    outputDir: "/work/assets",
    max: 7,
    rasterScale: 1.5,
  };
  assert.deepEqual(assetExportArgvFromRequest(request), [
    "export",
    "assets",
    "1:2",
    "-o",
    "/work/assets",
    "--max",
    "7",
    "--raster-scale",
    "1.5",
  ]);
  assert.deepEqual(
    assetExportRequestFromArgv([
      "export",
      "assets",
      "--output=/work/assets",
      "--raster-scale=1.5",
      "1:2",
      "--max",
      "7",
    ]),
    request
  );
  assert.deepEqual(
    assetExportArgvFromRequest({
      nodeId: "1:2",
      outputDir: "/work/assets",
      max: 100,
      rasterScale: 2,
    }),
    ["export", "assets", "1:2", "-o", "/work/assets"]
  );
  const url = "https://www.figma.com/design/FILEA/Asset-Lab?node-id=1-2";
  const planningArgv = assetExportPlanningArgvFromRequest({
    nodeId: url,
    outputDir: "/work/assets",
  });
  const cliUrlPlan = planFigmaCommand(planningArgv, { adapter: "cli" });
  const mcpUrlPlan = planFigmaCommand(planningArgv, { adapter: "mcp" });
  assert.deepEqual(cliUrlPlan.argv, [
    "export",
    "assets",
    "1:2",
    "-o",
    "/work/assets",
  ]);
  assert.deepEqual(cliUrlPlan.target, mcpUrlPlan.target);
  assert.equal(cliUrlPlan.target.fileKey, "FILEA");
  assert.equal(cliUrlPlan.execution.jobKey, mcpUrlPlan.execution.jobKey);
  assert.deepEqual(
    assetExportArgvFromRequest({
      nodeId: "1-2",
      outputDir: "/work/assets",
    }),
    ["export", "assets", "1:2", "-o", "/work/assets"]
  );

  for (const malformed of [
    ["export", "assets"],
    ["export", "assets", "1:2", "3:4"],
    ["export", "assets", "1:2", "--future", "secret"],
    ["export", "assets", "1:2", "--max"],
    ["export", "assets", "1:2", "--max", "3x"],
    ["export", "assets", "1:2", "--max", "0"],
    ["export", "assets", "1:2", "--raster-scale", "4.1"],
    ["export", "assets", "1:2", "--output", "--private"],
    ["export", "assets", "1:2", "-o", "a", "--output", "b"],
  ]) {
    assert.equal(
      planFigmaCommand(malformed).allowed,
      false,
      malformed.join(" ")
    );
  }
  assert.throws(
    () =>
      assetExportRequestFromArgv([
        "export",
        "assets",
        "1:2",
        "-o",
        "/work/assets",
        "--max",
        "3x",
      ]),
    /positive integer/
  );
});

test("CLI and MCP Asset Export plans cross one authentic Command Application Seam", async (t) => {
  const { root, io } = workspace(t, "asset-export-plan-");
  const argv = ["export", "assets", "1:1", "-o", join(root, "assets")];
  const mcpPlan = planFigmaCommand(argv, {
    adapter: "mcp",
    workspaceDir: root,
    fileKey: "FILE_A",
    workspaceIO: io,
  });
  const cliPlan = planFigmaCommand(argv, {
    adapter: "cli",
    workspaceDir: root,
    fileKey: "FILE_A",
    workspaceIO: io,
  });
  assert.equal(assetExportPlanRoute(mcpPlan), "command-application");
  assert.equal(assetExportPlanRoute(cliPlan), "command-application");
  assert.equal(
    assetExportPlanRoute(planFigmaCommand(["inspect", "1:1"])),
    "not-asset-export"
  );
  assert.throws(
    () => assetExportPlanRoute({ ...mcpPlan }),
    /requires a Command Plan/
  );

  const first = await executeAssetExportPlan(mcpPlan, {
    evaluate: metadataEvaluator(),
    workspaceIO: io,
  });
  const secondRoot = join(root, "assets-cli");
  const secondPlan = planFigmaCommand(
    ["export", "assets", "1:1", "-o", secondRoot],
    {
      adapter: "cli",
      workspaceDir: root,
      fileKey: "FILE_A",
      workspaceIO: io,
    }
  );
  const second = await executeAssetExportPlan(secondPlan, {
    evaluate: metadataEvaluator(),
    workspaceIO: io,
  });
  assert.deepEqual(
    {
      files: second.files,
      placements: second.placements,
      failures: second.failures,
    },
    {
      files: first.files,
      placements: first.placements,
      failures: first.failures,
    }
  );
});

test("Asset Export publishes files before assets.json and preserves its shared report", async (t) => {
  const { root, io } = workspace(t);
  const outputDir = join(root, "assets");
  let largeWritesOutsideLock = 0;
  const result = await executeAssetExport(
    {
      nodeId: "1:1",
      outputDir,
      max: 100,
      rasterScale: 2,
    },
    {
      evaluate: evaluator(),
      workspaceIO: io,
      onAssetWorkerPhase: async (phase) => {
        if (phase !== "asset-write") return;
        largeWritesOutsideLock += 1;
        assert.equal(
          readdirSync(outputDir).includes(ASSET_OUTPUT_LOCK_DIRECTORY),
          false
        );
      },
    }
  );

  assert.deepEqual(result.files.sort(), ["brand-mark.svg", "image-hash1.jpg"]);
  assert.equal(result.placements.length, 3);
  assert.deepEqual(result.publication.written.sort(), [
    "brand-mark.svg",
    "image-hash1.jpg",
  ]);
  assert.equal(basename(result.publication.manifestPath), "assets.json");
  assert.ok(
    result.publication.stagedBytes >= imageBytes.length + svgBytes.length
  );
  assert.ok(result.publication.peakMemory.rssBytes > 0);
  assert.equal(largeWritesOutsideLock, 2);
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.assets.length, 2);
  const output = formatAssetExportResult(result);
  assert.match(output, /2 file\(s\).*3 node reference/);
  assert.match(output, /verify-build <projectDir>/);
});

test("Asset Export prefers typed binary streams and never asks eval for asset bytes", async (t) => {
  const { root, io } = workspace(t, "asset-export-stream-");
  const found = collector({ images: false });
  const evaluated = [];
  const streamed = [];
  const result = await executeAssetExport(
    {
      nodeId: "1:1",
      outputDir: join(root, "assets"),
      max: 100,
      rasterScale: 2,
    },
    {
      workspaceIO: io,
      evaluate: async (code) => {
        evaluated.push(code);
        if (code.includes("format: 'SVG'")) {
          throw new Error("legacy SVG eval must not run");
        }
        return JSON.stringify(found);
      },
      streamAsset: async (asset) => {
        streamed.push(asset);
        return { bytes: svgBytes, details: { kind: "svg" } };
      },
    }
  );
  assert.deepEqual(streamed, [{ kind: "svg", ref: "1:4" }]);
  assert.equal(evaluated.length, 1, "only the bounded collector remains an eval");
  assert.deepEqual(result.files, ["brand-mark.svg"]);
});

test("Asset Export falls back only when an older Plugin rejects streaming before dispatch", async (t) => {
  const { root, io } = workspace(t, "asset-export-stream-fallback-");
  const found = collector({ images: false });
  let streamCalls = 0;
  let legacyByteReads = 0;
  const result = await executeAssetExport(
    {
      nodeId: "1:1",
      outputDir: join(root, "assets"),
      max: 100,
      rasterScale: 2,
    },
    {
      workspaceIO: io,
      evaluate: async (code) => {
        if (code.includes("format: 'SVG'")) {
          legacyByteReads += 1;
          return JSON.stringify({ base64: svgBytes.toString("base64") });
        }
        return JSON.stringify(found);
      },
      streamAsset: async () => {
        streamCalls += 1;
        throw Object.assign(new Error("capability missing"), {
          kind: "plugin-capability",
          outcome: "not-dispatched",
        });
      },
    }
  );
  assert.equal(streamCalls, 1);
  assert.equal(legacyByteReads, 1);
  assert.deepEqual(result.files, ["brand-mark.svg"]);
});

test("immediate staging permits one streamed asset above the old JSON ceiling without aggregate buffering", async (t) => {
  const { root, io } = workspace(t, "asset-export-large-stream-");
  const found = collector({ images: false });
  const largeSvg = Buffer.concat([
    Buffer.from('<svg width="32" height="24"><!--'),
    Buffer.alloc(6 * 1024 * 1024, 0x20),
    Buffer.from('--><path d="M0 0h32v24z"/></svg>'),
  ]);
  const largeSvgLength = largeSvg.length;
  const result = await executeAssetExport(
    {
      nodeId: "1:1",
      outputDir: join(root, "assets"),
      max: 100,
      rasterScale: 2,
    },
    {
      workspaceIO: io,
      evaluate: async () => JSON.stringify(found),
      streamAsset: async () => ({ bytes: largeSvg, details: { kind: "svg" } }),
      maxBufferedBytes: 1,
    }
  );
  assert.deepEqual(result.files, ["brand-mark.svg"]);
  assert.equal(result.publication.bufferedBytes, largeSvgLength);
  assert.equal(readFileSync(join(root, "assets", "brand-mark.svg")).length, largeSvgLength);
});

test("stream domain failures stay partial while transport failures abort and remove their stage", async (t) => {
  const partialWorkspace = workspace(t, "asset-export-stream-domain-");
  const partialOutput = join(partialWorkspace.root, "assets");
  const partial = await executeAssetExport(
    { nodeId: "1:1", outputDir: partialOutput, max: 100, rasterScale: 2 },
    {
      workspaceIO: partialWorkspace.io,
      evaluate: async () => JSON.stringify(collector()),
      streamAsset: async (asset) => {
        if (asset.kind === "image") return { bytes: imageBytes, details: { kind: "image" } };
        throw new Error("vector export denied");
      },
    }
  );
  assert.deepEqual(partial.files, ["image-hash1.jpg"]);
  assert.deepEqual(partial.failures, [
    { name: "Brand Mark", message: "vector export denied" },
  ]);

  const transportWorkspace = workspace(t, "asset-export-stream-transport-");
  const transportOutput = join(transportWorkspace.root, "assets");
  await assert.rejects(
    executeAssetExport(
      { nodeId: "1:1", outputDir: transportOutput, max: 100, rasterScale: 2 },
      {
        workspaceIO: transportWorkspace.io,
        evaluate: async () => JSON.stringify(collector({ images: false })),
        streamAsset: async () => {
          throw Object.assign(new Error("stream integrity failed"), {
            kind: "asset-transfer",
            outcome: "not-dispatched",
          });
        },
      }
    ),
    (error) => error.kind === "asset-transfer"
  );
  assert.equal(
    readdirSync(transportOutput).some((name) =>
      name.startsWith(".figma-bridge-assets-stage-")
    ),
    false,
    "a failed stream must not leave its private publication stage behind"
  );
});

test("concurrent exports of different roots into one output merge without losing either root", async (t) => {
  const { root, io } = workspace(t, "asset-export-concurrent-roots-");
  const outputDir = join(root, "assets");
  const firstRoot = {
    id: "10:1",
    name: "First Root",
    images: [],
    vectors: [
      {
        id: "10:2",
        name: "First Mark",
        ancestors: ["First Root"],
        w: 32,
        h: 24,
        parent: "First Root",
        rootId: "10:1",
      },
    ],
  };
  const secondRoot = {
    id: "20:1",
    name: "Second Root",
    images: [],
    vectors: [
      {
        id: "20:2",
        name: "Second Mark",
        ancestors: ["Second Root"],
        w: 48,
        h: 24,
        parent: "Second Root",
        rootId: "20:1",
      },
    ],
  };
  const plan = (nodeId) =>
    planFigmaCommand(["export", "assets", nodeId, "-o", outputDir], {
      adapter: "mcp",
      workspaceDir: root,
      fileKey: "FILE_A",
      workspaceIO: io,
    });

  let releaseFirst;
  let announceFirstPublication;
  const firstPublication = new Promise((resolve) => {
    announceFirstPublication = resolve;
  });
  let firstYieldCount = 0;
  const first = executeAssetExportPlan(plan(firstRoot.id), {
    workspaceIO: io,
    evaluate: metadataEvaluator(firstRoot, {
      svg: JSON.stringify({
        base64: Buffer.from(
          '<svg width="32" height="24"><path d="M0 0h32v24z"/></svg>'
        ).toString("base64"),
      }),
    }),
    yieldControl: async () => {
      firstYieldCount += 1;
      if (firstYieldCount !== 2) return;
      announceFirstPublication();
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    },
  });
  await firstPublication;

  let announceSecondCollected;
  const secondCollected = new Promise((resolve) => {
    announceSecondCollected = resolve;
  });
  let secondYieldCount = 0;
  const second = executeAssetExportPlan(plan(secondRoot.id), {
    workspaceIO: io,
    evaluate: metadataEvaluator(secondRoot, {
      svg: JSON.stringify({
        base64: Buffer.from(
          '<svg width="48" height="24"><path d="M0 0h48v24z"/></svg>'
        ).toString("base64"),
      }),
    }),
    yieldControl: async () => {
      secondYieldCount += 1;
      if (secondYieldCount === 1) announceSecondCollected();
    },
  });
  await secondCollected;
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  const manifest = JSON.parse(
    readFileSync(join(outputDir, "assets.json"), "utf8")
  );
  assert.deepEqual(manifest.roots, [
    { id: "10:1", name: "First Root" },
    { id: "20:1", name: "Second Root" },
  ]);
  assert.deepEqual(
    manifest.assets
      .flatMap((asset) =>
        asset.placements.map((item) => [item.rootId, item.nodeId])
      )
      .sort(),
    [
      ["10:1", "10:2"],
      ["20:1", "20:2"],
    ]
  );
  assert.equal(manifest.assets.length, 2);
  assert.equal(firstResult.kept, 0);
  assert.equal(secondResult.kept, 1);
});

test("Asset Export keeps the largest work, lists dropped assets and never loads them", async (t) => {
  const { root, io } = workspace(t, "asset-export-max-");
  const found = collector({ images: false, vectors: false });
  found.vectors = [
    { id: "2:1", name: "Large", ancestors: [], w: 200, h: 200, rootId: "1:1" },
    { id: "2:2", name: "Small", ancestors: [], w: 10, h: 10, rootId: "1:1" },
  ];
  const evaluated = [];
  const result = await executeAssetExport(
    {
      nodeId: "1:1",
      outputDir: join(root, "assets"),
      max: 1,
      rasterScale: 2,
    },
    {
      workspaceIO: io,
      evaluate: async (code) => {
        if (!code.includes("format: 'SVG'")) return JSON.stringify(found);
        evaluated.push(code.includes("2:1") ? "2:1" : "2:2");
        return JSON.stringify({ base64: svgBytes.toString("base64") });
      },
    }
  );
  assert.deepEqual(evaluated, ["2:1"]);
  assert.deepEqual(
    result.dropped.map((item) => item.name),
    ["Small"]
  );
  assert.match(
    formatAssetExportResult(result),
    /--max 1: dropped 1 smaller asset/
  );
});

test("empty roots succeed, partial failures publish, and total failures preserve the prior manifest", async (t) => {
  const { root, io } = workspace(t, "asset-export-outcomes-");
  const outputDir = join(root, "assets");
  const empty = await executeAssetExport(
    { nodeId: "1:1", outputDir, max: 100, rasterScale: 2 },
    {
      workspaceIO: io,
      evaluate: evaluator(collector({ images: false, vectors: false })),
    }
  );
  assert.equal(empty.status, "complete");
  assert.deepEqual(empty.files, []);

  await executeAssetExport(
    { nodeId: "1:1", outputDir, max: 100, rasterScale: 2 },
    {
      workspaceIO: io,
      evaluate: evaluator(),
    }
  );

  const partial = await executeAssetExport(
    { nodeId: "1:1", outputDir, max: 100, rasterScale: 2 },
    {
      workspaceIO: io,
      evaluate: evaluator(collector(), {
        svg: JSON.stringify({ error: "vector export denied" }),
      }),
    }
  );
  assert.deepEqual(partial.files, ["image-hash1.jpg"]);
  assert.deepEqual(partial.failures, [
    { name: "Brand Mark", message: "vector export denied" },
  ]);
  const partialManifest = JSON.parse(
    readFileSync(join(outputDir, "assets.json"), "utf8")
  );
  const preservedVector = partialManifest.assets.find(
    (asset) => asset.file === "brand-mark.svg"
  );
  assert.equal(
    preservedVector.placements.length,
    1,
    "a transient partial failure preserves the prior vector placement"
  );
  const before = readFileSync(join(outputDir, "assets.json"), "utf8");

  await assert.rejects(
    executeAssetExport(
      { nodeId: "1:1", outputDir, max: 100, rasterScale: 2 },
      {
        workspaceIO: io,
        evaluate: evaluator(collector({ images: false }), {
          svg: JSON.stringify({ error: "still denied" }),
        }),
      }
    ),
    (error) => {
      assert.ok(error instanceof AssetExportFailure);
      assert.equal(error.code, 1);
      assert.match(error.stdout, /existing assets\.json left unchanged/);
      assert.match(error.stdout, /Brand Mark: still denied/);
      return true;
    }
  );
  assert.equal(readFileSync(join(outputDir, "assets.json"), "utf8"), before);
});

test("Asset Export refuses unsafe file paths from an existing manifest", async (t) => {
  const { root, io } = workspace(t, "asset-export-prior-path-");
  const outputDir = join(root, "assets");
  io.ensureDirectory(outputDir, { role: "asset-export-directory" });
  const secretPath = join(root, "secret.svg");
  writeFileSync(secretPath, svgBytes);
  io.write(
    join(outputDir, "assets.json"),
    JSON.stringify({
      schemaVersion: 2,
      root: "old:root",
      roots: [{ id: "old:root", name: "Old" }],
      assets: [
        {
          sourceIdentity: "malicious",
          contentDigest: null,
          semanticLabel: "Secret",
          file: "../secret.svg",
          kind: "vector",
          placements: [],
        },
      ],
    }),
    { role: "asset-manifest" }
  );

  await assert.rejects(
    executeAssetExport(
      { nodeId: "1:1", outputDir, max: 100, rasterScale: 2 },
      {
        workspaceIO: io,
        evaluate: evaluator(collector({ images: false, vectors: false })),
      }
    ),
    /unsafe file path/
  );
  assert.deepEqual(readFileSync(secretPath), svgBytes);
});

test("structured transport failures abort instead of becoming partial asset failures", async (t) => {
  const { root, io } = workspace(t, "asset-export-transport-");
  const transportError = Object.assign(new Error("Plugin disconnected"), {
    kind: "plugin-unavailable",
    outcome: "unknown-after-dispatch",
    phase: "plugin-execution",
  });
  await assert.rejects(
    executeAssetExport(
      {
        nodeId: "1:1",
        outputDir: join(root, "assets"),
        max: 100,
        rasterScale: 2,
      },
      {
        workspaceIO: io,
        evaluate: async (code) => {
          if (code.includes("getImageByHash")) throw transportError;
          return JSON.stringify(collector({ vectors: false }));
        },
      }
    ),
    (error) => error === transportError
  );
  assert.equal(
    io.exists(join(root, "assets", "assets.json"), { role: "asset-manifest" }),
    false
  );
});

test("planned Asset Export pins one connection, file, page and page revision before publication", async (t) => {
  const { root, io } = workspace(t, "asset-export-revision-");
  const outputDir = join(root, "assets");
  const plan = planFigmaCommand(["export", "assets", "1:1", "-o", outputDir], {
    adapter: "mcp",
    workspaceDir: root,
    fileKey: "FILE_A",
    workspaceIO: io,
  });
  const evaluate = metadataEvaluator(collector(), {}, (call) => ({
    connectionId: "CONNECTION_A",
    fileKey: "FILE_A",
    pluginVersion: "3.3.26",
    documentRevisionBefore: null,
    documentRevisionAfter: null,
    revisionObservation: {
      scope: "page",
      pageId: "0:1",
      revisionBefore: call < 2 ? 7 : 8,
      revisionAfter: call < 2 ? 7 : 8,
    },
  }));

  await assert.rejects(
    executeAssetExportPlan(plan, { evaluate, workspaceIO: io }),
    (error) =>
      error.kind === "document-drift" && /revision changed/i.test(error.message)
  );
  assert.equal(
    io.exists(join(outputDir, "assets.json"), { role: "asset-manifest" }),
    false
  );

  await assert.rejects(
    executeAssetExportPlan(plan, { evaluate: evaluator(), workspaceIO: io }),
    (error) =>
      error.kind === "document-drift" &&
      /metadata envelope/i.test(error.message)
  );

  await assert.rejects(
    executeAssetExportPlan(plan, {
      evaluate: metadataEvaluator(collector(), {}, () => ({
        connectionId: "CONNECTION_A",
        fileKey: "FILE_B",
        pluginVersion: "3.3.26",
        documentRevisionBefore: null,
        documentRevisionAfter: null,
        revisionObservation: {
          scope: "page",
          pageId: "0:1",
          revisionBefore: 7,
          revisionAfter: 7,
        },
      })),
      workspaceIO: io,
    }),
    (error) =>
      error.kind === "document-drift" && /target changed/i.test(error.message)
  );

  await assert.rejects(
    executeAssetExportPlan(plan, {
      evaluate: metadataEvaluator(collector(), {}, (call) => ({
        connectionId: call === 0 ? "CONNECTION_A" : "CONNECTION_B",
        fileKey: "FILE_A",
        pluginVersion: "3.3.26",
        documentRevisionBefore: null,
        documentRevisionAfter: null,
        revisionObservation: {
          scope: "page",
          pageId: "0:1",
          revisionBefore: 7,
          revisionAfter: 7,
        },
      })),
      workspaceIO: io,
    }),
    (error) =>
      error.kind === "document-drift" &&
      /connection or observed revision changed/i.test(error.message)
  );
});

test("page revision compatibility is version-bounded and new plugins fail closed", async (t) => {
  const { root, io } = workspace(t, "asset-export-revision-transition-");
  const legacyOutput = join(root, "legacy-assets");
  const legacyPlan = planFigmaCommand(
    ["export", "assets", "1:1", "-o", legacyOutput],
    {
      adapter: "mcp",
      workspaceDir: root,
      fileKey: "FILE_A",
      workspaceIO: io,
    }
  );
  const legacy = await executeAssetExportPlan(legacyPlan, {
    workspaceIO: io,
    evaluate: metadataEvaluator(collector({ images: false }), {}, () => ({
      connectionId: "CONNECTION_A",
      fileKey: "FILE_A",
      pluginVersion: "3.3.5",
      documentRevisionBefore: null,
      documentRevisionAfter: null,
    })),
  });
  assert.equal(legacy.source.proof, "connection-only");
  assert.match(legacy.warning, /cannot prove Document Revision/);

  const compatibleOutput = join(root, "compatible-assets");
  const compatiblePlan = planFigmaCommand(
    ["export", "assets", "1:1", "-o", compatibleOutput],
    {
      adapter: "mcp",
      workspaceDir: root,
      fileKey: "FILE_A",
      workspaceIO: io,
    }
  );
  const compatible = await executeAssetExportPlan(compatiblePlan, {
    workspaceIO: io,
    evaluate: metadataEvaluator(collector({ images: false }), {}, () => ({
      connectionId: "CONNECTION_A",
      fileKey: "FILE_A",
      pluginVersion: "3.3.25",
      documentRevisionBefore: 7,
      documentRevisionAfter: 7,
    })),
  });
  assert.equal(compatible.source.proof, "document-revision");

  const currentOutput = join(root, "current-assets");
  const currentPlan = planFigmaCommand(
    ["export", "assets", "1:1", "-o", currentOutput],
    {
      adapter: "mcp",
      workspaceDir: root,
      fileKey: "FILE_A",
      workspaceIO: io,
    }
  );
  await assert.rejects(
    executeAssetExportPlan(currentPlan, {
      workspaceIO: io,
      evaluate: metadataEvaluator(collector({ images: false }), {}, () => ({
        connectionId: "CONNECTION_A",
        fileKey: "FILE_A",
        pluginVersion: "3.3.6",
        documentRevisionBefore: null,
        documentRevisionAfter: null,
      })),
    }),
    (error) =>
      error.kind === "document-drift" &&
      /did not provide the required page revision/.test(error.message)
  );
  assert.equal(
    io.exists(join(currentOutput, "assets.json"), { role: "asset-manifest" }),
    false
  );

  for (const pluginVersion of [null, "unknown", "3.3"]) {
    await assert.rejects(
      executeAssetExportPlan(currentPlan, {
        workspaceIO: io,
        evaluate: metadataEvaluator(collector({ images: false }), {}, () => ({
          connectionId: "CONNECTION_A",
          fileKey: "FILE_A",
          pluginVersion,
          documentRevisionBefore: null,
          documentRevisionAfter: null,
        })),
      }),
      (error) =>
        error.kind === "document-drift" &&
        /did not provide the required page revision/.test(error.message),
      `pluginVersion=${String(pluginVersion)} must fail closed`
    );
  }

  await assert.rejects(
    executeAssetExportPlan(currentPlan, {
      workspaceIO: io,
      evaluate: metadataEvaluator(collector({ images: false }), {}, () => ({
        connectionId: "CONNECTION_A",
        fileKey: "FILE_A",
        pluginVersion: "3.3.26",
        documentRevisionBefore: 7,
        documentRevisionAfter: 7,
      })),
    }),
    (error) =>
      error.kind === "document-drift" &&
      /did not provide the required page revision/.test(error.message)
  );
});

test("a queued export rechecks its pinned revision after acquiring the output lock", async (t) => {
  const { root, io } = workspace(t, "asset-export-queued-revision-");
  const outputDir = join(root, "assets");
  let releaseOwner;
  let announceOwner;
  const ownerAcquired = new Promise((resolve) => {
    announceOwner = resolve;
  });
  const owner = withAssetOutputLock(outputDir, { io }, async () => {
    announceOwner();
    await new Promise((resolve) => {
      releaseOwner = resolve;
    });
  });
  await ownerAcquired;

  const found = collector({ images: false });
  let call = 0;
  let announceBytesRead;
  const bytesRead = new Promise((resolve) => {
    announceBytesRead = resolve;
  });
  const evaluateValue = evaluator(found);
  const phases = [];
  const fileKeys = [];
  const observations = [];
  const evaluate = async (code, options = {}) => {
    const currentCall = call++;
    phases.push(options.phase);
    fileKeys.push(options.fileKey);
    observations.push(options.revisionObservation);
    const value = await evaluateValue(code);
    if (currentCall === 1) announceBytesRead();
    const revision = currentCall < 2 ? 7 : 8;
    return {
      value,
      metadata: {
        connectionId: "CONNECTION_A",
        fileKey: "FILE_A",
        pluginVersion: "3.3.26",
        documentRevisionBefore: null,
        documentRevisionAfter: null,
        revisionObservation: {
          scope: "page",
          pageId: "0:1",
          revisionBefore: revision,
          revisionAfter: revision,
        },
      },
    };
  };
  const plan = planFigmaCommand(["export", "assets", "1:1", "-o", outputDir], {
    adapter: "mcp",
    workspaceDir: root,
    fileKey: "FILE_A",
    workspaceIO: io,
  });
  const rejected = assert.rejects(
    executeAssetExportPlan(plan, { evaluate, workspaceIO: io }),
    (error) =>
      error.kind === "document-drift" &&
      /connection or observed revision changed during asset revision fence/i.test(
        error.message
      )
  );
  await bytesRead;
  await new Promise((resolve) => setImmediate(resolve));
  releaseOwner();
  await owner;
  await rejected;

  assert.deepEqual(phases, [
    "asset collector",
    "SVG bytes",
    "asset revision fence",
  ]);
  assert.deepEqual(fileKeys, ["FILE_A", "FILE_A", "FILE_A"]);
  assert.deepEqual(
    observations,
    Array(3)
      .fill(null)
      .map(() => ({
        scope: "page",
        nodeId: "1:1",
      }))
  );
  assert.equal(
    io.exists(join(outputDir, "assets.json"), { role: "asset-manifest" }),
    false
  );
  assert.equal(
    io.exists(join(outputDir, "brand-mark.svg"), { role: "exported-asset" }),
    false
  );
  assert.equal(
    readdirSync(outputDir).some((name) =>
      name.startsWith(".figma-bridge-assets-stage-")
    ),
    false,
    "a revision fence rejection must remove bytes staged before the lock"
  );
});

async function priorManifestFixture(t, prefix) {
  const { root, io } = workspace(t, prefix);
  const outputDir = join(root, "assets");
  await executeAssetExport(
    {
      nodeId: "1:1",
      outputDir,
      max: 100,
      rasterScale: 2,
    },
    { workspaceIO: io, evaluate: evaluator() }
  );
  return {
    root,
    io,
    outputDir,
    before: readFileSync(join(outputDir, "assets.json"), "utf8"),
  };
}

for (const cancelledPhase of ["hash", "asset-write", "manifest-write"]) {
  test(`Asset Export cancellation during ${cancelledPhase} preserves the prior manifest`, async (t) => {
    const fixture = await priorManifestFixture(
      t,
      `asset-export-cancel-${cancelledPhase}-`
    );
    let remaining = 10_000;
    let armed = cancelledPhase !== "hash";
    const found = {
      id: "2:1",
      name: "Replacement Root",
      images: [],
      vectors: [
        {
          id: "2:2",
          name: "Replacement Mark",
          ancestors: ["Replacement Root"],
          w: 64,
          h: 64,
          parent: "Replacement Root",
          rootId: "2:1",
        },
      ],
    };
    await assert.rejects(
      executeAssetExport(
        {
          nodeId: "2:1",
          outputDir: fixture.outputDir,
          max: 100,
          rasterScale: 2,
        },
        {
          workspaceIO: fixture.io,
          evaluate: evaluator(found, {
            svg: JSON.stringify({
              base64: Buffer.from(
                '<svg width="64" height="64"><circle cx="32" cy="32" r="31"/></svg>'
              ).toString("base64"),
            }),
          }),
          remainingMs: () => remaining,
          onAssetWorkerPhase: async (phase) => {
            if (phase === "hash" && !armed) {
              armed = true;
              remaining = 0;
            } else if (armed && phase === cancelledPhase) remaining = 0;
          },
        }
      ),
      (error) => error.kind === "timeout"
    );

    assert.equal(
      readFileSync(join(fixture.outputDir, "assets.json"), "utf8"),
      fixture.before
    );
    assert.equal(
      readdirSync(fixture.outputDir).some((name) =>
        name.startsWith(".figma-bridge-assets-stage-")
      ),
      false,
      "a cancelled worker must remove its private transaction stage"
    );
  });
}

test("Asset Publication Worker failure aborts instead of becoming a partial export", async (t) => {
  const fixture = await priorManifestFixture(t, "asset-export-worker-failure-");
  const found = collector({ images: false });
  await assert.rejects(
    executeAssetExport(
      {
        nodeId: "1:1",
        outputDir: fixture.outputDir,
        max: 100,
        rasterScale: 2,
      },
      {
        workspaceIO: fixture.io,
        evaluate: evaluator(found),
        assetPublicationWorker: {
          processVector: async () => {
            throw Object.assign(new Error("worker stopped"), {
              kind: "asset-worker",
            });
          },
        },
      }
    ),
    (error) => error.kind === "asset-worker"
  );
  assert.equal(
    readFileSync(join(fixture.outputDir, "assets.json"), "utf8"),
    fixture.before
  );
});

test("a committed manifest remains successful when cleanup crosses the deadline", async (t) => {
  const { root, io } = workspace(t, "asset-export-post-commit-");
  const outputDir = join(root, "assets");
  let remaining = 10_000;
  const phases = [];
  const result = await executeAssetExport(
    {
      nodeId: "1:1",
      outputDir,
      max: 100,
      rasterScale: 2,
    },
    {
      workspaceIO: io,
      evaluate: evaluator(),
      remainingMs: () => remaining,
      onAssetWorkerPhase: async (phase) => {
        phases.push(phase);
        if (phase === "post-commit-cleanup") remaining = 0;
      },
    }
  );

  assert.equal(result.status, "complete");
  assert.ok(phases.includes("post-commit-cleanup"));
  assert.equal(result.publication.cleanupPending, undefined);
  assert.equal(
    JSON.parse(readFileSync(join(outputDir, "assets.json"), "utf8")).assets
      .length,
    2
  );
  assert.equal(
    readdirSync(outputDir).some((name) =>
      name.startsWith(".figma-bridge-assets-stage-")
    ),
    false
  );
});

test("Asset Export Command Application has no console, termination or global argv dependency", () => {
  for (const relative of [
    "../src/application/asset-export-command.js",
    "../src/application/asset-export-request.js",
  ]) {
    const source = readFileSync(
      fileURLToPath(new URL(relative, import.meta.url)),
      "utf8"
    );
    assert.doesNotMatch(source, /\bconsole\s*\./, relative);
    assert.doesNotMatch(
      source,
      /\bprocess\s*\.\s*(?:argv|exit|exitCode)\b/,
      relative
    );
  }
});

test("oversized raster guidance distinguishes downsampleable PNG from retained JPEG", () => {
  const base = {
    status: "complete",
    files: ["photo.jpg"],
    outputDir: "/workspace/assets",
    placements: [],
    manifestPath: "/workspace/assets/assets.json",
    flagged: [],
    optimizedRasters: [],
    dropped: [],
    failures: [],
    kept: 0,
    rasterScale: 0,
  };
  const jpeg = assetExportResultRows({
    ...base,
    oversizedRasters: [{
      file: "photo.jpg", extension: "jpg", bytes: 2 * 1024 * 1024,
      nodes: [{ w: 40, h: 40 }],
    }],
  }).map((row) => row.text).join("\n");
  assert.match(jpeg, /photo\.jpg \(JPG\)/);
  assert.match(jpeg, /retained byte-for-byte/);
  assert.doesNotMatch(jpeg, /--raster-scale 2/);

  const png = assetExportResultRows({
    ...base,
    files: ["photo.png"],
    oversizedRasters: [{
      file: "photo.png", extension: "png", bytes: 2 * 1024 * 1024,
      nodes: [{ w: 40, h: 40 }],
    }],
  }).map((row) => row.text).join("\n");
  assert.match(png, /photo\.png \(PNG\)/);
  assert.match(png, /--raster-scale 2/);
  assert.doesNotMatch(png, /retained byte-for-byte/);
});
