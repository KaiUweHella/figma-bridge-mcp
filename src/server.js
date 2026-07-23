#!/usr/bin/env node
// figma-safe-mcp — MCP stdio server. Small, token-efficient tool surface over
// figma-cli running in Safe Mode.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runCli, ensureSafeConnect, health } from "./figma-cli.js";
import { ensureKey, readKey, rotateKey, keyPath } from "./pairing.js";
import { WRITE_CONFIRM } from "./config.js";

// Subcommands that mutate the design; gated behind confirm when
// FIGMA_WRITE_CONFIRM=1. Read commands always run.
const WRITE_COMMANDS = new Set([
  "render",
  "render-batch",
  "node",
  "component",
  "var",
  "import",
  "pin",
  "annotate",
  "dev",
  "section",
  "grid",
  "gradient",
]);

function isWrite(args) {
  if (!Array.isArray(args) || args.length === 0) return false;
  // `tokens import` is a write; bare `tokens` (export/list) is a read.
  if (args[0] === "tokens") return args[1] === "import";
  return WRITE_COMMANDS.has(args[0]);
}

const TOOLS = [
  {
    name: "figma_connect",
    description:
      "Connect to Figma in Safe Mode (never Yolo). Generates the plugin access key if needed and returns it with plugin import instructions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_status",
    description:
      "Show whether the Figma plugin is connected and authenticated, plus access-key state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "figma_pairing",
    description:
      "Show the Figma plugin access key (paste it into the FigCli plugin). Pass rotate:true to generate a fresh key (requires reconnect).",
    inputSchema: {
      type: "object",
      properties: {
        rotate: {
          type: "boolean",
          description:
            "Generate a NEW key, invalidating the old one. Run figma_connect afterwards to restart the daemon.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "figma_run",
    description:
      "Run any allowed figma-cli command. Tip: append --help to a command for its syntax.",
    inputSchema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "figma-cli subcommand and flags, e.g. [\"canvas\",\"info\"].",
        },
        confirm: {
          type: "boolean",
          description: "Required for write commands when write-confirm mode is on.",
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_render",
    description: "Render JSX into the open Figma design.",
    inputSchema: {
      type: "object",
      properties: {
        jsx: { type: "string", description: "JSX markup to render." },
        confirm: {
          type: "boolean",
          description: "Required when write-confirm mode is on.",
        },
      },
      required: ["jsx"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_inspect",
    description: "Inspect a node by id (JSON output).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id." },
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "figma_reference",
    description:
      "Offline Figma Plugin API reference (one-time 'api setup' needed). Omit name to list.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Command name to look up." },
      },
      additionalProperties: false,
    },
  },
];

function textResult(text) {
  return { content: [{ type: "text", text: text || "" }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text: text || "" }], isError: true };
}

function resultFromCli({ stdout, stderr }) {
  // Prefer stdout; fall back to stderr (CLI puts self-correction hints there).
  return textResult(stdout || stderr);
}

function previewResult(args) {
  return textResult(
    "Write-confirm mode is on. Planned command:\n" +
      "  figma-cli " +
      args.join(" ") +
      "\n\nRe-run with confirm:true to execute.",
  );
}

async function handleTool(name, rawArgs) {
  const input = rawArgs || {};

  switch (name) {
    case "figma_connect": {
      // Ensure an access key exists BEFORE starting the daemon — the daemon
      // reads the key file at startup and rejects the plugin without it.
      const { key, created } = ensureKey();
      const res = await ensureSafeConnect();
      const keyBlock =
        "\n────────────────────────────────────────\n" +
        `  Plugin access key${created ? " (newly generated)" : ""}:\n\n` +
        `    ${key}\n\n` +
        "  Paste this into the FigCli plugin's access-key field in Figma\n" +
        "  the first time you launch it. It is stored in the plugin and\n" +
        "  reused across sessions.\n" +
        "────────────────────────────────────────\n";
      return textResult((res.stdout || res.stderr || "") + keyBlock);
    }

    case "figma_status": {
      const h = await health();
      const key = readKey();
      const raw = h.raw || {};
      const lines = [
        h.message,
        `access key: ${key ? "configured" : "NOT set — run figma_connect"}`,
      ];
      if (h.raw) {
        lines.push(
          `plugin authenticated: ${raw.pluginAuthenticated === true ? "yes" : "no"}`,
        );
        if (raw.keyConfigured === false) {
          lines.push("daemon has NO key loaded — reconnect after figma_connect");
        }
      }
      return textResult(lines.join("\n"));
    }

    case "figma_pairing": {
      if (input.rotate === true) {
        const key = rotateKey();
        return textResult(
          `New plugin access key generated:\n\n    ${key}\n\n` +
            `Stored at: ${keyPath()}\n\n` +
            "The old key is now invalid. Run figma_connect to restart the daemon\n" +
            "with the new key, then paste it into the FigCli plugin.",
        );
      }
      const { key, created } = ensureKey();
      return textResult(
        `Plugin access key${created ? " (newly generated)" : ""}:\n\n    ${key}\n\n` +
          `Stored at: ${keyPath()}\n\n` +
          "Paste it into the FigCli plugin's access-key field in Figma.",
      );
    }

    case "figma_run": {
      const args = input.args;
      if (!Array.isArray(args) || args.length === 0) {
        return errorResult("args must be a non-empty array of strings.");
      }
      if (WRITE_CONFIRM && isWrite(args) && input.confirm !== true) {
        return previewResult(args);
      }
      const res = await runCli(args);
      return resultFromCli(res);
    }

    case "figma_render": {
      const jsx = input.jsx;
      if (typeof jsx !== "string" || jsx.length === 0) {
        return errorResult("jsx must be a non-empty string.");
      }
      const args = ["render", jsx];
      if (WRITE_CONFIRM && input.confirm !== true) {
        return previewResult(args);
      }
      const res = await runCli(args);
      return resultFromCli(res);
    }

    case "figma_inspect": {
      const nodeId = input.nodeId;
      if (typeof nodeId !== "string" || nodeId.length === 0) {
        return errorResult("nodeId must be a non-empty string.");
      }
      const res = await runCli(["inspect", nodeId, "--json"]);
      return resultFromCli(res);
    }

    case "figma_reference": {
      // `api` is figma-cli's offline Figma Plugin API reference. There is no
      // `api list` subcommand; bare `api` lists what is available (and prints a
      // one-time `api setup` hint if the docs are not downloaded yet).
      const args = input.name ? ["api", input.name] : ["api"];
      try {
        const res = await runCli(args);
        return resultFromCli(res);
      } catch (err) {
        const msg = `${err.stderr || ""}${err.stdout || ""}${err.message || ""}`;
        if (msg.includes("docs not installed")) {
          // The engine's hint says `figma-cli api setup`, which an MCP agent
          // cannot type. Translate it into the tool call that actually works.
          return errorResult(
            "The offline API docs are not installed yet (one-time download, ~5 MB).\n" +
              'Run: figma_run with args ["api", "setup"] — then retry figma_reference.',
          );
        }
        throw err;
      }
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

async function main() {
  const server = new Server(
    { name: "figma-safe-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args);
    } catch (err) {
      return errorResult(err.stderr || err.message || String(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`figma-safe-mcp failed to start: ${err.message}\n`);
  process.exit(1);
});
