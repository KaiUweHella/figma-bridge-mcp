import { test } from "node:test";
import assert from "node:assert/strict";
import { installedDependencyEvidence } from "../scripts/write-installed-dependency-evidence.js";

function lockWith(dependency = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/figma-bridge-mcp": {
        version: "1.0.0",
        resolved: "file:../artifact/package.tgz",
      },
      "node_modules/runtime": {
        version: "2.0.0",
        resolved: "https://registry.npmjs.org/runtime/-/runtime-2.0.0.tgz",
        integrity: "sha512-YWJj",
        dependencies: { zeta: "^1.0.0", alpha: "^2.0.0" },
        ...dependency,
      },
    },
  };
}

test("installed dependency evidence is exact, deterministic, and path-sanitized", () => {
  const evidence = installedDependencyEvidence(lockWith());
  assert.equal(
    evidence.schema,
    "figma-bridge/installed-dependency-evidence/v1"
  );
  assert.equal(evidence.componentCount, 2);
  assert.equal(evidence.installScriptCount, 0);
  assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.components[0].source, "verified-package-artifact");
  assert.equal(
    evidence.components[1].source,
    "https://registry.npmjs.org/runtime/-/runtime-2.0.0.tgz"
  );
  assert.deepEqual(evidence.components[1].requires, {
    alpha: "^2.0.0",
    zeta: "^1.0.0",
  });
  assert.doesNotMatch(JSON.stringify(evidence), /\.\.|private\/tmp|Users/);
});

test("installed dependency evidence rejects executable lifecycle hooks", () => {
  assert.throws(
    () => installedDependencyEvidence(lockWith({ hasInstallScript: true })),
    /runtime@2\.0\.0 declares an install script/
  );
});

test("installed dependency evidence rejects missing integrity and non-registry origins", () => {
  assert.throws(
    () =>
      installedDependencyEvidence(
        lockWith({
          resolved: "https://packages.example.test/runtime.tgz",
          integrity: undefined,
        })
      ),
    /not resolved from the canonical npm registry[\s\S]*no SHA-512 registry integrity/
  );
});
