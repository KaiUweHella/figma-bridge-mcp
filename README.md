# figma-safe-mcp

An MCP server that wraps [`figma-cli`](https://github.com/silships/figma-cli) as its
engine and exposes a small, token-efficient tool surface to any MCP client
(Claude Desktop, Cursor, Claude Code).

It runs **strictly in Safe Mode**: no binary patching, no Yolo mode, no Personal
Access Token, no `api.figma.com`. Everything stays on `127.0.0.1`, driven through
the Figma plugin API on your open design.

## Why

- **MCP ergonomics** — six clearly defined tools, natively usable in every MCP client.
- **figma-cli power** — one generic `figma_run` tool passes CLI commands through,
  so you get the full command surface without shipping ~113 tool schemas into
  every session's context.
- **Safer to use** — Safe Mode is enforced, commands are allowlisted, execution
  never touches a shell, the plugin manifest is locked to localhost, and every
  command is written to an audit log.

## Prerequisites

1. **Node.js 18+**
2. **figma-cli installed:**
   ```bash
   git clone https://github.com/silships/figma-cli && cd figma-cli && npm install
   ```
   Note the path to its entry point (`src/index.js`) or link it globally as
   `figma-cli`.
3. **Figma Desktop** open with a design file.
4. **Hardened plugin imported:** in Figma → Plugins → Development → Import plugin
   from manifest → choose the hardened [`plugin/manifest.json`](plugin/manifest.json)
   from this project (not the original). The plugin's `code.js` and `ui.html` are
   already bundled in [`plugin/`](plugin/) (byte-identical copies of figma-cli's),
   so the folder is self-contained — nothing else to copy.

## Install

```bash
npm install
```

## Configure your MCP client

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "figma-safe": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/figma-safe-mcp/src/server.js"],
      "env": {
        "FIGMA_CLI_BIN": "node",
        "FIGMA_CLI_ENTRY": "/ABSOLUTE/PATH/figma-cli/src/index.js"
      }
    }
  }
}
```

**Claude Code (CLI):**

```bash
claude mcp add figma-safe -s user \
  -e FIGMA_CLI_BIN=node \
  -e FIGMA_CLI_ENTRY=/ABSOLUTE/PATH/figma-cli/src/index.js \
  -- node /ABSOLUTE/PATH/figma-safe-mcp/src/server.js
```

No `FIGMA_ACCESS_TOKEN` is needed — that's the difference from figma-console-mcp.

## Tools

| Tool | Input | Action |
|------|-------|--------|
| `figma_connect` | – | Connect in Safe Mode; returns plugin import instructions. |
| `figma_status` | – | Show whether the plugin is connected. |
| `figma_run` | `{ args: string[], confirm?: boolean }` | Run any allowlisted figma-cli command. |
| `figma_render` | `{ jsx: string, confirm?: boolean }` | Render JSX into the open design. |
| `figma_inspect` | `{ nodeId: string }` | Inspect a node (`inspect <id> --json`). |
| `figma_reference` | `{ name?: string }` | Look up CLI command syntax offline. |

Use `figma_reference` to discover command syntax instead of guessing.

## Runtime flow

1. Open Figma Desktop with a design file.
2. Call `figma_connect` → starts the daemon in Safe Mode and prints import steps.
3. In Figma: import & run the hardened plugin (FigCli Safe/Hardened).
4. Call `figma_status` → should report the plugin connected.
5. Call `figma_render` with a small JSX, e.g.
   `<Frame name="Test" w={200} h={100} bg="#fff"/>`.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `FIGMA_CLI_BIN` | `figma-cli` | Command/path to the CLI. Use `node` with `FIGMA_CLI_ENTRY` if not linked globally. |
| `FIGMA_CLI_ENTRY` | – | Absolute path to figma-cli's `src/index.js` (when `FIGMA_CLI_BIN=node`). |
| `FIGMA_CLI_CWD` | cwd | Working directory for the CLI. |
| `AUDIT_LOG_PATH` | `~/.figma-safe-mcp/audit.log` | Where executed commands are logged. |
| `EXEC_TIMEOUT_MS` | `60000` | Per-command timeout. |
| `CONNECT_TIMEOUT_MS` | `12000` | `figma_connect` wait cap (daemon is detached, so it survives). |
| `DAEMON_PORT` | `3456` | figma-cli daemon port used by `figma_status`. |
| `DAEMON_TOKEN_FILE` | `~/.figma-ds-cli/.daemon-token` | Token file `figma_status` reads for `/health`. |
| `FIGMA_WRITE_CONFIRM` | off | When `1`, write commands require `confirm:true` (dry-run preview otherwise). |

## Security hardening

1. **Safe Mode enforced.** `connect` runs only via `ensureSafeConnect()` with
   `--safe`, and is intentionally absent from the command allowlist — so there is
   no path through `figma_run` to patch the binary or open a CDP debug port.
2. **No shell injection.** Execution is `execFile` with an argument array
   (`shell:false`); the first argument is checked against an allowlist and no
   user input is ever concatenated into a shell string.
3. **Locked plugin manifest.** `networkAccess.allowedDomains` is restricted from
   `["*"]` to localhost ports only, closing the plugin-UI exfiltration vector.
4. **Audit log.** Every executed command is appended as a JSON line to
   `~/.figma-safe-mcp/audit.log`. Optional write-confirm/dry-run adds a second gate.

### Optional daemon patch (closes the `/plugin` WS gap)

figma-cli checks the session token on HTTP routes but not on the WebSocket
upgrade to `/plugin`. To fully close this, add a `verifyClient` to the
`WebSocketServer` in figma-cli's `src/daemon.js` that validates the token from
`?token=`/`x-daemon-token` against `SESSION_TOKEN`, and make the plugin's
`ui.html` send that token when connecting. This is an upstream change to
figma-cli (not this wrapper) and optional — for single-user local use the
localhost binding suffices.

## Non-goals

- No REST/OAuth (no token) — extraction goes through the plugin.
- No cloud relay / web client.
- No 1:1 reproduction of all ~113 figma-console-mcp tools — breadth comes from
  `figma_run` + `figma_reference`, which is what keeps this token-efficient.
