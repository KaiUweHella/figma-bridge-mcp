import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "figma-audit-mcp-"));
const blocker = join(root, "blocked");
writeFileSync(blocker, "not a directory");
process.env.AUDIT_LOG_PATH = join(blocker, "audit.log");
process.env.PLUGIN_KEY_FILE = join(root, "plugin-key");

const { handleTool } = await import("../src/server.js");

test("MCP command utility survives degraded audit storage and reports recovery", async () => {
  const degraded = await handleTool("figma_run", { args: ["--help"] });
  assert.equal(degraded.isError, undefined, "the engine command still succeeds");
  assert.match(degraded.content[0].text, /Figma Commands available through figma_run:/);
  assert.match(degraded.content[0].text, /\[audit warning\]/);
  assert.equal(degraded._meta["figma-bridge-mcp"].auditTrail.status, "degraded");

  unlinkSync(blocker);
  mkdirSync(blocker);
  const recovered = await handleTool("figma_run", { args: ["--help"] });
  assert.equal(recovered.isError, undefined);
  assert.doesNotMatch(recovered.content[0].text, /\[audit warning\]/);
  assert.equal("auditTrail" in recovered._meta["figma-bridge-mcp"], false);
});
