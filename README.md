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
                        (Safe-Mode only)                │  HTTP: signed requests
                                                        │  WS  : challenge/response
                                                        ▼
                                              Figma Bridge plugin in Figma Desktop
                                                (evals code in the Figma sandbox)
```

- The **engine** lives under `engine/`. It began as a fork of `figma-ds-cli`
  v2.1.0 and has diverged well past it (see [attribution](#inspiration--attribution)).
  The Chrome-DevTools "Yolo mode" — which patches the Figma app binary — was
  removed entirely; there is no code path to it.
- The **daemon** brokers commands to the Figma plugin over a localhost
  WebSocket. Two gates protect it:
  - **HTTP routes** (`/health`, `/exec`) require a per-request HMAC signature
    keyed with the session token, a 0600 file — the token itself never crosses
    the wire.
  - **The plugin WebSocket** (`/plugin`) requires the **access key**: an
    `Origin`/`Host` allowlist plus a **mutual challenge-response handshake** in
    which the key is only ever an HMAC secret and never crosses the wire either.
    This closes the upstream gap where *any* local process could connect to the
    plugin socket and run code in your Figma document — and the inverse gap,
    where anything answering on a local port could drive an honest plugin.

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
3. Launch the plugin: `Plugins → Development → Figma Bridge`. **Paste the
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
| `figma_history` | Local change history from the audit log — filter by `nodeId`, optionally merge `git log` of generated code files and (REST add-on) the file's real Figma version history via `includeVersions:true`. Or pass `diff:{from,to}` for a structural diff of the document itself (added/removed/replaced/moved/changed). `figma_run`/`figma_render` accept a `label` to annotate entries. |
| `figma_selection` | The user's current selection in Figma (ids, names, types, sizes) — pushed live by the plugin. Instances resolve to their main component with the stable publish `key`, and mapped components show their Storybook story. |
| `figma_comments` | REST add-on: read design-review comments (`action:"list"`) or post/reply (`action:"post"` — always previews first, needs `confirm:true`). |

Node ids are accepted in every form a user has at hand: `12:34`, the URL
form `12-34`, or a full Figma URL (whose file key is checked against the files
you actually have open — see [Several files at once](#several-files-at-once)).

Write commands can be gated behind an explicit `confirm:true` by setting
`FIGMA_WRITE_CONFIRM=1` in the server's environment. The gate works on
subcommand level: reads like `node tree` or `component list` pass freely,
mutations like `node delete`, `combos`, or `tokens spacing` require confirm.

## Plugin window

The Figma Bridge plugin window is more than the connection status:

- **Activity** — every command the agent runs, live, with duration and
  ok/error; writes are highlighted. The collapsed row carries the tally
  (`12 ok · 1 failed`); the connected port and round-trip latency sit in the
  title bar.
- **Pause agent** — a kill switch: while paused, the plugin rejects every
  incoming agent command with an explicit error.
- **Save version** — writes a labeled entry into Figma's own version history
  (`Figma Bridge — <timestamp>`) as a manual restore point before letting the
  agent loose. There is no restore API for plugins: you roll back through
  Figma's version history panel.
- **Selection readout** — whatever the user selects is pushed to the agent
  automatically (debounced) and shown as "Agent sees: …", so the user always
  sees what `figma_selection` will return. Select a frame, say "build this" —
  no node-id copying.
- **Setup** — access key and the optional REST token, always reachable
  whether or not the bridge is connected.

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

   ```
   figma_run ["verify-build", "/abs/path/to/project"]
   ```

   It greps the project against `assets.json` and lists every exported file
   that is *not* referenced in the build — with size, offsets and parent, so
   placing it is one step — plus a `border-image` lint (CSS `border-image`
   ignores `border-radius`; gradient strokes on rounded boxes need the
   wrapper or mask pattern). Exit code 1 when files are missing, so it works
   as a CI gate too.

   With a build screenshot it also runs the **visual pass**:

   ```
   figma_run ["verify-build", "/abs/path/to/project", "--compare", "/abs/build.png"]
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

