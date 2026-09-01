import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFigmaCommand } from "../../src/capability-catalog.js";
import {
  executeVideoExportPlan,
  MAX_VIDEO_EXPORT_BASE64_CODE_UNITS,
  MAX_VIDEO_EXPORT_BYTES,
  videoExportCode,
  videoExportPlanRoute,
} from "../src/application/video-export-command.js";
import {
  parseVideoExportRequest,
  videoExportArgvFromRequest,
  videoExportPlanningArgvFromRequest,
} from "../src/application/video-export-request.js";
import {
  MAX_PLUGIN_MESSAGE_BYTES,
  MAX_PROTOCOL_VALUE_BYTES,
} from "../src/lib/protocol-contract.js";
import { createWorkspaceIO } from "../src/lib/workspace-io.js";

const URL = "https://www.figma.com/design/FILEA/Motion-Lab?node-id=1-2";

function box(type, payload = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(8 + payload.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write(type, 4, 4, "latin1");
  payload.copy(bytes, 8);
  return bytes;
}

const MP4 = Buffer.concat([
  box("ftyp", Buffer.from("isom\0\0\0\0mp42", "latin1")),
  box("moov"),
  box("mdat", Buffer.from([1, 2, 3, 4])),
]);
const GIF = Buffer.from([
  ...Buffer.from("GIF89a", "ascii"),
  0x20,
  0x00,
  0x10,
  0x00,
  0x00,
  0x00,
  0x00,
  0x3b,
]);
const WEBM = Buffer.from([
  0x1a,
  0x45,
  0xdf,
  0xa3,
  0x42,
  0x82,
  0x84,
  0x77,
  0x65,
  0x62,
  0x6d,
  0x18,
  0x53,
  0x80,
  0x67,
  0x00,
]);

function envelope(bytes, overrides = {}) {
  return {
    requestedId: "1:2",
    frameId: "1:1",
    frameName: "Motion Frame",
    frameWidth: 320,
    frameHeight: 180,
    format: "MP4",
    fps: 30,
    quality: "HIGH",
    loopCount: null,
    base64: bytes.toString("base64"),
    ...overrides,
  };
}

function fixture(bytes) {
  let settings = null;
  const page = { id: "0:1", type: "PAGE" };
  const frame = {
    id: "1:1",
    type: "FRAME",
    name: "Motion Frame",
    width: 320,
    height: 180,
    parent: page,
    async exportAsync(value) {
      settings = value;
      return Uint8Array.from(bytes);
    },
  };
  const child = {
    id: "1:2",
    type: "RECTANGLE",
    parent: frame,
    exportAsync: async () => Uint8Array.from([]),
    getTopLevelFrame: () => frame,
  };
  return {
    figma: {
      editorType: "figma",
      getNodeByIdAsync: async (id) => (id === child.id ? child : null),
      base64Encode: (value) => Buffer.from(value).toString("base64"),
    },
    settings: () => settings,
  };
}

test("Video Export request is closed, canonical, and URL-targeted", () => {
  assert.deepEqual(
    parseVideoExportRequest([
      "export",
      "video",
      "--format=gif",
      "--fps",
      "15",
      "--loop=3",
      "-oclip.gif",
      URL,
    ]),
    {
      nodeId: "1:2",
      warning:
        "id taken from a URL for Figma file FILEA. Safe Mode only reaches the file currently open in Figma Desktop — if that is a different file, the node will not be found.",
      format: "GIF",
      fps: 15,
      quality: null,
      loopCount: 3,
      outputPath: "clip.gif",
    }
  );
  assert.deepEqual(videoExportArgvFromRequest({ nodeId: "1-2" }), [
    "export",
    "video",
    "1:2",
    "-o",
    "video.mp4",
  ]);
  assert.deepEqual(
    videoExportArgvFromRequest({ nodeId: "1:2", outputPath: "-clip.mp4" }),
    ["export", "video", "1:2", "--output=-clip.mp4"]
  );
  assert.equal(
    parseVideoExportRequest([
      "export",
      "video",
      "1:2",
      "--format",
      "gif",
      "--quality",
      "legacy-ignored",
    ]).quality,
    null
  );
  assert.equal(
    parseVideoExportRequest([
      "export",
      "video",
      "1:2",
      "--loop",
      "legacy-ignored",
    ]).loopCount,
    null
  );
  assert.deepEqual(videoExportPlanningArgvFromRequest({ nodeId: URL }), [
    "export",
    "video",
    URL,
    "-o",
    "video.mp4",
  ]);
  const reordered = planFigmaCommand(
    ["export", "video", "--format", "gif", URL],
    { adapter: "mcp" }
  );
  assert.equal(reordered.allowed, true);
  assert.equal(reordered.execution.timeout, "long");
  assert.equal(reordered.target.fileKey, "FILEA");

  for (const args of [
    ["export", "video"],
    ["export", "video", "bad-node"],
    ["export", "video", "1:2", "2:3"],
    ["export", "video", "1:2", "--future"],
    ["export", "video", "1:2", "--format", "avi"],
    ["export", "video", "1:2", "--fps", "29"],
    ["export", "video", "1:2", "--format", "gif", "--fps", "60"],
    ["export", "video", "1:2", "--quality", "lossless"],
    ["export", "video", "1:2", "--format", "gif", "--loop", "1001"],
    ["export", "video", "1:2", "--fps", "30", "--fps", "30"],
  ]) {
    assert.throws(() => parseVideoExportRequest(args));
  }
});

test("CLI and MCP own one bounded Plan and format-specific Video Export", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "video-export-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const formats = [
    {
      name: "mp4",
      bytes: MP4,
      extra: ["--quality", "medium"],
      settings: { format: "MP4", fps: 30, quality: "MEDIUM" },
      envelope: { format: "MP4", quality: "MEDIUM", loopCount: null },
      container: "mp4",
    },
    {
      name: "gif",
      bytes: GIF,
      extra: ["--fps", "15", "--loop", "2"],
      settings: { format: "GIF", fps: 15, loopCount: 2 },
      envelope: { format: "GIF", fps: 15, quality: null, loopCount: 2 },
      container: "gif",
    },
    {
      name: "webm",
      bytes: WEBM,
      extra: [],
      settings: { format: "WEBM", fps: 30, quality: "HIGH" },
      envelope: { format: "WEBM", quality: "HIGH", loopCount: null },
      container: "webm",
    },
  ];
  for (const adapter of ["cli", "mcp"]) {
    for (const format of formats) {
      const output = `${adapter}.${format.name}`;
      const plan = planFigmaCommand(
        [
          "export",
          "video",
          URL,
          "--format",
          format.name,
          ...format.extra,
          "--output",
          output,
        ],
        { adapter, workspaceDir: root, workspaceIO: io }
      );
      assert.equal(plan.allowed, true);
      assert.equal(plan.id, "export.video");
      assert.equal(plan.execution.retry, "never");
      assert.deepEqual(plan.effects, {
        figma: "read",
        editor: "none",
        workspace: "write",
        network: "none",
        shared: "none",
      });
      assert.deepEqual(plan.target, {
        kind: "plugin-file",
        fileKey: "FILEA",
        source: "figma-url",
      });
      assert.deepEqual(plan.outputs, [
        { role: "video-output", path: join(root, output) },
      ]);
      assert.equal(videoExportPlanRoute(plan), "command-application");

      const live = fixture(format.bytes);
      let code = "";
      const result = await executeVideoExportPlan(plan, {
        workspaceIO: io,
        evaluate: async (value) => {
          code = value;
          return new Function("figma", `return ${value};`)(live.figma);
        },
      });
      assert.doesNotThrow(() => new Function("figma", `return ${code};`));
      assert.deepEqual(live.settings(), format.settings);
      assert.deepEqual(readFileSync(join(root, output)), format.bytes);
      assert.equal(result.result.container, format.container);
      assert.equal(result.result.requestedId, "1:2");
      assert.deepEqual(result.result.frame, {
        id: "1:1",
        name: "Motion Frame",
        width: 320,
        height: 180,
      });
      assert.match(result.stdout, /Exported Motion Frame/);
      if (format.name === "gif") {
        assert.equal(result.result.pixelWidth, 32);
        assert.equal(result.result.pixelHeight, 16);
      }
    }
  }
});

