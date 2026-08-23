import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createDaemonClient } from "../engine/src/lib/daemon-client.js";
import { retrySafeRead } from "../engine/src/lib/safe-read-retry.js";
import {
  HANDSHAKE_PROTO,
  makeNonce,
  pluginTranscript,
  sign,
} from "../engine/src/lib/plugin-handshake.js";
import { PLUGIN_BUILD_VERSION } from "../engine/src/lib/plugin-version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = join(ROOT, "engine", "src", "daemon.js");
const FILE_A = "SOAKFILEA01";
const FILE_B = "SOAKFILEB02";
const PLUGIN_CAPABILITIES = [
  "execution-deadline-v1",
  "render-plan-batch-v1",
  "render-plan-v1",
];

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!Number.isInteger(port))
    throw new Error("Could not allocate Runtime Soak test port");
  return port;
}

function openPlugin(port, key, fileKey, onEval) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`, {
      origin: "null",
    });
    const timeout = setTimeout(
      () => reject(new Error("Runtime Soak plugin handshake timed out")),
      3000
    );
    ws.once("error", reject);
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "challenge") {
        const nonce = makeNonce();
        ws.send(
          JSON.stringify({
            type: "hello",
            proto: HANDSHAKE_PROTO,
            nonce,
            version: PLUGIN_BUILD_VERSION,
            capabilities: PLUGIN_CAPABILITIES,
            proof: sign(
              key,
              pluginTranscript({
                daemonNonce: message.nonce,
                pluginNonce: nonce,
                port: message.port,
                version: PLUGIN_BUILD_VERSION,
                capabilities: PLUGIN_CAPABILITIES,
              })
            ),
          })
        );
      } else if (message.type === "hello-ack") {
        ws.send(
          JSON.stringify({
            type: "selection",
            selection: {
              page: "Soak",
              total: 0,
              nodes: [],
              fileKey,
              fileName: "Disposable Soak Fixture",
              editorType: "figma",
            },
          })
        );
        clearTimeout(timeout);
        setTimeout(() => resolve(ws), 75);
      } else if (message.action === "eval") {
        onEval(ws, message);
      }
    });
  });
}

async function waitForConnections(client, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const health = await client.health({ timeoutMs: 500 });
      const keys = new Set(
        (health.data?.connections || []).map(({ fileKey }) => fileKey)
      );
      if (expected.every((key) => keys.has(key))) return true;
    } catch {}
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (true);
  return false;
}

test(
  "real Daemon soak keeps targets isolated and retries only the disconnected read",
  { timeout: 20_000 },
  async () => {
    const state = mkdtempSync(join(tmpdir(), "figma-bridge-runtime-soak-"));
    const port = await freePort();
    const token = "runtime-soak-daemon-token";
    const key = "runtime-soak-plugin-key";
    const tokenFile = join(state, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(join(state, "key"), key, { mode: 0o600 });
    const daemon = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        DAEMON_PORT: String(port),
        DAEMON_TOKEN_FILE: tokenFile,
        DAEMON_PID_FILE: join(state, "pid"),
        DAEMON_PORT_FILE: join(state, "port"),
        PLUGIN_KEY_FILE: join(state, "key"),
        DAEMON_IDLE_TIMEOUT: "600000",
      },
      stdio: "ignore",
    });
    const client = createDaemonClient({
      readToken: () => token,
      getPort: () => port,
    });
    const sockets = [];
    let disconnectNextRead = true;
    let writeMutations = 0;

    const handler = (identity) => (ws, message) => {
      if (
        message.code === "read-disconnect" &&
        identity === "A" &&
        disconnectNextRead
      ) {
        disconnectNextRead = false;
        ws.close();
        return;
      }
      if (message.code === "write-disconnect" && identity === "B") {
        writeMutations++;
        ws.close();
        return;
      }
      const result =
        message.code === "write-count" ? writeMutations : { identity };
      ws.send(JSON.stringify({ type: "result", id: message.id, result }));
    };

    try {
      const started = await waitForConnections(client, [], 3000);
      assert.equal(
        started,
        true,
        "Daemon must accept authenticated health requests"
      );
      sockets.push(await openPlugin(port, key, FILE_A, handler("A")));
      sockets.push(await openPlugin(port, key, FILE_B, handler("B")));
      assert.equal(await waitForConnections(client, [FILE_A, FILE_B]), true);

      const latencies = [];
      for (let index = 0; index < 100; index++) {
        const expected = index % 2 === 0 ? "A" : "B";
        const fileKey = expected === "A" ? FILE_A : FILE_B;
        const startedAt = performance.now();
        const result = await client.evaluate("identity", {
          fileKey,
          timeoutMs: 2000,
        });
        latencies.push(performance.now() - startedAt);
        assert.deepEqual(
          result,
          { identity: expected },
          `alternating request ${index}`
        );
      }
      assert.ok(
        Math.max(...latencies) < 2000,
        "sustained explicit routing must stay within its request deadline"
      );

      let readAttempts = 0;
      const recoveredRead = await retrySafeRead(
        async () => {
          readAttempts++;
          return client.evaluate("read-disconnect", {
            fileKey: FILE_A,
            timeoutMs: 2000,
          });
        },
        {
          waitUntilReady: async () => {
            sockets.push(await openPlugin(port, key, FILE_A, handler("A")));
            return waitForConnections(client, [FILE_A, FILE_B]);
          },
        }
      );
      assert.deepEqual(recoveredRead, { identity: "A" });
      assert.equal(readAttempts, 2, "a known-safe read recovers exactly once");

      await assert.rejects(
        () =>
          client.evaluate("write-disconnect", {
            fileKey: FILE_B,
            timeoutMs: 2000,
          }),
        (error) =>
          error.kind === "plugin-unavailable" &&
          error.outcome === "unknown-after-dispatch"
      );
      assert.equal(
        writeMutations,
        1,
        "an uncertain write is never automatically repeated"
      );
      sockets.push(await openPlugin(port, key, FILE_B, handler("B")));
      assert.equal(await waitForConnections(client, [FILE_A, FILE_B]), true);
      assert.equal(
        await client.evaluate("write-count", {
          fileKey: FILE_B,
          timeoutMs: 2000,
        }),
        1
      );
    } finally {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {}
      }
      try {
        daemon.kill("SIGTERM");
      } catch {}
      try {
        rmSync(state, { recursive: true, force: true });
      } catch {}
    }
  }
);