The same spec is available as `figma_run ["export", "code-spec", "<nodeId>"]`.

## Storybook mirroring

Figma components carry a **stable publish key** (survives library publishing;
node ids are file-local). The key now flows through `figma_spec` (json/yaml
model + the "Component sets used" trailer), `figma_selection`, `component
list`, `figma_inspect`, and DESIGN.md.

To link them to their code mirror:

```
figma_run ["map", "storybook", "http://localhost:6006"]
```

This matches the file's components against the Storybook index by normalized
name and writes **`figma-map.json`** into your project: Figma key ↔ story id /
import path, with a `confidence` per match plus both unmatched lists. Edit
entries by hand and set `"matchedBy": "manual"` to pin them — pinned entries
survive re-runs. When the file exists, `figma_selection` and `figma_spec`
annotate components with `↔ story <id> (<importPath>)` automatically.

## Bring your own design system

This project ships **no** design system — no shadcn, no Tailwind preset, no icon
pack. That is deliberate: a bundled system is someone else's opinion rendered
into your file. What it ships instead is a way to make *your* system legible to
an agent in one command:

```
figma_run ["kit", "init", "./my-app", "--storybook", "http://localhost:6006"]
```

Four reads, one report:

| Step | Result |
|------|--------|
| `extract` | `design/DESIGN.md` — structure, tokens, variant matrices |
| `export dtcg` | `design/tokens.json` — W3C design tokens |
| `component list --all-pages` | inventory with stable publish keys |
| `map storybook` | `figma-map.json` — Figma component ↔ story |

It ends by naming what is still missing — an unmapped Storybook, components with
no story, the `tokens sync` command that keeps the two in step — because a setup
that quietly lacks the mapping looks finished until an agent needs it.

DESIGN.md is what an agent should read first; `tokens.json` is what it binds to.

## Several files at once

The bridge holds one connection per Figma window in which you started the
plugin. That is the consent model: a file is reachable because *you* opened it
and launched the plugin there — not because a flag widened the scope.

- **One window** — nothing changes. Commands go there.
- **Several windows** — a command must name its target, or it fails with the
  list of connected files:

  ```
  figma_status                                        # lists every connected window
  figma_run {args: ["canvas","info"], fileKey: "GY5SasBJ…"}
  ```

  `figma_selection` says which files are open rather than guessing which
  selection you meant. On the engine's own command line the flag is
  `--figma-file`, not `--file`: `eval` and `spec` already use `-f, --file`
  for a local path.

There is deliberately **no "all files" option**. Every write names one file, so
a mistaken command cannot fan out across a library. Two windows on the *same*
file are indistinguishable for routing, so the newer one takes over and the
older is told it lost the bridge. Audit entries carry the file key, so
`figma_history` stays readable when several files are in play.

Reaching files you have *not* opened is out of scope: Figma's REST API cannot
write document content, so a bulk rename across thirty library files is not
something this tool can honestly offer.

## FigJam

The plugin runs in FigJam boards too, over the same bridge — no second
transport, no extra permission:

```
figma_run ["jam", "sticky", "Ship the handshake", "--color", "green"]
figma_run ["jam", "stickies", "[\"Discovery\",\"Build\",\"Ship\"]", "--columns", "3"]
figma_run ["jam", "shape", "Decide?", "--type", "DIAMOND"]
figma_run ["jam", "connector", "1:2", "3:4", "--text", "yes"]
figma_run ["jam", "table", "3", "4", "--data", "[[\"Step\",\"Owner\"],[\"Handshake\",\"Alex\"]]"]
figma_run ["jam", "board"]      # read everything back, with connectors
figma_run ["jam", "arrange"]    # tidy loose nodes onto a grid
```

