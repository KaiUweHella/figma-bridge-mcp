import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const TEST_WORKFLOW = readFileSync(
  new URL("../.github/workflows/test.yml", import.meta.url),
  "utf8"
);
const PUBLISH_WORKFLOW = readFileSync(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8"
);

test("release workflows pin every third-party Action to an immutable commit", () => {
  const uses = [
    ...`${TEST_WORKFLOW}\n${PUBLISH_WORKFLOW}`.matchAll(
      /uses:\s*([^@\s]+)@([^\s#]+)/g
    ),
  ];
  assert.ok(uses.length > 0);
  for (const [, action, revision] of uses) {
    assert.match(
      revision,
      /^[0-9a-f]{40}$/,
      `${action} must use a full commit SHA`
    );
  }
});

test("publish workflow releases the verified tarball and retains all evidence", () => {
  assert.match(PUBLISH_WORKFLOW, /npm@11\.15\.0 --ignore-scripts/);
  assert.match(
    PUBLISH_WORKFLOW,
    /build:package-artifact -- --output-dir release-artifact/
  );
  assert.match(
    PUBLISH_WORKFLOW,
    /write-installed-dependency-evidence\.js package-smoke release-artifact\/dependencies\.json/
  );
  assert.match(
    PUBLISH_WORKFLOW,
    /npm publish release-artifact\/package\.tgz --ignore-scripts/
  );
  assert.match(PUBLISH_WORKFLOW, /path: release-artifact\//);
  assert.doesNotMatch(PUBLISH_WORKFLOW, /^\s*- run: npm publish\s*$/m);
});

test("CI dependency installation suppresses lifecycle scripts", () => {
  for (const workflow of [TEST_WORKFLOW, PUBLISH_WORKFLOW]) {
    for (const line of workflow
      .split("\n")
      .filter((entry) => /npm (?:ci|install)/.test(entry))) {
      assert.match(
        line,
        /--ignore-scripts/,
        `dependency command must disable scripts: ${line.trim()}`
      );
    }
  }
});
