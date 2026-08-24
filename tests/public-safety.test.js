import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  main,
  packageArtifactEntries,
  parsePatchEntries,
  scanText,
  sensitivePathReason,
} from "../scripts/check-public-safety.js";

test("public-safety accepts explicit Figma placeholders", () => {
  const source = [
    "https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=1-2",
    "https://www.figma.com/board/BOARDPLACEHOLDERKEY/FILE_NAME",
  ].join("\n");
  assert.deepEqual(scanText(source, { path: "example.md" }), []);
});

test("public-safety accepts only the named legacy fixture keys", () => {
  const source = [
    "https://www.figma.com/design/EXPLICITFILEKEY/FILE_NAME",
    "https://www.figma.com/design/ARGUMENTFILEKEY/FILE_NAME",
    "https://www.figma.com/board/BOARDFILEKEY/FILE_NAME",
  ].join("\n");
  assert.deepEqual(scanText(source, { path: "historical-fixture.js" }), []);
});

test("public-safety rejects real-looking Figma keys and file names", () => {
  const key = ["AbCdEf", "12345678901234"].join("");
  const findings = scanText(
    `https://www.figma.com/design/${key}/Private-Project?node-id=1-2`,
    { path: "README.md" }
  );
  assert.equal(findings[0]?.kind, "non-placeholder Figma file URL");
});

test("public-safety rejects provider tokens without printing their value", () => {
  const findings = scanText(`token = "npm_${"A".repeat(36)}"`, {
    path: "config.js",
  });
  assert.equal(findings[0]?.kind, "npm token");
  assert.equal("value" in findings[0], false);
});

test("public-safety still scans text that contains binary bytes", () => {
  const source = `prefix\0npm_${"A".repeat(36)}\0suffix`;
  const findings = scanText(source, { path: "mixed.bin" });
  assert.equal(findings[0]?.kind, "npm token");
});

test("public-safety rejects hard-coded high-entropy credentials", () => {
  const label = ["client", "secret"].join("_");
  const findings = scanText(`${label} = "AbCdEf0123456789!PrivateValue"`, {
    path: "config.js",
  });
  assert.equal(findings[0]?.kind, "hard-coded credential");
});

test("public-safety allows explicit test credential markers", () => {
  assert.deepEqual(
    scanText('access_token = "test-token-for-fixture-only"', {
      path: "fixture.js",
    }),
    []
  );
});

test("public-safety rejects personal absolute paths", () => {
  const privatePath = ["", "Users", "private-user", "project", "file.js"].join(
    "/"
  );
  const findings = scanText(`Open ${privatePath}`, {
    path: "notes.md",
  });
  assert.equal(findings[0]?.kind, "personal absolute path");
});

test("public-safety applies the private local denylist case-insensitively", () => {
  const findings = scanText("Internal codename: SecretClient", {
    path: "notes.md",
    denylist: ["secretclient"],
  });
  assert.equal(findings[0]?.kind, "private denylist term");
});

test("public-safety history parser scans additions with their real line", () => {
  const patch = [
    "PUBLIC_SAFETY_COMMIT abc123",
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -2 +2,2 @@",
    "-removed value",
    "+safe value",
    "+NPM_TOKEN=placeholder",
  ].join("\n");
  assert.deepEqual(parsePatchEntries(patch).slice(1), [
    {
      path: "notes.md",
      content: "safe value",
      revision: "abc123",
      lineOffset: 2,
      scanPath: false,
    },
    {
      path: "notes.md",
      content: "NPM_TOKEN=placeholder",
      revision: "abc123",
      lineOffset: 3,
      scanPath: false,
    },
  ]);
});

test("public-safety rejects credential-bearing filenames", () => {
  assert.equal(
    sensitivePathReason("config/.env.production"),
    "environment file"
  );
  assert.equal(
    sensitivePathReason("certificates/client.p12"),
    "credential file"
  );
  assert.equal(
    sensitivePathReason("certificates/client.key"),
    "credential file"
  );
  assert.equal(
    sensitivePathReason("screenshots/customer.png"),
    "binary artifact requiring public review"
  );
  assert.equal(sensitivePathReason(".env.example"), null);
});

test("public-safety scans an untracked file selected by the package artifact policy", () => {
  const root = mkdtempSync(join(tmpdir(), "figma-bridge-public-package-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "new-runtime.js"),
      `export const token = "npm_${"A".repeat(36)}";`
    );

    const entries = packageArtifactEntries({
      root,
      policy: {
        version: 1,
        files: ["src/new-runtime.js"],
        executables: [],
      },
    });
    const findings = entries.flatMap((entry) =>
      scanText(entry.content.toString("utf8"), {
        path: entry.path,
        revision: entry.revision,
      })
    );

    assert.equal(entries[0]?.revision, "package artifact");
    assert.equal(findings[0]?.kind, "npm token");
    assert.equal(findings[0]?.path, "src/new-runtime.js");
    assert.equal("value" in findings[0], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default prepublish safety fails on an untracked allowlisted Runtime secret", async () => {
  const root = mkdtempSync(join(tmpdir(), "figma-bridge-public-prepublish-"));
  const messages = [];
  try {
    mkdirSync(join(root, "release"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "README.md"), "safe tracked source\n");
    writeFileSync(
      join(root, "src", "new-runtime.js"),
      `export const token = "npm_${"B".repeat(36)}";`
    );
    writeFileSync(
      join(root, "release", "package-artifact-policy.json"),
      JSON.stringify({
        version: 1,
        files: ["src/new-runtime.js"],
        executables: [],
      })
    );
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync(
      "git",
      ["add", "README.md", "release/package-artifact-policy.json"],
      { cwd: root }
    );

    const output = {
      error: (...parts) => messages.push(parts.join(" ")),
      log: (...parts) => messages.push(parts.join(" ")),
    };
    assert.equal(await main([], { root, output }), 1);

    const rendered = messages.join("\n");
    assert.match(rendered, /npm token: src\/new-runtime\.js:1/);
    assert.doesNotMatch(rendered, new RegExp(`npm_${"B".repeat(36)}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package projection does not scan ignored private documentation", async () => {
  const root = mkdtempSync(join(tmpdir(), "figma-bridge-public-private-docs-"));
  const messages = [];
  try {
    mkdirSync(join(root, "release"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs-local"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "docs-local/\n");
    writeFileSync(join(root, "README.md"), "safe tracked source\n");
    writeFileSync(
      join(root, "src", "runtime.js"),
      "export const ready = true;\n"
    );
    writeFileSync(
      join(root, "docs-local", "private.md"),
      `private npm_${"C".repeat(36)}\n`
    );
    writeFileSync(
      join(root, "release", "package-artifact-policy.json"),
      JSON.stringify({
        version: 1,
        files: ["src/runtime.js"],
        executables: [],
      })
    );
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync(
      "git",
      [
        "add",
        ".gitignore",
        "README.md",
        "release/package-artifact-policy.json",
      ],
      { cwd: root }
    );

    const output = {
      error: (...parts) => messages.push(parts.join(" ")),
      log: (...parts) => messages.push(parts.join(" ")),
    };
    assert.equal(await main([], { root, output }), 0);
    assert.doesNotMatch(messages.join("\n"), /docs-local|private\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
