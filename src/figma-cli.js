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
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { signRequest } from "../engine/src/lib/daemon-auth.js";
import {
  AUDIT_LOG_PATH,
  EXEC_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  ENGINE_CWD,
  DAEMON_HOST,
  getDaemonPort,
  DAEMON_TOKEN_FILE,
  PLUGIN_KEY_FILE,
  REST_TOKEN_FILE,
  buildArgv,
} from "./config.js";

const execFileAsync = promisify(execFile);

// Environment for engine child processes. Threading PLUGIN_KEY_FILE through here
// is what lets the daemon (spawned detached by the engine) read the same access
// key the MCP layer generated, so the plugin handshake can be authenticated.
// REST_TOKEN_FILE tells the daemon where to persist the optional REST token
// the user pastes into the plugin UI (the MCP layer reads the same path).
const engineEnv = { ...process.env, PLUGIN_KEY_FILE, REST_TOKEN_FILE };

// Allowlisted first-token subcommands. `connect` is deliberately excluded.
// Verified against figma-cli's top-level commands (`var` aliases `variables`,
// `col` aliases `collections` — a write surface: `col create`).
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
  // map writes figma-map.json (Figma↔Storybook component mapping) into the
  // client project — file-write only, never touches the Figma document.
  "map",
  // verify-build greps a project directory against assets.json — fully
  // read-only, needs no Figma connection at all.
  "verify-build",
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

// Rotation cap: figma_history reads the log synchronously, and render-JSX
// args make entries fat — an unbounded log eventually made every history
// call drag. One rotated generation is kept (audit.log.1) and still read
// by figma_history, so rotation never visibly truncates recent history.
const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * Append a single JSON line to the audit log, creating the directory if
 * needed and rotating audit.log → audit.log.1 past the size cap.
 * @param {object} entry
 */
export function appendAudit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    try {
      if (fs.statSync(AUDIT_LOG_PATH).size >= AUDIT_ROTATE_BYTES) {
        fs.renameSync(AUDIT_LOG_PATH, AUDIT_LOG_PATH + ".1");
      }
    } catch {
      // ENOENT on first write — nothing to rotate.
    }
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
  // The entry is written BEFORE execution on purpose (aborted runs must be
  // auditable too); a matching {id, event:"done"} completion entry records
  // the outcome so failures stop reading like successes in figma_history.
  const auditId = randomUUID();
  const nodes = extractNodeIds(args);
  appendAudit({
    id: auditId,
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
    appendAudit({ id: auditId, ts: isoNow(), event: "done", ok: true });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err) {
    // execFile rejects on nonzero exit, timeout, or spawn failure.
    const code = typeof err.code === "number" ? err.code : 1;
    const stderr = err.stderr ?? "";
    const stdout = err.stdout ?? "";
    const detail = stderr || err.message || "Unknown error";
    appendAudit({
      id: auditId,
      ts: isoNow(),
      event: "done",
      ok: false,
      error: String(detail).trim().split("\n")[0].slice(0, 200),
    });
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
  const auditId = randomUUID();
  appendAudit({ id: auditId, ts: isoNow(), args });

  try {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      timeout: CONNECT_TIMEOUT_MS,
      cwd: ENGINE_CWD,
      env: engineEnv,
      maxBuffer: MAX_BUFFER,
      shell: false,
    });
    appendAudit({ id: auditId, ts: isoNow(), event: "done", ok: true });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err) {
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    // A timeout kill is the expected path: instructions were already printed
    // and the detached daemon lives on. Surface stdout as success.
    if (err.killed || err.signal === "SIGTERM") {
      appendAudit({ id: auditId, ts: isoNow(), event: "done", ok: true });
      return { stdout, stderr, code: 0 };
    }
    const code = typeof err.code === "number" ? err.code : 1;
    appendAudit({
      id: auditId,
      ts: isoNow(),
      event: "done",
      ok: false,
      error: String(stderr || err.message || "connect failed").trim().split("\n")[0].slice(0, 200),
    });
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
  let outDir;
  // Separated form: -o <dir> / --output <dir>
  const idx = args.findIndex((a) => a === "-o" || a === "--output");
  // Combined form: --output=<dir> / -o=<dir> — commander accepts it, and the
  // old findIndex missed it, silently redirecting assets to the default dir.
  const eqIdx = args.findIndex((a) => /^(--output|-o)=/.test(a));
  if (idx !== -1 && typeof args[idx + 1] === "string") {
    outDir = path.isAbsolute(args[idx + 1]) ? args[idx + 1] : path.resolve(baseDir, args[idx + 1]);
    args[idx + 1] = outDir;
  } else if (eqIdx !== -1) {
    const [flag, ...rest] = args[eqIdx].split("=");
    const value = rest.join("=");
    outDir = path.isAbsolute(value) ? value : path.resolve(baseDir, value);
    args[eqIdx] = `${flag}=${outDir}`;
  } else {
    outDir = path.resolve(baseDir, "assets");
    args.push("-o", outDir);
  }
  return { args, outDir };
}

