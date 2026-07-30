// Shared CLI core: daemon plumbing, figma eval helpers, config, program.
// Extracted from index.js — all command modules import from here.
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execSync, execFileSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { homedir, tmpdir } from 'os';
import { createServer } from 'http';
import { FigmaClient } from '../figma-client.js';
import * as apiDocs from '../api-docs.js';
import { extractGradient, extractMesh, buildMeshFromColors, buildFigmaPaint, buildCssString } from '../gradient-extractor.js';
import {
  nullDevice, killPort, getPortPid, sleepAfterStop,
  getFigmaVersion, isFigmaRunning, platformName
} from '../platform.js';
import { getDaemonPort, clearPortFile } from './daemon-port.js';
// Moved out of this file; re-exported below so command modules keep importing
// everything from one place.
import { unescapeShell, detectWrapperSplit } from './jsx-split.js';
import {
  GENERIC_NAME_PATTERNS, buildNodeSelector, componentContextExpr,
  hexToRgb, isVarRef, getVarName, generateFillCode, generateStrokeCode,
  varLoadingCode, smartPosCode,
} from './eval-snippets.js';
// default auto-names — they'd select every unnamed node in the whole tree.
// have fallen back to 3457-3460 when 3456 was held by a foreign process.
const DAEMON_PID_FILE = join(homedir(), '.figma-safe-mcp', 'daemon.pid');
const DAEMON_TOKEN_FILE = join(homedir(), '.figma-safe-mcp', '.daemon-token');

