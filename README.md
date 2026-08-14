# figma-bridge-mcp

A local MCP server that lets AI assistants inspect, create, and update designs
in **Figma Desktop**. It connects through a small Figma development plugin and
exposes focused tools for screenshots, design specs, JSX rendering, tokens,
assets, components, FigJam, and Figma Slides.

Everything runs on `127.0.0.1`. No Figma Personal Access Token required. No
cloud. No binary patching of the Figma app.

An [optional REST add-on](#rest-add-on-optional) adds version history, comments,
and published-library metadata. Its Figma token stays on your machine and is
never placed in your MCP client configuration or chat.

Requirements: Node.js 18 or newer, Figma Desktop, and an MCP client that can
start local stdio servers.

## Quick start

### 1. Add the MCP server

The recommended setup uses `npx`: no clone and no build step. For Claude Code:

```bash
claude mcp add figma-bridge -- npx -y figma-bridge-mcp@latest
```

For another MCP client, add the equivalent server configuration:

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "npx",
      "args": ["-y", "figma-bridge-mcp@latest"]
    }
  }
}
```

Restart the MCP client if it does not discover the server immediately. There is
intentionally no `env` block: the bridge creates its local credentials during
pairing.

<details>
<summary>From source (contributors)</summary>

```bash
git clone https://github.com/KaiUweHella/figma-bridge-mcp.git
cd figma-bridge-mcp
npm install
```

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/figma-bridge-mcp/src/server.js"]
    }
  }
}
```

</details>

### 2. Pair Figma Desktop once

1. Ask your AI assistant to **connect to Figma**, or call `figma_connect`
   directly. It starts the local bridge and returns an access key plus a plugin
   manifest path.
2. In **Figma Desktop**: `Plugins → Development → Import plugin from manifest…`
   and choose **`~/.figma-bridge-mcp/plugin/manifest.json`** (the path
   returned by `figma_connect`).
3. Open `Plugins → Development → Figma Bridge`, paste the access key, and
   click **Save & connect**.
4. When the plugin shows **Connected (authenticated)**, the assistant can work
   with that Figma file. The pairing is remembered; on later sessions, only
   reopen the plugin in the file you want to use.

Figma Dev Mode needs separate adapters because Figma does not support combining
the existing FigJam editor target with `dev` in one manifest:

- Import `~/.figma-bridge-mcp/plugin/manifest.dev.json` for **Figma Bridge Dev
  Mode**. It keeps the authenticated MCP bridge connected for selection,
  inspection, specs and exports. Dev Mode is read-only, so rendering and canvas
  edits still require switching the file to Design mode and opening the normal
  **Figma Bridge** plugin there.

### 3. Use it with Figma

Select a frame or layer in Figma and describe the outcome you want. For example:

- "Inspect my current selection and explain its layout."
- "Create a settings card next to the selected frame."
- "Export the selected screen's tokens and assets into this project."
- "Implement the selected frame, then compare the result with Figma."

The assistant can read the current selection, capture screenshots and specs,
render JSX, export assets, or apply targeted edits. Keep the Figma Bridge plugin
open in every document the assistant should access. If more than one document
is connected, pass a Figma URL or file key so the target is unambiguous.

## How it works

```
MCP client ──stdio──▶ figma-bridge-mcp (src/)
                        │
                    MCP tool adapters ─▶ Capability Catalog ─▶ CommandPlan
                                                                  │
                                          ┌───────────────────────┴──────────┐
                                  Command Application Modules   generic CLI adapter
                                             │            │
                                      Design Capture      │
                                      Asset Policy        │
                                             └──────┬─────┘
                                      Daemon Client Module
                                             │  HTTP: signed requests
                                             ▼
                                  local daemon :3456–3460
                                             │  WS: challenge/response
                                             ▼
                                  Figma Bridge plugin in Figma Desktop
```

