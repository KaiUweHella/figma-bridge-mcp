// Deterministic orchestration for the maintainer-only Runtime Soak.
//
// Private Figma Target Context values stay inside the injected Adapter. The
// returned report is a closed projection containing target aliases, bounded
// latency facts and structured recovery outcomes only.
import { randomUUID } from "node:crypto";
import { retrySafeRead } from "../../engine/src/lib/safe-read-retry.js";

export const RUNTIME_SOAK_REPORT_SCHEMA = "figma-bridge/runtime-soak-report/v1";
export const RUNTIME_SOAK_PLUGIN_DATA = Object.freeze({
  run: "figma-bridge:runtime-soak-run",
  marker: "figma-bridge:runtime-soak-marker",
});

const SAFE_TOKEN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const REQUIRED_ADAPTERS = Object.freeze([
  "preflight",
  "writeMarker",
  "readMarker",
  "reloadPlugin",
  "waitUntilReady",
  "editorSleepWake",
  "expireDaemon",
  "recoverDaemon",
  "cleanup",
  "countRunMarkers",
]);

function safeToken(value, fallback = "unknown") {
  const normalized = String(value || "").toLowerCase();
  return SAFE_TOKEN.test(normalized) ? normalized : fallback;
}

function roundMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(Math.min(86_400_000, Math.max(0, numeric)) * 100) / 100;
}

function boundedCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

function safeTimestamp(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : "1970-01-01T00:00:00.000Z";
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return roundMs(
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
  );
}

function latencySummary(values) {
  return Object.freeze({
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: roundMs(values.length ? Math.max(...values) : 0),
  });
}

/** Project an error without retaining its message, target, argv or payload. */
export function runtimeSoakErrorFacts(error) {
  const status =
    Number.isInteger(error?.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? error.status
      : null;
  return Object.freeze({
    kind: safeToken(error?.kind),
    phase: safeToken(error?.phase),
    outcome: safeToken(error?.outcome),
    ...(status === null ? {} : { status }),
  });
}

function validateInputs(targets, cycles, runId, adapters) {
  if (!Array.isArray(targets) || targets.length !== 2) {
    throw new TypeError("Runtime Soak requires exactly two explicit targets");
  }
  if (targets[0]?.alias !== "A" || targets[1]?.alias !== "B") {
    throw new TypeError("Runtime Soak target aliases must be A and B");
  }
  if (
    !targets.every(
      (target) =>
        typeof target.key === "string" &&
        target.key.length > 0 &&
        target.key.length <= 128
    )
  ) {
    throw new TypeError("Runtime Soak requires two resolved target keys");
  }
  if (targets[0].key === targets[1].key) {
    throw new TypeError("Runtime Soak targets must refer to different files");
  }
  if (!Number.isInteger(cycles) || cycles < 2 || cycles > 1000) {
    throw new TypeError(
      "Runtime Soak cycles must be an integer from 2 to 1000"
    );
  }
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) {
    throw new TypeError(
      "Runtime Soak run id must be a bounded opaque identifier"
    );
  }
  for (const name of REQUIRED_ADAPTERS) {
    if (typeof adapters?.[name] !== "function") {
      throw new TypeError(`Runtime Soak Adapter requires ${name}()`);
    }
  }
}

function marker(runId, target, purpose) {
  return Object.freeze({
    runId,
    token: `${runId}:${target.alias}:${purpose}`,
    label: `Figma Bridge Soak ${runId} ${target.alias} ${purpose}`,
    purpose,
  });
}

