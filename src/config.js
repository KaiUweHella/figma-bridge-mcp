// Central configuration, sourced from environment variables.
import os from "node:os";
import path from "node:path";

// Command / path to the figma-cli. Default assumes it is globally linked.
// If not linked globally, set FIGMA_CLI_BIN="node" and FIGMA_CLI_ENTRY to the
// absolute path of figma-cli's src/index.js.
export const FIGMA_CLI_BIN = process.env.FIGMA_CLI_BIN || "figma-cli";

// Entry point used only when FIGMA_CLI_BIN resolves to a node runtime.
export const FIGMA_CLI_ENTRY = process.env.FIGMA_CLI_ENTRY || "";

// Working directory for the CLI (optional).
export const FIGMA_CLI_CWD = process.env.FIGMA_CLI_CWD || process.cwd();

// Audit log path.
export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH ||
  path.join(os.homedir(), ".figma-safe-mcp", "audit.log");

// Timeout for a single CLI invocation (ms).
export const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS) || 60000;

// Timeout for `connect --safe` (ms). The CLI prints its daemon-started +
// plugin-import instructions within ~1-2s, then blocks up to 90s waiting for
// the plugin to connect. Because the daemon is spawned detached (unref'd), we
// can kill the connect process after capturing the instructions without
// stopping the daemon. Keep this well under the CLI's 90s wait.
export const CONNECT_TIMEOUT_MS =
  Number(process.env.CONNECT_TIMEOUT_MS) || 12000;

// figma-cli daemon endpoint (Safe Mode). Matches figma-cli's own defaults:
// port 3456 on 127.0.0.1, token file under ~/.figma-ds-cli.
export const DAEMON_HOST = process.env.DAEMON_HOST || "127.0.0.1";
export const DAEMON_PORT = Number(process.env.DAEMON_PORT) || 3456;
export const DAEMON_TOKEN_FILE =
  process.env.DAEMON_TOKEN_FILE ||
  path.join(os.homedir(), ".figma-ds-cli", ".daemon-token");

// Optional write-confirm / dry-run mode. When "1", write commands require an
// explicit confirm flag before they are executed.
export const WRITE_CONFIRM = process.env.FIGMA_WRITE_CONFIRM === "1";

// Node runtimes we recognise so we know when to prepend FIGMA_CLI_ENTRY.
const NODE_RUNTIMES = new Set(["node", "node.exe"]);

/**
 * Build the concrete command + argv for spawning figma-cli.
 *
 * @param {string[]} userArgs - the CLI subcommand + flags (already an array).
 * @returns {{cmd: string, argv: string[]}}
 */
export function buildArgv(userArgs) {
  if (!Array.isArray(userArgs)) {
    throw new Error("buildArgv: userArgs must be an array");
  }
  const base = path.basename(FIGMA_CLI_BIN).toLowerCase();
  if (NODE_RUNTIMES.has(base)) {
    if (!FIGMA_CLI_ENTRY) {
      throw new Error(
        "FIGMA_CLI_BIN is a node runtime but FIGMA_CLI_ENTRY is not set. " +
          "Set FIGMA_CLI_ENTRY to the absolute path of figma-cli's src/index.js.",
      );
    }
    return { cmd: FIGMA_CLI_BIN, argv: [FIGMA_CLI_ENTRY, ...userArgs] };
  }
  return { cmd: FIGMA_CLI_BIN, argv: [...userArgs] };
}