// Generate and save a new session token for daemon authentication
function generateDaemonToken() {
  const configDir = join(homedir(), '.figma-safe-mcp');
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
  const configDir = join(homedir(), '.figma-safe-mcp');
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
// ARRAY — never a shell string, so the daemon token can't hit shell parsing.
// Prepends -s and the X-Daemon-Token header; callers pass the URL and any
// extra flags. Returns stdout (utf8); throws like execFileSync on failure.
function daemonCurl(extraArgs, { timeout = 2000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const token = getDaemonToken();
  const args = ['-s'];
  if (token) args.push('-H', `X-Daemon-Token: ${token}`);
  args.push(...extraArgs);
  // maxBuffer: execFileSync defaults to 1 MB, which any real screenshot
  // response exceeds (ENOBUFS). 64 MB covers 4x exports of large frames.
  return execFileSync('curl', args, { encoding: 'utf8', stdio: 'pipe', timeout, maxBuffer });
}

// Process-level health cache. A single CLI command checks daemon health 3-4
// times across checkConnection/fastRender/command-internal guards — each was a
// fresh `curl` subprocess spawn. Since a CLI process is short-lived, caching the
// boolean result for a brief window collapses those to one spawn. `force` and
// the detail form always bypass the cache (used by retry/fallback logic that
// must see the live state after a failure).
let _daemonHealthCache = { time: 0, value: null, port: null };
const DAEMON_HEALTH_TTL_MS = 2000;
function invalidateDaemonHealthCache() { _daemonHealthCache = { time: 0, value: null, port: null }; }

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

// Send command to daemon (uses native fetch in Node 18+)
async function daemonExec(action, data = {}, timeoutMs = 90000) {
  const token = getDaemonToken();
  const headers = { 'Content-Type': 'application/json' };

  // Fail fast with clear error if token is missing
  if (!token) {
    const status = getTokenStatus();
    if (!status.tokenFileExists) {
      throw new Error(
        `Daemon token not found at ${DAEMON_TOKEN_FILE}\n` +
        `Run "node src/index.js connect" to start the daemon and generate a token.`
      );
    }
    throw new Error(
      `Failed to read daemon token from ${DAEMON_TOKEN_FILE}\n` +
      `${status.readError || 'Unknown error'}`
    );
  }

  headers['X-Daemon-Token'] = token;

  try {
    const response = await fetch(`http://localhost:${getDaemonPort()}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...data }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      const text = await response.text();
      // Try to parse as JSON error from daemon
      try {
        const errObj = JSON.parse(text);
        if (errObj.error) {
          // Enhance auth errors with helpful info
          if (errObj.error.includes('Unauthorized') || errObj.error.includes('token')) {
            throw new Error(
              `${errObj.error}\n` +
              `Token file: ${DAEMON_TOKEN_FILE}\n` +
              `Try: node src/index.js daemon restart`
            );
          }
          // Safe Mode: plugin tab was closed → guide the user back to it
          // instead of just dumping the raw error.
          if (/Plugin not connected/i.test(errObj.error)) {
            throw new Error(
              'Plugin not connected.\n' +
              'In Figma: Plugins → Development → FigCli (keep that tab open).\n' +
              'Or switch to Yolo Mode: node src/index.js connect'
            );
          }
          // Clean up error: remove stack trace line numbers for cleaner output
          const cleanError = errObj.error.split('\n')[0];
          throw new Error(cleanError);
        }
      } catch (parseErr) {
        if (parseErr.message && !parseErr.message.includes('JSON')) {
          throw parseErr; // Re-throw our clean error
        }
      }
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const result = await response.json();
    if (result.error) throw new Error(result.error);
    return result.result;
  } catch (e) {
    if (e.name === 'TimeoutError' || e.message.includes('timeout')) {
      throw new Error(`Execution timeout (${timeoutMs/1000}s). Try reconnecting: node src/index.js connect`);
    }
    throw e;
  }
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

// Fast eval via daemon (plugin bridge only — no direct CDP fallback)
async function fastEval(code) {
  if (!(await ensureDaemonRunning())) {
    throw new Error(NOT_CONNECTED_MSG);
  }
  // Let a daemon error propagate — the plugin bridge is the only path.
  return await daemonExec('eval', { code });
}

// Fast render via daemon (plugin bridge only — no direct CDP fallback)
async function fastRender(jsx) {
  // The daemon OWNS the render once it's up. A failed daemon call is surfaced
  // as-is: it may have already created the frame before erroring, and a retry
  // would silently DUPLICATE it.
  if (!(await ensureDaemonRunning())) {
    throw new Error(NOT_CONNECTED_MSG);
  }
  return await daemonExec('render', { jsx });
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
  } else if (isDaemonRunning(false, true)) {
    // force=true: bypass the 2s health cache. A stale cached "down" here
    // would rotate the session token underneath a LIVE daemon.
    return true; // Already running
  }

  // Generate session token before spawning daemon. Safe even if a daemon
  // wins a concurrent race: the daemon re-reads the token file per request.
  const newToken = generateDaemonToken();

  const daemonScript = join(__dirname, 'daemon.js');
  // Use the same node binary that launched this process (process.execPath),
  // not whatever 'node' resolves to on PATH — the MCP server may spawn the
  // engine with a node that isn't on PATH. PLUGIN_KEY_FILE (if set by the MCP
  // layer) rides along in ...process.env and is passed explicitly for clarity.
  //
  // DAEMON_PORT is only forwarded when the USER set it. Passing the resolved
  // port would freeze a stale port-file value into the child (a one-time 3457
  // fallback would become sticky); without it the daemon self-selects starting
  // at 3456 and republishes whatever it binds.
  const daemonEnv = {
    ...process.env,
    DAEMON_MODE: 'plugin',
    PLUGIN_KEY_FILE: process.env.PLUGIN_KEY_FILE || ''
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

// Stop daemon
function stopDaemon() {
  invalidateDaemonHealthCache(); // state changed — don't serve a stale "up"
  try {
    let filePid = null;
    if (existsSync(DAEMON_PID_FILE)) {
      filePid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8').trim(), 10);
      try {
        process.kill(filePid, 'SIGTERM');
      } catch {}
      unlinkSync(DAEMON_PID_FILE);
    }
    // Kill-by-port ONLY when the listener is provably our daemon (PID file
    // match). After an idle shutdown the port file is gone and the resolved
    // port is the range default — killPort() there would SIGKILL whatever
    // foreign process the port fallback deliberately left alone.
    try {
      const port = getDaemonPort();
      const raw = getPortPid(port);
      if (raw && filePid !== null) {
        const pids = String(raw).split('\n').map((s) => parseInt(s.trim(), 10));
        if (pids.includes(filePid)) killPort(port);
      }
    } catch {}
    clearPortFile();
  } catch {}
}

// (getFigmaPath / startFigma / killFigma / getManualStartCommand removed:
// launching Figma with a debug port belongs to the CDP/Yolo path this build
// does not have. The user opens Figma Desktop normally.)

// NOTE: this file lives in src/lib/ — keep __dirname pointing at src/ so
// daemon.js / figma-client.js / package.json resolve as before the split.
const __dirname = join(dirname(fileURLToPath(import.meta.url)), '..');
const __filename = join(__dirname, 'index.js');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const CONFIG_DIR = join(homedir(), '.figma-safe-mcp');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const program = new Command();

// Helper: Prompt user
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

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
  'Not connected to Figma. Run figma_connect, then launch the FigCli plugin in Figma Desktop and paste your access key.';

// (getFigmaClient / figmaEval removed: both existed only to reach the CDP
// transport. Everything goes through daemonExec / fastEval / figmaEvalSync.)

// Sync eval through the daemon (curl); used by the few sync CLI paths.
function figmaEvalSync(code) {
  // Try daemon first (fast path)
  const daemonRunning = isDaemonRunning();
  if (daemonRunning) {
    try {
      // Wrap code to ensure return value for plugin mode
      // CDP returns last expression automatically, plugin needs explicit return
      let wrappedCode = code.trim();
      // Don't wrap if already an IIFE or starts with return - plugin handles these
      // For simple expressions and multi-statement code, just pass through
      // The plugin will add return to the last statement
      const payload = JSON.stringify({ action: 'eval', code: wrappedCode });
      const payloadFile = join(tmpdir(), `figma-payload-${Date.now()}.json`);
      writeFileSync(payloadFile, payload);
      const result = daemonCurl(
        ['-X', 'POST', `http://127.0.0.1:${getDaemonPort()}/exec`,
         '-H', 'Content-Type: application/json', '-d', `@${payloadFile}`],
        { timeout: 60000 }
      );
      try { unlinkSync(payloadFile); } catch {}
      if (!result || result.trim() === '') {
        throw new Error('Empty response from daemon');
      }
      const data = JSON.parse(result);
      if (data.error) throw new Error(data.error);
      return data.result;
    } catch (e) {
      // Safe Mode: the plugin bridge is the only path. Re-throw the daemon
      // error instead of falling through to a (removed) direct CDP connection.
      throw e;
    }
  }

  // Daemon not running — no direct CDP fallback exists in the Safe-Mode build.
  throw new Error(NOT_CONNECTED_MSG);
}

