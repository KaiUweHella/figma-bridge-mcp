// Packaging guards: the npm tarball must ship everything the server needs at
// runtime (a file move that drops src/engine/plugin from `files` would publish
// a broken package that still passes every functional test locally), and the
// state-dir migration must preserve existing pairings across the rename.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("package.json files covers every runtime directory", () => {
  for (const required of [
    "src", "engine/src", "engine/package.json", "plugin", "NOTICE", "engine/LICENSE",
    // Shipped deliberately: the npm page is where most people decide whether to
    // trust an MCP server with write access to their design file.
    "SECURITY.md",
  ]) {
    assert.ok(
      pkg.files.includes(required),
      `"${required}" missing from package.json files — the npm tarball would be broken`,
    );
  }
});

test("package identity: name, bin, repository, prepublish test gate", () => {
  assert.equal(pkg.name, "figma-bridge-mcp");
  assert.ok(pkg.bin["figma-bridge-mcp"], "bin entry present");
  assert.match(pkg.repository.url, /github\.com/);
  assert.equal(pkg.scripts.prepublishOnly, "npm test", "publishing must run the suite");
});

test("test script uses Node discovery instead of shell-expanded globs", () => {
  assert.match(pkg.scripts.test, /node --test(?:\s|$)/);
  assert.doesNotMatch(
    pkg.scripts.test,
    /\*\.test\./,
    "PowerShell passes npm-script globs literally, so Node must discover test files itself",
  );
});

test("plugin dir ships exactly the three files connect installs", () => {
  for (const f of ["manifest.json", "code.js", "ui.html"]) {
    assert.ok(existsSync(join(ROOT, "plugin", f)), `plugin/${f} exists`);
  }
});

// The migration lives at module load of engine/src/lib/state-dir.js and keys
// off homedir() — run it in a child process with a scratch home on Unix and Windows.
function runMigration(home) {
  execFileSync(
    process.execPath,
    ["-e", "import('./engine/src/lib/state-dir.js').then(m => console.log(m.STATE_DIR))"],
    { cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8" },
  );
}

test("state-dir migration: old dir is renamed once, pairing files survive", () => {
  const home = mkdtempSync(join(tmpdir(), "figma-bridge-home-"));
  mkdirSync(join(home, ".figma-safe-mcp"), { recursive: true });
  writeFileSync(join(home, ".figma-safe-mcp", "plugin-key"), "the-key");
  runMigration(home);
  assert.equal(existsSync(join(home, ".figma-safe-mcp")), false, "old dir gone");
  assert.equal(
    readFileSync(join(home, ".figma-bridge-mcp", "plugin-key"), "utf8"),
    "the-key",
    "pairing survives the rename",
  );
  rmSync(home, { recursive: true, force: true });
});

test("state-dir migration: when both dirs exist, the new one wins untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "figma-bridge-home-"));
  mkdirSync(join(home, ".figma-safe-mcp"), { recursive: true });
  writeFileSync(join(home, ".figma-safe-mcp", "plugin-key"), "old-key");
  mkdirSync(join(home, ".figma-bridge-mcp"), { recursive: true });
  writeFileSync(join(home, ".figma-bridge-mcp", "plugin-key"), "new-key");
  runMigration(home);
  assert.equal(
    readFileSync(join(home, ".figma-bridge-mcp", "plugin-key"), "utf8"),
    "new-key",
    "existing new state must never be overwritten",
  );
  assert.ok(existsSync(join(home, ".figma-safe-mcp")), "old dir left alone");
  rmSync(home, { recursive: true, force: true });
});

test("fresh install: no old dir, migration is a no-op", () => {
  const home = mkdtempSync(join(tmpdir(), "figma-bridge-home-"));
  runMigration(home);
  assert.equal(existsSync(join(home, ".figma-safe-mcp")), false);
  // STATE_DIR itself is created lazily by the writers, not the migration.
  rmSync(home, { recursive: true, force: true });
});