test("Plugin evidence and each video container validate before publication", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "video-export-rejection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const plan = planFigmaCommand(
    ["export", "video", "1:2", "-o", "clip.mp4"],
    { adapter: "mcp", workspaceDir: root, workspaceIO: io }
  );
  const output = join(root, "clip.mp4");

  for (const value of [
    { ...envelope(MP4), extra: true },
    envelope(MP4, { requestedId: "9:9" }),
    envelope(MP4, { frameId: "bad" }),
    envelope(MP4, { format: "WEBM" }),
    envelope(Buffer.from("not-an-mp4")),
    envelope(MP4, { base64: "not/base64" }),
  ]) {
    await assert.rejects(
      () =>
        executeVideoExportPlan(plan, {
          workspaceIO: io,
          evaluate: async () => value,
        }),
      /invalid bounded frame evidence|MP4|Base64/
    );
    assert.equal(existsSync(output), false);
  }

  await assert.rejects(
    () =>
      executeVideoExportPlan(plan, {
        workspaceIO: io,
        evaluate: async () => ({ error: "unsafe\u202eerror" }),
      }),
    /invalid bounded Figma error/
  );
  assert.equal(existsSync(output), false);

  for (const [format, bytes, overrides, message] of [
    ["gif", Buffer.from("GIF89a"), { format: "GIF", quality: null, loopCount: 0 }, /GIF/],
    ["webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), { format: "WEBM" }, /WebM/],
  ]) {
    const formatPlan = planFigmaCommand(
      ["export", "video", "1:2", "-f", format, "-o", `clip.${format}`],
      { adapter: "mcp", workspaceDir: root, workspaceIO: io }
    );
    await assert.rejects(
      () =>
        executeVideoExportPlan(formatPlan, {
          workspaceIO: io,
          evaluate: async () => envelope(bytes, overrides),
        }),
      message
    );
    assert.equal(existsSync(join(root, `clip.${format}`)), false);
  }
});