- The **engine** lives under `engine/`. It began as a fork of `figma-ds-cli`
  v2.1.0 and has diverged well past it (see [attribution](#inspiration--attribution)).
  The Chrome-DevTools "Yolo mode" — which patches the Figma app binary — was
  removed entirely; there is no code path to it.
- Specialized MCP reads (`figma_spec`, `figma_inspect`, `figma_screenshot`)
  execute directly through value-returning **Command Application Modules**.
  MCP and CLI are thin adapters over the same implementations; generic
  `figma_run` remains the deliberately broad child-process CLI adapter. One
  **Daemon Client Module** owns signing, timeouts and transport errors for both
  paths.
- The **Design Capture Module** walks an explicit node once and locally projects
  structure, style and the lossless output formats from those same facts. A
  Capture is reused only after a cheap revision probe proves the authenticated
  plugin connection and Figma document revision are unchanged. Missing or
  unstable revision metadata disables reuse; selection and named-section calls
  remain uncached in this first Slice.
  Captures distinguish authored Figma Auto Layout/Grid, Figma's marked
  `inferredAutoLayout` heuristic and geometry fallback. They also preserve
  Code-to-Figma semantic/fallback metadata separately from later native Figma
  annotations, plus full component and variable-mode contracts.
- The **Design Link Registry** gives a component, screen or frame one durable,
  repository-owned **Design Entity** id. `figma-bridge.json` holds portable
  code/Storybook/Figma links; Figma plugin data holds only the same id and kind.
  This dual anchor lets future agents resolve the exact existing component from
  either side without putting repository paths into a Figma document.
- The report-only **Round-trip Planner** compares current code and the current
  normalized Figma subtree with an explicitly **Accepted Design Baseline**.
  The **Project Design Context** projects that status, the entity links and the
  exact next reads through one in-process Command Application. When semantic
  paths exist, changed subtrees are reported with their current node ids;
  plugin markers themselves never count as visual changes.
- One **Capability Catalog** resolves every Figma Command entering through MCP
  into an immutable plan before either execution adapter runs it. That plan is
  the single source for exposure, Figma/workspace/shared-state effects, target
  need, confirmation, normalized paths, retry, timeout, accepted exit codes
  and background-job identity. Unknown commands default to denied/write/no-retry.
- One immutable **Figma Target Context** resolves explicit `fileKey`, pasted
  Figma URL or implicit single-window targeting once per command and then
  accompanies planning, audit, job identity and daemon execution. One shared
  **Asset Policy** classifies image fills, vector art and vector clusters for
  both Design Capture projections and export.
- Runtime protocol validators reject malformed HTTP execution payloads and
  plugin frames at the transport boundary. TypeScript checks the JavaScript
  seams (including the Figma plugin), while deterministic context, payload and
  median and tail latency budgets catch architectural regressions in CI without
  treating brief shared-runner scheduling pauses as a sustained regression.
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

## Tools

| Tool | Purpose |
|------|---------|
| `figma_connect` | Start Safe Mode, generate/show the access key, print plugin setup steps. |
| `figma_status` | Report local daemon/plugin/file/key state immediately; `validateRest:true` explicitly checks the optional REST token. |
| `figma_pairing` | Show the access key; `{rotate:true}` generates a fresh one. |
| `figma_run` | Run a Capability Catalog-approved engine command; discover them with `figma_reference {name:"capabilities"}`. |
| `figma_render` | Render JSX into the open Figma design. |
| `figma_inspect` | Inspect a node by id: geometry, fills/strokes/effects, clip, opacity (YAML). |
| `figma_screenshot` | Save a PNG of a node/selection to a temp file (path + dimensions + applied scale returned). |
| `figma_spec` | Design-to-code spec of a node: real content, component names, tokens, vector-art refs, clip/abs — in phases. |
| `figma_reference` | Offline Figma Plugin API reference (`api setup` once); `{name:"capabilities"}` lists the generated command index without starting the engine. |
| `figma_history` | Local change history from the audit log — filter by `nodeId`, optionally merge `git log` of generated code files and (REST add-on) the file's real Figma version history via `includeVersions:true`. Or pass `diff:{from,to}` for a structural diff of the document itself (added/removed/replaced/moved/changed). `figma_run`/`figma_render` accept a `label` to annotate entries. |
| `figma_selection` | The user's current selection in Figma (ids, names, types, sizes) — pushed live by the plugin. Instances resolve to their stable publish `key`; linked nodes show their Design Entity, code file and Storybook story. |
| `figma_comments` | REST add-on: read design-review comments (`action:"list"`) or post/reply (`action:"post"` — always previews first, needs `confirm:true`). |

Node ids are accepted in every form a user has at hand: `12:34`, the URL
form `12-34`, or a full Figma URL (whose file key is checked against the files
you actually have open — see [Several files at once](#several-files-at-once)).

Write commands can be gated behind an explicit `confirm:true` by setting
`FIGMA_WRITE_CONFIRM=1` in the server's environment. The gate works on
subcommand level: reads like `node tree` or `component list` pass freely,
mutations like `node delete`, `combos`, or `tokens spacing` require confirm.

Native JSX instances require durable Registry identity (`entity` plus a
published `key` or local `id`). Their editable overrides use the component's
real Figma structure:

```jsx
<Instance entity="ui.card" key="..."
  prop:Selected="true"
  text:Title="New title"
  fill:StatusDot="var:status/healthy|#22c55e"
  swap:LeadingIcon="ui.icon.leaf" />
```

`prop:` resolves a component-property definition; `text:` and `fill:` resolve
one named descendant. `swap:` values and INSTANCE_SWAP property values are
Design Entity ids, resolved from `figma-bridge.json`; component display names
are intentionally not accepted as swap identity. Missing, ambiguous or
unlinked targets stop preflight before the first canvas node is created.

Dimensions and typography accept the same `var:name|fallback` form. The native
executor binds width, height and min/max constraints plus font family/style,
weight, size, line height, letter spacing, paragraph spacing and paragraph
indent. Family/style use STRING variables; the other typography and dimension
fields use FLOAT variables. A missing bound font stops preflight with an
install-or-choose-another-face message instead of silently substituting it.
Named Text Styles are reconciled before canvas creation as well: an explicit
`style="Typography/Eyebrow"` is reused only when its complete typography
matches; a conflicting same-name style stops, and otherwise exact typography
is reused or created under a deterministic `Typography/Generated/...` name.
Figma float32 metric readback is normalized for stable comparison, and
family-specific faces such as DM Sans/Manrope `SemiBold` and `ExtraBold` are
tried before any fallback family. Successful native renders return
`textStyleReport` and `variableReport` counts for references,
unique reused variables, created variables and bound properties. Ambiguous or
unsupported preflight errors include the corresponding zero/nonzero counts and
do not leave newly created variables or canvas nodes behind.

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
than interpreting it. Build a screen from Figma in six steps:

1. **`figma_screenshot`** on the target frame, then read the saved PNG — the
   visual ground truth. Never build from a node tree alone.
2. **`figma_spec` with `phase: "structure"`** — build the markup skeleton:
   real text characters, resolved icon/component names (instances are
   descended into, so overrides and true main-component names appear),
   hierarchy and flex direction. Copy texts and icons verbatim. A
   `layout:inferred (Figma heuristic — verify)` marker is not authored Auto
   Layout; check the hierarchy before treating it as the component contract.
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
   Oversized PNGs are downsampled by default to 2× their largest Figma usage
   (retina density), without upscaling and only when the encoded file becomes
   smaller. Aspect ratio, manifest placement and CSS crop behavior remain
   unchanged; pass `--raster-scale 0` to retain original PNG bytes.
5. **`figma_spec` with `phase: "style"`** — apply sizes, gaps, padding,
   alignment, fill/hug sizing, paints incl. gradients (`→ var(name)` marks a
   design-token binding), radii, shadows, typography, `opacity`, `clip`
   (overflow hidden) and `abs` positioning. Decorative vectors appear as
   `vector art → assets/…` lines with placement — place the exported SVGs,
   never approximate them in CSS.

   Structured YAML/JSON additionally retains exact component property
   definitions and values (including INSTANCE_SWAP and SLOT), property
   references, preferred values, direct overrides, exposed instances and slot
   violations. Variable bindings include collection identity, authored scopes,
   explicit/resolved modes, `codeSyntax.WEB` and the resolved value;
   `inferredVariables` is emitted separately as suggestion-only evidence.

   For a large section, request `depth:0` first. This is a complete contract
   for the section container itself (including background, border, radius and
   layout) without descendants. Then request child node ids in bounded calls.
   Use `dedup:true` for repeated cards/lists; shared `S<n>` references remain
   lossless and stop identical instance styles exhausting the result budget.
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

The same spec is available as
`figma_run ["export", "code-spec", "<nodeId>"]`. Its default is the readable
tree; pass `-f yaml` or `-f json` for the canonical model.

### Lossless structured spec formats

`figma_spec` and `export code-spec` default to `format:"tree"`, the concise,
line-oriented agent view whose footers carry the required asset and fidelity
actions. Use `yaml` or formatted `json` explicitly when a consumer needs the
versioned canonical model. Both structured formats serialize the **same model**;
only syntax differs. Roundtrip tests require every field — text,
ids, layout provenance, paint, typography, mode-aware variables, assets,
component contracts, Bridge intent, native annotations, capture
completeness, and fidelity checks — to survive exactly. Minified JSON is not
offered: real agent tests showed that a single huge line was materially harder
to act on despite carrying the same raw fields.

The model's `capture` field explicitly reports requested/actual depth,
payload completeness, hidden-node policy, and whether the requested depth cut
off descendants. There is no silent tool-result truncation: if a spec exceeds
the configured output budget, the call returns `complete:false` with a
section-by-section retry recipe and returns **no misleading partial design**.
`depth:0` intentionally means “the requested node only” and is complete, not
a depth-truncated tree.

IMAGE-fill filenames are keyed by Figma's stable image hash, not by the local
layer name/path. This keeps `figma_spec`, isolated child calls, asset export and
`assets.json` on the same filename even when generic layers such as “Frame 64”
are reached through different roots.

For MCP design-to-code calls, `dedup:false` is the default: every visible layer
keeps its own id, native Figma Inspect `css{…}`, layout/paint/token facts and
complete text. Mixed rich-text layers carry their individual styled ranges.
The footer reconciles the live visible-layer count with explicit rows, SVG
internals, component internals and non-rendering helpers. A style projection
is rejected when depth limits or an unaccounted layer would force guessing;
split it by the node ids from the structure map. Set `dedup:true` only for a
compact overview using shared `S<n>` style and repeat references.

For repeated explicit-node calls, `phase`, `format` and deduplication do not
trigger another full Figma walk. The in-memory Design Capture cache is bounded
to 8 entries / 8 MiB by default (`DESIGN_CAPTURE_CACHE_ENTRIES` and
`DESIGN_CAPTURE_CACHE_BYTES`). Every hit still probes the live document
revision; there is no TTL and no stale-while-revalidate path.

## Code ↔ Figma design memory

Give each important component, screen or frame a durable **Design Entity** id.
The id describes the concept, not its current location: use names such as
`ui.button`, `ui.account-card` or `screen.settings`.

After selecting or identifying a Figma node, an agent can create the link with:

```text
figma_run {args:["link","set","9:9","screen.settings","--kind","screen","--source","src/routes/settings.tsx","--export","SettingsScreen","--story","screens-settings--default"], confirm:true}
```

This converges two small adapters:

- `figma-bridge.json` is the committed, reviewable Registry with repo-relative
  code paths plus optional Storybook and Figma handles.
- Figma stores only `{version,id,kind}` as plugin data on the node. It contains
  no local path, credential or machine-specific state.

Use `figma_run ["link","inspect","9:9"]` to resolve a node and
`figma_run ["link","list"]` to inspect the repository memory without reading
Figma. Once linked, `figma_selection` and `figma_spec` automatically expose the
same id and the Registry's code/Storybook targets. Agents should reuse or edit
that code component instead of creating a look-alike. Repeating the same `set`
command is safe and repairs either side after an interrupted write.

After visually verifying that code and Figma correspond, explicitly record
their current fingerprints. Screen entities require a real browser screenshot
and a passing pixel threshold:

```text
figma_run ["link","accept","screen.settings","--compare","/abs/build.png","--max-diff","5"]
```

Source code is never stored in the Registry. The initial code Adapter hashes
the complete linked file plus its export identity; therefore an unrelated edit
in a shared file may conservatively report a code change, but a real change is
never hidden. The Figma Adapter hashes the normalized linked subtree. For
Code-to-Figma nodes it also stores each unique `figmaBridge.semanticPath` with
that node's subtree hash. A later `link status` can therefore list the exact
added, removed or changed semantic paths and recommend node-scoped specs.
Changing a semantic marker alone does not change the visual fingerprint;
duplicate paths are reported as ambiguous instead of guessed.

```text
figma_run ["link","status","screen.settings"]
figma_run ["link","context","screen.settings"]
```

| Status | Meaning |
|--------|---------|
| `unchanged` | Neither side moved from the accepted baseline. |
| `code-only` | Only the linked code file moved. |
| `figma-only` | Only the linked Figma subtree moved. |
| `conflict` | Both moved; neither side is overwritten. |
| `untracked` | No baseline has been explicitly accepted yet. |

`link context` is the preferred agent entry point after a link exists. It
returns the smallest relevant projection: entity, code/export, Figma root,
Storybook story, current Round-trip Plan, discovered `DESIGN.md`/token files
and exact next reads. It is generated on demand, not persisted as another
memory file. `link accept` writes only `figma-bridge.json`; it never changes
Figma or code. For screens it also stores the measured diff and SHA-256 hashes
of both comparison images, so a structural fingerprint cannot certify a
visibly wrong baseline.

Conventional `DESIGN.md`, `design/DESIGN.md`, `tokens.json` and
`design/tokens.json` locations are discovered automatically. Configure custom
repo-relative locations once when needed:

```text
figma_run ["link","configure","--design-doc","docs/product-design.md","--tokens","src/theme/tokens.json"]
```

Commit `figma-bridge.json`. Do not put secrets, absolute paths or generated
credentials in it. The schema and conflict rules are documented in
`docs/adr/0007-dual-anchor-design-entities.md`, with baseline and context
decisions in ADR-0008 and ADR-0009.

### Reviewed CSS ↔ Figma boundary strategies

Semantic Code-to-Figma uses stable policy ids rather than silent visual
substitutions: `minmax.native-grid`, `space-around.equal-slots`,
`border.single-paint-native`, `sticky.metadata-only`, `filters.layer-stack`,
`masks.vector-mask`, `font.named-faces`, and `figma-effects.native`. The full
matrix and its remaining hard stops live in
[`docs/css-figma-semantic-matrix.md`](docs/css-figma-semantic-matrix.md).

Reviewed lossy policies can opt into an automatic native Figma annotation on
the exact affected semantic node. The annotation explains the unsupported CSS
fact, links the relevant Figma properties and is mirrored as versioned
`figmaBridge.fallbackAnnotations` plugin data for future agents. Equivalent
native conversions remain unannotated to avoid review noise. The first active
policy is `border.single-paint-native`: Figma receives the first explicitly
painted CSS side as the shared native stroke, retains all four side weights,
and marks `strokes` plus `strokeWeight`. Native renders report how many
fallback annotations were added, deduplicated or unsupported.

Intrinsic single-line DOM text maps to Figma HUG sizing. Positioned and
multiline text keeps measured box geometry; the bridge does not add arbitrary
percentage width headroom to prevent wrapping.

Variable-font axes are captured, but the structural gate asks whether the
required font should be installed or an available named face should be used
before rendering. Native Figma Glass remains an editable native effect with
all effect parameters retained; it is not silently treated as CSS
`backdrop-filter`, because Figma's CSS export does not expose those Glass
parameters.

## Storybook mirroring

Figma components carry a **stable publish key** (survives library publishing;
node ids are file-local). The key now flows through `figma_spec` (canonical
structured model + the "Component sets used" tree trailer), `figma_selection`, `component
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

`figma-map.json` remains a legacy read adapter, so existing mappings continue
to work. New durable links belong in `figma-bridge.json`; `link set` never
copies legacy rows into it. Migrate a component when you next touch it by
assigning its real Design Entity id and passing its story via `--story`. Remove
the legacy file only after `link list` shows every mapping you still need.

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
  figma_spec {nodeId: "12:34", fileKey: "GY5SasBJ…"}
  ```

  `figma_render`, `figma_selection`, `figma_inspect`, `figma_screenshot`, and
  `figma_spec` accept the same `fileKey` parameter. A full Figma node URL also
  supplies its file key automatically. Without a target, `figma_selection`
  says which files are open rather than guessing. On the engine CLI the flag is
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
figma_run ["jam", "arrange"]    # arrange only the current selection
figma_run ["jam", "arrange", "--ids", "1:2,3:4"]
figma_run ["jam", "arrange", "--all"] # explicit: whole page
```

New nodes land to the right of whatever is already on the board unless you pass
`--at x,y`, so an agent adding to a populated board does not stack everything at
the origin. Every command checks `figma.editorType` first and says "this is a
figma file, not a FigJam board" rather than failing on an undefined API.
`figma_status` reports which editor the bridge is attached to.

`jam arrange` is deliberately selection-scoped. Agents can pass exact node ids
without changing the user's selection; rearranging the whole page requires the
visible `--all` flag. Sections and connectors are never moved by this command.
The public surface was exercised in Figma Desktop on 2026-08-10; the commands,
readback evidence and runtime font fix are recorded in
[`docs/live-acceptance.md`](docs/live-acceptance.md).

## Figma Slides beta

Slides uses the same authenticated plugin bridge. The beta surface covers deck
structure and native slide properties, not a separate presentation renderer:

```
figma_run ["slides", "inspect"]
figma_run ["slides", "create", "Agenda", "--row", "0", "--col", "1"]
figma_run ["slides", "duplicate", "Agenda", "--label", "Agenda alternative"]
figma_run ["slides", "move", "Agenda alternative", "1", "0"]
figma_run ["slides", "transition", "Agenda", "DISSOLVE", "--duration", "0.4"]
figma_run ["slides", "skip", "Appendix", "on"]
figma_run ["slides", "delete", "1:42"]
```

Figma renumbers native slide names whenever the canvas grid changes. The
optional argument to `create` and `--label` on `duplicate` therefore store a
durable Bridge label in plugin data; `inspect` reports both the native `name`
and stable `label`. References resolve by id, exact native name or label, then
unique substring. Ambiguity is an error, delete always requires an explicit
reference, and duplicate/move refuse a nonexistent target row rather than
accepting Figma's fallback placement. Every operation checks
`figma.editorType === "slides"` before touching a Slides-only API. The open
candidates and the criteria for leaving beta live in
[`docs/slides-roadmap.md`](docs/slides-roadmap.md); editor acceptance is tracked
in [`docs/live-acceptance.md`](docs/live-acceptance.md).

## Token sync (two-way)

`tokens import` only ever creates, so a value edited in code never reaches an
existing Figma variable and a value edited in Figma never reaches code.
`tokens sync` closes that loop:

```
figma_run ["tokens", "sync", "src/tokens.json"]              # plan only
figma_run ["tokens", "sync", "src/tokens.json", "--apply"]   # write it
```

The import surface is broader than the sync surface. One-shot `import` accepts
Tailwind v3 config, Tailwind v4/CSS, Storybook indexes, DTCG/W3C JSON, and the
DTCG-compatible token shapes exported by Style Dictionary and Tokens Studio.
That compatibility does not include Tokens Studio theme semantics or arbitrary
preprocessors; metadata such as `$themes` is ignored while token sets and
aliases are read.

New FLOAT variables in explicit `spacing/*` or `space/*` namespaces are scoped
to Figma's `GAP` consumers only. `radius/*` and `radii/*` variables are scoped
to `CORNER_RADIUS` only. The inference is deliberately namespace-exact:
names such as `spacingFactor` are left at Figma's default scope, and rendering
does not silently change the scopes of existing user or library variables.
Other new COLOR, FLOAT, or STRING variables surface `SCOPE DECISION REQUIRED`
with only the compatible Figma choices. The agent should ask before narrowing
them; inspect the catalog with `figma_reference {name:"variable-scopes"}` and
apply the answer with `figma_run ["var","update","<name>","--collection",
"<collection>","--scopes","TEXT_FILL,STROKE_COLOR"]`.

Safe three-way sync accepts only **DTCG / W3C design tokens** (`.json`, what
`export dtcg` emits) and **CSS custom properties** (`.css`, what `export css`
emits). Sass `$variables` are not CSS custom properties and `.scss` is refused
rather than partially parsed. Note that
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

Typography variables have their own range-aware command because text can carry
different bindings on different character spans:

```
figma_run ["font", "bind", "12:36", "fontWeight", "type/weight", "--collection", "Typography"]
figma_run ["font", "bind", "12:36", "line-height", "type/line-height", "--start", "0", "--end", "12"]
figma_run ["font", "unbind", "12:36", "lineHeight", "--start", "0", "--end", "12"]
```

Bindable fields are `fontFamily`, `fontSize`, `fontStyle`, `fontWeight`,
`letterSpacing`, `lineHeight`, `paragraphSpacing` and `paragraphIndent`;
kebab-case spellings are accepted too. Existing fonts—and for family/style/
weight bindings the relevant available family styles—are loaded before the
binding is changed. Variable names are refused when ambiguous, and STRING vs
FLOAT is checked before Figma is called. A numeric `fontWeight` binding still
is not a general variable-font-axis setter: Figma selects a valid weight for
the active font.

`tokens rebind` is the theme switch: it walks a subtree and repoints every
binding at the same-named variable in a target collection. Design a card
against `SOURCE_COLLECTION`, run rebind with `TARGET_COLLECTION`, and the same card follows
TARGET_COLLECTION values — no redesign. It plans by default; `--apply` writes. Tokens
with no counterpart in the target are listed and left pointing where they were,
so a partial theme is a report rather than a half-broken design.

`node set` changes properties on nodes that already exist — `fill`, `stroke`,
`strokeWidth`, `radius`, `opacity`, `x`, `y`, `width`/`height`, `name`,
`visible` — one node at a time or many through `--batch`, which matters because
the batch form is **one** round-trip:

```
figma_run ["node", "set", "12:34", "--name", "Card", "--radius", "12"]
figma_run ["node", "set", "--batch", "[{\"node\":\"12:35\",\"fill\":\"var:sage/50\",\"name\":\"Badge\"}]"]
```

A colour takes a hex or `var:<name>`. The difference is not cosmetic: a hex is
frozen, a `var:` reference stays **bound**, so a later `tokens rebind` can still
move it.

### Local styles, variable metadata, and modes

The local design-system primitives that used to require manual UI work now
have first-class Figma Commands. They use the live Plugin API, not REST:

```
figma_run ["style", "list", "--type", "TEXT"]
figma_run ["style", "show", "Heading/H1"]
figma_run ["style", "create", "PAINT", "Brand/Primary", "--properties", "{\"paints\":[{\"type\":\"SOLID\",\"color\":{\"r\":0.1,\"g\":0.3,\"b\":0.9}}]}"]
figma_run ["style", "apply", "Brand/Primary", "12:34,12:35", "--field", "fill"]
figma_run ["style", "consumers", "Brand/Primary"]
figma_run ["style", "publish-status", "Brand/Primary"]
figma_run ["style", "bind-font", "Body", "fontSize", "--variable", "type/size/body"]
figma_run ["style", "unbind-font", "Body", "fontSize"]
```

`style` covers local PAINT, TEXT, EFFECT and GRID styles. `update` accepts the
same type-specific JSON properties as `create`; `apply` validates the style
type against `fill`, `stroke`, `text`, `effect` or `grid`. Name lookups refuse
ambiguity. Consumers come from `getStyleConsumersAsync()`, and publish state is
one of Figma's `UNPUBLISHED`, `CURRENT` or `CHANGED` values.

Variables expose the metadata and mode operations that token-file sync does
not own:

```
figma_run ["var", "show", "space/md", "--collection", "Primitives"]
figma_run ["var", "update", "space/md", "--description", "Medium spacing", "--scopes", "GAP"]
figma_run ["var", "set-value", "space/md", "12", "--mode", "Light"]
figma_run ["var", "set-value", "space/card", "--alias", "space/md", "--mode", "Light"]
figma_run ["var", "code-syntax", "space/md", "WEB", "var(--space-md)"]
figma_run ["var", "resolve", "space/md", "12:34"]
figma_run ["col", "mode-add", "Primitives", "Dark"]
figma_run ["col", "mode-rename", "Primitives", "Dark", "Dim"]
figma_run ["col", "extend", "Primitives", "Brand"]
```

`var show` returns values by mode, scopes, code syntax, collection metadata and
publish status. `var resolve` deliberately requires a consumer node because
aliases can resolve differently under that node's selected modes. Collection
`show`, `update`, `mode-add`, `mode-rename`, `mode-remove` and
`publish-status` follow the same ID/exact-name/unique-substring lookup policy.
Figma plan limits on mode count remain Figma-enforced and surface as errors.
Collection extensions use `VariableCollection.extend()` for local collections
and `extendLibraryCollectionByKeyAsync()` for published keys. Figma restricts
this feature to Enterprise plans; the CLI reports Figma's plan error unchanged.
Text-style bindings support exactly Figma's bindable typography fields:
family, style, weight, size, line height, letter spacing, and paragraph values.

### Enabled team libraries

Library discovery and imports also stay on the authenticated plugin transport:

```
figma_run ["library", "collections"]
figma_run ["library", "variables", "Acme/Primitives", "--type", "COLOR"]
figma_run ["library", "import-variable", "<published-variable-key>"]
figma_run ["library", "import-style", "<published-style-key>"]
figma_run ["library", "import-component", "<published-component-key>"]
figma_run ["library", "import-component-set", "<published-component-set-key>"]
```

`collections` and `variables` are reads. The four `import-*` commands
materialize published assets in the current file and are therefore writes in
the Capability Catalog. Figma only exposes discovery for variable collections
and variables. Published styles, components and component sets can be imported
when their stable key is already known, but the Plugin API cannot enumerate
them.

Libraries must be enabled for the current file in Figma's UI before
`library collections` can see them; the Plugin API cannot enable a library.
The shipped plugin already declares the required `teamlibrary` permission.
Name lookup uses collection key, exact collection name, then an unambiguous
collection or library-name substring. Library discovery owns an 18-second
Plugin-API timeout below the Bridge deadline, so a stalled Figma library
request names the operation and suggests checking whether the library is
enabled instead of degrading into a generic execution timeout.

### Prototypes, Dev Mode measurements, and annotations

These document features are also Plugin-API-first:

```
figma_run ["prototype", "inspect", "12:34"]
figma_run ["prototype", "add", "12:34", "--trigger", "click", "--navigate-to", "12:36"]
figma_run ["prototype", "set", "12:34", "--json", "[{\"trigger\":{\"type\":\"ON_CLICK\"},\"actions\":[{\"type\":\"BACK\"}]}]"]
figma_run ["measure", "add", "12:34:right", "12:36:left", "--offset", "16", "--text", "gap"]
figma_run ["annotate", "categories"]
figma_run ["annotate", "add", "Review spacing", "--node", "12:34", "--category", "Review", "--properties", "width,fontSize"]
figma_run ["annotate", "edit", "12:34", "0", "--text", "Resolved"]
```

`prototype set --json` is the lossless form for Figma's multiple actions,
`SET_VARIABLE`, `SET_VARIABLE_MODE`, and conditional blocks. It writes through
`setReactionsAsync()` so dynamic-page manifests are supported. Measurement
writes are guarded to Figma Dev Mode and use `PageNode`'s native measurement
methods. Annotation indexes are zero-based; custom category create/edit/remove
commands are available alongside `categories`. These manual review notes are
independent from the semantic renderer's automatic Boundary Fallback
Annotations, which are emitted only by explicitly opted-in lossy mapping
policies and remain machine-readable through plugin data.

### 2026 Plugin APIs: video, shaders, grid, slots, and Draw

The current official Plugin API surface is exposed as Figma Commands rather
than REST calls:

```
figma_run ["export", "video", "12:34", "--format", "mp4", "--fps", "30", "-o", "/abs/demo.mp4"]
figma_run ["shader", "list"]
figma_run ["shader", "import", "<shader-id>"]
figma_run ["shader", "apply", "12:34", "<shader-id>", "--field", "fill", "--properties", "{\"definition-id\":0.8}"]
figma_run ["layout", "grid", "set", "12:34", "--rows", "2", "--columns", "3", "--row-gap", "12"]
figma_run ["layout", "grid", "auto-flow", "12:34", "--auto-tracks", "rows", "--positioning", "row_auto_flow"]
figma_run ["slot", "create", "12:37", "Content", "--settings", "{\"minChildren\":1,\"maxChildren\":3}"]
figma_run ["slot", "validate", "12:37"]
figma_run ["draw", "inspect", "12:38"]
figma_run ["draw", "text-path", "12:38", "--text", "Around the curve"]
figma_run ["draw", "stroke-profile", "12:38", "--preset", "TAPER"]
figma_run ["draw", "pattern", "12:38", "12:39", "--field", "fill"]
```

Video export resolves a selected descendant to its top-level animated frame
and accepts only Figma's format-specific FPS values. Shader properties are
keyed by definition ID, not display name, and an available shader must be
imported before it is applied. `layout grid` means the auto-layout `GRID`
model; the older top-level `grid` command remains layout-guide management.
Slots expose GA `SlotSettings`, preferred values, reset, and limit violations;
JSX `<Slot>` now uses `ComponentNode.createSlot()` and validates configured
limits after rendering. Draw commands cover text paths, repeat transform
groups, stretch/scatter/dynamic strokes, variable-width profiles, and async
pattern fill/stroke setters. Run the corresponding `inspect`/`validate` read
before writes when modifying an unfamiliar document.

### Finding what needs fixing

```
figma_run ["analyze", "lint", "--node", "12:34"]
```

One pass for the four things a design-system review acts on: colours that match
an existing variable but are not bound to it, layers still carrying a default
name, text with no style, text under 12px. `--fail-on-issues` makes it a CI
gate; `--kind` narrows it; `--json` never truncates.

A hardcoded colour is only reported **when a variable already holds that exact
value** — otherwise the finding is noise you cannot act on. Because the match
is known, each one arrives with the command that fixes it:

```
unbound token colour — 1
  12:35    Badge  fill is #8a9a8d, which is sage/400
    fix: node bind 12:35 fill "sage/400" --collection "Sprout Primitives"
```

`analyze colors|typography|spacing` still give the full census. Lint is the
pass that answers whether anything needs doing at all.

### Variable fonts and OpenType facts

Figma does not expose a general variation-axis tuple through the Plugin API.
The bridge therefore separates facts Figma actually reports from axis intent
that a caller records explicitly:

```
figma_run ["font", "inspect", "12:36"]
figma_run ["font", "inspect", "12:36", "--start", "0", "--end", "12", "--all-open-type"]
```

`font inspect` returns styled text ranges with `fontName`, numeric read-only
`fontWeight`, size, enabled OpenType feature tags and resolved typography
variable bindings. `--all-open-type` also includes false feature values. The
result names the API limit explicitly: a reported `fontWeight` is not a general
`wght`/`wdth`/`opsz`/custom-axis tuple, and OpenType features are read-only.

When the exact axis values are known from the UI or another font tool, preserve
them on the text node as range metadata:

```
figma_run ["font", "remember-axes", "12:36", "wght=357,wdth=82", "--start", "0", "--end", "12"]
figma_run ["font", "axes", "12:36"]
figma_run ["font", "forget-axes", "12:36", "--start", "0", "--end", "12"]
figma_run ["font", "forget-axes", "12:36"]  # clear every stored range
```

`remember-axes` changes plugin metadata only — never the font or rendered
glyphs — and is therefore classified as a write by the Capability Catalog.
`figma_spec` carries these records as `axes-meta[start:end](tag=value,…)`, plus
Figma's reported `fw…` value and enabled `ot(…)` tags, so design-to-code capture
does not silently discard the documented intent.

## Native Plugin API facts

Two read commands expose Figma's own representations without contacting the
REST API:

```
figma_run ["node", "css", "12:34"]
figma_run ["node", "css", "12:34", "--json"]
figma_run ["export", "node-json", "12:34"]
figma_run ["export", "node-json", "12:34", "-o", "facts/card.json"]
```

`node css` calls `getCSSAsync()` and returns the declarations Figma exposes for
its Inspect panel. This is deliberately separate from `export css`, which
exports design-token custom properties. `export node-json` uses
`exportAsync({format:"JSON_REST_V1"})`: the shape resembles the REST file
schema, but the bytes come from the live plugin document and need neither a
token nor a network request.

## Version history and diffs

Figma's plugin API can *write* a version but not read one back, so "what changed
since this morning" has no answer from the bridge alone. `history` supplies one
without any credential: record the structure of a subtree, record it again
later, diff the two.

```
figma_run ["history", "save", "Before refactor", "--description", "Agent restore point"]
figma_run ["history", "snapshot", "--label", "before refactor"]
# … agent works …
figma_run ["history", "diff", "latest", "live"]
```

`history save` creates the named entry directly through
`saveVersionHistoryAsync()` and is a Figma write. `snapshot`, `list` and `diff`
remain local/read-only Figma operations; reading Figma's native historical
versions still requires the optional REST add-on.

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
3. `figma_status` reports that the token is configured without making a remote
   request. Run `figma_status {validateRest:true}` when you want an explicit
   validity check; it reports your handle or verifies file access when the
   optional *Current user* scope is absent.

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

The REST client is a closed internal allowlist, not a generic HTTP escape
hatch. It permits token health, version lists, version-pinned document
contents, comments, and file-wide published-component metadata. A bare current
file fetch and all node/CSS/export/variable/style/Dev-Resource endpoints are
rejected before the token is read or the network is touched; those operations
must use the local Plugin API commands above.

## Security model

- **No Figma API token required** — Figma is driven through the local plugin,
  never `api.figma.com`. The REST add-on is strictly opt-in: without a token
  the code path is inert, and with one the token lives in a 0600 file (or your
  own env var), not in the MCP client config.
- **No binary patching** — Yolo/CDP mode is stripped from the vendored engine.
- **Capability-gated commands** — `figma_run` only accepts Commands exposed by
  the Capability Catalog; `connect` is *not* exposed, so Safe-Mode-only
  connection is enforced. The same resolved plan drives the write-confirm gate,
  target requirement and retry policy, preventing adapter drift.
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

- **Figma Slides is beta and deliberately bounded.** Grid inspection, slide
  create/duplicate/move/delete, skip state and transitions are supported.
  Speaker notes, interactive polls/embeds, presenter controls and a complete
  content-authoring workflow are not. See the
  [Slides roadmap](docs/slides-roadmap.md) for actionable candidates versus
  Plugin API boundaries.
- **Non-localhost network actions are few and explicit**: `api setup`
  (one-time git clone of the Figma Plugin API docs mirror, for
  `figma_reference`; `api gap` instead measures against the installed official
  `@figma/plugin-typings` package), the Storybook index fetch of `import`/`map
  storybook`
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
npm run check:contracts       # static JavaScript seam + plugin contracts
npm run check:architecture-latency # warmed latency budget in an idle process
npm run measure:architecture  # context, payload and local latency baselines
npm test                      # all contracts and regression suites
```

The current domain language lives in [`CONTEXT.md`](CONTEXT.md), accepted
architectural decisions in [`docs/adr/`](docs/adr/), API coverage in
[`docs/figma-plugin-api-coverage.md`](docs/figma-plugin-api-coverage.md), and
release instructions in [`docs/releasing.md`](docs/releasing.md). The maintained
cross-area backlog and official-API watchlist live in
[`docs/future-work.md`](docs/future-work.md).

Avoid running an upstream `figma-cli` at the same time. The daemon now falls
back within 3456–3460 when 3456 is taken, so both *can* coexist, but the plugin
scans the whole range and the two daemons use different access keys — which one
the plugin reaches first is a coin toss. This build isolates its own
token/pid/port files under `~/.figma-bridge-mcp/`.

## License

figma-bridge-mcp is released under the [MIT License](LICENSE). It is provided
"as is", without warranty; the exact warranty and liability terms are in the
license itself. Third-party copyright and license notices are retained in
[`NOTICE`](NOTICE) and [`engine/LICENSE`](engine/LICENSE).

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

**Plugin identity.** The development manifests use the product-aligned ids
`figma-bridge-mcp` and `figma-bridge-mcp-dev`. Figma keys `clientStorage` —
where the paired access key lives — on the plugin id. Installations from before
0.5.0 therefore need to re-import the manifest and paste their existing Bridge
access key once.
