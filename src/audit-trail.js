// Private, closed-schema Audit Trail.
//
// Callers provide semantic capability facts plus values that need a
// non-reversible summary. This module is the only place that serializes audit
// records, so raw argv, JSX, labels, paths, file keys, REST bodies, and error
// messages cannot accidentally become log fields.
import fs from "node:fs";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { AUDIT_LOG_PATH, STATE_DIR } from "./config.js";
import {
  isMutationOutcomeProjection,
  projectMutationOutcome,
} from "./error-projection.js";

export const AUDIT_SCHEMA_VERSION = 6;
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_AUDIT_ENTRY_BYTES = 16 * 1024;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const EFFECT_VALUES = new Set(["none", "read", "write"]);
const DISPATCH_STATES = new Set(["not-dispatched", "completed", "failed", "unknown"]);

function safeToken(value, fallback = "unknown") {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeEffect(value) {
  return EFFECT_VALUES.has(value) ? value : "none";
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

/** Return non-reversible metadata without retaining the source value. */
export function summarizeSensitive(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return Object.freeze({
    bytes: byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  });
}

function summarizeArguments(values) {
  const args = Array.isArray(values) ? values : [];
  return Object.freeze({
    count: args.length,
    ...summarizeSensitive(args),
  });
}

function summarizeReferences(values) {
  if (!Array.isArray(values)) return Object.freeze([]);
  return Object.freeze(values.slice(0, 50).map((value) => summarizeSensitive(value)));
}

function auditFailureCode(error) {
  const code = safeToken(error?.code, "AUDIT_WRITE_FAILED");
  return code === "unknown" ? "AUDIT_WRITE_FAILED" : code;
}

function writeJsonLine(auditPath, entry, { rotateBytes, manageDirectory }) {
  try {
    const directory = path.dirname(auditPath);
    const directoryExisted = fs.existsSync(directory);
    fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (!directoryExisted || manageDirectory) {
      fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
    }

    const rotatedPath = `${auditPath}.1`;
    try {
      const rotated = fs.lstatSync(rotatedPath);
      if (rotated.isSymbolicLink() || !rotated.isFile()) {
        const error = new Error("Rotated audit path is not a regular file");
        error.code = "AUDIT_PATH_UNSAFE";
        throw error;
      }
      fs.chmodSync(rotatedPath, PRIVATE_FILE_MODE);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    try {
      const current = fs.lstatSync(auditPath);
      if (current.isSymbolicLink() || !current.isFile()) {
        const error = new Error("Audit path is not a regular file");
        error.code = "AUDIT_PATH_UNSAFE";
        throw error;
      }
      if (current.size >= rotateBytes) {
        try {
          const rotated = fs.lstatSync(rotatedPath);
          if (rotated.isSymbolicLink() || !rotated.isFile()) {
            const error = new Error("Rotated audit path is not a regular file");
            error.code = "AUDIT_PATH_UNSAFE";
            throw error;
          }
          fs.unlinkSync(rotatedPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        fs.renameSync(auditPath, rotatedPath);
        fs.chmodSync(rotatedPath, PRIVATE_FILE_MODE);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const line = `${JSON.stringify(entry)}\n`;
    if (byteLength(line) > MAX_AUDIT_ENTRY_BYTES) {
      const error = new Error("Audit entry exceeds its closed-schema bound");
      error.code = "AUDIT_ENTRY_TOO_LARGE";
      throw error;
    }

    let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
    if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
    const descriptor = fs.openSync(auditPath, flags, PRIVATE_FILE_MODE);
    try {
      fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fs.writeSync(descriptor, line, null, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    return Object.freeze({ ok: true });
  } catch (error) {
    return Object.freeze({ ok: false, code: auditFailureCode(error) });
  }
}

function normalizedEffects(effects) {
  return Object.freeze({
    figma: safeEffect(effects?.figma),
    editor: safeEffect(effects?.editor),
    workspace: safeEffect(effects?.workspace),
    network: safeEffect(effects?.network),
    shared: safeEffect(effects?.shared),
  });
}

function startRecord(id, timestamp, projection) {
  const targetKind = safeToken(projection?.target?.kind, "none");
  const outputRoles = Array.isArray(projection?.outputRoles)
    ? projection.outputRoles.slice(0, 16).map((role) => safeToken(role))
    : [];
  const data = {
    arguments: summarizeArguments(projection?.arguments),
    ...(projection?.label == null
      ? {}
      : { label: summarizeSensitive(projection.label) }),
    ...(projection?.body == null
      ? {}
      : { body: summarizeSensitive(projection.body) }),
    ...(projection?.nodes?.length
      ? { nodeRefs: summarizeReferences(projection.nodes) }
      : {}),
    ...(outputRoles.length ? { outputRoles } : {}),
  };
  return Object.freeze({
    schema: AUDIT_SCHEMA_VERSION,
    id,
    ts: timestamp,
    event: "start",
    capability: safeToken(projection?.capability),
    operation: ["none", "read", "write"].includes(projection?.operation)
      ? projection.operation
      : "none",
    effects: normalizedEffects(projection?.effects),
    ...(projection?.materialVersion == null
      ? {}
      : { materialVersion: safeToken(projection.materialVersion) }),
    target: Object.freeze({
      kind: targetKind,
      ...(projection?.target?.identity == null
        ? {}
        : { identity: summarizeSensitive(projection.target.identity) }),
    }),
    data: Object.freeze(data),
  });
}

function completionRecord(handle, outcome) {
  const durationMs = Math.max(0, Date.now() - handle.startedAt);
  const code = typeof outcome?.code === "number"
    ? outcome.code
    : typeof outcome?.status === "number"
      ? outcome.status
      : undefined;
  const mutation = isMutationOutcomeProjection(outcome?.mutation)
    ? outcome.mutation : projectMutationOutcome(outcome);
  return Object.freeze({
    schema: AUDIT_SCHEMA_VERSION,
    id: handle.id,
    ts: new Date().toISOString(),
    event: "done",
    outcome: Object.freeze({
      ok: outcome?.ok === true,
      durationMs,
      ...(code === undefined ? {} : { code }),
      ...(outcome?.errorKind
        ? { errorKind: safeToken(outcome.errorKind, "request") }
        : {}),
      ...(DISPATCH_STATES.has(outcome?.dispatchState)
        ? { dispatchState: outcome.dispatchState }
        : {}),
      ...(mutation ? { mutation } : {}),
    }),
  });
}

/**
 * Create an isolated trail. Production uses the singleton below; tests can
 * provide a temporary path and a smaller rotation threshold.
 */
export function createAuditTrail({
  auditPath = AUDIT_LOG_PATH,
  rotateBytes = AUDIT_ROTATE_BYTES,
  manageDirectory = auditPath === path.join(STATE_DIR, "audit.log"),
} = {}) {
  let degraded = null;

  const rememberFailure = (result) => {
    if (result.ok) return;
    degraded = degraded || Object.freeze({
      status: "degraded",
      code: result.code,
      since: new Date().toISOString(),
    });
  };

  return Object.freeze({
    begin(projection = {}) {
      const id = randomUUID();
      const startedAt = Date.now();
      const start = writeJsonLine(
        auditPath,
        startRecord(id, new Date(startedAt).toISOString(), projection),
        { rotateBytes, manageDirectory },
      );
      rememberFailure(start);
      return Object.freeze({ id, startedAt, start });
    },

    finish(handle, outcome = {}) {
      const done = writeJsonLine(
        auditPath,
        completionRecord(handle, outcome),
        { rotateBytes, manageDirectory },
      );
      rememberFailure(done);
      if (handle.start.ok && done.ok) degraded = null;
      if (!handle.start.ok || !done.ok) {
        const failure = !handle.start.ok ? handle.start : done;
        return Object.freeze({
          status: "degraded",
          code: failure.code,
          since: degraded?.since || new Date().toISOString(),
        });
      }
      return Object.freeze({ status: "healthy" });
    },

    status() {
      return degraded || Object.freeze({ status: "healthy" });
    },
  });
}

export const auditTrail = createAuditTrail();

export function getAuditStatus() {
  return auditTrail.status();
}
