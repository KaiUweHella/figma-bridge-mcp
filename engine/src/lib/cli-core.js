// Shared CLI core: daemon plumbing, figma eval helpers, config, program.
// Extracted from index.js — all command modules import from here.
import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as apiDocs from '../api-docs.js';
import { nullDevice, getPortPid, sleepAfterStop } from '../platform.js';
import { getDaemonPort, clearPortFile } from './daemon-port.js';
import { signRequest } from './daemon-auth.js';
import { createDaemonClient } from './daemon-client.js';
import { PLUGIN_BUILD_VERSION } from './plugin-version.js';
import { retrySafeRead } from './safe-read-retry.js';
import { STATE_DIR } from './state-dir.js';
// Moved out of this file; re-exported below so command modules keep importing
// everything from one place.
import { unescapeShell, detectWrapperSplit } from './jsx-split.js';
import {
  GENERIC_NAME_PATTERNS, buildNodeSelector, componentContextExpr,
  hexToRgb, isVarRef, getVarName, generateFillCode, generateStrokeCode,
  varLoadingCode, smartPosCode,
} from './eval-snippets.js';
// Match daemon.js and the MCP layer: callers/tests may isolate daemon state
// without changing the user's real pairing directory.
const DAEMON_PID_FILE = process.env.DAEMON_PID_FILE || join(STATE_DIR, 'daemon.pid');
const DAEMON_TOKEN_FILE = process.env.DAEMON_TOKEN_FILE || join(STATE_DIR, '.daemon-token');
const DEFAULT_PLUGIN_KEY_FILE = join(STATE_DIR, 'plugin-key');

// The MCP wrapper passes PLUGIN_KEY_FILE explicitly, but the vendored engine is
// also a supported local entry point (`connect`, `daemon restart`). Falling
// back to the shared state directory keeps those paths paired with the same
// plugin instead of silently launching an unauthenticated daemon.
function getPluginKeyFile() {
  return process.env.PLUGIN_KEY_FILE || DEFAULT_PLUGIN_KEY_FILE;
}

