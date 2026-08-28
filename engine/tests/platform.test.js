import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPortPids,
  PlatformListenerInspectionError,
  sleepAfterStop,
} from "../src/platform.js";

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function result(stdout, status = 0) {
  return { stdout, stderr: "", status, signal: null, error: undefined };
}

test("Unix listener inspection uses bounded lsof argv without a shell", () => {
  const calls = [];
  const pids = getPortPids(3456, {
    platform: "darwin",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return result("42\n77\n42\n");
    },
  });

  assert.deepEqual(pids, [42, 77]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "lsof");
  assert.deepEqual(calls[0].args, [
    "-nP",
    "-iTCP:3456",
    "-sTCP:LISTEN",
    "-t",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeout > 0);
  assert.ok(calls[0].options.maxBuffer > 0);
});

test("Unix listener inspection treats lsof no-match as an empty listener set", () => {
  assert.deepEqual(
    getPortPids(3456, {
      platform: "linux",
      spawnSyncImpl: () => result("", 1),
    }),
    []
  );
  assert.throws(
    () =>
      getPortPids(3456, {
        platform: "linux",
        spawnSyncImpl: () => ({
          ...result("", 1),
          stderr: "lsof: permission denied",
        }),
      }),
    /lsof exited with status 1/u
  );
});

test("Windows listener inspection parses exact LISTEN sockets and ignores clients", () => {
  const calls = [];
  const stdout = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:3456         0.0.0.0:0              LISTENING       900",
    "  TCP    [::]:3456            [::]:0                 LISTENING       900",
    "  TCP    127.0.0.1:34560      0.0.0.0:0              LISTENING       901",
    "  TCP    127.0.0.1:51000      127.0.0.1:3456         ESTABLISHED     902",
  ].join("\r\n");
  const pids = getPortPids(3456, {
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return result(stdout);
    },
  });

  assert.deepEqual(pids, [900]);
  assert.deepEqual(calls[0].args, ["-ano", "-p", "tcp"]);
  assert.equal(calls[0].options.shell, false);
});

test("listener inspection failures remain actionable and fail closed", () => {
  assert.throws(
    () =>
      getPortPids(3456, {
        platform: "darwin",
        spawnSyncImpl: () => ({
          stdout: "",
          stderr: "",
          status: null,
          signal: "SIGTERM",
          error: Object.assign(new Error("spawnSync lsof ETIMEDOUT"), {
            code: "ETIMEDOUT",
          }),
        }),
      }),
    (error) => {
      assert.ok(error instanceof PlatformListenerInspectionError);
      assert.equal(error.code, "LISTENER_INSPECTION_UNAVAILABLE");
      assert.match(error.message, /timed out after 1500 ms/u);
      assert.match(error.message, /authenticated daemon shutdown/u);
      return true;
    }
  );
  assert.throws(
    () =>
      getPortPids(0, {
        platform: "darwin",
        spawnSyncImpl: () => result(""),
      }),
    /port from 1 to 65535/u
  );
});

test("platform lifecycle source has no destructive port-kill or shell execution", () => {
  const source = readFileSync(
    join(ENGINE_ROOT, "src", "platform.js"),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /\bkillPort\b|\bexecSync\b|\btaskkill\b|\bfindstr\b/u
  );
  assert.doesNotMatch(source, /shell:\s*true/u);
  assert.match(source, /shell:\s*false/u);
});

test("native post-stop wait is bounded and accepts a zero-duration no-op", () => {
  const start = Date.now();
  sleepAfterStop(0);
  assert.ok(Date.now() - start < 100);
});
