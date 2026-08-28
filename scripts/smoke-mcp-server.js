#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.argv[2];
const engineEntry = process.argv[3];
if (!executable || !engineEntry) {
  process.stderr.write(
    "Usage: node scripts/smoke-mcp-server.js <server-executable> <engine-entry>\n"
  );
  process.exit(2);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

const port = await reservePort();
const scratch = realpathSync.native(
  mkdtempSync(join(tmpdir(), "figma-bridge-installed-smoke-"))
);
const stateDir = join(scratch, ".figma-bridge-mcp");
const smokeEnv = {
  ...process.env,
  HOME: scratch,
  USERPROFILE: scratch,
  AUDIT_LOG_PATH: join(stateDir, "audit.log"),
  DAEMON_PID_FILE: join(stateDir, "daemon.pid"),
  DAEMON_PORT: String(port),
  DAEMON_PORT_FILE: join(stateDir, "daemon-port"),
  DAEMON_TOKEN_FILE: join(stateDir, ".daemon-token"),
  PLUGIN_INSTALL_DIR: join(stateDir, "plugin"),
  PLUGIN_KEY_FILE: join(stateDir, "plugin-key"),
  REST_TOKEN_FILE: join(stateDir, "rest-token"),
};

const child = spawn(executable, [], {
  env: smokeEnv,
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
let complete = false;
let timeout;

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function resultText(payload) {
  return (payload?.result?.content || [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function requireToolSuccess(payload, name) {
  if (payload?.error)
    throw new Error(
      `${name} returned JSON-RPC error ${JSON.stringify(payload.error)}`
    );
  if (payload?.result?.isError === true)
    throw new Error(`${name} returned an MCP tool error`);
  const text = resultText(payload);
  if (!text) throw new Error(`${name} returned no text result`);
  return text;
}

function cleanup() {
  child.kill();
  const stopped = spawnSync(process.execPath, [engineEntry, "daemon", "stop"], {
    env: smokeEnv,
    encoding: "utf8",
    timeout: 10_000,
  });
  let error = null;
  if (stopped.error) error = `daemon cleanup failed: ${stopped.error.message}`;
  else if (stopped.status !== 0)
    error = `daemon cleanup exited with status ${stopped.status}`;
  else if (
    existsSync(smokeEnv.DAEMON_PID_FILE) ||
    existsSync(smokeEnv.DAEMON_PORT_FILE)
  )
    error = "daemon cleanup left live process state behind";
  rmSync(scratch, { recursive: true, force: true });
  return error;
}

function finish(error) {
  if (complete) return;
  complete = true;
  clearTimeout(timeout);
  const cleanupError = cleanup();
  const failure = error || cleanupError;
  if (failure) {
    process.stderr.write(`${failure}${stderr ? `\n${stderr}` : ""}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    "Packaged MCP initialize, pairing, authenticated daemon startup, status, and cleanup smoke passed.\n"
  );
}

child.stdout.on("data", (chunk) => {
  stdout += chunk;
  const lines = stdout.split("\n");
  stdout = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let payload;
    try {
      payload = JSON.parse(line);
      if (payload.id === 1) {
        if (payload.result?.serverInfo?.name !== "figma-bridge-mcp") {
          throw new Error(
            "Packaged MCP initialize returned the wrong server identity"
          );
        }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (payload.id === 2) {
        const tools = payload.result?.tools;
        if (
          !Array.isArray(tools) ||
          !tools.some((tool) => tool.name === "figma_spec")
        ) {
          throw new Error(
            "Packaged MCP tools/list did not expose the expected tool surface"
          );
        }
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "figma_pairing", arguments: {} },
        });
      } else if (payload.id === 3) {
        const text = requireToolSuccess(payload, "figma_pairing");
        if (!/Plugin access key/i.test(text))
          throw new Error("figma_pairing did not create an access key");
        const key = readFileSync(smokeEnv.PLUGIN_KEY_FILE, "utf8").trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(key))
          throw new Error("figma_pairing persisted an invalid access key");
        if (
          process.platform !== "win32" &&
          (statSync(smokeEnv.PLUGIN_KEY_FILE).mode & 0o777) !== 0o600
        ) {
          throw new Error("figma_pairing access-key file is not mode 0600");
        }
        send({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "figma_connect", arguments: {} },
        });
      } else if (payload.id === 4) {
        const text = requireToolSuccess(payload, "figma_connect");
        if (!/Safe Mode/i.test(text))
          throw new Error("figma_connect did not use Safe Mode");
        for (const required of [
          smokeEnv.DAEMON_PID_FILE,
          smokeEnv.DAEMON_PORT_FILE,
          smokeEnv.DAEMON_TOKEN_FILE,
          join(smokeEnv.PLUGIN_INSTALL_DIR, "manifest.json"),
          join(smokeEnv.PLUGIN_INSTALL_DIR, "manifest.dev.json"),
          join(smokeEnv.PLUGIN_INSTALL_DIR, "code.js"),
          join(smokeEnv.PLUGIN_INSTALL_DIR, "ui.html"),
        ]) {
          if (!existsSync(required))
            throw new Error(`figma_connect did not create ${required}`);
        }
        send({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "figma_status", arguments: { probePlugin: false } },
        });
      } else if (payload.id === 5) {
        const text = requireToolSuccess(payload, "figma_status");
        if (
          !/daemon running/i.test(text) ||
          !/access key: configured/i.test(text)
        ) {
          throw new Error(
            "figma_status did not confirm authenticated local startup"
          );
        }
        if (/authentication FAILED/i.test(text)) {
          throw new Error(
            "figma_status reported a daemon authentication failure"
          );
        }
        finish();
      }
    } catch (error) {
      finish(error.message);
      return;
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", (error) =>
  finish(`Unable to start packaged MCP: ${error.message}`)
);
child.on("exit", (code) => {
  if (!complete)
    finish(`Packaged MCP exited before the smoke completed (code ${code}).`);
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "package-smoke", version: "1.0.0" },
  },
});

timeout = setTimeout(
  () => finish("Packaged MCP installed-package smoke timed out."),
  20_000
);