// Generate and save a new session token for daemon authentication
function generateDaemonToken() {
  const configDir = STATE_DIR;
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(DAEMON_TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

// Read the current daemon session token
function getDaemonToken() {
  try {
    return readFileSync(DAEMON_TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

// Get detailed token status for debugging
function getTokenStatus() {
  const configDir = STATE_DIR;
  const tokenPath = DAEMON_TOKEN_FILE;
  const status = {
    configDir,
    tokenPath,
    configDirExists: existsSync(configDir),
    tokenFileExists: existsSync(tokenPath),
    token: null,
    tokenPreview: null
  };

  if (status.tokenFileExists) {
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      status.token = token;
      status.tokenPreview = token.slice(0, 8) + '...' + token.slice(-8);
    } catch (e) {
      status.readError = e.message;
    }
  }

  return status;
}

// Sync HTTP call to the local daemon: curl via execFileSync with an ARGUMENT
// ARRAY — never a shell string, so header values can't hit shell parsing.
// Prepends -s and the signed auth headers (HMAC over method/path/body — the
// session token itself never crosses the wire, so a squatter on a range port
// cannot harvest it). `path` and `body` MUST match what the extraArgs URL and
// payload actually send, or the daemon rejects the signature. A body is fed
// via stdin (`-d @-`), never a temp file — the old Date.now()-named tmp file
// collided between concurrent CLI processes and sat in world-writable tmp.
function daemonCurl(path, extraArgs, { method = 'GET', body = '', timeout = 2000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const token = getDaemonToken();
  const args = ['-s'];
  if (token) {
    for (const [name, value] of Object.entries(signRequest(token, method, path, body))) {
      args.push('-H', `${name}: ${value}`);
    }
  }
  args.push(...extraArgs);
  // maxBuffer: execFileSync defaults to 1 MB, which any real screenshot
  // response exceeds (ENOBUFS). 64 MB covers 4x exports of large frames.
  return execFileSync('curl', args, {
    encoding: 'utf8', stdio: 'pipe', input: body || undefined, timeout, maxBuffer,
  });
}

// Process-level health cache. A single CLI command checks daemon health 3-4
// times across checkConnection/fastEval/command-internal guards — each was a
// fresh `curl` subprocess spawn. Since a CLI process is short-lived, caching the
// boolean result for a brief window collapses those to one spawn. `force` and
// the detail form always bypass the cache (used by retry/fallback logic that
// must see the live state after a failure).
let _daemonHealthCache = { time: 0, value: null, port: null };
const DAEMON_HEALTH_TTL_MS = 2000;
function invalidateDaemonHealthCache() { _daemonHealthCache = { time: 0, value: null, port: null }; }

function daemonBuildMatchesCurrent() {
  try {
    const raw = daemonCurl('/health', [`http://127.0.0.1:${getDaemonPort()}/health`], { timeout: 1000 });
    return JSON.parse(raw).bridgeBuildVersion === PLUGIN_BUILD_VERSION;
  } catch {
    return false;
  }
}

// Check if daemon is running (returns object with details, or false)
function isDaemonRunning(returnDetails = false, force = false) {
  // The cache is keyed by the RESOLVED port: after a fallback the daemon may
  // publish a new port within the TTL window, and a cached "down" for the old
  // port must not answer for the new one.
  const port = getDaemonPort();
  if (!returnDetails && !force && _daemonHealthCache.value !== null &&
      _daemonHealthCache.port === port &&
      Date.now() - _daemonHealthCache.time < DAEMON_HEALTH_TTL_MS) {
    return _daemonHealthCache.value;
  }
  try {
    const token = getDaemonToken();
    const response = daemonCurl(
      '/health',
      ['-o', nullDevice, '-w', '%{http_code}', `http://127.0.0.1:${port}/health`],
      { timeout: 1000 }
    );
    const statusCode = response.trim();

    if (returnDetails) {
      return {
        running: statusCode === '200',
        statusCode,
        hasToken: !!token,
        authFailed: statusCode === '403'
      };
    }
    const ok = statusCode === '200';
    _daemonHealthCache = { time: Date.now(), value: ok, port };
    return ok;
  } catch (e) {
    if (returnDetails) {
      return {
        running: false,
        error: e.message,
        hasToken: !!getDaemonToken()
      };
    }
    _daemonHealthCache = { time: Date.now(), value: false, port };
    return false;
  }
}

let _asyncDaemonClient = null;

function asyncDaemonClient() {
  if (_asyncDaemonClient) return _asyncDaemonClient;
  _asyncDaemonClient = createDaemonClient({
    readToken: getDaemonToken,
    getPort: getDaemonPort,
    tokenFile: DAEMON_TOKEN_FILE,
    defaultFileKey: targetFileKey,
    missingTokenMessage: () => {
      const status = getTokenStatus();
      return status.tokenFileExists
        ? `Failed to read daemon token from ${DAEMON_TOKEN_FILE}\n${status.readError || 'Unknown error'}`
        : `Daemon token not found at ${DAEMON_TOKEN_FILE}\nRun "node src/index.js connect" to start the daemon and generate a token.`;
    },
  });
  return _asyncDaemonClient;
}

// Send command through the shared daemon transport Module. Explicit fileKey
// in data wins; otherwise the CLI adapter supplies its global target.
async function daemonExec(action, data = {}, timeoutMs = 90000) {
  return asyncDaemonClient().execute(action, data, { timeoutMs });
}

// Ensure the daemon is up before sending it work. The daemon idle-shuts-down
// after a while, so a command issued after a quiet stretch would otherwise find
// it dead and limp along on the slow direct-connection path for the rest of the
// session. Here we transparently respawn it and wait briefly for health, so the
// fast path self-heals. Only auto-restarts when the user has connected before
// (PID file present) — never spawns a daemon on a fresh, never-connected setup.
async function ensureDaemonRunning(maxWaitMs = 5000) {
  if (isDaemonRunning()) return true;
  // Guard: only resurrect a daemon the user actually set up — a PID file is
  // present once figma_connect has started the daemon (idle-shutdown leaves it).
  // Never spawn a daemon on a fresh, never-connected setup.
  if (!existsSync(DAEMON_PID_FILE)) return false;
  try {
    startDaemon();
  } catch {
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 200));
    if (isDaemonRunning(false, true)) return true; // force: bypass the "false" we just cached
  }
  return false;
}

/**
 * Which connected Figma file a command targets, from the global `--file`.
 * Accepts a bare key or a full Figma URL, so a user can paste what they have.
 * Null means "the only connected window", which the daemon resolves; with
 * several connected it refuses rather than picking one.
 */
function targetFileKey() {
  let raw = null;
  try { raw = program.opts().figmaFile || null; } catch { raw = null; }
  if (!raw) return null;
  const url = /figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/.exec(String(raw));
  return url ? url[1] : String(raw).trim();
}

// Fast eval via daemon (plugin bridge only — no direct CDP fallback)
async function fastEval(code) {
  if (!(await ensureDaemonRunning())) {
    throw new Error(NOT_CONNECTED_MSG);
  }
  // Let a daemon error propagate — the plugin bridge is the only path.
  return await daemonExec('eval', { code });
}

// Read-only commands may safely repeat one eval after a brief socket churn.
// Mutation commands must continue using fastEval: their result can be lost
// after Figma accepted the write, so replaying them could duplicate content.
async function safeReadEval(code) {
  return retrySafeRead(() => fastEval(code), {
    waitUntilReady: () => waitForPluginConnection(),
  });
}

// Start daemon in background. The Safe-Mode build only ever runs the daemon in
// plugin mode; the `mode` argument is accepted for signature compatibility but
// ignored.
function startDaemon(forceRestart = false, mode = 'plugin') {
  // If force restart, always kill existing daemon first
  if (forceRestart) {
    // stopDaemon() kills the daemon's own PID (guarded — never a foreign
    // process squatting the default port) and clears the port file.
    stopDaemon();
    sleepAfterStop();
  } else if (isDaemonRunning(false, true) && daemonBuildMatchesCurrent()) {
    // force=true: bypass the 2s health cache. A stale cached "down" here
    // would rotate the session token underneath a LIVE daemon.
    return true; // Already running
  } else if (isDaemonRunning(false, true)) {
    // A detached daemon can survive an MCP client upgrade. Replace an older
    // bridge build once; later sessions match and preserve it normally.
    stopDaemon();
    sleepAfterStop();
  }

  // Generate session token before spawning daemon. Safe even if a daemon
  // wins a concurrent race: the daemon re-reads the token file per request.
  const newToken = generateDaemonToken();

  const daemonScript = join(__dirname, 'daemon.js');
  // Use the same node binary that launched this process (process.execPath),
  // not whatever 'node' resolves to on PATH — the MCP server may spawn the
  // engine with a node that isn't on PATH. PLUGIN_KEY_FILE (if set by the MCP
  // layer) rides along in ...process.env; direct engine invocations fall back
  // to the same state-dir key used by the MCP layer.
  //
  // DAEMON_PORT is only forwarded when the USER set it. Passing the resolved
  // port would freeze a stale port-file value into the child (a one-time 3457
  // fallback would become sticky); without it the daemon self-selects starting
  // at 3456 and republishes whatever it binds.
  const daemonEnv = {
    ...process.env,
    DAEMON_MODE: 'plugin',
    PLUGIN_KEY_FILE: getPluginKeyFile()
  };
  if (!process.env.DAEMON_PORT) delete daemonEnv.DAEMON_PORT;
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: 'ignore',
    env: daemonEnv
  });
  child.unref();

  // Do NOT write the PID file here. Under a concurrent check-then-act race two
  // CLIs can each spawn a daemon; only one wins the port bind. The WINNING daemon
  // writes its own pid on listen-success (see daemon.js); the loser exits on
  // EADDRINUSE without touching it. Writing child.pid here (the loser's) is what
  // caused the PID file to point at a dead process → daemon churn.
  invalidateDaemonHealthCache(); // state changed — don't serve a stale "down"
  return true;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listeningPids(port) {
  try {
    const raw = getPortPid(port);
    if (!raw) return [];
    return String(raw).split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 1);
  } catch {
    return [];
  }
}

function sleepMs(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* best-effort fallback */ }
  }
}

