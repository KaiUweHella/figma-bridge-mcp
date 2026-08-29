import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_SOAK_REPORT_SCHEMA,
  runRuntimeSoak,
  runtimeSoakErrorFacts,
} from "../scripts/lib/runtime-soak-harness.js";
import {
  createLiveAdapters,
  waitForDaemonStateRemoval,
  writeRuntimeSoakReport,
} from "../scripts/runtime-soak.js";
import { assertPosixMode } from "../test-support/posix-permissions.js";

function transient(kind = "plugin-unavailable") {
  return Object.assign(
    new Error("PRIVATE_FILE_KEY and private document name"),
    {
      kind,
      phase: "plugin-execution",
      outcome: "unknown-after-dispatch",
      status: 503,
    }
  );
}

function simulatedAdapters({
  crossTarget = false,
  crossTargetAfterBaseline = false,
  cleanupFailure = null,
  privateResidue = false,
} = {}) {
  const state = new Map([
    ["PRIVATE_FILE_ALPHA", []],
    ["PRIVATE_FILE_BETA", []],
  ]);
  const calls = {
    writes: new Map(),
    reads: new Map(),
    reloads: [],
    recovered: 0,
    expired: false,
  };
  const list = (target) =>
    state.get(
      crossTarget && target.alias === "B" ? "PRIVATE_FILE_ALPHA" : target.key
    );
  return {
    calls,
    adapters: {
      async preflight(targets) {
        assert.deepEqual(
          targets.map(({ alias }) => alias),
          ["A", "B"]
        );
      },
      async writeMarker(target, marker, { holdMs }) {
        calls.writes.set(
          marker.purpose,
          (calls.writes.get(marker.purpose) || 0) + 1
        );
        state.get(target.key).push({ ...marker });
        if (holdMs > 0) throw transient();
        return { created: true };
      },
      async readMarker(target, marker, { holdMs }) {
        calls.reads.set(
          marker.purpose,
          (calls.reads.get(marker.purpose) || 0) + 1
        );
        if (calls.expired) throw transient("unavailable");
        if (holdMs > 0) throw transient();
        if (privateResidue && marker.purpose === "write-disconnect") {
          return { count: "PRIVATE_RESIDUE_VALUE", marker: marker.token };
        }
        const delayedCrossTarget =
          crossTargetAfterBaseline &&
          marker.purpose === "baseline" &&
          calls.reads.get("baseline") > 2 &&
          target.alias === "B";
        const values = delayedCrossTarget
          ? state.get("PRIVATE_FILE_ALPHA")
          : list(target);
        const matches = values.filter((value) => value.token === marker.token);
        return { count: matches.length, marker: matches[0]?.token || null };
      },
      async reloadPlugin(target) {
        calls.reloads.push(target.alias);
        return true;
      },
      async waitUntilReady() {
        return true;
      },
      async editorSleepWake({ skipped }) {
        return skipped ? false : true;
      },
      async expireDaemon() {
        calls.expired = true;
        return true;
      },
      async recoverDaemon() {
        calls.expired = false;
        calls.recovered++;
      },
      async cleanup(target, runId) {
        if (cleanupFailure === target.alias) throw transient();
        state.set(
          target.key,
          state.get(target.key).filter((value) => value.runId !== runId)
        );
      },
      async countRunMarkers(target, runId) {
        return state.get(target.key).filter((value) => value.runId === runId)
          .length;
      },
    },
  };
}

const targets = Object.freeze([
  Object.freeze({ alias: "A", key: "PRIVATE_FILE_ALPHA" }),
  Object.freeze({ alias: "B", key: "PRIVATE_FILE_BETA" }),
]);

