# figma-safe-mcp

A **self-contained** MCP server that lets an AI assistant drive **Figma Desktop
locally** — combining the **efficiency** of [figma-cli](https://github.com/silships/figma-cli)
(plugin bridge, no Figma API token, terse token-efficient commands) with the
**security** of a hardened plugin and a **locally generated access key** you paste
into the plugin once.

Everything runs on `127.0.0.1`. No Figma Personal Access Token. No cloud. No
binary patching of the Figma app.

---

## How it works

```
MCP client ──stdio──▶ figma-safe-mcp (src/)
                        │  execFile, command allowlist, audit log
                        ▼
                     vendored engine (engine/)  ──▶  local daemon :3456
                        (Safe-Mode only)                │  HTTP: X-Daemon-Token
                                                        │  WS  : access-key hello
                                                        ▼
                                              FigCli plugin in Figma Desktop
                                                (evals code in the Figma sandbox)
```

- The **engine** is a Safe-Mode-only fork of `figma-ds-cli` v2.1.0, vendored
  under `engine/`. The Chrome-DevTools "Yolo mode" (which patches the Figma app
  binary) has been removed entirely — there is no code path to it.
- The **daemon** brokers commands to the Figma plugin over a localhost
  WebSocket. Two gates protect it:
  - **HTTP routes** (`/health`, `/exec`) require the session token
    (`X-Daemon-Token`), a 0600 file.
  - **The plugin WebSocket** (`/plugin`) requires the **access key**: an
    `Origin`/`Host` allowlist plus a first-message `hello` handshake carrying the
    key, compared in constant time. This closes the upstream gap where *any*
    local process could connect to the plugin socket and run code in your Figma
    document.

## Install

```bash
git clone <this-repo> figma-cli-mcp
cd figma-cli-mcp
npm install
```

That's it — the engine and plugin ship inside this repo. There is **no external
figma-cli to install** and **no environment variables to set**.

## Configure your MCP client

Point your MCP client at the server (adjust the path):

```json
{
  "mcpServers": {
    "figma-safe": {
      "command": "node",
      "args": ["/absolute/path/to/figma-cli-mcp/src/server.js"]
    }
  }
}
```

## One-time pairing

1. Call **`figma_connect`**. It generates your access key (if needed), starts the
   daemon, and prints the key plus plugin-import instructions.
2. In **Figma Desktop**: `Plugins → Development → Import plugin from manifest…`
   and choose `plugin/manifest.json` from this repo.
3. Launch the plugin: `Plugins → Development → FigCli`. **Paste the access key**
   into its input and click *Save & connect*. The key is stored in the plugin
   (`figma.clientStorage`) and reused every session.
4. The plugin shows **“Connected (authenticated)”**. Verify with **`figma_status`**.

## Tools

| Tool | Purpose |
|------|---------|
| `figma_connect` | Start Safe Mode, generate/show the access key, print plugin setup steps. |
| `figma_status` | Report daemon + plugin connection, authentication, and key state. |
| `figma_pairing` | Show the access key; `{rotate:true}` generates a fresh one. |
| `figma_run` | Run any allowlisted engine command, e.g. `{"args":["canvas","info"]}`. |
| `figma_render` | Render JSX into the open Figma design. |
| `figma_inspect` | Inspect a node by id (JSON). |
| `figma_reference` | Offline Figma Plugin API reference (`api setup` once). |

Write commands can be gated behind an explicit `confirm:true` by setting
`FIGMA_WRITE_CONFIRM=1` in the server's environment.

## Security model

- **No Figma API token** — Figma is driven through the local plugin, never
  `api.figma.com`.
- **No binary patching** — Yolo/CDP mode is stripped from the vendored engine.
- **Command allowlist** — `figma_run` only accepts a fixed set of subcommands;
  `connect` is *not* on it, so Safe-Mode-only connection is enforced.
- **No shell** — the engine is spawned with `execFile` (`shell:false`).
- **Two-layer daemon auth** — HTTP session token + plugin access key
  (constant-time compared, `Origin`/`Host` allowlisted).
- **Localhost-locked plugin** — `plugin/manifest.json` restricts
  `networkAccess.allowedDomains` to `ws://127.0.0.1:3456–3460`.
- **Isolated state** — token, pid, key, and audit log live under
  `~/.figma-safe-mcp/`, separate from any upstream figma-cli install.
- **Audit log** — every executed command is appended to
  `~/.figma-safe-mcp/audit.log`.

**Residual risk (documented):** a malicious local process that binds port 3456
*before* the daemon could observe the plugin's `hello` and learn the key. The
manifest's port lock and the daemon normally holding the port mitigate this; an
HMAC challenge-response is a possible future hardening.

## Known limitations

- **FigJam commands are unavailable.** `figjam-client.js` uses the (removed) CDP
  transport; FigJam is not in the allowlist.
- **`figma_reference` (`api setup`)** downloads the Figma Plugin API docs from the
  network on first use — the only non-localhost action in the project.
- **Node 20+ / figma-use.** The upstream `figma-use` dependency is fragile on
  Node 20+, but all its call sites were Yolo-only and are inert in this build.

## Development

```bash
npm test      # 285 tests: vendored engine + daemon auth + MCP layer
```

Do **not** run an upstream `figma-cli` at the same time — both would compete for
port 3456. This build isolates its own token/pid under `~/.figma-safe-mcp/`, but
the port is shared by design (the plugin manifest locks it).

## Attribution

The `engine/` directory is derived from **figma-ds-cli v2.1.0**
(© Sil Bormüller, MIT). See [`NOTICE`](NOTICE) for the exact list of vendored,
modified, and excluded files, and [`engine/LICENSE`](engine/LICENSE) for the
upstream license. figma-safe-mcp itself is MIT — see [`LICENSE`](LICENSE).
