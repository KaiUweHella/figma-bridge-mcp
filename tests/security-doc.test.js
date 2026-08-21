import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECURITY = readFileSync(join(ROOT, "SECURITY.md"), "utf8");

const EVIDENCE = Object.freeze([
  [
    "SEC-HTTP-AUTH",
    [
      ["tests/daemon-auth.test.js", "replayed signed headers are rejected"],
      ["tests/daemon-auth.test.js", "signature is bound to method and path"],
      ["tests/daemon-auth.test.js", "signature is bound to the exact body"],
      [
        "tests/daemon-auth.test.js",
        "request authentication rejects an adversarial header corpus without throwing",
      ],
    ],
  ],
  [
    "SEC-PLUGIN-AUTH",
    [
      [
        "tests/daemon-auth.test.js",
        "WS challenge-response authenticates and the daemon proves itself back",
      ],
      ["tests/daemon-auth.test.js", "a proof for a DIFFERENT port is rejected"],
      [
        "tests/plugin-handshake.test.js",
        "plugin HMAC matches on random inputs",
      ],
    ],
  ],
  [
    "SEC-LOOPBACK",
    [
      [
        "tests/daemon-auth.test.js",
        "HTTP /plugin-ready exposes only a CORS-scoped, non-sensitive discovery beacon",
      ],
      [
        "tests/daemon-auth.test.js",
        "WS with a disallowed browser Origin is rejected",
      ],
      [
        "tests/plugin-sync.test.js",
        "the manifest permits every port in the range and nothing beyond loopback",
      ],
    ],
  ],
  [
    "SEC-PAYLOAD",
    [
      ["tests/daemon-auth.test.js", "oversized chunked HTTP /exec is rejected"],
      ["tests/daemon-auth.test.js", "oversized WebSocket messages close"],
      [
        "engine/tests/protocol-contract.test.js",
        "plugin result, error, metadata, batch, token and selection payloads are bounded",
      ],
    ],
  ],
  [
    "SEC-TARGET",
    [
      [
        "tests/daemon-auth.test.js",
        "with several windows, /exec must name a file",
      ],
      [
        "tests/figma-target.test.js",
        "Figma Target Context resolves precedence once and stays immutable",
      ],
    ],
  ],
  [
    "SEC-COMMAND",
    [
      [
        "tests/capability-catalog.test.js",
        "catalog denies and gates unknown commands with safe defaults",
      ],
      ["tests/write-gate.test.js", "unknown command GROUPS default to WRITE"],
    ],
  ],
  [
    "SEC-NO-SHELL",
    [
      [
        "tests/security-doc.test.js",
        "engine execution stays argv-only without a shell",
      ],
      [
        "tests/error-projection.test.js",
        "child-process projection never exposes the internal command line or argv",
      ],
    ],
  ],
  [
    "SEC-NO-WRITE-RETRY",
    [
      [
        "tests/command-application.test.js",
        "in-process execution never repeats an ambiguous daemon failure by default",
      ],
      [
        "tests/command-application.test.js",
        "safe-read retries share one decreasing deadline budget",
      ],
    ],
  ],
  [
    "SEC-REST",
    [
      [
        "tests/rest.test.js",
        "closed REST allowlist permits only named metadata/history endpoints",
      ],
      [
        "tests/rest.test.js",
        "REST allowlist fails closed on URL canonicalization attacks before token lookup",
      ],
      [
        "tests/rest.test.js",
        "REST audit uses endpoint capabilities and never retains token, path, file key, or body",
      ],
      [
        "tests/rest-token-daemon.test.js",
        "unauthenticated socket cannot plant a REST token",
      ],
    ],
  ],
  [
    "SEC-AUDIT",
    [
      [
        "tests/audit-trail.test.js",
        "Audit Trail stores a closed redacted schema with private permissions",
      ],
      [
        "tests/audit-trail.test.js",
        "Audit Trail failure is explicit and non-blocking, then clears after recovery",
      ],
      [
        "tests/audit-trail.test.js",
        "Audit Trail keeps one bounded private rotation",
      ],
      [
        "tests/audit-degraded-mcp.test.js",
        "MCP command utility survives degraded audit storage and reports recovery",
      ],
      [
        "tests/history.test.js",
        "versioned audit history filters by redacted node digest without storing the node id",
      ],
    ],
  ],
  [
    "SEC-PLUGIN-NETWORK",
    [
      [
        "tests/plugin-sync.test.js",
        "the manifest permits every port in the range and nothing beyond loopback",
      ],
    ],
  ],
  [
    "SEC-LINK-PATH",
    [
      [
        "engine/tests/design-link-registry.test.js",
        "repository path boundary rejects traversal, sibling-prefix and null-byte attacks",
      ],
    ],
  ],
  [
    "SEC-DATA-AS-DATA",
    [
      [
        "engine/tests/add-variant.test.js",
        "a quoted payload cannot break out of the eval",
      ],
      ["tests/history.test.js", "formatHistory sanitizes hostile labels/refs"],
      [
        "engine/tests/structured-render-executor.test.js",
        "preflights the whole plan and rejects unsupported facts without writes",
      ],
    ],
  ],
  [
    "SEC-PUBLIC-SAFETY",
    [
      [
        "tests/public-safety.test.js",
        "public-safety rejects provider tokens without printing their value",
      ],
      [
        "tests/public-safety.test.js",
        "public-safety history parser scans additions with their real line",
      ],
    ],
  ],
  [
    "SEC-PACKAGE",
    [
      [
        "tests/package-artifact.test.js",
        "release artifact is allowlisted and byte-reproducible",
      ],
      [
        "tests/package-artifact.test.js",
        "artifact policy rejects an unreviewed executable even when it is regular",
      ],
      [
        "tests/installed-dependency-evidence.test.js",
        "installed dependency evidence is exact, deterministic, and path-sanitized",
      ],
      [
        "tests/installed-dependency-evidence.test.js",
        "installed dependency evidence rejects executable lifecycle hooks",
      ],
      [
        "tests/packaging.test.js",
        "published runtime keeps the declared Node floor after consumer resolution",
      ],
      [
        "tests/release-integrity.test.js",
        "release workflows pin every third-party Action to an immutable commit",
      ],
      [
        "tests/release-integrity.test.js",
        "publish workflow releases the verified tarball and retains all evidence",
      ],
    ],
  ],
]);