test("Runtime Soak proves alternating identity, safe read recovery, one-shot writes and cleanup", async () => {
  const simulated = simulatedAdapters();
  const report = await runRuntimeSoak({
    targets,
    adapters: simulated.adapters,
    cycles: 8,
    runId: "test-run-1",
    eventDelayMs: 25,
    holdMs: 50,
    idleMs: 1000,
  });

  assert.equal(report.schema, RUNTIME_SOAK_REPORT_SCHEMA);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.safety.targetIsolation, {
    cyclesCompleted: 8,
    mismatches: 0,
  });
  assert.deepEqual(report.safety.writeDisconnect, {
    attempts: 1,
    outcome: "passed",
    executionOutcome: "unknown-after-dispatch",
    residue: 1,
    duplicateMutation: false,
    latencyMs: report.safety.writeDisconnect.latencyMs,
  });
  assert.equal(
    simulated.calls.writes.get("write-disconnect"),
    1,
    "uncertain writes must never repeat"
  );
  assert.equal(
    report.recoveries.find(({ event }) => event === "read-disconnect").attempts,
    2
  );
  assert.equal(
    report.recoveries.find(({ event }) => event === "daemon-idle-restart")
      .attempts,
    2
  );
  assert.equal(simulated.calls.recovered, 1);
  assert.deepEqual(report.residue, { A: 0, B: 0 });
  assert.equal(report.manualCleanup.required, false);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(
    serialized,
    /PRIVATE_FILE|private document|Figma Bridge Soak/
  );
});

test("Runtime Soak fails a cross-file route and still removes its disposable markers", async () => {
  const simulated = simulatedAdapters({ crossTarget: true });
  const report = await runRuntimeSoak({
    targets,
    adapters: simulated.adapters,
    cycles: 6,
    runId: "test-run-2",
    eventDelayMs: 25,
    holdMs: 50,
    idleMs: 1000,
  });

  assert.equal(report.status, "failed");
  assert.ok(report.failures.some(({ code }) => code === "phase-aborted"));
  assert.deepEqual(report.residue, { A: 0, B: 0 });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_FILE/);
});

test("Runtime Soak stops write phases after a sustained-route identity mismatch", async () => {
  const simulated = simulatedAdapters({ crossTargetAfterBaseline: true });
  const report = await runRuntimeSoak({
    targets,
    adapters: simulated.adapters,
    cycles: 6,
    runId: "test-run-routing",
    eventDelayMs: 25,
    holdMs: 50,
    idleMs: 1000,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.safety.targetIsolation.mismatches, 1);
  assert.equal(
    simulated.calls.writes.has("write-disconnect"),
    false,
    "no later write may run after target identity is uncertain"
  );
  assert.deepEqual(report.residue, { A: 0, B: 0 });
});

test("Runtime Soak records incomplete manual acceptance and actionable residue without identities", async () => {
  const simulated = simulatedAdapters({ cleanupFailure: "B" });
  const report = await runRuntimeSoak({
    targets,
    adapters: simulated.adapters,
    cycles: 4,
    runId: "test-run-3",
    eventDelayMs: 25,
    holdMs: 50,
    idleMs: 1000,
    skipEditorSleepWake: true,
  });

  assert.equal(
    report.status,
    "failed",
    "cleanup residue outranks the incomplete manual checkpoint"
  );
  assert.equal(report.configuration.editorSleepWake, "skipped");
  assert.equal(
    report.residue.B,
    null,
    "a failed cleanup cannot claim a known residue count"
  );
  assert.deepEqual(report.manualCleanup.targets, ["B"]);
  assert.match(report.manualCleanup.instruction, /Figma Bridge Soak <runId>/);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_FILE|private document/);
});

