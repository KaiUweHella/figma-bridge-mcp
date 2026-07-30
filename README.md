# figma-safe-mcp

A **self-contained** MCP server that lets an AI assistant drive **Figma Desktop
locally** — a plugin bridge with terse, token-efficient commands, hardened by
a **locally generated access key** you paste into the plugin once.

Everything runs on `127.0.0.1`. No Figma Personal Access Token. No cloud. No
binary patching of the Figma app.

---

## How it works

```
MCP client ──stdio──▶ figma-safe-mcp (src/)
                        │  execFile, command allowlist, audit log
                        ▼
                     vendored engine (engine/)  ──▶  local daemon :3456–3460
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
| `figma_inspect` | Inspect a node by id: geometry, fills/strokes/effects, clip, opacity (YAML). |
| `figma_screenshot` | Save a PNG of a node/selection to a temp file (path + dimensions + applied scale returned). |
| `figma_spec` | Design-to-code spec of a node: real content, component names, tokens, vector-art refs, clip/abs — in phases. |
| `figma_reference` | Offline Figma Plugin API reference (`api setup` once). |
| `figma_history` | Local change history from the audit log — filter by `nodeId`, optionally merge `git log` of generated code files. `figma_run`/`figma_render` accept a `label` to annotate entries. |
| `figma_selection` | The user's current selection in Figma (ids, names, types, sizes) — pushed live by the plugin. Instances resolve to their main component with the stable publish `key`, and mapped components show their Storybook story. |

Node ids are accepted in every form a user has at hand: `12:34`, the URL
form `12-34`, or a full Figma URL (the file key is checked against the
Safe-Mode "only the open file" constraint and warned about).

Write commands can be gated behind an explicit `confirm:true` by setting
`FIGMA_WRITE_CONFIRM=1` in the server's environment. The gate works on
subcommand level: reads like `node tree` or `component list` pass freely,
mutations like `node delete`, `combos`, or `tokens spacing` require confirm.

## Plugin window

The FigCli plugin window is more than the connection status:

- **Activity log** (Log ▾) — every command the agent runs, live, with
  duration and ok/error; writes are highlighted. The connected port and
  round-trip latency show next to the status dot.
- **⏸ Pause** — a kill switch: while paused, the plugin rejects every
  incoming agent command with an explicit error.
- **Selection readout** — whatever the user selects is pushed to the agent
  automatically (debounced) and shown in the window ("▸ Selected: …"), so
  the user always sees what `figma_selection` will return. Select a frame,
  say "build this" — no node-id copying.
- **Checkpoint** — saves a labeled entry in Figma's native version history
  as a manual safety net before letting the agent loose.

## Design-to-code workflow

The design is the complete specification — the tooling makes copying it easier
than interpreting it. Build a screen from Figma in five steps:

1. **`figma_screenshot`** on the target frame, then read the saved PNG — the
   visual ground truth. Never build from a node tree alone.
2. **`figma_spec` with `phase: "structure"`** — build the markup skeleton:
   real text characters, resolved icon/component names (instances are
   descended into, so overrides and true main-component names appear),
   hierarchy and flex direction. Copy texts and icons verbatim.
3. **Export tokens** (`figma_run` with `["export","css"]` or
   `["export","dtcg"]`) and wire them up as CSS variables / theme. The output
   names its source Figma file — check it is the file you are building.
4. **Export assets** (`figma_run` with
   `["export","assets","<nodeId>","-o","/abs/path/src/assets"]`) — every
   `→ assets/…` reference in the spec points at a file this writes. Pass an
   absolute path; large exports keep running in the background ("still
   RUNNING") — re-run the same call to poll. `assets.json` is merged across
   runs and byte-identical assets are deduped.
5. **`figma_spec` with `phase: "style"`** — apply sizes, gaps, padding,
   alignment, fill/hug sizing, paints incl. gradients (`→ var(name)` marks a
   design-token binding), radii, shadows, typography, `opacity`, `clip`
   (overflow hidden) and `abs` positioning. Decorative vectors appear as
   `vector art → assets/…` lines with placement — place the exported SVGs,
   never approximate them in CSS.
6. **Verify** — screenshot your build and compare against the PNG from step 1.

The same spec is available on the CLI as `figma-cli export code-spec <nodeId>`.

## Storybook mirroring

Figma components carry a **stable publish key** (survives library publishing;
node ids are file-local). The key now flows through `figma_spec` (json/yaml
model + the "Component sets used" trailer), `figma_selection`, `component
list`, `figma_inspect`, and DESIGN.md.

To link them to their code mirror:

```bash
figma-cli map storybook http://localhost:6006
```

(or via MCP: `figma_run` with `["map","storybook","http://localhost:6006"]`).
This matches the file's components against the Storybook index by normalized
name and writes **`figma-map.json`** into your project: Figma key ↔ story id /
import path, with a `confidence` per match plus both unmatched lists. Edit
entries by hand and set `"matchedBy": "manual"` to pin them — pinned entries
survive re-runs. When the file exists, `figma_selection` and `figma_spec`
annotate components with `↔ story <id> (<importPath>)` automatically.

## Security model

- **No Figma API token** — Figma is driven through the local plugin, never
  `api.figma.com`.
- **No binary patching** — Yolo/CDP mode is stripped from the vendored engine.
- **Command allowlist** — `figma_run` only accepts a fixed set of subcommands;
  `connect` is *not* on it, so Safe-Mode-only connection is enforced.
- **No shell** — the engine is spawned with `execFile` (`shell:false`).
- **Two-layer daemon auth** — signed HTTP requests (per-request HMAC over
  method/path/body, keyed with the session token, nonce replay guard — the
  token itself never crosses the wire) + plugin access key (constant-time
  compared, `Origin`/`Host` allowlisted).
- **Localhost-locked plugin** — `plugin/manifest.json` restricts
  `networkAccess.allowedDomains` to `ws://127.0.0.1:3456–3460`.