// Terminate only a process that is BOTH named by our PID file and currently
// owns the published listening socket. This guards against stale PID reuse.
// Escalation is PID-specific: connected clients (including Figma Desktop) are
// never swept up just because they share the TCP port.
function terminateVerifiedDaemon(pid, port, graceMs = 500) {
  if (!Number.isInteger(pid) || pid <= 1 || !listeningPids(port).includes(pid)) return false;
  try { process.kill(pid, 'SIGTERM'); } catch { return true; }
  sleepMs(graceMs);
  if (!processAlive(pid)) return true;
  // If the daemon already released its listener, the restart can proceed and
  // a still-draining process must not be force-killed. Recheck ownership to
  // protect against PID reuse during the grace window as well.
  if (!listeningPids(port).includes(pid)) return true;
  try { process.kill(pid, 'SIGKILL'); } catch { return true; }
  sleepMs(100);
  return !processAlive(pid);
}

// Stop daemon
function stopDaemon() {
  invalidateDaemonHealthCache(); // state changed — don't serve a stale "up"
  try {
    let filePid = null;
    const port = getDaemonPort();
    if (existsSync(DAEMON_PID_FILE)) {
      filePid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8').trim(), 10);
      // Prefer an authenticated in-band shutdown. This works even when OS
      // listener inspection is unavailable and lets active evals drain. A
      // foreign service cannot authenticate this request.
      try {
        daemonCurl('/shutdown', [`http://127.0.0.1:${port}/shutdown`], { timeout: 1000 });
        sleepMs(150);
      } catch {}
      terminateVerifiedDaemon(filePid, port);
      // Do not unlink a PID written by a replacement daemon in a concurrent
      // restart race. The contents must still be the PID we inspected.
      try {
        const current = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8').trim(), 10);
        if (current === filePid) unlinkSync(DAEMON_PID_FILE);
      } catch {}
    }
    // A dying old daemon must not delete a newer daemon's published port.
    clearPortFile(process.env, port);
  } catch {}
}