test("public security claims resolve to named executable evidence", () => {
  for (const [id, cases] of EVIDENCE) {
    assert.ok(
      new RegExp("\\|\\s+`" + id + "`\\s+\\|").test(SECURITY),
      `${id} must have one public evidence row`
    );
    for (const [path, name] of cases) {
      const source = readFileSync(join(ROOT, path), "utf8");
      assert.ok(
        source.includes(name),
        `${id}: missing evidence ${path} :: ${name}`
      );
      assert.ok(
        SECURITY.includes(path),
        `${id}: SECURITY.md must cite ${path}`
      );
    }
  }
});

test("public threat model separates boundary attackers from a same-user host compromise", () => {
  assert.match(
    SECURITY,
    /loopback but \*\*cannot\*\* read Figma Bridge's private state/
  );
  assert.match(SECURITY, /same OS user[\s\S]*full host compromise/);
  assert.match(SECURITY, /MCP arguments[\s\S]*untrusted input/);
  assert.doesNotMatch(SECURITY, /\*\*No secret is ever transmitted\.\*\*/);
  assert.doesNotMatch(
    SECURITY,
    /\*\*Everything is logged and interruptible\.\*\*/
  );
});

test("engine execution stays argv-only without a shell", () => {
  const source = readFileSync(join(ROOT, "src", "engine.js"), "utf8");
  assert.match(source, /import \{ execFile \} from ["']node:child_process["']/);
  assert.equal((source.match(/^\s+shell:\s*false,/gm) || []).length, 2);
  assert.doesNotMatch(source, /\bexec\s*\(/);
});