New nodes land to the right of whatever is already on the board unless you pass
`--at x,y`, so an agent adding to a populated board does not stack everything at
the origin. Every command checks `figma.editorType` first and says "this is a
figma file, not a FigJam board" rather than failing on an undefined API.
`figma_status` reports which editor the bridge is attached to.

## Token sync (two-way)

`tokens import` only ever creates, so a value edited in code never reaches an
existing Figma variable and a value edited in Figma never reaches code.
`tokens sync` closes that loop:

```
figma_run ["tokens", "sync", "src/tokens.json"]              # plan only
figma_run ["tokens", "sync", "src/tokens.json", "--apply"]   # write it
```

Formats: **DTCG / W3C design tokens** (`.json`, what `export dtcg` emits) and
**CSS custom properties** (`.css`, what `export css` emits). Note that
`export dtcg` writes *every* local variable into one file while sync targets one
collection — pass `--collection` accordingly. If most names in the file already
live in another collection, sync says so instead of offering to duplicate them. Tailwind configs
are an import source only — their parser buckets values into
colour/spacing/radius and cannot round-trip, so sync refuses them by name
rather than silently dropping tokens it did not understand.

**Why a lockfile.** A two-way sync without memory cannot tell "the code
changed" from "Figma changed" — it only sees that the two differ, and whichever
direction it picks destroys the other side's work. `figma-tokens.lock.json`
records the state at the last successful sync, so every decision is a
three-way comparison:

| code | Figma | result |
|------|-------|--------|
| changed | unchanged | update Figma |
| unchanged | changed | **reported, never overwritten** — update your code file |
| both changed | | **conflict** — nothing is applied |
| unchanged | unchanged | unchanged |

Conflicts stop the whole run. Resolve them by editing one side, or decide them
all at once with `--ours` (the code file wins) / `--theirs` (Figma wins, and
nothing is written to Figma).

Deletions need `--prune`, and even then only touch variables sync itself
created — a variable it never tracked is reported as untracked and left alone.

The lockfile also stores each variable's Figma id, which is what makes a
**rename** one rename instead of a delete plus a create that would drop every
layer binding. Pairing is by value and only when unambiguous: renaming *and*
re-valuing a token in the same commit falls back to create + delete, so do
those as two steps if the bindings matter.

Without `--apply` the command exits 1 when changes are pending, so it works as a
CI check for "is Figma in sync with the repo?".

### Binding, and switching which collection a design follows

`tokens sync` writes token *values*. Two neighbouring things it deliberately
does not do:

```
figma_run ["node", "bind", "12:34", "radius", "radius/lg", "--collection", "TARGET_COLLECTION"]
figma_run ["tokens", "rebind", "TARGET_COLLECTION", "--node", "12:34"]            # plan
figma_run ["tokens", "rebind", "TARGET_COLLECTION", "--node", "12:34", "--apply"] # write
```

`node bind` attaches a variable to a property of an **existing** node — `fill`,
`stroke`, `radius`, `gap`, `padding` (or one side), `opacity`, `stroke-width`,
`width`, `height`. Its read counterpart is `node bindings`. Pass `--batch` with
a JSON array to bind many properties or nodes in one call.

A variable name that is not unique is **refused, not guessed** — this file has
`radius/lg` in two collections, and the answer names both so `--collection` can
settle it. The variable's type is checked against the property first, so a
COLOR on `radius` fails with a sentence rather than a plugin stack trace.

`tokens rebind` is the theme switch: it walks a subtree and repoints every
binding at the same-named variable in a target collection. Design a card
against `SOURCE_COLLECTION`, run rebind with `TARGET_COLLECTION`, and the same card follows
TARGET_COLLECTION values — no redesign. It plans by default; `--apply` writes. Tokens
with no counterpart in the target are listed and left pointing where they were,
so a partial theme is a report rather than a half-broken design.

## Version history and diffs

