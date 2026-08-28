/**
 * Small, bounded platform helpers used by the daemon lifecycle.
 *
 * Listener inspection is diagnostic and ownership evidence only. It never
 * kills a process by port and never invokes a shell. The caller may signal a
 * PID only after independently matching it to the daemon-owned PID file.
 */

import { spawnSync } from "node:child_process";

const PLATFORM = process.platform;
const LISTENER_INSPECTION_TIMEOUT_MS = 1_500;
const LISTENER_INSPECTION_MAX_OUTPUT_BYTES = 1024 * 1024;

// --- Null device ---
export const nullDevice = PLATFORM === "win32" ? "NUL" : "/dev/null";

export class PlatformListenerInspectionError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PlatformListenerInspectionError";
    this.code = "LISTENER_INSPECTION_UNAVAILABLE";
  }
}

function validPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError("Listener inspection requires a port from 1 to 65535.");
  }
  return value;
}

function uniquePids(values) {
  return [...new Set(values)]
    .filter((pid) => Number.isInteger(pid) && pid > 1)
    .sort((left, right) => left - right);
}

function commandFailure(command, result) {
  const reason =
    result?.error?.code === "ETIMEDOUT"
      ? `timed out after ${LISTENER_INSPECTION_TIMEOUT_MS} ms`
      : result?.error?.code === "ENOENT"
        ? "is not installed or not available on PATH"
        : result?.error?.message ||
          `exited with status ${String(result?.status)}`;
  return new PlatformListenerInspectionError(
    `Cannot inspect the daemon listener because ${command} ${reason}. ` +
      "Use the authenticated daemon shutdown or install the platform listener tool before forcing a restart.",
    { cause: result?.error || null }
  );
}

function runListenerCommand(command, args, spawnSyncImpl) {
  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: LISTENER_INSPECTION_TIMEOUT_MS,
    maxBuffer: LISTENER_INSPECTION_MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
  });
  if (!result || result.error) throw commandFailure(command, result);
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function unixListenerPids(port, spawnSyncImpl) {
  const result = runListenerCommand(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    spawnSyncImpl
  );
  // lsof uses exit 1 for a valid query with no matching open file.
  if (result.status === 1 && !result.stderr.trim()) return [];
  if (result.status !== 0) throw commandFailure("lsof", result);
  const lines = result.stdout.trim() ? result.stdout.trim().split(/\s+/u) : [];
  if (lines.some((value) => !/^\d+$/u.test(value))) {
    throw new PlatformListenerInspectionError(
      "Cannot inspect the daemon listener because lsof returned an unrecognized PID list."
    );
  }
  return uniquePids(lines.map(Number));
}

function localPort(address) {
  const separator = String(address || "").lastIndexOf(":");
  if (separator < 0) return null;
  const raw = address.slice(separator + 1);
  return /^\d+$/u.test(raw) ? Number(raw) : null;
}

function windowsListenerPids(port, spawnSyncImpl) {
  const result = runListenerCommand(
    "netstat",
    ["-ano", "-p", "tcp"],
    spawnSyncImpl
  );
  if (result.status !== 0) throw commandFailure("netstat", result);
  const pids = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (
      columns.length < 5 ||
      columns[0].toUpperCase() !== "TCP" ||
      columns.at(-2).toUpperCase() !== "LISTENING" ||
      localPort(columns[1]) !== port
    ) {
      continue;
    }
    const rawPid = columns.at(-1);
    if (!/^\d+$/u.test(rawPid)) {
      throw new PlatformListenerInspectionError(
        "Cannot inspect the daemon listener because netstat returned an unrecognized PID."
      );
    }
    pids.push(Number(rawPid));
  }
  return uniquePids(pids);
}

/**
 * Return every process that owns a LISTEN socket on exactly `port`.
 * `spawnSyncImpl` and `platform` are injectable so both supported parsers and
 * their no-shell invocation contracts can be tested on every CI platform.
 */
export function getPortPids(
  port,
  { platform = PLATFORM, spawnSyncImpl = spawnSync } = {}
) {
  const checkedPort = validPort(port);
  if (platform === "win32") {
    return windowsListenerPids(checkedPort, spawnSyncImpl);
  }
  if (platform === "darwin" || platform === "linux") {
    return unixListenerPids(checkedPort, spawnSyncImpl);
  }
  throw new PlatformListenerInspectionError(
    `Cannot inspect the daemon listener on unsupported platform ${JSON.stringify(platform)}.`
  );
}

// Native bounded wait after daemon stop. This replaces the inherited shell
// calls to sleep/ping while preserving the synchronous lifecycle contract.
export function sleepAfterStop(milliseconds = 500) {
  const duration = Number(milliseconds);
  if (!Number.isFinite(duration) || duration <= 0) return;
  const bounded = Math.min(5_000, Math.ceil(duration));
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, bounded);
  } catch {
    const deadline = Date.now() + bounded;
    while (Date.now() < deadline) {
      // Best-effort fallback for runtimes where blocking Atomics are disabled.
    }
  }
}
