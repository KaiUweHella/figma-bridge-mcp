// figma_comments confirm gate — the UNCONDITIONAL one. Unlike figma_run's
// opt-in FIGMA_WRITE_CONFIRM gate, posting a comment must preview without
// confirm:true even when the env gate is OFF (comments are visible to other
// humans in a shared cloud file). Also: the unconfigured-token path.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "figma-bridge-comments-"));
process.env.PLUGIN_KEY_FILE = join(tmp, "plugin-key");
process.env.AUDIT_LOG_PATH = join(tmp, "audit.log");
process.env.REST_TOKEN_FILE = join(tmp, "rest-token");
delete process.env.FIGMA_REST_TOKEN;
delete process.env.FIGMA_WRITE_CONFIRM; // the point: gate must hold WITHOUT it

const { test, after } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { handleTool } = await import("../src/server.js");
const { NOT_CONFIGURED_MSG } = await import("../src/figma-rest.js");

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("without a token, figma_comments explains the setup instead of erroring", async () => {
  const res = await handleTool("figma_comments", { action: "list" });
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, NOT_CONFIGURED_MSG);
});

test("post without confirm returns a PREVIEW and never reaches the network", async () => {
  writeFileSync(process.env.REST_TOKEN_FILE, "figd_test");
  // Explicit fileKey — no daemon/selection needed. If the gate failed, the
  // call would hit api.figma.com and fail differently; the preview must come
  // back BEFORE any fetch.
  const res = await handleTool("figma_comments", {
    action: "post",
    fileKey: "PLACEHOLDERFILEKEY",
    message: "Spacing fixed in commit COMMIT_SHA",
    nodeId: "1:2",
  });
  assert.equal(res.isError, undefined);
  const text = res.content[0].text;
  assert.match(text, /PREVIEW — nothing was posted/);
  assert.match(text, /PLACEHOLDERFILEKEY/);
  assert.match(text, /node 1:2/);
  assert.match(text, /Spacing fixed in commit COMMIT_SHA/);
  assert.match(text, /confirm:true/);
});

test("post validates message before anything else", async () => {
  const res = await handleTool("figma_comments", {
    action: "post",
    fileKey: "PLACEHOLDERFILEKEY",
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /non-empty message/);
});

test("bad explicit fileKey yields an actionable parse error", async () => {
  const res = await handleTool("figma_comments", { action: "list", fileKey: "12:34" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Could not parse a file key/);
});

test("figma_history includeVersions without a token appends the setup note (no error)", async () => {
  rmSync(process.env.REST_TOKEN_FILE, { force: true }); // earlier test wrote one
  const res = await handleTool("figma_history", { includeVersions: true });
  assert.equal(res.isError, undefined, "history must still be delivered");
  assert.match(res.content[0].text, /REST access is not configured/);
});

test("figma_history includeVersions with token but no resolvable file degrades to a note", async () => {
  writeFileSync(process.env.REST_TOKEN_FILE, "figd_test");
  const res = await handleTool("figma_history", { includeVersions: true });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /Figma versions (skipped|unavailable)/);
});