Figma's plugin API can *write* a version but not read one back, so "what changed
since this morning" has no answer from the bridge alone. `history` supplies one
without any credential: record the structure of a subtree, record it again
later, diff the two.

```
figma_run ["history", "snapshot", "--label", "before refactor"]
# … agent works …
figma_run ["history", "diff", "latest", "live"]
```

A snapshot stores one normalized record per node — geometry, layout, paints,
typography, component keys — plus a content hash and a subtree hash, so the
differ can report an untouched section instead of walking it. They live in
`~/.figma-bridge-mcp/snapshots/<fileKey>/`, gzipped, newest 20 kept.

Refs are `latest`, `previous`, an index from `history list`, a filename, or
`live` for the document right now. The report separates **added**, **removed**,
**replaced**, **moved** and **changed** — that last distinction is the one that
matters in practice: an agent that deletes a frame and re-renders it keeps the
name path but gets new node ids, and without the replaced-detection every
re-render would read as a hundred deletions. `--changelog` emits markdown
instead; `diff` exits 1 when anything differs, so it also works as a CI gate.

Via MCP this is a parameter, not a thirteenth tool:

```
figma_history {diff: {from: "latest", to: "live"}}
figma_history {diff: {from: "version:1234", to: "version:5678"}}   # REST add-on
```

`version:` refs go through the REST layer and diff what *designers* saved, using
the same differ. The two sources cannot be mixed in one diff: a REST document
and a plugin snapshot expose different properties, so every node would look
changed — the tool says so rather than producing a misleading wall of output.

## Motion

Figma Motion (Config 2026 Beta) is reachable through `figma_run` with
`["motion", …]`: keyframe tracks (`add`), whole specs from JSON (`apply`),
named presets (`preset`), choreographed offsets across nodes (`stagger`),
Figma's first-party animation styles (`styles`, `style`), frame duration
(`timeline`), readback (`inspect`) and removal (`clear`).

Like every other command it runs over the plugin bridge — there is no separate
transport for it. `styles` and `inspect` are reads; everything else, `timeline`
included (it reads *or* sets depending on its arguments), counts as a write
under `FIGMA_WRITE_CONFIRM=1`.

Motion is rolling out behind a Figma Beta flag. Without access, the commands
fail with a named `MOTION_DISABLED` error telling you to update Figma Desktop
rather than a generic API failure.

## REST add-on (optional)

Everything above works with **zero Figma credentials**. Three things the local
plugin bridge structurally cannot reach live behind Figma's REST API, and can
be unlocked with a personal access token:

| Feature | What it adds |
|---------|--------------|
| **Version history** | `figma_history {includeVersions:true}` merges what *designers* saved (when, by whom) into the local audit+git timeline — the plugin API can only *write* versions, not read them. `figma_history {diff:{from:"version:…", to:"version:…"}}` goes further and diffs the documents themselves. |
| **Comments** | `figma_comments` reads design-review feedback (with node anchors and thread ids) and can reply. Posting always shows a preview first and requires `confirm:true` — comments are visible to other people. |
| **Library metadata** | `map storybook` automatically enriches `figma-map.json` with the published components' `description` and documentation links — a far stronger matching signal than name normalization. |

**Enabling it — the token never leaves your machine:**

1. Create a personal access token in Figma (Settings → Security → Personal
   access tokens) with scopes: **File content (read)**, **File versions
   (read)**, **Comments (read and write)**. *Current user (read)* is optional —
   it only makes `figma_status` show your handle.
