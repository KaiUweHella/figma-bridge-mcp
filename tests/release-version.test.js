import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseVersion,
  releaseVersionMismatches,
  syncReleaseVersion,
} from "../scripts/sync-release-version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

function writeJson(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

function releaseFixture(version = "0.1.0") {
  const root = mkdtempSync(join(tmpdir(), "figma-bridge-release-"));
  writeJson(root, "package.json", { name: "figma-bridge-mcp", version });
  writeJson(root, "package-lock.json", { version, packages: { "": { version } } });
  writeJson(root, "engine/package.json", { version });
  writeJson(root, ".codex-plugin/plugin.json", { version });
  writeJson(root, ".claude-plugin/plugin.json", { version });
  writeJson(root, "plugin.json", { version });
  writeJson(root, ".agents/plugins/marketplace.json", {
    plugins: [{ source: { ref: `v${version}` } }],
  });
  writeJson(root, ".claude-plugin/marketplace.json", {
    plugins: [{ source: { ref: `v${version}` } }],
  });
  writeJson(root, ".mcp.json", {
    mcpServers: { "figma-bridge": { args: ["-y", `figma-bridge-mcp@${version}`] } },
  });
  writeJson(root, "mcp.json", {
    mcpServers: { "figma-bridge": { args: ["-y", `figma-bridge-mcp@${version}`] } },
  });
  return root;
}

test("checked-in release metadata is synchronized", () => {
  assert.equal(assertReleaseVersion(ROOT), PACKAGE_VERSION);
  assert.deepEqual(releaseVersionMismatches(ROOT), []);
});

test("release sync updates manifests, Git tags, npm runtime pins, and lockfiles together", () => {
  const root = releaseFixture();
  try {
    assert.equal(syncReleaseVersion("0.6.0", root), "0.6.0");
    assert.equal(assertReleaseVersion(root), "0.6.0");
    assert.deepEqual(releaseVersionMismatches(root), []);
    assert.equal(JSON.parse(readFileSync(join(root, "package-lock.json"))).packages[""].version, "0.6.0");
    assert.equal(
      JSON.parse(readFileSync(join(root, ".agents/plugins/marketplace.json"))).plugins[0].source.ref,
      "v0.6.0",
    );
    assert.equal(
      JSON.parse(readFileSync(join(root, ".mcp.json"))).mcpServers["figma-bridge"].args.at(-1),
      "figma-bridge-mcp@0.6.0",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release check reports drift instead of silently accepting latest", () => {
  const root = releaseFixture();
  try {
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json")));
    mcp.mcpServers["figma-bridge"].args[1] = "figma-bridge-mcp@latest";
    writeJson(root, ".mcp.json", mcp);
    assert.deepEqual(releaseVersionMismatches(root), [{
      key: ".mcp.json#server-package",
      expected: "figma-bridge-mcp@0.1.0",
      actual: "figma-bridge-mcp@latest",
    }]);
    assert.throws(() => assertReleaseVersion(root), /not synchronized/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release sync rejects non-strict semver prerelease identifiers", () => {
  const root = releaseFixture();
  try {
    assert.throws(() => syncReleaseVersion("1.0.0-01", root), /strict semver/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