// (getFigmaPath / startFigma / killFigma / getManualStartCommand removed:
// launching Figma with a debug port belongs to the CDP/Yolo path this build
// does not have. The user opens Figma Desktop normally.)

// NOTE: this file lives in src/lib/ — keep __dirname pointing at src/ so
// daemon.js / lib modules / package.json resolve as before the split.
const __dirname = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const CONFIG_DIR = STATE_DIR;
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const program = new Command();

// Helper: Load config
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

// Helper: Save config
function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Direct CDP connection is removed in the Safe-Mode-only build. Every command
// runs through the daemon → plugin bridge. This is the single choke point that
// all former "direct fallback" paths flowed through, so neutering it here turns
// every stray CDP fallback into one clear, actionable error.
const NOT_CONNECTED_MSG =
  'Not connected to Figma. Run figma_connect, then launch the Figma Bridge plugin in Figma Desktop and paste your access key.';

// (getFigmaClient / figmaEval removed: both existed only to reach the CDP
// transport. Everything goes through daemonExec / fastEval / figmaEvalSync.)

// Sync eval through the daemon (curl); used by the few sync CLI paths.
function figmaEvalSync(code) {
  if (!isDaemonRunning()) {
    // Daemon not running — the plugin bridge is the only path in Safe Mode.
    throw new Error(NOT_CONNECTED_MSG);
  }
  // The plugin adds `return` to the last statement itself — pass code as-is.
  // Payload rides on curl's STDIN (`-d @-`): no temp file, so concurrent CLI
  // processes can't clobber each other's payloads and nothing predictable
  // lands in world-writable tmp.
  const fileKey = targetFileKey();
  const payload = JSON.stringify({
    action: 'eval',
    code: code.trim(),
    ...(fileKey ? { fileKey } : {}),
  });
  const result = daemonCurl(
    '/exec',
    ['-X', 'POST', `http://127.0.0.1:${getDaemonPort()}/exec`,
     '-H', 'Content-Type: application/json', '-d', '@-'],
    { method: 'POST', body: payload, timeout: 60000 }
  );
  if (!result || result.trim() === '') {
    throw new Error('Empty response from daemon');
  }
  const data = JSON.parse(result);
  if (data.error) throw new Error(data.error);
  return data.result;
}