2. Open the **Figma Bridge plugin** in Figma Desktop, connect (the field
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
- **Two-layer daemon auth, no secret on the wire** — signed HTTP requests
  (per-request HMAC over method/path/body, keyed with the session token, nonce
  replay guard) + a mutual challenge-response handshake on the plugin socket
  (`Origin`/`Host` allowlisted). Neither the session token nor the access key is
  ever transmitted in either direction — see [Handshake](#handshake).
- **Localhost-locked plugin** — `plugin/manifest.json` restricts
  `networkAccess.allowedDomains` to `ws://127.0.0.1:3456–3460`.
- **Isolated state** — token, pid, key, and audit log live under
  `~/.figma-bridge-mcp/`, separate from any upstream figma-ds-cli install.
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
and body; the daemon rejects reused nonces). The plugin socket is safe on any
range port for the same reason: the handshake below carries no secret and binds
the port it ran on. Setting `DAEMON_PORT` explicitly disables the fallback;
values outside 3456–3460 are unsupported — the plugin manifest is
Figma-enforced and cannot reach them.

### Handshake

The plugin socket runs a mutual challenge-response (proto 2,
`engine/src/lib/plugin-handshake.js`):

```
daemon → plugin   {type:'challenge', proto:2, nonce:<dNonce>, port:<bound>}
plugin → daemon   {type:'hello', proto:2, nonce:<pNonce>, version, proof}
daemon → plugin   {type:'hello-ack', proof, restTokenConfigured}
```

where `proof = HMAC-SHA256(access key, transcript)` over both nonces, the bound
port and the plugin version — with distinct role labels and nonce ordering per
direction, so neither proof can be replayed as the other. Three properties
follow:

- **The key never crosses the wire.** A process that binds a range port before
  the daemon and records the whole exchange learns one HMAC over nonces it will
  never see again. This retires the residual risk earlier versions documented,
  where the raw key was the first frame the plugin sent.
- **The daemon proves itself too.** Before proto 2 the plugin trusted whatever
  answered and would run any `eval` it was sent — impersonating the daemon
  needed no key at all. The panel now refuses every command until the ack
  verifies.
- **The bound port is inside the transcript.** A squatter on 3456 that forwards
  to the real daemon on 3457 makes the plugin sign 3456 while the daemon
  verifies 3457, so the relay collapses.

There is no proto-1 fallback. `figma_connect` refreshes the installed plugin
files on every run, so upgrading is: run `figma_connect`, then close and reopen
the plugin window — a stale panel gets a named error saying exactly that,
instead of a silently weaker handshake.

The panel carries its own SHA-256/HMAC implementation: the plugin UI is a
sandboxed null-origin iframe, where WebCrypto availability is not ours to
guarantee, and a silent fallback to something weaker is the worst outcome for an
auth handshake. `tests/plugin-handshake.test.js` runs that shipped code against
Node's `crypto` so the two implementations cannot drift apart.

## Known limitations

- **Figma Slides is not supported.** FigJam is (see [FigJam](#figjam)); Slides
  would need its own command group and has not been built.
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

Two projects shaped this one, in different ways.

[**figma-cli**](https://github.com/silships/figma-cli) (Sil Bormüller) is where
the `engine/` directory comes from: it was vendored at v2.1.0 in July 2026 and
has diverged since — the CDP transport and the binary-patching installer are
gone, the plugin socket is authenticated, and most of what the engine does now
was written here. Four files remain byte-identical to upstream. The upstream
MIT license is retained in full at [`engine/LICENSE`](engine/LICENSE), and
[`NOTICE`](NOTICE) records what changed.

[**figma-console-mcp**](https://github.com/southleft/figma-console-mcp)
contributed an idea rather than code: that a Figma bridge can be genuinely
local — a plugin socket on the loopback interface, no cloud relay, no patched
binary. Nothing here is derived from its source; the tool surfaces, the
transport and the plugin are unrelated. Where this project differs is that the
socket also proves who is on the other end of it.

figma-bridge-mcp itself is MIT — see [`LICENSE`](LICENSE).

**Why the plugin id says `figma-safe-mcp-bridge`.** Figma keys a plugin's
`clientStorage` — where the paired access key lives — on the plugin id.
Renaming it to match the project would sign every existing user out and force
them to pair again, so it stays as it is.