test("Plugin runtime refusals and export failures publish no video", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "video-export-runtime-refusal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const io = createWorkspaceIO({ root });
  const plan = planFigmaCommand(
    ["export", "video", "1:2", "-o", "clip.mp4"],
    { adapter: "mcp", workspaceDir: root, workspaceIO: io }
  );
  const page = { id: "0:1", type: "PAGE" };
  const frame = (exportAsync) => ({
    id: "1:2",
    type: "FRAME",
    name: "Motion Frame",
    width: 320,
    height: 180,
    parent: page,
    exportAsync,
  });
  const cases = [
    {
      figma: { editorType: "figjam", getNodeByIdAsync: async () => null },
      message: /only available in Figma Design/,
    },
    {
      figma: { editorType: "figma", getNodeByIdAsync: async () => null },
      message: /Exportable node not found/,
    },
    {
      figma: {
        editorType: "figma",
        getNodeByIdAsync: async () => ({
          id: "1:2",
          type: "RECTANGLE",
          exportAsync: async () => Uint8Array.from([]),
          getTopLevelFrame: () => null,
        }),
      },
      message: /top-level frame/,
    },
    {
      figma: {
        editorType: "figma",
        getNodeByIdAsync: async () => frame(async () => {
          throw new Error("native export unavailable");
        }),
      },
      message: /native export unavailable/,
    },
    {
      figma: {
        editorType: "figma",
        getNodeByIdAsync: async () => frame(
          async () => new Uint8Array(MAX_VIDEO_EXPORT_BYTES + 1)
        ),
      },
      message: /exceeds the bounded Plugin transport/,
    },
  ];
  for (const entry of cases) {
    entry.figma.base64Encode = (value) => Buffer.from(value).toString("base64");
    await assert.rejects(
      () =>
        executeVideoExportPlan(plan, {
          workspaceIO: io,
          evaluate: async (code) =>
            new Function("figma", `return ${code};`)(entry.figma),
        }),
      entry.message
    );
    assert.equal(existsSync(join(root, "clip.mp4")), false);
  }
});

test("Video Export refuses forged plans and keeps envelope headroom", async () => {
  const plan = planFigmaCommand(["export", "video", "1:2"]);
  assert.equal(videoExportPlanRoute(plan), "command-application");
  assert.throws(
    () => videoExportPlanRoute({ ...plan }),
    /requires a Command Plan/
  );
  assert.equal(
    videoExportPlanRoute(planFigmaCommand(["export", "node-json", "1:2"])),
    "not-video-export"
  );
  await assert.rejects(
    () => executeVideoExportPlan(planFigmaCommand(["export", "node-json", "1:2"])),
    /not owned/
  );
  assert.ok(MAX_VIDEO_EXPORT_BASE64_CODE_UNITS < MAX_PLUGIN_MESSAGE_BYTES);
  assert.ok(MAX_VIDEO_EXPORT_BASE64_CODE_UNITS < MAX_PROTOCOL_VALUE_BYTES);
  assert.equal(
    MAX_VIDEO_EXPORT_BYTES,
    Math.floor(MAX_VIDEO_EXPORT_BASE64_CODE_UNITS / 4) * 3
  );
  const code = videoExportCode({ nodeId: "1:2" });
  assert.match(code, new RegExp(`bytes\\.length > ${MAX_VIDEO_EXPORT_BYTES}`));
  assert.match(
    code,
    new RegExp(`base64\\.length > ${MAX_VIDEO_EXPORT_BASE64_CODE_UNITS}`)
  );
});
