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
    ".claude-plugin", ".codex-plugin", ".mcp.json", "plugin.json", "mcp.json", "skills",
    "src", "engine/src", "engine/package.json", "plugin", "NOTICE", "engine/LICENSE",
    // Shipped deliberately: the npm page is where most people decide whether to
    // trust an MCP server with write access to their design file.
    "SECURITY.md", "CHANGELOG.md", "README.md", "LICENSE",
  ]) {
    assert.ok(
      pkg.files.includes(required),
      `"${required}" missing from package.json files — the npm tarball would be broken`,
    );
  }
});

test("Codex plugin bundles the MCP server and focused bidirectional skills", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(
    readFileSync(join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8"),
  );
  const mcp = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
  const skills = Object.fromEntries([
    "figma-bridge-design-to-code",
    "figma-bridge-code-to-figma",
    "figma-bridge-component-library",
  ].map(name => [name, readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf8")]));

  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(marketplace.plugins, [{
    name: pkg.name,
    source: {
      source: "url",
      url: "https://github.com/KaiUweHella/figma-bridge-mcp.git",
      ref: "main",
    },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Creativity",
  }]);
  assert.deepEqual(mcp.mcpServers["figma-bridge"], {
    command: "npx",
    args: ["-y", "figma-bridge-mcp@latest"],
  });
  for (const [name, skill] of Object.entries(skills)) {
    assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`));
    assert.doesNotMatch(skill, /\[TODO:/);
  }
  assert.match(skills["figma-bridge-design-to-code"], /Do not install Playwright/);
  assert.match(skills["figma-bridge-design-to-code"], /Parallelize only independent sections/);
  assert.match(skills["figma-bridge-code-to-figma"], /Bridge DOM-capture workflow/);
  assert.match(skills["figma-bridge-code-to-figma"], /Componentize repeated source structures/);
  assert.match(skills["figma-bridge-component-library"], /INSTANCE_SWAP/);
  assert.match(skills["figma-bridge-component-library"], /Cartesian variant matrix at 30/);
});

test("Claude Code plugin reuses the same MCP server and skill", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const marketplace = JSON.parse(
    readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"),
  );

  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.skills, undefined, "Claude discovers the default skills/ directory once");
  assert.equal(
    manifest.mcpServers,
    undefined,
    "Claude discovers the default .mcp.json once instead of registering it twice",
  );
  assert.equal(marketplace.name, "figma-bridge");
  assert.deepEqual(marketplace.plugins, [
    {
      name: pkg.name,
      source: ".",
      description: "Authenticated local Figma MCP plus focused design-to-code, code-to-Figma, and component-library skills",
    },
  ]);
  assert.ok(existsSync(join(ROOT, ".mcp.json")));
  assert.ok(existsSync(join(ROOT, "skills", "figma-bridge-design-to-code", "SKILL.md")));
  assert.ok(existsSync(join(ROOT, "skills", "figma-bridge-code-to-figma", "SKILL.md")));
  assert.ok(existsSync(join(ROOT, "skills", "figma-bridge-component-library", "SKILL.md")));
});

test("portable Agent Plugin makes the bundle installable in Cursor", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(ROOT, "mcp.json"), "utf8"));

  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(mcp.mcpServers["figma-bridge"], {
    type: "stdio",
    command: "npx",
    args: ["-y", "figma-bridge-mcp@latest"],
  });
});

test("package.json keeps maintainer-only documentation out of the tarball", () => {
  for (const repositoryOnly of ["docs", "CONTEXT.md", "CONTRIBUTING.md", "SUPPORT.md"]) {
    assert.equal(
      pkg.files.includes(repositoryOnly),
      false,
      `"${repositoryOnly}" is repository documentation and should not ship to npm`,
    );
  }
});

test("package identity: name, bin, repository, prepublish test gate", () => {
  assert.equal(pkg.name, "figma-bridge-mcp");
  assert.ok(pkg.bin["figma-bridge-mcp"], "bin entry present");
  assert.match(
    readFileSync(join(ROOT, pkg.bin["figma-bridge-mcp"]), "utf8"),
    /^#!\/usr\/bin\/env node\r?\n/,
    "the installed npm executable needs a portable Node shebang",
  );
  assert.equal(
    pkg.repository.url,
    "git+https://github.com/KaiUweHella/figma-bridge-mcp.git",
    "npm provenance requires the canonical repository URL",
  );
  assert.equal(pkg.scripts.prepublishOnly, "npm test", "publishing must run the suite");
  assert.equal(pkg.publishConfig.access, "public");
  assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");
  assert.equal(pkg.main, undefined, "the executable package must not claim a library entry point");
});

test("root MIT license stays canonical; third-party notices stay complete", () => {
  const license = readFileSync(join(ROOT, "LICENSE"), "utf8");
  const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
  const upstreamLicense = readFileSync(join(ROOT, "engine", "LICENSE"), "utf8");
  const licenseHeader = /^MIT License\r?\n\r?\nCopyright \(c\) 2026 Kai-Uwe Hella and contributors\r?\n\r?\nPermission is hereby granted,/;
  assert.match(license, licenseHeader);
  assert.match(license.replace(/\r?\n/g, "\r\n"), licenseHeader,
    "the canonical license contract must also hold after a Windows CRLF checkout");
  assert.doesNotMatch(license, /figma-ds-cli|Feather/, "attribution belongs in NOTICE, not the canonical license");
  assert.match(notice, /Sil Bormüller/);
  assert.match(notice, /retained in full at engine\/LICENSE/);
  assert.match(upstreamLicense, /Copyright \(c\) 2026 Sil Bormüller/);
  assert.match(notice, /Copyright \(c\) 2013-2023 Cole Bemis/);
  assert.match(notice, /Permission is hereby granted, free of charge/);
});

test("test script uses Node discovery instead of shell-expanded globs", () => {
  assert.match(pkg.scripts.test, /node --test(?:\s|$)/);
  assert.doesNotMatch(
    pkg.scripts.test,
    /\*\.test\./,
    "PowerShell passes npm-script globs literally, so Node must discover test files itself",
  );
});

test("plugin dir ships every adapter connect installs", () => {
  const setupSource = readFileSync(join(ROOT, "engine", "src", "commands", "setup.js"), "utf8");
  for (const f of ["manifest.json", "manifest.dev.json", "code.js", "ui.html"]) {
    assert.ok(existsSync(join(ROOT, "plugin", f)), `plugin/${f} exists`);
    assert.ok(setupSource.includes(`'${f}'`), `figma_connect installs plugin/${f}`);
  }
  for (const removed of ["manifest.codegen.json", "codegen.js"]) {
    assert.equal(existsSync(join(ROOT, "plugin", removed)), false, `plugin/${removed} stays removed`);
    assert.ok(setupSource.includes(`'${removed}'`), `figma_connect retires cached plugin/${removed}`);
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