test("Runtime Soak rejects identity-bearing Adapter values at the report seam", async () => {
  const simulated = simulatedAdapters({ privateResidue: true });
  const report = await runRuntimeSoak({
    targets,
    adapters: simulated.adapters,
    cycles: 4,
    runId: "test-run-4",
    eventDelayMs: 25,
    holdMs: 50,
    idleMs: 1000,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.safety.writeDisconnect.residue, null);
  assert.doesNotMatch(
    JSON.stringify(report),
    /PRIVATE_RESIDUE_VALUE|PRIVATE_FILE/
  );
});

test("Runtime Soak error facts retain only bounded structured fields", () => {
  const error = transient();
  error.kind = "INVALID PRIVATE KIND";
  error.phase = "plugin-execution";
  error.outcome = "unknown-after-dispatch";
  assert.deepEqual(runtimeSoakErrorFacts(error), {
    kind: "unknown",
    phase: "plugin-execution",
    outcome: "unknown-after-dispatch",
    status: 503,
  });
});

test("Runtime Soak keeps the temporary daemon idle window below Plugin keepalive", async () => {
  const simulated = simulatedAdapters();
  await assert.rejects(
    () =>
      runRuntimeSoak({
        targets,
        adapters: simulated.adapters,
        cycles: 4,
        runId: "test-run-5",
        eventDelayMs: 25,
        holdMs: 50,
        idleMs: 2001,
      }),
    /idle timeout must be from 1000 to 2000 ms/
  );
});

test("Runtime Soak observes daemon idle exit without health activity", async () => {
  let clock = 0;
  let probes = 0;
  const removed = await waitForDaemonStateRemoval({
    maxWaitMs: 1000,
    statePath: "PRIVATE_DAEMON_PORT_STATE",
    existsFile() {
      probes++;
      return probes < 4;
    },
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    pollMs: 100,
  });

  assert.equal(removed, true);
  assert.equal(probes, 4);
  assert.equal(clock, 300);
});

test("Runtime Soak reports are new private workspace files", () => {
  const root = mkdtempSync(join(tmpdir(), "figma-bridge-soak-report-"));
  const reportPath = join(root, "docs-local", "evidence", "runtime-soak.json");
  const report = { schema: RUNTIME_SOAK_REPORT_SCHEMA, status: "passed" };
  writeRuntimeSoakReport(report, reportPath, { root });
  assertPosixMode(reportPath, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), report);
  assert.throws(
    () => writeRuntimeSoakReport(report, reportPath, { root }),
    /output already exists/
  );
  assert.throws(
    () =>
      writeRuntimeSoakReport(report, join(root, "public-report.json"), {
        root,
      }),
    /outside allowed roots/
  );
});

test("live Runtime Soak binds every eval to Figma Design", async () => {
  const calls = [];
  const client = {
    evaluate(code, options) {
      calls.push({ code, options });
      return Promise.resolve(null);
    },
  };
  const target = Object.freeze({ alias: "A", key: "PRIVATE_FILE_ALPHA" });
  const adapters = createLiveAdapters(client, {
    targets: [target],
    idleMs: 1000,
    holdMs: 50,
  });
  const marker = Object.freeze({
    runId: "test-run-editor-binding",
    token: "test-marker-token",
    label: "test marker",
  });

  await adapters.writeMarker(target, marker, { holdMs: 0 });
  await adapters.readMarker(target, marker, { holdMs: 0 });
  await adapters.cleanup(target, marker.runId);
  await adapters.countRunMarkers(target, marker.runId);

  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.deepEqual(call.options, {
      fileKey: target.key,
      timeoutMs: 10_000,
      expectedEditor: "figma",
    });
  }
  for (const call of calls.slice(1)) {
    const load = call.code.indexOf("await figma.loadAllPagesAsync()");
    const traversal = call.code.indexOf("figma.root.findAll");
    assert.ok(load >= 0 && traversal > load);
  }
});

test("live Runtime Soak Adapter stays on the shared Daemon Client Interface", () => {
  const source = readFileSync(
    new URL("../scripts/runtime-soak.js", import.meta.url),
    "utf8"
  );
  assert.match(source, /createDaemonClient/);
  assert.doesNotMatch(
    source,
    /\bfetch\s*\(|https?\.request\s*\(|new WebSocket\s*\(/
  );
});
