import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPluginArtifact } from "../scripts/sync-plugin-artifact.js";

const canonical = readFileSync(
  new URL("../engine/src/lib/structured-render-executor.js", import.meta.url),
  "utf8"
);
const plugin = readFileSync(
  new URL("../plugin/code.js", import.meta.url),
  "utf8"
);

test("deterministic Plugin build reproduces the checked-in artifact", () => {
  assert.equal(
    renderPluginArtifact(canonical, plugin),
    plugin.replace(/\r\n?/g, "\n")
  );
});

test("Plugin build replaces only the marked runtime and strips ESM exports", () => {
  const source = [
    "// before",
    "// BEGIN STRUCTURED RENDER RUNTIME",
    "export function canonicalRuntime() { return 1; }",
    "// END STRUCTURED RENDER RUNTIME",
    "// after",
    "",
  ].join("\n");
  const stale = [
    "// shell",
    "// BEGIN STRUCTURED RENDER RUNTIME",
    "function staleRuntime() {}",
    "// END STRUCTURED RENDER RUNTIME",
    "// tail",
    "",
  ].join("\n");
  assert.equal(
    renderPluginArtifact(source.replace(/\n/g, "\r\n"), stale),
    [
      "// shell",
      "// BEGIN STRUCTURED RENDER RUNTIME",
      "function canonicalRuntime() { return 1; }",
      "// END STRUCTURED RENDER RUNTIME",
      "// tail",
      "",
    ].join("\n")
  );
});

test("Plugin build fails closed when either marker boundary is ambiguous", () => {
  assert.throws(
    () =>
      renderPluginArtifact(
        canonical,
        `${plugin}\n// BEGIN STRUCTURED RENDER RUNTIME\n`
      ),
    /exactly one structured-runtime marker pair/
  );
});
