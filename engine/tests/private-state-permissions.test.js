import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PRIVATE_STATE_MAX_ENTRIES,
  hardenPrivateTree,
  privateStateOwns,
  verifyPrivateTree,
} from "../src/lib/private-state-permissions.js";
import { assertPosixMode } from "../../test-support/posix-permissions.js";

function fixture(t, name = ".figma-bridge-mcp") {
  const parent = mkdtempSync(path.join(tmpdir(), "private-state-policy-"));
  const root = path.join(parent, name);
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return realpathSync.native(root);
}

test("private-state ownership contains only exact descendants", () => {
  const root = path.resolve("/private-state/.figma-bridge-mcp");
  assert.equal(
    privateStateOwns(root, [
      path.join(root, "plugin-key"),
      path.join(root, "snapshots", "one.json.gz"),
    ]),
    true
  );
  assert.equal(
    privateStateOwns(root, [path.resolve("/private-state/customer-output")]),
    false
  );
  assert.equal(privateStateOwns(root, ["relative-token"]), false);
});

test("Windows ACL Adapter uses a bounded argument array and returns direct evidence", (t) => {
  const root = fixture(t);
  const calls = [];
  const report = hardenPrivateTree(root, {
    kind: "bridge-state",
    platform: "win32",
    runWindowsAcl(command, argv, options) {
      calls.push({ command, argv, options });
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          version: 1,
          private: true,
          count: 1,
          rootProtected: true,
          principals: ["administrators", "current-user", "local-system"],
          violations: [],
        }),
      };
    },
  });
  assert.deepEqual(report, {
    version: 1,
    private: true,
    platform: "win32",
    count: 1,
    rootProtected: true,
    principals: ["administrators", "current-user", "local-system"],
    violations: [],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "pwsh.exe");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 10_000);
  assert.equal(calls[0].options.maxBuffer, 64 * 1024);
  assert.deepEqual(calls[0].argv.slice(-6), [
    "-Mode",
    "repair",
    "-Path",
    root,
    "-MaxEntries",
    String(PRIVATE_STATE_MAX_ENTRIES),
  ]);
  assert.ok(calls[0].argv.includes("-NonInteractive"));
  assert.ok(calls[0].argv.includes("-NoProfile"));
});

test("Windows ACL Adapter falls back only when PowerShell 7 is unavailable", (t) => {
  const root = fixture(t);
  const calls = [];
  const report = hardenPrivateTree(root, {
    kind: "bridge-state",
    platform: "win32",
    runWindowsAcl(command) {
      calls.push(command);
      if (command === "pwsh.exe") {
        return {
          status: null,
          signal: null,
          stdout: "",
          error: Object.assign(new Error("missing"), { code: "ENOENT" }),
        };
      }
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          version: 1,
          private: true,
          count: 1,
          rootProtected: true,
          principals: ["administrators", "current-user", "local-system"],
          violations: [],
        }),
      };
    },
  });
  assert.equal(report.private, true);
  assert.deepEqual(calls, ["pwsh.exe", "powershell.exe"]);
});

test("Windows ACL Adapter never retries a possibly dispatched failure", (t) => {
  const root = fixture(t);
  const calls = [];
  assert.throws(
    () =>
      hardenPrivateTree(root, {
        kind: "bridge-state",
        platform: "win32",
        runWindowsAcl(command) {
          calls.push(command);
          return {
            status: null,
            signal: "SIGTERM",
            stdout: "",
            error: Object.assign(new Error("timed out"), {
              code: "ETIMEDOUT",
            }),
          };
        },
      }),
    /could not secure its private local state/
  );
  assert.deepEqual(calls, ["pwsh.exe"]);
});

test("Windows ACL failures retain bounded recovery guidance without the private path", (t) => {
  const root = fixture(t);
  assert.throws(
    () =>
      verifyPrivateTree(root, {
        platform: "win32",
        runWindowsAcl: () => ({
          status: 1,
          signal: null,
          stdout: "",
          stderr: `sensitive path: ${root}`,
        }),
      }),
    (error) => {
      assert.equal(error.code, "PRIVATE_STATE_PERMISSIONS");
      assert.match(error.message, /restart Figma Bridge/);
      assert.doesNotMatch(
        error.message,
        new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      );
      assert.doesNotMatch(error.message, /sensitive path/);
      return true;
    }
  );
});

