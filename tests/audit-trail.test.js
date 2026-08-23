import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_SCHEMA_VERSION,
  createAuditTrail,
} from "../src/audit-trail.js";

function records(file) {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("Audit Trail stores a closed redacted schema with private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "figma-audit-private-"));
  const directory = join(root, "state");
  const auditPath = join(directory, "audit.log");
  const trail = createAuditTrail({ auditPath, manageDirectory: true });
  const secrets = {
    jsx: '<Frame name="Acme confidential launch" />',
    label: "customer requested private hero",
    path: "/workspace/private-project/source.tsx",
    fileKey: "SENSITIVEFIGMAFILEKEY",
    connectionEpoch: "11111111-1111-4111-8111-111111111111",
    body: { message: "private review comment" },
  };

  const handle = trail.begin({
    capability: "render",
    operation: "write",
    effects: { figma: "write", workspace: "read", network: "none", shared: "none" },
    target: { kind: "plugin-file", identity: secrets.fileKey },
    arguments: ["render", secrets.jsx, "--icons", secrets.path],
    label: secrets.label,
    body: secrets.body,
    nodes: ["12:34"],
    outputRoles: ["assets-dir"],
  });
  const status = trail.finish(handle, {
    ok: false,
    code: 1,
    errorKind: "engine-exit",
    dispatchState: "failed",
    connectionEpoch: secrets.connectionEpoch,
  });

  assert.deepEqual(status, { status: "healthy" });
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(auditPath).mode & 0o777, 0o600);

  const content = readFileSync(auditPath, "utf8");
  for (const raw of [
    secrets.jsx,
    secrets.label,
    secrets.path,
    secrets.fileKey,
    secrets.connectionEpoch,
    secrets.body.message,
    "12:34",
  ]) {
    assert.equal(content.includes(raw), false, `must redact ${raw}`);
  }

  const [start, done] = records(auditPath);
  assert.equal(start.schema, AUDIT_SCHEMA_VERSION);
  assert.equal(start.event, "start");
  assert.equal(start.capability, "render");
  assert.equal(start.operation, "write");
  assert.deepEqual(start.effects, { figma: "write", workspace: "read", network: "none", shared: "none" });
  assert.equal(start.target.kind, "plugin-file");
  assert.match(start.target.identity.sha256, /^[a-f0-9]{64}$/);
  assert.equal(start.data.arguments.count, 4);
  assert.equal(start.data.nodeRefs.length, 1);
  assert.deepEqual(start.data.outputRoles, ["assets-dir"]);
  assert.equal(done.event, "done");
  assert.deepEqual(done.outcome, {
    ok: false,
    durationMs: done.outcome.durationMs,
    code: 1,
    errorKind: "engine-exit",
    dispatchState: "failed",
  });
});

test("Audit Trail failure is explicit and non-blocking, then clears after recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "figma-audit-degraded-"));
  const blocker = join(root, "blocked");
  writeFileSync(blocker, "not a directory");
  const auditPath = join(blocker, "audit.log");
  const trail = createAuditTrail({ auditPath, manageDirectory: true });

  const failed = trail.begin({ capability: "inspect", operation: "read" });
  const degraded = trail.finish(failed, { ok: true });
  assert.equal(degraded.status, "degraded");
  assert.match(degraded.code, /EEXIST|ENOTDIR|AUDIT_WRITE_FAILED/);
  assert.deepEqual(trail.status(), degraded);

  unlinkSync(blocker);
  mkdirSync(blocker, { mode: 0o755 });
  const recovered = trail.begin({ capability: "inspect", operation: "read" });
  assert.deepEqual(trail.finish(recovered, { ok: true }), { status: "healthy" });
  assert.deepEqual(trail.status(), { status: "healthy" });
  assert.equal(statSync(blocker).mode & 0o777, 0o700);
});

test("Audit Trail keeps one bounded private rotation", () => {
  const root = mkdtempSync(join(tmpdir(), "figma-audit-rotation-"));
  const auditPath = join(root, "audit.log");
  const trail = createAuditTrail({ auditPath, rotateBytes: 700 });
  for (let index = 0; index < 4; index++) {
    const handle = trail.begin({
      capability: "render",
      operation: "write",
      arguments: ["render", `payload-${index}`],
    });
    trail.finish(handle, { ok: true });
  }
  assert.equal(existsSync(auditPath), true);
  assert.equal(existsSync(`${auditPath}.1`), true);
  assert.equal(lstatSync(auditPath).isFile(), true);
  assert.equal(lstatSync(`${auditPath}.1`).isFile(), true);
  assert.equal(statSync(auditPath).mode & 0o777, 0o600);
  assert.equal(statSync(`${auditPath}.1`).mode & 0o777, 0o600);

  // Correct deliberately broad pre-existing active and rotated permissions.
  chmodSync(auditPath, 0o666);
  chmodSync(`${auditPath}.1`, 0o666);
  const final = trail.begin({ capability: "inspect", operation: "read" });
  trail.finish(final, { ok: true });
  assert.equal(statSync(auditPath).mode & 0o777, 0o600);
  assert.equal(statSync(`${auditPath}.1`).mode & 0o777, 0o600);
});