function markerMatches(value, expected) {
  return value?.count === 1 && value?.marker === expected.token;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timed(operation, now) {
  const started = now();
  try {
    return {
      ok: true,
      value: await operation(),
      latencyMs: roundMs(now() - started),
    };
  } catch (error) {
    return { ok: false, error, latencyMs: roundMs(now() - started) };
  }
}

function delayedReload(adapters, target, delayMs) {
  return (async () => {
    await delay(delayMs);
    return adapters.reloadPlugin(target);
  })();
}

async function recoveringRead({
  adapters,
  target,
  expected,
  waitUntilReady,
  disrupt = false,
  eventDelayMs,
  holdMs,
  now,
}) {
  let attempts = 0;
  let firstFailure = null;
  let disruption = null;
  const result = await timed(async () => {
    const value = await retrySafeRead(
      async (attempt) => {
        attempts++;
        if (disrupt && attempt === 0)
          disruption = delayedReload(adapters, target, eventDelayMs);
        try {
          return await adapters.readMarker(target, expected, {
            holdMs: disrupt && attempt === 0 ? holdMs : 0,
          });
        } catch (error) {
          if (!firstFailure) firstFailure = runtimeSoakErrorFacts(error);
          throw error;
        }
      },
      { waitUntilReady }
    );
    return value;
  }, now);
  if (disruption) await disruption.catch(() => {});
  return { ...result, attempts, firstFailure };
}

/**
 * Run the bounded Runtime Soak through an injected live or simulated Adapter.
 * The function returns a report even after a failed phase so cleanup evidence
 * is never lost.
 */
export async function runRuntimeSoak({
  targets,
  adapters,
  cycles = 50,
  runId = randomUUID(),
  eventDelayMs = 150,
  holdMs = 1200,
  idleMs = 1500,
  skipEditorSleepWake = false,
  now = () => performance.now(),
  timestamp = () => new Date().toISOString(),
} = {}) {
  validateInputs(targets, cycles, runId, adapters);
  targets = Object.freeze(
    targets.map((target) =>
      Object.freeze({ alias: target.alias, key: target.key })
    )
  );
  if (
    !Number.isFinite(eventDelayMs) ||
    eventDelayMs < 25 ||
    eventDelayMs > 5000
  ) {
    throw new TypeError("Runtime Soak event delay must be from 25 to 5000 ms");
  }
  if (!Number.isFinite(holdMs) || holdMs <= eventDelayMs || holdMs > 15_000) {
    throw new TypeError(
      "Runtime Soak hold must exceed the event delay and stay at or below 15000 ms"
    );
  }
  if (!Number.isFinite(idleMs) || idleMs < 1000 || idleMs > 2000) {
    throw new TypeError(
      "Runtime Soak idle timeout must be from 1000 to 2000 ms"
    );
  }

  const startedAt = safeTimestamp(timestamp());
  const events = [];
  const recoveries = [];
  const failures = [];
  const alternatingLatencies = [];
  const residues = { A: null, B: null };
  const baseline = new Map(
    targets.map((target) => [target.alias, marker(runId, target, "baseline")])
  );
  const addFailure = (code, event, target, error = null) => {
    if (failures.length >= 20) return;
    failures.push(
      Object.freeze({
        code: safeToken(code, "soak-failure"),
        event: safeToken(event, "runtime-soak"),
        target: target?.alias || "none",
        ...(error ? { error: runtimeSoakErrorFacts(error) } : {}),
      })
    );
  };
  const addEvent = (event, target, outcome, latencyMs) => {
    events.push(
      Object.freeze({
        event: safeToken(event),
        target: target?.alias || "none",
        outcome: safeToken(outcome),
        latencyMs: roundMs(latencyMs),
      })
    );
  };

  let manualAcknowledged = false;
  let alternatingMismatches = 0;
  let writeDisconnect = Object.freeze({
    attempts: 0,
    outcome: "not-run",
    executionOutcome: "unknown",
    residue: null,
    duplicateMutation: null,
  });

  try {
    const preflight = await timed(() => adapters.preflight(targets), now);
    addEvent(
      "preflight",
      null,
      preflight.ok ? "passed" : "failed",
      preflight.latencyMs
    );
    if (!preflight.ok) throw preflight.error;

    for (const target of targets) {
      const expected = baseline.get(target.alias);
      const created = await timed(
        () => adapters.writeMarker(target, expected, { holdMs: 0 }),
        now
      );
      addEvent(
        "baseline-write",
        target,
        created.ok ? "passed" : "failed",
        created.latencyMs
      );
      if (!created.ok) throw created.error;
      const read = await timed(
        () => adapters.readMarker(target, expected, { holdMs: 0 }),
        now
      );
      addEvent(
        "baseline-read",
        target,
        read.ok && markerMatches(read.value, expected) ? "passed" : "failed",
        read.latencyMs
      );
      if (!read.ok) throw read.error;
      if (!markerMatches(read.value, expected))
        throw Object.assign(new Error("marker mismatch"), {
          kind: "target-mismatch",
        });
    }

    for (let index = 0; index < cycles; index++) {
      const target = targets[index % targets.length];
      const expected = baseline.get(target.alias);
      const read = await timed(
        () => adapters.readMarker(target, expected, { holdMs: 0 }),
        now
      );
      alternatingLatencies.push(read.latencyMs);
      if (!read.ok || !markerMatches(read.value, expected)) {
        alternatingMismatches++;
        addFailure("target-mismatch", "alternating-read", target, read.error);
        break;
      }
    }
    addEvent(
      "alternating-read",
      null,
      alternatingMismatches === 0 ? "passed" : "failed",
      alternatingLatencies.reduce((sum, value) => sum + value, 0)
    );
    if (alternatingMismatches > 0) {
      throw Object.assign(new Error("target mismatch"), {
        kind: "target-mismatch",
        phase: "target-resolution",
        outcome: "not-dispatched",
      });
    }

    for (const target of targets) {
      const started = now();
      const reloaded = await adapters.reloadPlugin(target);
      await adapters.waitUntilReady([target]);
      const read = await recoveringRead({
        adapters,
        target,
        expected: baseline.get(target.alias),
        waitUntilReady: () => adapters.waitUntilReady([target]),
        eventDelayMs,
        holdMs,
        now,
      });
      const passed =
        reloaded !== false &&
        read.ok &&
        markerMatches(read.value, baseline.get(target.alias));
      recoveries.push(
        Object.freeze({
          event: "plugin-reload",
          target: target.alias,
          outcome: passed ? "recovered" : "failed",
          attempts: read.attempts,
          latencyMs: roundMs(now() - started),
        })
      );
      if (!passed)
        addFailure("plugin-reload", "plugin-reload", target, read.error);
    }

    if (skipEditorSleepWake) {
      await adapters.editorSleepWake({ skipped: true });
    } else {
      manualAcknowledged =
        (await adapters.editorSleepWake({ skipped: false })) !== false;
      for (const target of targets) {
        const read = await recoveringRead({
          adapters,
          target,
          expected: baseline.get(target.alias),
          waitUntilReady: () => adapters.waitUntilReady([target]),
          eventDelayMs,
          holdMs,
          now,
        });
        if (
          !read.ok ||
          !markerMatches(read.value, baseline.get(target.alias))
        ) {
          addFailure("editor-wake", "editor-sleep-wake", target, read.error);
        }
      }
    }
    addEvent(
      "editor-sleep-wake",
      null,
      skipEditorSleepWake
        ? "skipped"
        : manualAcknowledged
          ? "passed"
          : "failed",
      0
    );

    const idleStarted = now();
    const expired = await adapters.expireDaemon({ idleMs, targets });
    const idleRead = await recoveringRead({
      adapters,
      target: targets[0],
      expected: baseline.get("A"),
      waitUntilReady: async () => {
        await adapters.recoverDaemon();
        return adapters.waitUntilReady(targets);
      },
      eventDelayMs,
      holdMs,
      now,
    });
    const idlePassed =
      expired !== false &&
      idleRead.ok &&
      idleRead.attempts === 2 &&
      markerMatches(idleRead.value, baseline.get("A"));
    recoveries.push(
      Object.freeze({
        event: "daemon-idle-restart",
        target: "A",
        outcome: idlePassed ? "recovered" : "failed",
        attempts: idleRead.attempts,
        latencyMs: roundMs(now() - idleStarted),
        ...(idleRead.firstFailure
          ? { firstFailure: idleRead.firstFailure }
          : {}),
      })
    );
    if (!idlePassed)
      addFailure(
        "daemon-idle-restart",
        "daemon-idle-restart",
        targets[0],
        idleRead.error
      );

    const readDisconnect = await recoveringRead({
      adapters,
      target: targets[0],
      expected: baseline.get("A"),
      waitUntilReady: () => adapters.waitUntilReady([targets[0]]),
      disrupt: true,
      eventDelayMs,
      holdMs,
      now,
    });
    const readDisconnectPassed =
      readDisconnect.ok &&
      readDisconnect.attempts === 2 &&
      readDisconnect.firstFailure?.outcome === "unknown-after-dispatch" &&
      markerMatches(readDisconnect.value, baseline.get("A"));
    recoveries.push(
      Object.freeze({
        event: "read-disconnect",
        target: "A",
        outcome: readDisconnectPassed ? "recovered" : "failed",
        attempts: readDisconnect.attempts,
        latencyMs: readDisconnect.latencyMs,
        ...(readDisconnect.firstFailure
          ? { firstFailure: readDisconnect.firstFailure }
          : {}),
      })
    );
    if (!readDisconnectPassed)
      addFailure(
        "read-disconnect",
        "read-disconnect",
        targets[0],
        readDisconnect.error
      );

    const writeTarget = targets[1];
    const uncertainMarker = marker(runId, writeTarget, "write-disconnect");
    let writeAttempts = 0;
    let writeError = null;
    const writeStarted = now();
    const disruption = delayedReload(adapters, writeTarget, eventDelayMs);
    try {
      writeAttempts++;
      await adapters.writeMarker(writeTarget, uncertainMarker, { holdMs });
    } catch (error) {
      writeError = error;
    }
    await disruption.catch(() => {});
    await adapters.waitUntilReady([writeTarget]);
    const residueRead = await recoveringRead({
      adapters,
      target: writeTarget,
      expected: uncertainMarker,
      waitUntilReady: () => adapters.waitUntilReady([writeTarget]),
      eventDelayMs,
      holdMs,
      now,
    });
    const residue = residueRead.ok
      ? boundedCount(residueRead.value?.count)
      : null;
    const executionOutcome = runtimeSoakErrorFacts(writeError).outcome;
    const writePassed =
      writeAttempts === 1 &&
      executionOutcome === "unknown-after-dispatch" &&
      residue === 1 &&
      markerMatches(residueRead.value, uncertainMarker);
    writeDisconnect = Object.freeze({
      attempts: writeAttempts,
      outcome: writePassed ? "passed" : "failed",
      executionOutcome,
      residue,
      duplicateMutation: residue === null ? null : residue > 1,
      latencyMs: roundMs(now() - writeStarted),
    });
    if (!writePassed)
      addFailure(
        "write-disconnect",
        "write-disconnect",
        writeTarget,
        writeError || residueRead.error
      );
  } catch (error) {
    addFailure("phase-aborted", "runtime-soak", null, error);
  } finally {
    for (const target of targets) {
      try {
        await adapters.cleanup(target, runId);
        const remaining = await retrySafeRead(
          () => adapters.countRunMarkers(target, runId),
          { waitUntilReady: () => adapters.waitUntilReady([target]) }
        );
        residues[target.alias] = boundedCount(remaining);
        if (residues[target.alias] !== 0)
          addFailure("cleanup-residue", "cleanup", target);
      } catch (error) {
        residues[target.alias] = null;
        addFailure("cleanup-failed", "cleanup", target, error);
      }
    }
  }

  const cleanupTargets = targets
    .filter((target) => residues[target.alias] !== 0)
    .map((target) => target.alias);
  const incomplete = skipEditorSleepWake || !manualAcknowledged;
  const status = failures.length
    ? "failed"
    : incomplete
      ? "incomplete"
      : "passed";
  return Object.freeze({
    schema: RUNTIME_SOAK_REPORT_SCHEMA,
    status,
    runId,
    startedAt,
    finishedAt: safeTimestamp(timestamp()),
    configuration: Object.freeze({
      targets: 2,
      cycles,
      editorSleepWake: skipEditorSleepWake
        ? "skipped"
        : manualAcknowledged
          ? "acknowledged"
          : "missing",
    }),
    latency: Object.freeze({
      alternatingReads: latencySummary(alternatingLatencies),
    }),
    events: Object.freeze(events),
    recoveries: Object.freeze(recoveries),
    safety: Object.freeze({
      targetIsolation: Object.freeze({
        cyclesCompleted: alternatingLatencies.length,
        mismatches: alternatingMismatches,
      }),
      writeDisconnect,
    }),
    residue: Object.freeze({ ...residues }),
    failures: Object.freeze(failures),
    manualCleanup: Object.freeze({
      required: cleanupTargets.length > 0,
      targets: Object.freeze(cleanupTargets),
      instruction: cleanupTargets.length
        ? 'In each listed target, remove only layers whose name starts with "Figma Bridge Soak <runId>".'
        : "No manual cleanup is required.",
    }),
  });
}
