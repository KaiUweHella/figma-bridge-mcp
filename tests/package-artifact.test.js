import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVerifiedPackage,
  verifyPackageMetadata,
} from "../scripts/verify-package-artifact.js";

test(
  "release artifact is allowlisted and byte-reproducible",
  { timeout: 30_000 },
  () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    const evidence = buildVerifiedPackage();
    assert.equal(evidence.schema, "figma-bridge/package-integrity-evidence/v1");
    assert.equal(
      evidence.package,
      `${packageJson.name}@${packageJson.version}`
    );
    assert.equal(evidence.reproducibility.byteIdenticalPacks, 2);
    assert.ok(evidence.inventory.count > 100);
    assert.deepEqual(evidence.inventory.executables, ["engine/src/index.js"]);
    assert.match(evidence.artifact.sha256, /^[0-9a-f]{64}$/);
    assert.match(evidence.artifact.sha512, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
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
