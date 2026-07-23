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
  DAEMON_PORT,
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
export const ALLOWED_COMMANDS = new Set([
  "render",
  "render-batch",
  "blocks",
  "shadcn",
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
]);

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
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function runCli(args) {
  validateArgs(args);

  const command = args[0];
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Command not allowed: ${command}`);
  }

  const { cmd, argv } = buildArgv(args);
  appendAudit({ ts: isoNow(), args });

  try {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      timeout: EXEC_TIMEOUT_MS,
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

  const url = `http://${DAEMON_HOST}:${DAEMON_PORT}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, {
      headers: { "X-Daemon-Token": token, Host: `${DAEMON_HOST}:${DAEMON_PORT}` },
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
