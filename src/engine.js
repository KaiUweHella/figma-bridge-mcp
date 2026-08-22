// Safe execution wrapper around the vendored engine.
//
// Security invariants:
//  - Never runs through a shell (execFile, shell:false) -> no command injection.
//  - First token must be in ALLOWED_COMMANDS.
//  - `connect` is intentionally NOT allowlisted; connecting only ever happens
//    through ensureSafeConnect(), which forces --safe. This makes Yolo/patching
//    unreachable via the wrapper.
//  - Every executed command attempts one closed-schema Audit Trail lifecycle;
//    storage failure is returned as degraded state without blocking Figma.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { createDaemonClient, DaemonClientError } from "../engine/src/lib/daemon-client.js";
import { createDesignCaptureModule } from "../engine/src/application/design-capture.js";
import { retrySafeRead } from "../engine/src/lib/safe-read-retry.js";
import { publicError } from "./error-projection.js";
import { resolveFigmaTarget, targetFileKey } from "./figma-target.js";
import { auditTrail } from "./audit-trail.js";
import {
  isFigmaCommandPlan,
  listFigmaCapabilities,
  planFigmaCommand,
} from "./capability-catalog.js";
import {
  EXEC_TIMEOUT_MS,
  LONG_EXEC_TIMEOUT_MS,
  BACKGROUND_EXEC_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  ENGINE_CWD,
  DAEMON_HOST,
  getDaemonPort,
  DAEMON_TOKEN_FILE,
  PLUGIN_KEY_FILE,
  REST_TOKEN_FILE,
  WORKSPACE_IO,
  ENGINE_WORKSPACE_ROOTS,
  buildArgv,
} from "./config.js";

const execFileAsync = promisify(execFile);

// Environment for engine child processes. Threading PLUGIN_KEY_FILE through here
// is what lets the daemon (spawned detached by the engine) read the same access
// key the MCP layer generated, so the plugin handshake can be authenticated.
// REST_TOKEN_FILE tells the daemon where to persist the optional REST token
// the user pastes into the plugin UI (the MCP layer reads the same path).
const engineEnv = {
  ...process.env,
  PLUGIN_KEY_FILE,
  REST_TOKEN_FILE,
  FIGMA_BRIDGE_WORKSPACE_ROOTS: ENGINE_WORKSPACE_ROOTS,
};

// Compatibility view for callers/tests. The Capability Catalog is the source
// of truth; `connect`, raw eval/run and removed generators are absent there.
export const ALLOWED_COMMANDS = new Set(listFigmaCapabilities().map(({ name }) => name));

// Discoverability: the top-level help flag is read-only (commander prints the
// command list and exits) and safe to expose. Without this, an agent has no way
// to find out which commands exist short of guessing against the allowlist.
// Only the flag forms are included: the vendored engine has no `help` command,
// so a bare "help" token would reach the engine's unknown-command path (exit 1).
export const HELP_TOKENS = new Set(["--help", "-h"]);

// Guard against absurdly large arguments. render passes JSX inline, so this is
// generous but still bounded.
const MAX_ARG_LENGTH = 200000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

// Node ids referenced by a command, for the local history (figma_history).
// Plain "12:34" plus the URL form "node-id=12-34". Best-effort: a "12:30"
// inside free text matches too — acceptable for a history filter.
const NODE_ID_RE = /\b\d+:\d+\b/g;
const URL_NODE_ID_RE = /node-id=(\d+)-(\d+)/g;

/**
 * Extract Figma node ids from a list of strings, normalized to "d:d",
 * deduplicated and capped.
 * @param {string[]} strings
 * @param {number} [cap]
 * @returns {string[]}
 */
export function extractNodeIds(strings, cap = 50) {
  const ids = new Set();
  for (const s of strings) {
    if (typeof s !== "string") continue;
    for (const m of s.matchAll(URL_NODE_ID_RE)) ids.add(`${m[1]}:${m[2]}`);
    for (const m of s.matchAll(NODE_ID_RE)) ids.add(m[0]);
    if (ids.size >= cap) break;
  }
  return [...ids].slice(0, cap);
}

function validateArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("args must be a non-empty array of strings");
  }
  for (const a of args) {
    if (typeof a !== "string") {
      throw new Error("All arguments must be strings");
    }
    if (a.length > MAX_ARG_LENGTH) {
      throw new Error(
        `Argument exceeds maximum length of ${MAX_ARG_LENGTH} characters`,
      );
    }
  }
}