- **Isolated state** — token, pid, key, and audit log live under
  `~/.figma-safe-mcp/`, separate from any upstream figma-cli install.
- **Audit log** — every executed command is appended to
  `~/.figma-safe-mcp/audit.log` (with touched node ids, optional labels, and a
  completion entry recording success/failure — the data source for
  `figma_history`). Rotates at 5 MB; one previous generation (`audit.log.1`)
  is kept and still read by `figma_history`.

**Port fallback.** The daemon binds the first free port in 3456–3460 and
publishes it in `~/.figma-safe-mcp/daemon-port`; the CLI/MCP layers resolve the
port per call (env `DAEMON_PORT` > port file > 3456), and the plugin scans the
whole range, so a foreign process squatting 3456 no longer blocks connecting.
The squatter check is an *unauthenticated* `/health` probe, and authenticated
requests are HMAC-signed — a squatter on a range port sees neither the session
token nor anything replayable (signatures bind timestamp, nonce, method, path
and body; the daemon rejects reused nonces). Setting `DAEMON_PORT` explicitly
disables the fallback; values outside 3456–3460 are unsupported — the plugin
manifest is Figma-enforced and cannot reach them.

**Residual risk (documented):** a malicious local process that binds port 3456
*before* the daemon could observe the plugin's `hello` and learn the *plugin
access key* (the HTTP session token is protected by request signing and never
exposed). The manifest's port lock and the daemon normally holding the port
mitigate this; a challenge-response handshake for the plugin `hello` is a
possible future hardening. (The port fallback does not change this: the plugin
sends `hello` to whichever range port accepts, so the same risk simply applies
to the bound port.)

## Known limitations

- **FigJam is not supported.** The upstream FigJam commands drove the removed
  CDP transport and were deleted along with it.
- **Exactly two non-localhost network actions exist**, both explicit and
  user-initiated: `api setup` (one-time git clone of the Figma Plugin API docs
  mirror, for `figma_reference`) and the Storybook index fetch of
  `import`/`map storybook` (the URL/directory you pass in). Nothing else
  talks to the network — the upstream's iconify/unsplash/remove.bg/
  screenshot-url integrations were removed entirely; `<Icon>` in
  `figma_render` JSX renders as a named placeholder (real icons come out of
  the Figma file via `export assets`).
- **One transport, no CDP remnants.** Every command reaches Figma the same
  way: engine → daemon → plugin eval. The upstream's Chrome-DevTools client,
  its `figma-use` shell round-trip, the binary-patching `init` wizard and the
  `figma-use` dependency are all gone (~5,600 lines removed), so there is no
  second code path that could bypass the plugin bridge.

## Development

```bash
npm test      # 509 tests: vendored engine + daemon auth + MCP layer
```

Avoid running an upstream `figma-cli` at the same time. The daemon now falls
back within 3456–3460 when 3456 is taken, so both *can* coexist, but the plugin
scans the whole range and the two daemons use different access keys — which one
the plugin reaches first is a coin toss. This build isolates its own
token/pid/port files under `~/.figma-safe-mcp/`.

## Inspiration & attribution

Inspired by [figma-cli](https://github.com/silships/figma-cli) — this project
has since gone its own way (Safe-Mode-only architecture, MCP layer, hardened
plugin, design-to-code fidelity stack, Storybook mapping) and shares neither
the Yolo/CDP approach nor the bundled integrations.

Licensing: the `engine/` directory started as a fork of **figma-ds-cli v2.1.0**
(© Sil Bormüller, MIT) and retains that license — see [`NOTICE`](NOTICE) and
[`engine/LICENSE`](engine/LICENSE). figma-safe-mcp itself is MIT — see
[`LICENSE`](LICENSE).