/**
 * Progress reporter for long-running commands. Replaces ora.
 *
 * The engine's caller is the MCP server: it captures stdout and stderr as
 * text, so an animated spinner was pure noise there — repainted frames and
 * escape codes for nobody to watch. This writes ONE line per state change,
 * and only when stderr is a terminal (i.e. a human is actually watching).
 *
 * The shape matches what the command files already call: `.start()`,
 * assignment to `.text`, `.fail()`, `.stop()`. `succeed()` is deliberately
 * absent — success belongs on stdout, via spinnerSucceed below.
 */
function progress(initial) {
  const live = process.stderr.isTTY;
  const write = (s) => { if (live) process.stderr.write(s + '\n'); };
  return {
    set text(t) { write(chalk.gray('  ' + t)); },
    get text() { return initial; },
    start() { write(chalk.gray('  ' + initial)); return this; },
    stop() { return this; },
    fail(msg) { console.error(chalk.red('\u2717') + ' ' + (msg || initial)); return this; },
  };
}

/**
 * Finish a progress reporter with a SUCCESS message on stdout.
 *
 * Progress goes to stderr, but a success line must not: the MCP layer folds
 * stderr into its reply under a `[warnings]` header — so "Created 12
 * variables" reached the agent labelled as a warning. Failures stay on
 * stderr where they belong.
 */
function spinnerSucceed(spinner, text) {
  try { spinner.stop(); } catch { /* already stopped */ }
  if (text) console.log(chalk.green('\u2713') + ' ' + text);
}

// Eval helpers. These replaced `figmaUse`, which took a command STRING,
// regex-re-parsed an embedded eval payload, un-escaped it and only then
// evaluated it — three encoding layers that also collapsed newlines (silently
// breaking `//` comments in generated code). These call the daemon directly.

/** Eval `code` in Figma and print the result (unless silent). */
function evalPrint(code, { silent = false } = {}) {
  const result = figmaEvalSync(code);
  if (!silent && result !== undefined) {
    console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
  }
  return typeof result === 'object' ? JSON.stringify(result) : String(result || '');
}

/** Select a single node by id. */
function selectNode(nodeId) {
  figmaEvalSync(`(async () => {
    const node = await figma.getNodeByIdAsync(${JSON.stringify(String(nodeId))});
    if (node) figma.currentPage.selection = [node];
  })()`);
  return 'Selected';
}

/** List local variables as "name (TYPE)" lines. */
function listVariables({ silent = false } = {}) {
  const result = figmaEvalSync(`(async () => {
    const vars = await figma.variables.getLocalVariablesAsync();
    return vars.map(v => v.name + ' (' + v.resolvedType + ')').join('\\n');
  })()`);
  if (!silent) console.log(result);
  return result;
}

