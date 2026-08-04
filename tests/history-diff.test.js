// The MCP side of structural diffs: figma_history's `diff` parameter.
//
// The tool surface stays at 12 tools — diffing is a parameter, not a thirteenth
// schema — so the routing rules here (local vs REST, and the refusal to mix
// them) are the part worth pinning down.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "figma-bridge-histdiff-"));
process.env.PLUGIN_KEY_FILE = join(tmp, "plugin-key");
process.env.AUDIT_LOG_PATH = join(tmp, "audit.log");
process.env.REST_TOKEN_FILE = join(tmp, "rest-token");
delete process.env.FIGMA_REST_TOKEN;

const { test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { handleTool } = await import("../src/server.js");
const { NOT_CONFIGURED_MSG } = await import("../src/figma-rest.js");
const { ALLOWED_COMMANDS } = await import("../src/engine.js");
const { isWrite } = await import("../src/server.js");

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const textOf = (res) => res.content[0].text;

test("history is allowlisted and counts as a read of the design", async () => {
  assert.ok(ALLOWED_COMMANDS.has("history"));
  // It writes snapshot files, not the Figma document — same class as extract.
  assert.equal(isWrite(["history", "snapshot"]), false);
  assert.equal(isWrite(["history", "diff", "latest", "live"]), false);
});

test("mixing a Figma version with a local snapshot is refused, with the reason", async () => {
  const res = await handleTool("figma_history", {
    diff: { from: "version:123456", to: "live" },
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /cannot be diffed against a local snapshot/);
  // The refusal has to say WHY, or it reads as an arbitrary restriction.
  assert.match(textOf(res), /every node would look changed/);
});

test("the reverse mix is refused too", async () => {
  const res = await handleTool("figma_history", {
    diff: { from: "latest", to: "version:123456" },
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /cannot be diffed/);
});

test("a version diff without a REST token explains the setup instead of failing", async () => {
  const res = await handleTool("figma_history", {
    diff: { from: "version:1", to: "version:2" },
  });
  assert.equal(res.isError, undefined);
  assert.equal(textOf(res), NOT_CONFIGURED_MSG);
});

test("a malformed diff parameter is rejected with an example", async () => {
  for (const bad of ["latest", 42, [], null]) {
    const res = await handleTool("figma_history", { diff: bad });
    assert.equal(res.isError, true, `diff: ${JSON.stringify(bad)}`);
    assert.match(textOf(res), /diff must be an object/);
  }
});

test("unknown keys inside diff are caught by the schema, not silently ignored", async () => {
  const { unknownParamError } = await import("../src/server.js");
  // Top-level unknown params are checked by hand; the nested object relies on
  // additionalProperties:false in the schema. Assert the schema says so.
  const { TOOLS } = await import("../src/server.js");
  const history = TOOLS.find((t) => t.name === "figma_history");
  assert.equal(history.inputSchema.properties.diff.additionalProperties, false);
  assert.deepEqual(
    Object.keys(history.inputSchema.properties.diff.properties).sort(),
    ["changelog", "from", "nodeId", "to"],
  );
  assert.equal(unknownParamError("figma_history", { diff: {} }), null);
});

test("the tool surface stays at 12 — diffing did not add a thirteenth", async () => {
  const { TOOLS } = await import("../src/server.js");
  assert.equal(TOOLS.length, 12);
});
