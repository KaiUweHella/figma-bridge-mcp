#!/usr/bin/env node
import { spawn } from "node:child_process";

const executable = process.argv[2];
if (!executable) {
  process.stderr.write("Usage: node scripts/smoke-mcp-server.js <server-executable>\n");
  process.exit(2);
}

const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
let complete = false;
let timeout;

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function finish(error) {
  if (complete) return;
  complete = true;
  clearTimeout(timeout);
  child.kill();
  if (error) {
    process.stderr.write(`${error}${stderr ? `\n${stderr}` : ""}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Packaged MCP initialize + tools/list smoke passed.\n");
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
    } catch {
      finish(`Packaged MCP returned invalid JSON: ${line}`);
      return;
    }
    if (payload.id === 1) {
      if (payload.result?.serverInfo?.name !== "figma-bridge-mcp") {
        finish(`Packaged MCP initialize failed: ${line}`);
        return;
      }
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    } else if (payload.id === 2) {
      const tools = payload.result?.tools;
      if (!Array.isArray(tools) || !tools.some((tool) => tool.name === "figma_spec")) {
        finish(`Packaged MCP tools/list failed: ${line}`);
        return;
      }
      finish();
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", (error) => finish(`Unable to start packaged MCP: ${error.message}`));
child.on("exit", (code) => {
  if (!complete) finish(`Packaged MCP exited before the handshake completed (code ${code}).`);
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

timeout = setTimeout(() => finish("Packaged MCP handshake timed out."), 5_000);