/**
 * Resolve one explicit Figma target for a command.
 *
 * An explicit fileKey wins. Otherwise a Figma URL argument
 * supplies its file key automatically. Non-Figma URLs (for example a local
 * Storybook) are ignored. This keeps all command adapters consistent without
 * teaching every handler how to parse Figma URLs.
 */
export function resolveFileTarget(explicitFileKey, args = []) {
  return resolveFigmaTarget({ explicitFileKey, args }).fileKey;
}

function createCommandPlan(args, opts = {}) {
  validateArgs(args);
  return planFigmaCommand(args, {
    fileKey: opts.fileKey,
    registryFileKey: opts.registryFileKey,
    workspaceIO: WORKSPACE_IO,
  });
}

function startCommandExecution(plan, opts = {}) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError("Command Application requires a Command Plan created by the Capability Catalog");
  }
  validateArgs(plan.argv);
  const command = plan.argv[0];
  if (!plan.allowed) {
    const rejected = ALLOWED_COMMANDS.has(command) && plan.argv[1]
      ? `${command} ${plan.argv[1]}`
      : command;
    throw new Error(
      `Command not allowed: ${rejected}. Allowed: ${[...ALLOWED_COMMANDS].sort().join(", ")}`,
    );
  }
  const targetContext = plan.target;
  const fileKey = targetFileKey(targetContext);
  const nodes = extractNodeIds(plan.argv);
  const audit = auditTrail.begin({
    ...plan.audit,
    arguments: plan.argv,
    ...(nodes.length ? { nodes } : {}),
    ...(opts.label == null ? {} : { label: opts.label }),
    outputRoles: plan.audit.outputRoles,
    target: {
      kind: plan.audit.targetKind,
      ...(fileKey ? { identity: fileKey } : {}),
    },
  });
  return Object.freeze({ args: plan.argv, opts, command, plan, targetContext, fileKey, audit });
}

function executionTimeout(context, opts) {
  if (opts.timeoutMs != null) return opts.timeoutMs;
  if (context.plan.execution.timeout === "background") return BACKGROUND_EXEC_TIMEOUT_MS;
  if (context.plan.execution.timeout === "long") return LONG_EXEC_TIMEOUT_MS;
  return EXEC_TIMEOUT_MS;
}

function completeCommandExecution(context, code = 0) {
  return auditTrail.finish(context.audit, { ok: true, code });
}

function failCommandExecution(context, error) {
  return auditTrail.finish(context.audit, {
    ok: false,
    ...(typeof error?.code === "number" ? { code: error.code } : {}),
    errorKind: error?.kind || (typeof error?.code === "number" ? "engine-exit" : "request"),
  });
}

function attachAuditStatus(error, audit) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    error.audit = audit;
  }
  return error;
}

/**
 * Run an allowlisted engine command.
 * @param {string[]} args
 * @param {{timeoutMs?: number, label?: string, fileKey?: string, okExitCodes?: number[]}} [opts]
 *   `timeoutMs` overrides the default EXEC_TIMEOUT_MS (long exports need more);
 *   `label` is summarized non-reversibly for audit correlation;
 *   `fileKey` targets one of several connected Figma windows;
 *   `okExitCodes` names exit codes that are an ANSWER rather than a failure.
 * @returns {Promise<{stdout: string, stderr: string, code: number, audit: object}>}
 */
export async function runCli(args, opts = {}) {
  return runCliPlan(createCommandPlan(args, opts), opts);
}

/** Execute one already-resolved Command Plan through the child-process Adapter. */
export async function runCliPlan(plan, opts = {}) {
  const context = startCommandExecution(plan, opts);
  try {
    const result = await spawnCliAdapter(context.args, opts, context.fileKey, executionTimeout(context, opts), context.plan.execution.okExitCodes);
    const audit = completeCommandExecution(context, result.code);
    return { ...result, audit };
  } catch (error) {
    throw attachAuditStatus(error, failCommandExecution(context, error));
  }
}

async function spawnCliAdapter(args, opts, fileKey, timeoutMs, plannedExitCodes = [0]) {
  const { cmd, argv } = buildArgv(args, { fileKey });
  try {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      timeout: timeoutMs,
      cwd: ENGINE_CWD,
      env: engineEnv,
      maxBuffer: MAX_BUFFER,
      shell: false,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err) {
    // execFile rejects on nonzero exit, timeout, or spawn failure.
    const code = typeof err.code === "number" ? err.code : 1;
    const stderr = err.stderr ?? "";
    const stdout = err.stdout ?? "";
    // Some commands use the exit code as an ANSWER, not as a failure:
    // `history diff` exits 1 when the design changed, so it works as a CI
    // gate. Callers opt in by naming the codes explicitly — a blanket "ignore
    // exit codes" would swallow real breakage.
    const okay = Array.isArray(opts.okExitCodes) ? opts.okExitCodes : plannedExitCodes;
    if (okay.includes(code)) {
      return { stdout, stderr, code };
    }
    throw publicError(Object.assign(err, { code, stdout, stderr }));
  }
}

