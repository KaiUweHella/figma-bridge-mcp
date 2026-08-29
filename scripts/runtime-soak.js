#!/usr/bin/env node

// Live Figma Desktop Adapter for the maintainer Runtime Soak.
//
// This script is intentionally outside the MCP tool surface. Running it
// requires two explicit Figma files plus a visible disposable-write opt-in.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemonClient } from "../engine/src/lib/daemon-client.js";
import { portFilePath } from "../engine/src/lib/daemon-port.js";
import { createWorkspaceIO } from "../engine/src/lib/workspace-io.js";
import { ensureSafeConnect } from "../src/engine.js";
import {
  DAEMON_HOST,
  DAEMON_TOKEN_FILE,
  REPO_ROOT,
  getDaemonPort,
} from "../src/config.js";
import { resolveFigmaTarget } from "../src/figma-target.js";
import {
  RUNTIME_SOAK_PLUGIN_DATA,
  runRuntimeSoak,
} from "./lib/runtime-soak-harness.js";

const execFileAsync = promisify(execFile);
const TARGET_KEY = /^[A-Za-z0-9]{10,64}$/;
const HELP = `Usage:
  FIGMA_SOAK_FILE_A=<key-or-url> FIGMA_SOAK_FILE_B=<key-or-url> \\
    npm run accept:runtime-soak -- --confirm-disposable-writes --output <workspace-path>

Options:
  --file-a <key-or-url>          Explicit first Figma Design file (env preferred)
  --file-b <key-or-url>          Explicit second Figma Design file (env preferred)
  --output <path>                New 0600 JSON report inside workspace docs-local/
  --cycles <2..1000>             Alternating targeted reads (default: 50)
  --idle-ms <1000..2000>         Temporary daemon idle timeout (default: 1500)
  --event-delay-ms <25..5000>    Delay before controlled Plugin reload (default: 150)
  --hold-ms <delay..15000>       In-flight read/write hold (default: 1200)
  --confirm-disposable-writes    Required acknowledgement of temporary Figma nodes
  --skip-editor-sleep-wake       Produce an incomplete report without the manual checkpoint
  --help                         Show this help
`;

function parseInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    fileA: process.env.FIGMA_SOAK_FILE_A || null,
    fileB: process.env.FIGMA_SOAK_FILE_B || null,
    output: null,
    cycles: 50,
    idleMs: 1500,
    eventDelayMs: 150,
    holdMs: 1200,
    confirm: false,
    skipEditorSleepWake: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--confirm-disposable-writes") {
      options.confirm = true;
      continue;
    }
    if (arg === "--skip-editor-sleep-wake") {
      options.skipEditorSleepWake = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--file-a") options.fileA = value;
    else if (arg === "--file-b") options.fileB = value;
    else if (arg === "--output") options.output = value;
    else if (arg === "--cycles")
      options.cycles = parseInteger(value, arg, options.cycles);
    else if (arg === "--idle-ms")
      options.idleMs = parseInteger(value, arg, options.idleMs);
    else if (arg === "--event-delay-ms")
      options.eventDelayMs = parseInteger(value, arg, options.eventDelayMs);
    else if (arg === "--hold-ms")
      options.holdMs = parseInteger(value, arg, options.holdMs);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function targetKey(input, label) {
  const key = resolveFigmaTarget({ explicitFileKey: input }).fileKey;
  if (!key || !TARGET_KEY.test(key))
    throw new Error(`${label} must be a valid Figma file key or URL`);
  return key;
}

function readDaemonToken() {
  try {
    return readFileSync(DAEMON_TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDaemonStateRemoval({
  maxWaitMs = 6000,
  statePath = portFilePath(),
  existsFile = existsSync,
  now = Date.now,
  wait = sleep,
  pollMs = 100,
} = {}) {
  const deadline = now() + maxWaitMs;
  do {
    if (!existsFile(statePath)) return true;
    if (now() >= deadline) return false;
    await wait(pollMs);
  } while (true);
}

function bridgeFailure(kind, phase, outcome) {
  return Object.assign(new Error("Runtime Soak bridge event failed"), {
    kind,
    phase,
    outcome,
  });
}

function codeForWrite(marker, holdMs) {
  return `(async () => {
    if (figma.editorType !== 'figma') throw new Error('Runtime Soak requires Figma Design');
    const node = figma.createRectangle();
    node.name = ${JSON.stringify(marker.label)};
    node.resize(48, 48);
    node.fills = [{ type: 'SOLID', color: { r: 0.95, g: 0.18, b: 0.55 } }];
    let right = 0;
    for (const child of figma.currentPage.children) {
      if (child !== node && 'x' in child && 'width' in child) right = Math.max(right, child.x + child.width);
    }
    node.x = right + 96;
    node.y = 0;
    node.setPluginData(${JSON.stringify(RUNTIME_SOAK_PLUGIN_DATA.run)}, ${JSON.stringify(marker.runId)});
    node.setPluginData(${JSON.stringify(RUNTIME_SOAK_PLUGIN_DATA.marker)}, ${JSON.stringify(marker.token)});
    ${holdMs > 0 ? `await new Promise(resolve => setTimeout(resolve, ${holdMs}));` : ""}
    return { created: true };
  })()`;
}

function codeForRead(marker, holdMs) {
  return `(async () => {
    await figma.loadAllPagesAsync();
    const matches = figma.root.findAll(node =>
      typeof node.getPluginData === 'function' &&
      node.getPluginData(${JSON.stringify(RUNTIME_SOAK_PLUGIN_DATA.marker)}) === ${JSON.stringify(marker.token)}
    );
    const result = {
      count: matches.length,
      marker: matches.length === 1
        ? matches[0].getPluginData(${JSON.stringify(RUNTIME_SOAK_PLUGIN_DATA.marker)})
        : null
    };
    ${holdMs > 0 ? `await new Promise(resolve => setTimeout(resolve, ${holdMs}));` : ""}
    return result;
  })()`;
}

function codeForCleanup(runId) {
  return `(async () => {
    await figma.loadAllPagesAsync();
    const matches = figma.root.findAll(node =>
      typeof node.getPluginData === 'function' &&
      node.getPluginData(${JSON.stringify(RUNTIME_SOAK_PLUGIN_DATA.run)}) === ${JSON.stringify(runId)}
    );
    for (const node of matches) node.remove();
    return { removed: matches.length };
  })()`;
}

function codeForCount(runId) {
  return `(async () => {
    await figma.loadAllPagesAsync();
    return figma.root.findAll(node =>
      typeof node.getPluginData === 'function' &&
      node.getPluginData(${JSON.stringify(RUNTIME_SOAK_PLUGIN_DATA.run)}) === ${JSON.stringify(runId)}
    ).length;
  })()`;
}

export function createLiveAdapters(client, { targets, idleMs, holdMs }) {
  const timeoutMs = Math.max(10_000, holdMs + 5000);
  const figmaEvalOptions = (target) => ({
    fileKey: target.key,
    expectedEditor: "figma",
    timeoutMs,
  });

  async function healthConnections() {
    const response = await client.health({ timeoutMs: 1500 });
    if (!response.ok)
      throw bridgeFailure("unavailable", "daemon-request", "not-dispatched");
    return Array.isArray(response.data?.connections)
      ? response.data.connections
      : [];
  }

  async function targetsReady(wantedTargets) {
    const connections = await healthConnections();
    return wantedTargets.every((target) =>
      connections.some(
        (connection) =>
          connection.fileKey === target.key && connection.editorType === "figma"
      )
    );
  }

  async function waitUntilReady(wantedTargets, maxWaitMs = 30_000) {
    const deadline = Date.now() + maxWaitMs;
    do {
      try {
        if (await targetsReady(wantedTargets)) return true;
      } catch {}
      if (Date.now() >= deadline) break;
      await sleep(250);
    } while (true);
    throw bridgeFailure(
      "plugin-unavailable",
      "target-resolution",
      "not-dispatched"
    );
  }

  async function startShortIdleDaemon() {
    const script = `
      const { ensureSafeConnect } = await import('./src/engine.js');
      await ensureSafeConnect();
    `;
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DAEMON_IDLE_TIMEOUT: String(idleMs) },
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }
    );
  }

  return Object.freeze({
    async preflight() {
      await ensureSafeConnect();
      await waitUntilReady(targets);
      const connections = await healthConnections();
      for (const target of targets) {
        const matches = connections.filter(
          (connection) => connection.fileKey === target.key
        );
        if (matches.length !== 1 || matches[0].editorType !== "figma") {
          throw bridgeFailure(
            "targeting",
            "target-resolution",
            "not-dispatched"
          );
        }
      }
    },
    writeMarker(target, marker, { holdMs: requestedHold }) {
      return client.evaluate(
        codeForWrite(marker, requestedHold),
        figmaEvalOptions(target)
      );
    },
    readMarker(target, marker, { holdMs: requestedHold }) {
      return client.evaluate(
        codeForRead(marker, requestedHold),
        figmaEvalOptions(target)
      );
    },
    async reloadPlugin(target) {
      const response = await client.reconnect({
        fileKey: target.key,
        timeoutMs: 6500,
      });
      return (
        response.ok &&
        response.data?.hadPlugin === true &&
        response.data?.targeted === 1
      );
    },
    waitUntilReady,
    async editorSleepWake({ skipped }) {
      if (skipped) return false;
      if (!stdin.isTTY || !stdout.isTTY) {
        throw bridgeFailure(
          "manual-checkpoint",
          "editor-sleep-wake",
          "not-dispatched"
        );
      }
      stdout.write(
        "\nManual checkpoint: put Figma/the computer to sleep or background it, wake it, and keep both Plugin windows open.\n"
      );
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        await terminal.question(
          "Press Enter after both files have recovered: "
        );
      } finally {
        terminal.close();
      }
      await waitUntilReady(targets);
      return true;
    },
    async expireDaemon() {
      const shutdown = await client.shutdown({ timeoutMs: 3000 });
      if (!shutdown.ok || !(await waitForDaemonStateRemoval())) return false;
      await startShortIdleDaemon();
      await waitUntilReady(targets);
      if (
        await waitForDaemonStateRemoval({ maxWaitMs: idleMs + 5000 })
      )
        return true;
      await client.shutdown({ timeoutMs: 3000 }).catch(() => {});
      await waitForDaemonStateRemoval();
      return false;
    },
    async recoverDaemon() {
      await ensureSafeConnect();
    },
    async cleanup(target, runId) {
      return client.evaluate(codeForCleanup(runId), figmaEvalOptions(target));
    },
    async countRunMarkers(target, runId) {
      return client.evaluate(codeForCount(runId), figmaEvalOptions(target));
    },
  });
}

