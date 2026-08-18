import assert from "node:assert/strict";
import test from "node:test";

import {
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