/**
 * Run a value-returning command Module in the long-lived MCP process while
 * preserving the same allowlist, targeting and audit contract as runCli.
 */
export async function runInProcessCommand(args, opts = {}, operation) {
  return runInProcessCommandPlan(createCommandPlan(args, opts), opts, operation);
}

/** Execute one already-resolved Command Plan through an in-process Command Application. */
export async function runInProcessCommandPlan(plan, opts = {}, operation) {
  if (typeof operation !== "function") throw new TypeError("runInProcessCommand requires an operation");
  const context = startCommandExecution(plan, opts);
  const timeoutMs = executionTimeout(context, opts);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const invoke = () => operation({
    plan: context.plan,
    target: context.targetContext,
    fileKey: context.fileKey,
    timeoutMs: remaining(),
    deadline,
  });
  try {
    const result = context.plan.execution.retry === "safe-read"
      ? await retrySafeRead(invoke, {
          waitUntilReady: opts.waitUntilReady
            ? (error) => opts.waitUntilReady(error, { deadline, timeoutMs: remaining() })
            : () => waitForPluginConnection(remaining()),
        })
      : await invoke();
    const code = result?.code ?? 0;
    if (!Number.isInteger(code) || code < 0) {
      throw new TypeError("Command Application returned an invalid outcome code");
    }
    if (!context.plan.execution.okExitCodes.includes(code)) {
      throw Object.assign(new Error(`Command Application returned unsupported outcome code ${code}`), {
        code,
        kind: "command-outcome",
      });
    }
    const audit = completeCommandExecution(context, code);
    return {
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
      code,
      audit,
    };
  } catch (error) {
    // Existing read-only slices retain Commander self-healing during
    // migration. A completed Command Application disables that compatibility
    // path explicitly so recovery repeats the same Implementation only.
    // Write commands must never risk repeating an accepted mutation.
    if (opts.compatibilityFallback !== false
      && context.plan.execution.retry === "safe-read"
      && isDaemonUnavailable(error)) {
      try {
        const result = await spawnCliAdapter(context.args, opts, context.fileKey, remaining(), context.plan.execution.okExitCodes);
        const audit = completeCommandExecution(context, result.code);
        return { ...result, audit };
      } catch (fallbackError) {
        throw attachAuditStatus(
          fallbackError,
          failCommandExecution(context, fallbackError),
        );
      }
    }
    throw attachAuditStatus(error, failCommandExecution(context, error));
  }
}

/**
 * Establish a connection in Safe Mode. Runs OUTSIDE the allowlist and always
 * forces --safe, so binary patching / Yolo mode cannot be triggered here.
 *
 * The MCP client cannot display the access key until this call returns, so it
 * must never wait for the plugin that needs that key. `--no-wait` starts the
 * detached daemon, refreshes the stable plugin files and returns immediately.
 * CONNECT_TIMEOUT_MS remains a hard failure cap for daemon startup itself.
 * A healthy daemon is reused by default; forceRestart is reserved for an
 * explicit pairing-key rotation.
 * @param {{forceRestart?: boolean}} [options]
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function ensureSafeConnect({ forceRestart = false } = {}) {
  const args = ["connect", "--safe", "--no-wait"];
  if (forceRestart) args.push("--force-restart");
  const { cmd, argv } = buildArgv(args);
  const auditHandle = auditTrail.begin({
    capability: "bridge.connect",
    operation: "write",
    effects: { figma: "none", workspace: "none", shared: "write" },
    target: { kind: "local-bridge" },
    arguments: args,
  });

  try {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      timeout: CONNECT_TIMEOUT_MS,
      cwd: ENGINE_CWD,
      env: engineEnv,
      maxBuffer: MAX_BUFFER,
      shell: false,
    });
    const audit = auditTrail.finish(auditHandle, { ok: true, code: 0 });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0, audit };
  } catch (err) {
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    const code = typeof err.code === "number" ? err.code : 1;
    const audit = auditTrail.finish(auditHandle, {
      ok: false,
      code,
      errorKind: "engine-connect",
    });
    const projected = publicError(Object.assign(err, { code, stdout, stderr }));
    projected.audit = audit;
    throw projected;
  }
}

/**
 * Force an ABSOLUTE -o/--output on an `export assets` argv, resolving relative
 * paths against the given base dir (the MCP server's cwd = the client's
 * workspace — NOT the engine repo, where relative paths used to land).
 * Appends the default "assets" dir when no -o was given.
 * @param {string[]} rawArgs
 * @param {string} [baseDir]
 * @returns {{args: string[], outDir: string}}
 */
