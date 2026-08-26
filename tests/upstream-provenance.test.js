import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(ROOT, "UPSTREAM_PROVENANCE.json"), "utf8"),
);

function sha256(path) {
  return createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
}

function attributionInventory(summary) {
  return `Attribution inventory: ${summary.retainedModifiedDerivedSourceFiles} retained modified-derived source files, ${summary.byteIdenticalSourceFiles} byte-identical source files, and ${summary.verbatimUpstreamLicenseFiles} verbatim upstream license file.`;
}

test("upstream provenance pins one exact figma-cli revision and local hashes", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.upstreams.length, 1);
  const [upstream] = manifest.upstreams;

  assert.deepEqual(
    {
      id: upstream.id,
      repository: upstream.repository,
      version: upstream.version,
      tag: upstream.tag,
      tagObject: upstream.tagObject,
      revision: upstream.revision,
    },
    {
      id: "silships/figma-cli",
      repository: "https://github.com/silships/figma-cli",
      version: "2.1.0",
      tag: "v2.1.0",
      tagObject: "6ccbee66012764502ef513ed3e44e182052b3368",
      revision: "e69cba0dae4478e844516e84ba13e838f6616b6b",
    },
  );
  assert.equal(upstream.license.relationship, "byte-identical-license");
  assert.equal(upstream.license.localSha256, upstream.license.upstreamSha256);
  assert.equal(sha256(upstream.license.localPath), upstream.license.localSha256);

  assert.equal(
    upstream.retainedDerivedFiles.length,
    manifest.summary.retainedModifiedDerivedSourceFiles,
  );
  for (const file of upstream.retainedDerivedFiles) {
    assert.equal(file.relationship, "modified-derived");
    assert.match(file.upstreamSha256, /^[a-f0-9]{64}$/u);
    assert.match(file.localSha256, /^[a-f0-9]{64}$/u);
    assert.notEqual(file.localSha256, file.upstreamSha256);
    assert.equal(sha256(file.localPath), file.localSha256, `${file.localPath} drifted`);
  }
  assert.equal(manifest.summary.byteIdenticalSourceFiles, 0);
  assert.equal(manifest.summary.verbatimUpstreamLicenseFiles, 1);
});

test("public attribution documents use the manifest-derived inventory", () => {
  const expected = attributionInventory(manifest.summary);
  for (const path of ["README.md", "NOTICE", "CONTRIBUTING.md"]) {
    assert.ok(
      readFileSync(join(ROOT, path), "utf8").includes(expected),
      `${path} must contain the canonical attribution inventory`,
    );
  }
});

test("the provenance manifest ships in the allowlisted npm artifact", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const policy = JSON.parse(
    readFileSync(join(ROOT, "release", "package-artifact-policy.json"), "utf8"),
  );
  assert.ok(pkg.files.includes("UPSTREAM_PROVENANCE.json"));
  assert.ok(policy.files.includes("UPSTREAM_PROVENANCE.json"));
});
