import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HAS_LSOF =
  process.platform !== "win32" && !spawnSync("lsof", ["-v"]).error;
const CHILD_OUTPUT_LIMIT = 8192;

function waitForLine(
  child,
  { timeoutMs = 3000, accept = () => true, label = "child" } = {}
) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let settled = false;

    const describeOutput = () => {
      const details = [];
      if (stdout.trim())
        details.push(`stdout=${JSON.stringify(stdout.trim().slice(-2048))}`);
      if (stderr.trim())
        details.push(`stderr=${JSON.stringify(stderr.trim().slice(-2048))}`);
      return details.length > 0 ? ` (${details.join(", ")})` : "";
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const succeed = (line) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(line);
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} ${message}${describeOutput()}`));
    };
    const onStdout = (chunk) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-CHILD_OUTPUT_LIMIT);
      lineBuffer = (lineBuffer + text).slice(-CHILD_OUTPUT_LIMIT);
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line && accept(line)) {
          succeed(line);
          return;
        }
      }
    };
    const onStderr = (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-CHILD_OUTPUT_LIMIT);
    };
    const onError = (error) => fail(`failed: ${error.message}`);
    const onExit = (code) => fail(`exited before becoming ready (${code})`);
    const timer = setTimeout(() => fail("did not become ready"), timeoutMs);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function isPortLine(line) {
  const port = Number(line);
  return (
    /^\d+$/.test(line) && Number.isInteger(port) && port > 0 && port <= 65535
  );
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopFromIsolatedCli(state, port) {
  const script = `
    const { stopDaemon } = await import('./engine/src/lib/cli-core.js');
    await stopDaemon();
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      DAEMON_PID_FILE: join(state, "daemon.pid"),
      DAEMON_PORT_FILE: join(state, "daemon-port"),
      DAEMON_PORT_RANGE: String(port),
      DAEMON_TOKEN_FILE: join(state, "token"),
      PLUGIN_KEY_FILE: join(state, "key"),
    },
    timeout: 5000,
  });
}

test(
  "stopDaemon never signals a stale/reused PID that does not own the daemon listener",
  {
    skip: !HAS_LSOF,
  },
  async () => {
    const state = mkdtempSync(join(tmpdir(), "figma-bridge-stop-stale-pid-"));
    const unrelated = spawn(
      process.execPath,
      ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    try {
      await waitForLine(unrelated, {
        accept: (line) => line === "ready",
        label: "unrelated child",
      });
      const unusedPort = 49151;
      writeFileSync(join(state, "daemon.pid"), String(unrelated.pid));
      writeFileSync(join(state, "daemon-port"), String(unusedPort));

      await stopFromIsolatedCli(state, unusedPort);
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(
        isAlive(unrelated.pid),
        true,
        "a stale daemon.pid must never let the bridge terminate an unrelated process"
      );
    } finally {
      try {
        unrelated.kill("SIGKILL");
      } catch {}
      rmSync(state, { recursive: true, force: true });
    }
  }
);

test(
  "stopDaemon force-kills only its verified hung listener and leaves connected clients alive",
  {
    skip: !HAS_LSOF,
  },
  async () => {
    const state = mkdtempSync(join(tmpdir(), "figma-bridge-stop-owned-pid-"));
    const listener = spawn(
      process.execPath,
      [
        "-e",
        `
    const net = require('net');
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    process.on('SIGTERM', () => {});
    // A startup diagnostic must not be mistaken for the listener's ready signal.
    console.log('listener startup diagnostic');
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    setInterval(() => {}, 1000);
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let client = null;
    try {
      const port = Number(
        await waitForLine(listener, {
          accept: isPortLine,
          label: "listener child",
        })
      );
      assert.ok(Number.isInteger(port) && port > 0);
      client = spawn(
        process.execPath,
        [
          "-e",
          `
      const net = require('net');
      const socket = net.connect(${port}, '127.0.0.1', () => console.log('connected'));
      socket.on('error', () => {});
      setInterval(() => {}, 1000);
    `,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      await waitForLine(client, {
        accept: (line) => line === "connected",
        label: "client child",
      });

      writeFileSync(join(state, "daemon.pid"), String(listener.pid));
      writeFileSync(join(state, "daemon-port"), String(port));
      await stopFromIsolatedCli(state, port);
      await new Promise((resolve) => setTimeout(resolve, 250));

      assert.equal(
        isAlive(listener.pid),
        false,
        "a verified daemon listener that ignores SIGTERM must not keep the port forever"
      );
      assert.equal(
        isAlive(client.pid),
        true,
        "port cleanup must not kill Figma or any other connected client process"
      );
    } finally {
      try {
        listener.kill("SIGKILL");
      } catch {}
      try {
        client?.kill("SIGKILL");
      } catch {}
      rmSync(state, { recursive: true, force: true });
    }
  }
);
