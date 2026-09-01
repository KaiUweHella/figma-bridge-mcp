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
        "plugin result, error, metadata, token and selection payloads are bounded",
      ],
      [
        "engine/tests/daemon-client.test.js",
        "legacy daemon error bodies are bounded before they become client messages",
      ],
    ],
  ],
  [
    "SEC-ASSET-STREAM",
    [
      [
        "tests/daemon-auth.test.js",
        "authenticated Asset Stream carries bytes above the JSON ceiling with backpressure and no residue",
      ],
      [
        "tests/daemon-auth.test.js",
        "malformed Asset Stream order fails integrity and removes its private partial file",
      ],
      [
        "tests/daemon-auth.test.js",
        "Plugin disconnect during Asset Stream removes its private partial file",
      ],
      [
        "engine/tests/asset-transfer-store.test.js",
        "a completed asset transfer verifies sequence, length and digest before one-shot consumption",
      ],
      [
        "engine/tests/asset-transfer-store.test.js",
        "private permissions and restart cleanup retain no recognised transfer bytes",
      ],
      [
        "engine/tests/daemon-client.test.js",
        "daemon client rejects a truncated or digest-mismatched Asset Stream",
      ],
    ],
  ],
  [
    "SEC-IMAGE-EXPORT",
    [
      [
        "engine/tests/image-export-command.test.js",
        "JPG, SVG and PDF use one Plan-bound Image Export Application for CLI and MCP",
      ],
      [
        "engine/tests/image-export-command.test.js",
        "format bytes and Plugin evidence are validated before Workspace publication",
      ],
      [
        "engine/tests/image-export-command.test.js",
        "SVG and PDF require complete bounded containers before publication",
      ],
      [
        "engine/tests/image-export-command.test.js",
        "Image Export leaves bounded envelope room inside the Plugin transport",
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
      [
        "tests/figma-target.test.js",
        "registry targeting is lazy and stays below explicit and URL-derived targets",
      ],
      [
        "tests/capability-catalog.test.js",
        "one Command Plan resolves its Figma Target Context after path normalization",
      ],
      [
        "tests/capability-catalog.test.js",
        "every exposed command root owns a closed URL target projection",
      ],
      [
        "tests/capability-catalog.test.js",
        "only semantic node fields may derive a Figma URL target",
      ],
      [
        "tests/capability-catalog.test.js",
        "conflicting semantic node URLs stop before one target is selected",
      ],
      [
        "tests/command-application.test.js",
        "a pre-resolved Command Plan preserves its registry target through the Command Application",
      ],
      [
        "tests/mcp-layer.test.js",
        "figma_run creates one registry-targeted plan for Link and Contract execution",
      ],
      [
        "tests/mcp-layer.test.js",
        "asset background jobs include the target file in their identity",
      ],
    ],
  ],
  [
    "SEC-DISPATCH",
    [
      [
        "engine/tests/dispatch-receipt.test.js",
        "Plugin preflight rejects stale connection, target, editor, and capability before execution",
      ],
      [
        "tests/plugin-sync.test.js",
        "expired queued writes never begin and timed-out evals quarantine the Plugin lane",
      ],
      [
        "tests/daemon-auth.test.js",
        "a terminal response from an old connection epoch cannot settle a newer execution",
      ],
      [
        "tests/daemon-auth.test.js",
        "/exec treats a valid but target-mismatched terminal receipt as outcome unknown",
      ],
      [
        "tests/error-projection.test.js",
        "public errors expose only the closed Dispatch Receipt state",
      ],
    ],
  ],
  [
    "SEC-WRITE-LANE",
    [
      [
        "engine/tests/plugin-write-lane.test.js",
        "same-session writes are ordered while different sessions progress independently",
      ],
      [
        "engine/tests/plugin-write-lane.test.js",
        "queued deadline and cancellation remove only their own command",
      ],
      [
        "engine/tests/plugin-write-lane.test.js",
        "unknown dispatch quarantines until the exact settlement token arrives",
      ],
      [
        "tests/daemon-auth.test.js",
        "Plugin write lanes order one file while different files progress independently",
      ],
      [
        "tests/daemon-auth.test.js",
        "queued deadline and HTTP cancellation never reach the Plugin write boundary",
      ],
      [
        "tests/daemon-auth.test.js",
        "unknown write quarantine survives reconnect until the exact lane settlement replays",
      ],
      [
        "tests/plugin-sync.test.js",
        "Plugin main replays exact lane settlement after an authenticated UI reconnect",
      ],
    ],
  ],
  [
    "SEC-RENDER-ROLLBACK",
    [
      [
        "engine/tests/structured-render-executor.test.js",
        "preflights every batch resource before the first real mutation",
      ],
      [
        "engine/tests/structured-render-executor.test.js",
        "rolls back batch-wide Command resources in reverse creation order without touching reused resources",
      ],
      [
        "engine/tests/structured-render-executor.test.js",
        "fault-injects after every removable resource and tree mutation",
      ],
      [
        "engine/tests/structured-render-executor.test.js",
        "reports bounded image residue and preserves the original execution failure",
      ],
      [
        "engine/tests/structured-render-executor.test.js",
        "keeps rollback failure as a failed partial-residue result",
      ],
      [
        "tests/daemon-auth.test.js",
        "/exec preserves a failed Structured Render mutation report without weakening dispatch uncertainty",
      ],
      [
        "engine/tests/daemon-error-envelope.test.js",
        "Bridge Daemon errors preserve only closed bounded mutation residue facts",
      ],
    ],
  ],
  [
    "SEC-RENDER-OUTCOME",
    [
      [
        "engine/tests/semantic-render-command.test.js",
        "malformed post-dispatch results remain unknown and never redispatch",
      ],
      [
        "engine/tests/semantic-render-command.test.js",
        "known rollback residue is carried only as typed failure facts",
      ],
      [
        "engine/tests/semantic-render-command.test.js",
        "a structural finding preserves the created root, returns code 1 and bounded deterministic output",
      ],
      [
        "tests/mcp-layer.test.js",
        "figma_run and figma_render share simple and compound non-retrying Semantic Render Applications",
      ],
      [
        "tests/command-application.test.js",
        "Semantic Render findings project the same Outcome into process and Audit codes",
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
    "SEC-BULK-GATES",
    [
      [
        "tests/high-risk-command-gates.test.js",
        "high-risk legacy write modes are denied by policy with static alternatives",
      ],
      [
        "tests/high-risk-command-gates.test.js",
        "direct Commander gates fail before connection or Plugin dispatch",
      ],
      [
        "tests/high-risk-command-gates.test.js",
        "Source MCP returns the same actionable denial before readiness",
      ],
      [
        "tests/high-risk-command-gates.test.js",
        "safe adjacent utility remains available and literal payload cannot trigger a gate",
      ],
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
        "tests/daemon-auth.test.js",
        "HTTP /exec reports a missing Plugin before dispatch",
      ],
      [
        "tests/daemon-auth.test.js",
        "/exec reports Plugin timeout as outcome unknown after dispatch",
      ],
      [
        "tests/daemon-auth.test.js",
        "/exec keeps domain token failures as execution errors after Plugin dispatch",
      ],
      [
        "engine/tests/daemon-client.test.js",
        "daemon client trusts structured execution facts instead of domain prose",
      ],
      [
        "engine/tests/daemon-client.test.js",
        "legacy string-only daemon errors stay compatible without token substring auth inference",
      ],
      [
        "engine/tests/daemon-error-envelope.test.js",
        "compatibility redispatch requires a capability rejection before dispatch",
      ],
      [
        "tests/command-application.test.js",
        "in-process mutation never repeats an outcome-unknown daemon failure",
      ],
      [
        "tests/command-application.test.js",
        "safe-read retries share one decreasing deadline budget",
      ],
      [
        "engine/tests/safe-read-retry.test.js",
        "transient classifier recognizes normalized plugin and daemon failures",
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
    "SEC-PRIVATE-STATE",
    [
      [
        "engine/tests/private-state-permissions.test.js",
        "Windows ACL Adapter uses a bounded argument array and returns direct evidence",
      ],
      [
        "engine/tests/private-state-permissions.test.js",
        "Windows directly rejects a permissive DACL and repairs it idempotently",
      ],
      [
        "engine/tests/private-state-permissions.test.js",
        "POSIX privacy repair is recursive, idempotent and directly verifiable",
      ],
      [
        "engine/tests/private-state-permissions.test.js",
        "POSIX privacy preflight rejects links before changing the tree",
      ],
      [
        "engine/tests/private-state-permissions.test.js",
        "private-state policy rejects broad roots and unowned artifact names",
      ],
      [
        "engine/tests/screenshot-command.test.js",
        "default screenshot persistence is an exact private Plan artifact",
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
        "engine/tests/component-add-variant-command.test.js",
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
    "SEC-REMOTE-STORYBOOK",
    [
      [
        "engine/tests/storybook-remote.test.js",
        "remote Storybook policy keeps conventional localhost zero-config and canonicalizes numeric aliases",
      ],
      [
        "engine/tests/storybook-remote.test.js",
        "remote Storybook rejects public-origin DNS rebinding and always-forbidden network ranges",
      ],
      [
        "engine/tests/storybook-remote.test.js",
        "remote Storybook pins the validated address and ignores proxy environment variables",
      ],
      [
        "engine/tests/storybook-remote.test.js",
        "remote Storybook revalidates every redirect and never contacts an unapproved target",
      ],
      [
        "engine/tests/storybook-remote.test.js",
        "remote Storybook enforces connect, header, body, and total deadlines",
      ],
      [
        "engine/tests/storybook-remote.test.js",
        "local Storybook directory imports keep working through Workspace I/O",
      ],
      [
        "tests/capability-catalog.test.js",
        "each capability supplies a closed audit projection without user payloads or identities",
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
      [
        "tests/public-safety.test.js",
        "default prepublish safety fails on an untracked allowlisted Runtime secret",
      ],
      [
        "tests/public-safety.test.js",
        "package projection does not scan ignored private documentation",
      ],
    ],
  ],
  [
    "SEC-API-REFERENCE",
    [
      [
        "tests/api-reference-store.test.js",
        "setup reads a read-only package and atomically publishes private material",
      ],
      [
        "tests/api-reference-store.test.js",
        "failed provenance update leaves the previous known-good material readable",
      ],
      [
        "tests/api-reference-store.test.js",
        "concurrent setup processes publish one complete material without temporary residue",
      ],
      [
        "tests/api-reference-store.test.js",
        "private state rejects links and unexpected entries before lookup",
      ],
      [
        "tests/capability-catalog.test.js",
        "API reference plans expose only private-state effects and stable material provenance",
      ],
      [
        "tests/audit-trail.test.js",
        "Audit Trail retains only a safe API material version",
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
        "tests/package-artifact.test.js",
        "unexpected tar paths fail without becoming source-tree reads",
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