export function writeRuntimeSoakReport(
  report,
  outputPath,
  { root = process.cwd() } = {}
) {
  const workspace = createWorkspaceIO({ root });
  const privateRoot = workspace.ensureDirectory(join(root, "docs-local"), {
    role: "runtime-soak-report",
  });
  const privateWorkspace = createWorkspaceIO({ root: privateRoot });
  const resolvedOutput = resolve(root, outputPath);
  const privateRelative = relative(resolve(root, "docs-local"), resolvedOutput);
  const canonicalOutput = resolve(privateRoot, privateRelative);
  return privateWorkspace.write(
    canonicalOutput,
    `${JSON.stringify(report, null, 2)}\n`,
    {
      role: "runtime-soak-report",
      mode: 0o600,
      createParents: true,
      exclusive: true,
      encoding: "utf8",
    }
  );
}

export async function runRuntimeSoakCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write(HELP);
    return 0;
  }
  if (!options.confirm)
    throw new Error(
      "Pass --confirm-disposable-writes to run the live acceptance"
    );
  if (!options.output) throw new Error("--output is required");
  const targets = Object.freeze([
    Object.freeze({ alias: "A", key: targetKey(options.fileA, "Target A") }),
    Object.freeze({ alias: "B", key: targetKey(options.fileB, "Target B") }),
  ]);
  if (targets[0].key === targets[1].key)
    throw new Error("Target A and B must be different files");

  const client = createDaemonClient({
    readToken: readDaemonToken,
    getPort: getDaemonPort,
    host: DAEMON_HOST,
    tokenFile: DAEMON_TOKEN_FILE,
  });
  const report = await runRuntimeSoak({
    targets,
    adapters: createLiveAdapters(client, {
      targets,
      idleMs: options.idleMs,
      holdMs: options.holdMs,
    }),
    cycles: options.cycles,
    idleMs: options.idleMs,
    eventDelayMs: options.eventDelayMs,
    holdMs: options.holdMs,
    skipEditorSleepWake: options.skipEditorSleepWake,
  });

  writeRuntimeSoakReport(report, options.output);
  stdout.write(`Runtime Soak ${report.status}; redacted report written.\n`);
  return report.status === "passed" ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runRuntimeSoakCli().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write(
        "Runtime Soak could not start. Run with --help and verify the explicit inputs.\n"
      );
      process.exitCode = 1;
    }
  );
}