test("private-state policy rejects broad roots and unowned artifact names", (t) => {
  const root = fixture(t, "ordinary-output");
  assert.throws(
    () => hardenPrivateTree(path.dirname(root), { kind: "bridge-state" }),
    /could not secure its private local state/
  );
  assert.throws(
    () => hardenPrivateTree(root, { kind: "verification-artifact" }),
    /could not secure its private local state/
  );
});

test(
  "POSIX privacy repair is recursive, idempotent and directly verifiable",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const root = fixture(t);
    const nested = path.join(root, "snapshots");
    const token = path.join(root, ".daemon-token");
    const snapshot = path.join(nested, "capture.json.gz");
    mkdirSync(nested, { mode: 0o777 });
    writeFileSync(token, "token", { mode: 0o666 });
    writeFileSync(snapshot, "snapshot", { mode: 0o666 });
    chmodSync(root, 0o777);
    chmodSync(nested, 0o777);
    chmodSync(token, 0o666);
    chmodSync(snapshot, 0o666);

    const first = hardenPrivateTree(root);
    const second = hardenPrivateTree(root);
    assert.equal(first.count, 4);
    assert.deepEqual(second, first);
    assertPosixMode(root, 0o700);
    assertPosixMode(nested, 0o700);
    assertPosixMode(token, 0o600);
    assertPosixMode(snapshot, 0o600);
    assert.equal(verifyPrivateTree(root).rootProtected, true);

    chmodSync(token, 0o644);
    assert.throws(
      () => verifyPrivateTree(root),
      /could not secure its private local state/
    );
    hardenPrivateTree(root);
    assertPosixMode(token, 0o600);
  }
);

test(
  "POSIX privacy preflight rejects links before changing the tree",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const root = fixture(t);
    const outside = path.join(path.dirname(root), "outside.txt");
    writeFileSync(outside, "outside", { mode: 0o644 });
    chmodSync(root, 0o755);
    symlinkSync(outside, path.join(root, "linked-token"));
    assert.throws(
      () => hardenPrivateTree(root),
      /could not secure its private local state/
    );
    assertPosixMode(root, 0o755);
    assertPosixMode(outside, 0o644);
  }
);

test(
  "Windows directly rejects a permissive DACL and repairs it idempotently",
  {
    skip: process.platform !== "win32",
  },
  (t) => {
    const root = fixture(t);
    const snapshots = path.join(root, "snapshots");
    const references = path.join(root, "api-reference");
    const verification = path.join(root, "verification-artifacts");
    mkdirSync(snapshots);
    mkdirSync(references);
    mkdirSync(verification);
    for (const file of [
      path.join(root, "plugin-key"),
      path.join(root, ".daemon-token"),
      path.join(root, "rest-token"),
      path.join(root, "audit.log"),
      path.join(snapshots, "capture.json.gz"),
      path.join(references, "material.json"),
      path.join(verification, "capture.png"),
    ])
      writeFileSync(file, "fixture");

    const repaired = hardenPrivateTree(root);
    assert.equal(repaired.platform, "win32");
    assert.equal(repaired.count, 11);
    assert.deepEqual(verifyPrivateTree(root), repaired);
    assert.deepEqual(hardenPrivateTree(root), repaired);

    const token = path.join(root, ".daemon-token");
    const grant = spawnSync("icacls.exe", [token, "/grant", "*S-1-1-0:R"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(grant.status, 0, "permissive fixture ACL must be created");
    assert.throws(
      () => verifyPrivateTree(root),
      /could not secure its private local state/
    );
    assert.deepEqual(hardenPrivateTree(root), repaired);
    assert.deepEqual(verifyPrivateTree(root), repaired);
  }
);