export function withAbsoluteOutputDir(rawArgs, baseDir = process.cwd()) {
  const plan = planFigmaCommand(rawArgs, { workspaceDir: baseDir });
  return { args: [...plan.argv], outDir: plan.outputs[0]?.path || null };
}

/**
 * The engine child runs with cwd = the MCP server repo, so RELATIVE output
 * paths land inside this repo instead of the user's project (a stray
 * node-export.png in the repo root was the live evidence). `export assets`
 * is covered by withAbsoluteOutputDir; this normalizes the other three
 * file-writing commands against the server's cwd (the client workspace):
 *   - `extract [output]`            (positional, default DESIGN.md)
 *   - `export node|screenshot -o …` (default node-export.png / screenshot.png)
 *   - `verify-build <dir> …`        (dir positional + --assets/--compare/
 *                                    --design/--diff-out path flags)
 * All other commands pass through untouched.
 * @param {string[]} rawArgs
 * @param {string} [baseDir]
 * @returns {string[]}
 */
export function normalizeOutputArgs(rawArgs, baseDir = process.cwd()) {
  return [...planFigmaCommand(rawArgs, { workspaceDir: baseDir }).argv];
}

/**
 * Read the daemon session token written by the engine (0600 file). Returns null
 * if it does not exist yet (daemon never started).
 * @returns {string|null}
 */
