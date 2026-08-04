# figma-bridge-mcp

A **self-contained** MCP server that lets an AI assistant drive **Figma Desktop
locally** — a plugin bridge with terse, token-efficient commands, hardened by
a **locally generated access key** you paste into the plugin once.

Everything runs on `127.0.0.1`. No Figma Personal Access Token required. No
cloud. No binary patching of the Figma app.

An **optional REST add-on** (version history, comments, published library
metadata) can be enabled by pasting a Figma PAT into the plugin window — the
token is stored 0600 on your machine, never in your MCP client config, never
in chat. See [REST add-on](#rest-add-on-optional).

---

## How it works

```
MCP client ──stdio──▶ figma-bridge-mcp (src/)
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

The recommended setup is **npx** — no clone, no build, always the latest
version:

```bash
claude mcp add figma-safe -- npx -y figma-bridge-mcp@latest
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "figma-safe": {
      "command": "npx",
      "args": ["-y", "figma-bridge-mcp@latest"]
    }
  }
}
```

Note there is **no `env` block** — unlike PAT-based Figma MCP servers, no
token lives in your client config. Everything the server needs is generated
locally on first connect.

<details>
<summary>From source (contributors)</summary>

```bash
git clone https://github.com/KaiUweHella/figma-cli-mcp.git
cd figma-cli-mcp
npm install
```

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

</details>

## One-time pairing

1. Call **`figma_connect`**. It generates your access key (if needed), starts
   the daemon, installs the plugin files to a stable location, and prints the
   key plus the import path.
2. In **Figma Desktop**: `Plugins → Development → Import plugin from manifest…`
   and choose **`~/.figma-bridge-mcp/plugin/manifest.json`** (the path
   `figma_connect` printed — stable across npx updates).
3. Launch the plugin: `Plugins → Development → FigCli Bridge`. **Paste the
   access key** into its input and click *Save & connect*. The key is stored in
   the plugin (`figma.clientStorage`) and reused every session.
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
| `figma_history` | Local change history from the audit log — filter by `nodeId`, optionally merge `git log` of generated code files and (REST add-on) the file's real Figma version history via `includeVersions:true`. `figma_run`/`figma_render` accept a `label` to annotate entries. |
| `figma_selection` | The user's current selection in Figma (ids, names, types, sizes) — pushed live by the plugin. Instances resolve to their main component with the stable publish `key`, and mapped components show their Storybook story. |
| `figma_comments` | REST add-on: read design-review comments (`action:"list"`) or post/reply (`action:"post"` — always previews first, needs `confirm:true`). |

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
   runs and byte-identical assets are deduped. Each entry carries placement
   data (`x`/`y` offsets, `parent` name path, `parentId`, `absolutePosition`,
   `overhang`), so the manifest alone positions an overlay — no spec
   cross-reference needed. The export summary lists the absolutely-positioned
   and overhanging files explicitly: those are the ones builds lose.
5. **`figma_spec` with `phase: "style"`** — apply sizes, gaps, padding,
   alignment, fill/hug sizing, paints incl. gradients (`→ var(name)` marks a
   design-token binding), radii, shadows, typography, `opacity`, `clip`
   (overflow hidden) and `abs` positioning. Decorative vectors appear as
   `vector art → assets/…` lines with placement — place the exported SVGs,
   never approximate them in CSS.
6. **Verify** — screenshot your build and compare against the PNG from step 1,
   then run the mechanical check:

   ```bash
   figma-cli verify-build /abs/path/to/project
   ```

   (via MCP: `figma_run` with `["verify-build","/abs/path/to/project"]`).
   It greps the project against `assets.json` and lists every exported file
   that is *not* referenced in the build — with size, offsets and parent, so
   placing it is one step — plus a `border-image` lint (CSS `border-image`
   ignores `border-radius`; gradient strokes on rounded boxes need the
   wrapper or mask pattern). Exit code 1 when files are missing, so it works
   as a CI gate too.

   With a build screenshot it also runs the **visual pass**:

   ```bash
   figma-cli verify-build /abs/path/to/project --compare /abs/build.png
   ```

   The reference render is fetched live from Figma (`--node <id>`, default:
   the manifest's export root) or supplied offline via `--design <png>`.
   Both images are normalized to a common width and pixel-diffed
   (antialiasing-tolerant); the output reports the overall diff percentage,
   a height-mismatch finding (build too tall/short = inserted or dropped
   block), the worst differing regions in node-pixel coordinates — the same
   space the spec and `assets.json` use — and writes a diff PNG (red =
   differing, on the dimmed design). Informational by default;
   `--max-diff <pct>` gates the exit code.

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

## REST add-on (optional)

Everything above works with **zero Figma credentials**. Three things the local
plugin bridge structurally cannot reach live behind Figma's REST API, and can
be unlocked with a personal access token:

| Feature | What it adds |
|---------|--------------|
| **Version history** | `figma_history {includeVersions:true}` merges what *designers* saved (when, by whom) into the local audit+git timeline — the plugin API can only *write* versions, not read them. |
| **Comments** | `figma_comments` reads design-review feedback (with node anchors and thread ids) and can reply. Posting always shows a preview first and requires `confirm:true` — comments are visible to other people. |
| **Library metadata** | `map storybook` automatically enriches `figma-map.json` with the published components' `description` and documentation links — a far stronger matching signal than name normalization. |

**Enabling it — the token never leaves your machine:**

1. Create a personal access token in Figma (Settings → Security → Personal
   access tokens) with scopes: **File content (read)**, **File versions
   (read)**, **Comments (read and write)**. *Current user (read)* is optional —
   it only makes `figma_status` show your handle.
2. Open the **FigCli Bridge plugin** in Figma Desktop, connect (the field
   appears once the plugin is authenticated), and expand **“REST token
   (optional)”**. Paste the token, *Save token*.
3. `figma_status` now reports `REST token: configured (@your-handle)`, or
   `configured and working (file access verified)` when you left out the
   *Current user* scope.

The token travels from the plugin over the **authenticated localhost
WebSocket** to the daemon, which stores it in `~/.figma-bridge-mcp/rest-token`
(mode 0600). It is never entered in chat, never stored in your MCP client
config, never echoed back by any tool, and never written to the audit log
(REST calls are logged as method + path only). *Clear token* in the plugin
removes the file.

Headless/CI alternative: set the `FIGMA_REST_TOKEN` environment variable — it
overrides the file.

**Scope:** by default REST calls target the file currently open in Figma
Desktop (the plugin pushes its file key). Other files require an explicit
`fileKey` parameter (bare key or full Figma URL). Note that a PAT itself can
read every file its account can access — keep the scopes minimal.

## Security model

- **No Figma API token required** — Figma is driven through the local plugin,
  never `api.figma.com`. The REST add-on is strictly opt-in: without a token
  the code path is inert, and with one the token lives in a 0600 file (or your
  own env var), not in the MCP client config.
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
  `~/.figma-bridge-mcp/`, separate from any upstream figma-cli install.
- **Audit log** — every executed command is appended to
  `~/.figma-bridge-mcp/audit.log` (with touched node ids, optional labels, and a
  completion entry recording success/failure — the data source for
  `figma_history`). Rotates at 5 MB; one previous generation (`audit.log.1`)
  is kept and still read by `figma_history`.

**Port fallback.** The daemon binds the first free port in 3456–3460 and
publishes it in `~/.figma-bridge-mcp/daemon-port`; the CLI/MCP layers resolve the
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
- **Non-localhost network actions are few and explicit**: `api setup`
  (one-time git clone of the Figma Plugin API docs mirror, for
  `figma_reference`), the Storybook index fetch of `import`/`map storybook`
  (the URL/directory you pass in), and — only when you opt into the REST
  add-on — calls to `api.figma.com`. Nothing else talks to the network — the
  upstream's iconify/unsplash/remove.bg/screenshot-url integrations were
  removed entirely; `<Icon>` in `figma_render` JSX renders as a named
  placeholder (real icons come out of the Figma file via `export assets`).
- **One transport, no CDP remnants.** Every command reaches Figma the same
  way: engine → daemon → plugin eval. The upstream's Chrome-DevTools client,
  its `figma-use` shell round-trip, the binary-patching `init` wizard and the
  `figma-use` dependency are all gone (~5,600 lines removed), so there is no
  second code path that could bypass the plugin bridge.

## Development

```bash
npm test      # vendored engine + daemon auth + MCP layer + REST layer
```

Avoid running an upstream `figma-cli` at the same time. The daemon now falls
back within 3456–3460 when 3456 is taken, so both *can* coexist, but the plugin
scans the whole range and the two daemons use different access keys — which one
the plugin reaches first is a coin toss. This build isolates its own
token/pid/port files under `~/.figma-bridge-mcp/`.

## Inspiration & attribution

Inspired by [figma-cli](https://github.com/silships/figma-cli) — this project
has since gone its own way (Safe-Mode-only architecture, MCP layer, hardened
plugin, design-to-code fidelity stack, Storybook mapping) and shares neither
the Yolo/CDP approach nor the bundled integrations.

Licensing: the `engine/` directory started as a fork of **figma-ds-cli v2.1.0**
(© Sil Bormüller, MIT) and retains that license — see [`NOTICE`](NOTICE) and
[`engine/LICENSE`](engine/LICENSE). figma-bridge-mcp itself is MIT — see
[`LICENSE`](LICENSE).