/** Find local variables by name pattern (`*` allowed). */
function findVariables(pattern, { silent = false } = {}) {
  const result = figmaEvalSync(`(async () => {
    const pattern = ${JSON.stringify(String(pattern))}.replace('*', '.*');
    const re = new RegExp(pattern, 'i');
    const vars = await figma.variables.getLocalVariablesAsync();
    return vars.filter(v => re.test(v.name)).map(v => v.name).join('\\n');
  })()`);
  if (!silent) console.log(result);
  return result;
}

/** List variable collections as "name (N vars)" lines. */
function listCollections({ silent = false } = {}) {
  const result = figmaEvalSync(`(async () => {
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    return cols.map(c => c.name + ' (' + c.variableIds.length + ' vars)').join('\\n');
  })()`);
  if (!silent) console.log(result);
  return result;
}

/** Create a variable collection; returns its id. */
function createCollection(name, { silent = false } = {}) {
  const result = figmaEvalSync(`(() => {
    const col = figma.variables.createVariableCollection(${JSON.stringify(String(name))});
    return col.id;
  })()`);
  if (!silent) console.log(chalk.green('\u2713 Created collection: ' + name));
  return result;
}

// Single source of truth for "daemon up AND plugin bridge connected". All
// connection checks (checkConnection, `status`) go through this so
// the health contract lives in one place.
function daemonHealthy() {
  try {
    const health = daemonCurl('/health', [`http://127.0.0.1:${getDaemonPort()}/health`]);
    const data = JSON.parse(health);
    return data.status === 'ok' && !!data.plugin;
  } catch {
    return false;
  }
}

async function waitForPluginConnection(maxWaitMs = 8000) {
  if (!(await ensureDaemonRunning())) return false;
  const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0);
  do {
    if (daemonHealthy()) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (true);
  return false;
}

// Helper: Check connection
async function checkConnection() {
  // Self-heal: if the daemon idle-shut-down, bring it back BEFORE any command
  // tries to talk to it. Several command paths (e.g. render-batch) call
  // daemonExec directly with no fallback, so a dead daemon would hard-error
  // rather than just run slow. Resurrecting it here keeps the fast path alive.
  if (await waitForPluginConnection()) return true;

  // No direct CDP fallback in Safe Mode — the plugin bridge must be connected.
  console.log(chalk.red('\n✗ Not connected to Figma\n'));
  console.log(chalk.white('  Run figma_connect, then launch the Figma Bridge plugin'));
  console.log(chalk.white('  in Figma Desktop and paste your access key.\n'));
  process.exit(1);
}

// Prints the error, then tries to surface relevant Figma Plugin API docs.
function handleEvalError(e) {
  console.error(chalk.red('✗'), e.message);
  try { apiDocs.suggestFromError(e.message); } catch { /* docs not installed, no-op */ }
  process.exit(1);
}

export {
  CONFIG_DIR,
  DAEMON_PID_FILE,
  getDaemonPort,
  DAEMON_TOKEN_FILE,
  GENERIC_NAME_PATTERNS,
  __dirname,
  buildNodeSelector,
  checkConnection,
  componentContextExpr,
  daemonCurl,
  daemonExec,
  detectWrapperSplit,
  fastEval,
  safeReadEval,
  figmaEvalSync,
  evalPrint,
  progress,
  spinnerSucceed,
  selectNode,
  listVariables,
  findVariables,
  listCollections,
  createCollection,
  generateFillCode,
  generateStrokeCode,
  getDaemonToken,
  getTokenStatus,
  getVarName,
  handleEvalError,
  hexToRgb,
  isDaemonRunning,
  daemonBuildMatchesCurrent,
  isVarRef,
  loadConfig,
  pkg,
  program,
  saveConfig,
  smartPosCode,
  startDaemon,
  getPluginKeyFile,
  stopDaemon,
  unescapeShell,
  varLoadingCode
};
