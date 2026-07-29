// Safe execution wrapper around figma-cli.
//
// Security invariants:
//  - Never runs through a shell (execFile, shell:false) -> no command injection.
//  - First token must be in ALLOWED_COMMANDS.
//  - `connect` is intentionally NOT allowlisted; connecting only ever happens
//    through ensureSafeConnect(), which forces --safe. This makes Yolo/patching
//    unreachable via the wrapper.
//  - Every executed command is appended to an audit log.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import {
  AUDIT_LOG_PATH,
  EXEC_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  ENGINE_CWD,
  DAEMON_HOST,
  getDaemonPort,
  DAEMON_TOKEN_FILE,
  PLUGIN_KEY_FILE,
  buildArgv,
} from "./config.js";

const execFileAsync = promisify(execFile);

// Environment for engine child processes. Threading PLUGIN_KEY_FILE through here
// is what lets the daemon (spawned detached by the engine) read the same access
// key the MCP layer generated, so the plugin handshake can be authenticated.
const engineEnv = { ...process.env, PLUGIN_KEY_FILE };

// Allowlisted first-token subcommands. `connect` is deliberately excluded.
// Verified against figma-cli's top-level commands (`var`/`col` are real aliases
// of `variables`/`colors`).
// `blocks` and `shadcn` are gone on purpose: the engine ships no third-party
// design-system generators, so there is nothing to allowlist.
export const ALLOWED_COMMANDS = new Set([
  "render",
  "render-batch",
  "combos",
  "sizes",
  "node",
  "component",
  "tokens",
  "var",
  "col",
  "section",
  "grid",
  "dev",
  "annotate",
  "a11y",
  "canvas",
  "find",
  "verify",
  "inspect",
  "export",
  "gradient",
  "pin",
  "api",
  "import",
  // Read-only design-to-code surface: extract writes DESIGN.md (filesystem,
  // not the design), spec reads/enforces it, analyze reports color/typo/
  // spacing censuses. None of them mutate the Figma file.
  "extract",
  "spec",
  "analyze",
]);

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

/**
 * Append a single JSON line to the audit log, creating the directory if needed.
 * @param {object} entry
 */
export function appendAudit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Audit logging must never block execution; swallow write errors.
  }
}

function isoNow() {
  return new Date().toISOString();
}

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
 * Run an allowlisted figma-cli command.
 * @param {string[]} args
 * @param {{timeoutMs?: number, label?: string}} [opts] - per-call timeout
 *   override (long-running exports need more than the default EXEC_TIMEOUT_MS);
 *   `label` is a short human intent note stored in the audit/history log.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function runCli(args, opts = {}) {
  validateArgs(args);

  const command = args[0];
  if (!ALLOWED_COMMANDS.has(command) && !HELP_TOKENS.has(command)) {
    // Name the allowlist right in the error — agents were guessing command
    // names one rejection at a time (style, select, selection, …).
    throw new Error(
      `Command not allowed: ${command}. Allowed: ${[...ALLOWED_COMMANDS].sort().join(", ")}`,
    );
  }

  const { cmd, argv } = buildArgv(args);
  // `nodes`/`label` feed figma_history; old {ts, args} lines stay valid.
  const nodes = extractNodeIds(args);
  appendAudit({
    ts: isoNow(),
    args,
    ...(nodes.length ? { nodes } : {}),
    ...(opts.label ? { label: String(opts.label).slice(0, 200) } : {}),
  });

  try {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      timeout: opts.timeoutMs || EXEC_TIMEOUT_MS,
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
    const detail = stderr || err.message || "Unknown error";
    const wrapped = new Error(`figma-cli exited with code ${code}: ${detail}`);
    wrapped.code = code;
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    throw wrapped;
  }
}

/**
 * Establish a connection in Safe Mode. Runs OUTSIDE the allowlist and always
 * forces --safe, so binary patching / Yolo mode cannot be triggered here.
 *
 * `connect --safe` prints its daemon-started + plugin-import instructions within
 * ~1-2s, then blocks up to 90s waiting for the plugin. Since the daemon is
 * spawned detached, we cap the wait at CONNECT_TIMEOUT_MS and return the
 * captured instructions — the daemon keeps running in the background.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function ensureSafeConnect() {
  const args = ["connect", "--safe"];
  const { cmd, argv } = buildArgv(args);
  appendAudit({ ts: isoNow(), args });

  try {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      timeout: CONNECT_TIMEOUT_MS,
      cwd: ENGINE_CWD,
      env: engineEnv,
      maxBuffer: MAX_BUFFER,
      shell: false,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err) {
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    // A timeout kill is the expected path: instructions were already printed
    // and the detached daemon lives on. Surface stdout as success.
    if (err.killed || err.signal === "SIGTERM") {
      return { stdout, stderr, code: 0 };
    }
    const code = typeof err.code === "number" ? err.code : 1;
    const wrapped = new Error(
      `figma-cli connect failed with code ${code}: ${stderr || err.message}`,
    );
    wrapped.code = code;
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    throw wrapped;
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
  const args = [...rawArgs];
  const idx = args.findIndex((a) => a === "-o" || a === "--output");
  let outDir;
  if (idx !== -1 && typeof args[idx + 1] === "string") {
    outDir = path.isAbsolute(args[idx + 1]) ? args[idx + 1] : path.resolve(baseDir, args[idx + 1]);
    args[idx + 1] = outDir;
  } else {
    outDir = path.resolve(baseDir, "assets");
    args.push("-o", outDir);
  }
  return { args, outDir };
}

/**
 * Read the daemon session token written by figma-cli (0600 file). Returns null
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

/**
 * Query Safe-Mode connection health via the daemon's /health endpoint. This is
 * the ground-truth signal: `plugin:true` means the Figma plugin is connected.
 * @returns {Promise<{ok: boolean, plugin: boolean, raw: object|null, message: string}>}
 */
export async function health() {
  const token = readDaemonToken();
  if (!token) {
    return {
      ok: false,
      plugin: false,
      raw: null,
      message:
        "Daemon not started (no token file). Run figma_connect first, then launch the FigCli plugin in Figma.",
    };
  }

  const daemonPort = getDaemonPort();
  const url = `http://${DAEMON_HOST}:${daemonPort}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, {
      headers: { "X-Daemon-Token": token, Host: `${DAEMON_HOST}:${daemonPort}` },
      signal: controller.signal,
    });
    const raw = await res.json();
    const plugin = raw.plugin === true;
    return {
      ok: res.ok,
      plugin,
      raw,
      message: plugin
        ? `plugin connected (mode: ${raw.mode})`
        : `daemon running (${raw.status}, mode: ${raw.mode}) — plugin NOT connected. Launch Plugins → Development → FigCli in Figma.`,
    };
  } catch (err) {
    return {
      ok: false,
      plugin: false,
      raw: null,
      message: `Daemon not reachable at ${url}: ${err.message}. Run figma_connect first.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
