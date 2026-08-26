import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  buildVerifiedPackage,
  canonicalizePackageTarball,
  npmPackInvocation,
  verifyPackageMetadata,
} from "../scripts/verify-package-artifact.js";

function writeTarOctal(header, offset, length, value) {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii"
  );
}

function tarFixture(entries) {
  const parts = [];
  for (const { path, mode, contents = "fixture" } of entries) {
    const body = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(`package/${path}`, 0, 100, "utf8");
    writeTarOctal(header, 100, 8, mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, body.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii"
    );
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

test("Windows pack runs npm's JavaScript entry through Node without a shell", () => {
  const npmExecPath = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(npmPackInvocation({ platform: "win32", npmExecPath }), {
    command: process.execPath,
    args: [npmExecPath],
  });
});

test("package tarball modes are canonical even when the checkout has no Unix executable bits", () => {
  const windowsSource = tarFixture([
    { path: "engine/src/index.js", mode: 0o644 },
    { path: "src/server.js", mode: 0o644 },
    { path: "src/config.js", mode: 0o644 },
  ]);
  windowsSource[9] = 0;
  const posixSource = tarFixture([
    { path: "engine/src/index.js", mode: 0o755 },
    { path: "src/server.js", mode: 0o644 },
    { path: "src/config.js", mode: 0o644 },
  ]);
  posixSource[9] = 3;
  const policy = {
    executables: ["engine/src/index.js", "src/server.js"],
  };
  const canonical = canonicalizePackageTarball(windowsSource, policy);
  const posixCanonical = canonicalizePackageTarball(posixSource, policy);

  assert.equal(canonical.tarball[9], 0xff);
  assert.ok(canonical.tarball.equals(posixCanonical.tarball));
  assert.deepEqual(canonical.files, [
    { path: "engine/src/index.js", size: 7, mode: 0o755 },
    { path: "src/server.js", size: 7, mode: 0o755 },
    { path: "src/config.js", size: 7, mode: 0o644 },
  ]);
});

test("package tarball canonicalization rejects an unreviewed executable", () => {
  const source = tarFixture([
    { path: "engine/src/index.js", mode: 0o644 },
    { path: "src/surprise.js", mode: 0o755 },
  ]);

  assert.throws(
    () =>
      canonicalizePackageTarball(source, {
        executables: ["engine/src/index.js"],
      }),
    /unreviewed executable in npm tarball: src\/surprise\.js/
  );
});

test(
  "release artifact is allowlisted and byte-reproducible",
  { timeout: 30_000 },
  () => {
    const outputDir = mkdtempSync(
      join(tmpdir(), "figma-bridge-package-artifact-output-")
    );
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    try {
      const evidence = buildVerifiedPackage({ outputDir });
      assert.equal(
        evidence.schema,
        "figma-bridge/package-integrity-evidence/v1"
      );
      assert.equal(
        evidence.package,
        `${packageJson.name}@${packageJson.version}`
      );
      assert.equal(evidence.reproducibility.byteIdenticalPacks, 2);
      assert.ok(evidence.inventory.count > 100);
      assert.deepEqual(evidence.inventory.executables, [
        "engine/src/index.js",
        "src/server.js",
      ]);
      assert.match(evidence.artifact.sha256, /^[0-9a-f]{64}$/);
      assert.match(evidence.artifact.sha512, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
      assert.ok(readFileSync(join(outputDir, "package.tgz")).length > 0);
      assert.ok(readFileSync(join(outputDir, "integrity.json")).length > 0);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }
);

test("artifact policy rejects an unreviewed executable even when it is regular", () => {
  const root = mkdtempSync(join(tmpdir(), "figma-bridge-artifact-policy-"));
  try {
    writeFileSync(join(root, "approved.js"), "export {};");
    writeFileSync(join(root, "surprise.js"), "export {};");
    assert.throws(
      () =>
        verifyPackageMetadata(
          {
            name: "example",
            version: "1.0.0",
            files: [
              { path: "approved.js", size: 10, mode: 0o644 },
              { path: "surprise.js", size: 10, mode: 0o755 },
            ],
          },
          {
            root,
            packageJson: { name: "example", version: "1.0.0" },
            policy: { version: 1, files: ["approved.js"], executables: [] },
          }
        ),
      /unexpected packed files: surprise\.js[\s\S]*executable file set is \[surprise\.js\]/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected tar paths fail without becoming source-tree reads", () => {
  const root = mkdtempSync(join(tmpdir(), "figma-bridge-artifact-boundary-"));
  try {
    writeFileSync(join(root, "approved.js"), "export {};");
    assert.throws(
      () =>
        verifyPackageMetadata(
          {
            name: "example",
            version: "1.0.0",
            files: [
              { path: "approved.js", size: 10, mode: 0o644 },
              { path: "../outside.js", size: 10, mode: 0o644 },
            ],
          },
          {
            root,
            packageJson: { name: "example", version: "1.0.0" },
            policy: { version: 1, files: ["approved.js"], executables: [] },
          }
        ),
      (error) => {
        assert.match(
          error.message,
          /unexpected packed files: \.\.\/outside\.js/
        );
        assert.doesNotMatch(
          error.message,
          /cannot be verified in the source tree/
        );
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