function readDaemonToken() {
  try {
    return fs.readFileSync(DAEMON_TOKEN_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

let _daemonClient = null;
function daemonClient() {
  if (_daemonClient) return _daemonClient;
  _daemonClient = createDaemonClient({
    readToken: readDaemonToken,
    getPort: getDaemonPort,
    host: DAEMON_HOST,
    tokenFile: DAEMON_TOKEN_FILE,
  });
  return _daemonClient;
}

/** Evaluate code through the authenticated Safe-Mode daemon without spawning
 * the CLI/Commander process. The caller supplies file targeting explicitly. */
export async function evaluateFigma(code, { target, fileKey, timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  return daemonClient().evaluate(code, {
    fileKey: targetFileKey(target) || resolveFileTarget(fileKey, []),
    timeoutMs,
  });
}

/** Metadata-aware eval for freshness-sensitive read Modules. Ordinary command
 * callers keep the value-only evaluateFigma Interface. */
export async function evaluateFigmaWithMetadata(code, { target, fileKey, timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  return daemonClient().evaluateWithMetadata(code, {
    fileKey: targetFileKey(target) || resolveFileTarget(fileKey, []),
    timeoutMs,
  });
}

const designCaptureModule = createDesignCaptureModule({
  maxEntries: Number(process.env.DESIGN_CAPTURE_CACHE_ENTRIES) || 8,
  maxBytes: Number(process.env.DESIGN_CAPTURE_CACHE_BYTES) || 8 * 1024 * 1024,
});

/** Capture one explicit Figma node, reusing it only when the plugin proves the
 * connection and document revision are unchanged. */
export function captureFigmaDesign(request, { fileKey, deadline, timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  const target = resolveFileTarget(fileKey, []);
  const remaining = () => deadline == null
    ? timeoutMs
    : Math.max(1, deadline - Date.now());
  return designCaptureModule.capture({ ...request, fileKey: target }, {
    evaluateWithMetadata: (code) => daemonClient().evaluateWithMetadata(code, {
      fileKey: target,
      timeoutMs: remaining(),
    }),
  });
}

export function isDaemonUnavailable(error) {
  return error instanceof DaemonClientError &&
    [
      "missing-token",
      "unavailable",
      "timeout",
      "plugin-unavailable",
      "plugin-timeout",
    ].includes(error.kind);
}

async function waitForPluginConnection(maxWaitMs = 8000) {
  const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0);
  do {
    const current = await health({ timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) });
    if (current.ok && current.plugin) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (true);
  return false;
}

/**
 * Read the last selection the plugin UI pushed to the daemon (button or
 * debounced selectionchange). Null selection means nothing was pushed yet —
 * either nothing is selected, or the plugin predates the feature.
 * @param {string} [fileKey] Bare key or Figma URL when several windows exist.
 * @returns {Promise<{ok: boolean, selection: object|null, pluginConnected: boolean, message: string}>}
 */
export async function getSelection(fileKey) {
  const target = resolveFileTarget(fileKey, []);
  try {
    const response = await daemonClient().selection({ fileKey: target, timeoutMs: 3000 });
    if (!response.ok) {
      return {
        ok: false,
        selection: null,
        pluginConnected: false,
        message:
          response.status === 404
            ? "Daemon predates the selection feature — restart it via figma_connect."
            : `Daemon answered HTTP ${response.status}.`,
      };
    }
    const raw = response.data || {};
    return {
      ok: true,
      selection: raw.selection || null,
      pluginConnected: raw.pluginConnected === true,
      // Present when several windows are connected and none was named: there
      // is no single "the selection" to report.
      ambiguous: raw.ambiguous === true,
      connections: Array.isArray(raw.connections) ? raw.connections : [],
      message: "",
    };
  } catch (err) {
    if (err instanceof DaemonClientError && err.kind === "missing-token") {
      return {
        ok: false,
        selection: null,
        pluginConnected: false,
        message: "Daemon not started (no token file). Run figma_connect first.",
      };
    }
    return {
      ok: false,
      selection: null,
      pluginConnected: false,
      message: `${err.message}. Run figma_connect first.`,
    };
  }
}

/**
 * Query Safe-Mode connection health via the daemon's /health endpoint. This is
 * the ground-truth signal: `plugin:true` means the Figma plugin is connected.
 * @returns {Promise<{ok: boolean, plugin: boolean, raw: object|null, message: string}>}
 */
export async function health({ timeoutMs = 3000 } = {}) {
  try {
    const response = await daemonClient().health({ timeoutMs });
    const raw = response.data || {};
    // 403 = a daemon answered but rejected OUR token. Without this branch the
    // message below reads "plugin NOT connected" and sends the user to
    // relaunch the plugin — the actual problem is a token mismatch (stale
    // token file, or a foreign daemon on the port).
    if (response.status === 403) {
      return {
        ok: false,
        plugin: false,
        raw,
        message:
          "Daemon reachable but authentication FAILED (token mismatch — stale token file or a different daemon on this port). Run figma_connect to restart the daemon with a fresh token.",
      };
    }
    const plugin = raw.plugin === true;
    return {
      ok: response.ok,
      plugin,
      raw,
      message: plugin
        ? `plugin connected (mode: ${raw.mode})`
        : `daemon running (${raw.status}, mode: ${raw.mode}) — plugin NOT connected. Launch Plugins → Development → Figma Bridge in Figma.`,
    };
  } catch (err) {
    if (err instanceof DaemonClientError && err.kind === "missing-token") {
      return {
        ok: false,
        plugin: false,
        raw: null,
        message:
          "Daemon not started (no token file). Run figma_connect first, then launch the Figma Bridge plugin in Figma.",
      };
    }
    return {
      ok: false,
      plugin: false,
      raw: null,
      message: `${err.message}. Run figma_connect first.`,
    };
  }
}

/** A real read-only plugin round trip. A WebSocket can remain OPEN while a
 * backgrounded Figma/plugin runtime no longer services eval messages, so
 * socket state alone is not a useful readiness signal. */
export async function probePluginResponsiveness(fileKey, timeoutMs = 4000) {
  const target = resolveFileTarget(fileKey, []);
  const started = Date.now();
  try {
    await daemonClient().execute('eval', {
      code: '(async () => ({ ok: true }))()',
      timeoutMs: Math.max(1000, timeoutMs - 500),
    }, { fileKey: target, timeoutMs });
    return { responsive: true, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    return {
      responsive: false,
      latencyMs: Date.now() - started,
      error: error?.message || String(error),
    };
  }
}

/** Ask a still-connected plugin main thread to replace only its UI iframe.
 * The daemon falls back to closing an unresponsive socket, after which the
 * plugin's quiet HTTP discovery path reconnects it. */
export async function recoverPluginConnection(fileKey, timeoutMs = 6500) {
  const target = resolveFileTarget(fileKey, []);
  const response = await daemonClient().reconnect({ fileKey: target, timeoutMs });
  if (!response.ok || response.data?.error) {
    throw new Error(response.data?.error || response.text || `Daemon answered HTTP ${response.status}`);
  }
  return response.data || {};
}