// Engine flags (beyond -o/--output) that consume a value token — needed to
// find positional arguments correctly.
const VALUE_FLAGS = new Set(["--sections", "--pages", "-s", "--scale", "-f", "--format", "-d", "--depth"]);

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
  const args = [...rawArgs];
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));

  if (args[0] === "extract") {
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (VALUE_FLAGS.has(a)) { i++; continue; }
      if (a.startsWith("-")) continue;
      args[i] = abs(a); // the [output] positional
      return args;
    }
    args.push(abs("DESIGN.md"));
    return args;
  }

  if (args[0] === "export" && (args[1] === "node" || args[1] === "screenshot")) {
    const idx = args.findIndex((a) => a === "-o" || a === "--output");
    if (idx !== -1 && typeof args[idx + 1] === "string") {
      args[idx + 1] = abs(args[idx + 1]);
      return args;
    }
    const eqIdx = args.findIndex((a) => /^(--output|-o)=/.test(a));
    if (eqIdx !== -1) {
      const [flag, ...rest] = args[eqIdx].split("=");
      args[eqIdx] = `${flag}=${abs(rest.join("="))}`;
      return args;
    }
    args.push("-o", abs(args[1] === "node" ? "node-export.png" : "screenshot.png"));
    return args;
  }

  // verify-build takes a project DIRECTORY positional plus several path
  // flags — all of them must resolve against the client workspace, not the
  // engine repo (a relative "." used to grep the MCP server's own repo).
  if (args[0] === "verify-build") {
    const PATH_FLAGS = new Set(["--assets", "--compare", "--design", "--diff-out"]);
    const SKIP_VALUE = new Set(["--node", "--max-diff"]);
    let positionalDone = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const eq = a.match(/^(--[a-z-]+)=(.*)$/);
      if (eq) {
        if (PATH_FLAGS.has(eq[1])) args[i] = `${eq[1]}=${abs(eq[2])}`;
        continue;
      }
      if (PATH_FLAGS.has(a)) {
        if (typeof args[i + 1] === "string") args[i + 1] = abs(args[i + 1]);
        i++;
        continue;
      }
      if (SKIP_VALUE.has(a)) { i++; continue; }
      if (a.startsWith("-")) continue;
      if (!positionalDone) { args[i] = abs(a); positionalDone = true; }
    }
    return args;
  }

  // map storybook writes figma-map.json — anchor it in the client project.
  if (args[0] === "map") {
    const idx = args.findIndex((a) => a === "-o" || a === "--output");
    if (idx !== -1 && typeof args[idx + 1] === "string") {
      args[idx + 1] = abs(args[idx + 1]);
      return args;
    }
    const eqIdx = args.findIndex((a) => /^(--output|-o)=/.test(a));
    if (eqIdx !== -1) {
      const [flag, ...rest] = args[eqIdx].split("=");
      args[eqIdx] = `${flag}=${abs(rest.join("="))}`;
      return args;
    }
    args.push("-o", abs("figma-map.json"));
    return args;
  }

  return args;
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
 * Read the last selection the plugin UI pushed to the daemon (button or
 * debounced selectionchange). Null selection means nothing was pushed yet —
 * either nothing is selected, or the plugin predates the feature.
 * @returns {Promise<{ok: boolean, selection: object|null, pluginConnected: boolean, message: string}>}
 */
export async function getSelection() {
  const token = readDaemonToken();
  if (!token) {
    return {
      ok: false,
      selection: null,
      pluginConnected: false,
      message: "Daemon not started (no token file). Run figma_connect first.",
    };
  }
  const daemonPort = getDaemonPort();
  const url = `http://${DAEMON_HOST}:${daemonPort}/selection`;
  try {
    const res = await fetch(url, {
      // Signed request — the session token itself never crosses the wire.
      headers: { ...signRequest(token, "GET", "/selection", ""), Host: `${DAEMON_HOST}:${daemonPort}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return {
        ok: false,
        selection: null,
        pluginConnected: false,
        message:
          res.status === 404
            ? "Daemon predates the selection feature — restart it via figma_connect."
            : `Daemon answered HTTP ${res.status}.`,
      };
    }
    const raw = await res.json();
    return {
      ok: true,
      selection: raw.selection || null,
      pluginConnected: raw.pluginConnected === true,
      message: "",
    };
  } catch (err) {
    return {
      ok: false,
      selection: null,
      pluginConnected: false,
      message: `Daemon not reachable at ${url}: ${err.message}. Run figma_connect first.`,
    };
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
      // Signed request — the session token itself never crosses the wire.
      headers: { ...signRequest(token, "GET", "/health", ""), Host: `${DAEMON_HOST}:${daemonPort}` },
      signal: controller.signal,
    });
    const raw = await res.json();
    // 403 = a daemon answered but rejected OUR token. Without this branch the
    // message below reads "plugin NOT connected" and sends the user to
    // relaunch the plugin — the actual problem is a token mismatch (stale
    // token file, or a foreign daemon on the port).
    if (res.status === 403) {
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