/**
 * Finish a spinner with a SUCCESS message on stdout.
 *
 * ora writes to stderr (correct for the animation), but `spinner.succeed()`
 * persists the success line there too. The MCP layer folds stderr into its
 * reply under a `[warnings]` header — so "Created 12 variables" reached the
 * agent labelled as a warning. Failures stay on stderr where they belong.
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
    const health = daemonCurl([`http://127.0.0.1:${getDaemonPort()}/health`]);
    const data = JSON.parse(health);
    return data.status === 'ok' && !!data.plugin;
  } catch {
    return false;
  }
}

// Helper: Check connection
async function checkConnection() {
  // Self-heal: if the daemon idle-shut-down, bring it back BEFORE any command
  // tries to talk to it. Several command paths (e.g. render-batch) call
  // daemonExec directly with no fallback, so a dead daemon would hard-error
  // rather than just run slow. Resurrecting it here keeps the fast path alive.
  await ensureDaemonRunning();

  if (daemonHealthy()) return true;

  // No direct CDP fallback in Safe Mode — the plugin bridge must be connected.
  console.log(chalk.red('\n✗ Not connected to Figma\n'));
  console.log(chalk.white('  Run figma_connect, then launch the FigCli plugin'));
  console.log(chalk.white('  in Figma Desktop and paste your access key.\n'));
  process.exit(1);
}

// Helper: Check if Figma is patched
function isFigmaPatched() {
  const config = loadConfig();
  return config.patched === true;
}

// Helper: Hex to Figma RGB (handles both #RGB and #RRGGBB)
// Prints the error, then tries to surface relevant Figma Plugin API docs.
function handleEvalError(e) {
  console.error(chalk.red('✗'), e.message);
  try { apiDocs.suggestFromError(e.message); } catch { /* docs not installed, no-op */ }
  process.exit(1);
}

// Helper: Check if Safe Mode (plugin only)
export {
  CONFIG_DIR,
  CONFIG_FILE,
  DAEMON_PID_FILE,
  getDaemonPort,
  DAEMON_TOKEN_FILE,
  GENERIC_NAME_PATTERNS,
  __dirname,
  __filename,
  buildNodeSelector,
  checkConnection,
  componentContextExpr,
  daemonCurl,
  daemonExec,
  detectWrapperSplit,
  fastEval,
  fastRender,
  figmaEvalSync,
  evalPrint,
  spinnerSucceed,
  selectNode,
  listVariables,
  findVariables,
  listCollections,
  createCollection,
  generateDaemonToken,
  generateFillCode,
  generateStrokeCode,
  getDaemonToken,
  getTokenStatus,
  getVarName,
  handleEvalError,
  hexToRgb,
  isDaemonRunning,
  isFigmaPatched,
  isVarRef,
  loadConfig,
  pkg,
  program,
  prompt,
  saveConfig,
  smartPosCode,
  startDaemon,
  stopDaemon,
  unescapeShell,
  varLoadingCode
};
